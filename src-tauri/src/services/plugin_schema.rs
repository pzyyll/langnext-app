// ABOUTME: Plugin schema v1 validation, normalization, and readiness checks.
// ABOUTME: Structural validity is separate from readiness; secrets stay outside config JSON.
use crate::domain::plugin_schema::{
  FieldControl, HOST_OPTION_SOURCE_IDS, HOST_SUPPORTED_LANGUAGES_SOURCE_ID, MULTI_ENUM_MAX_SELECTED,
  OPTION_VALUE_MAX_LEN, OptionSource, PluginSchemaV1, SCHEMA_MAX_FIELDS, SCHEMA_MAX_GROUPS, SCHEMA_MAX_OPTIONS,
  SCHEMA_TEXT_MAX_LEN, SCHEMA_VERSION_V1, SchemaField, validate_field_id,
};
use crate::domain::service_integration::validate_slot_id;
use crate::services::runtime_plugin_contracts::ValidatedPluginManifest;
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Tolerance for float step-alignment checks (absorbs rounding from JSON parsing).
const STEP_ALIGNMENT_TOLERANCE: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaErrorCode {
  UnknownVersion,
  UnknownKey,
  InvalidField,
  DuplicateId,
  LimitExceeded,
  UndeclaredReference,
  InvalidValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
  pub code: SchemaErrorCode,
  pub message: String,
}

impl SchemaError {
  fn new(code: SchemaErrorCode, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
    }
  }
}

impl std::fmt::Display for SchemaError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{:?}: {}", self.code, self.message)
  }
}

impl std::error::Error for SchemaError {}

/// Schema errors map to validation failures so adapters can use `?` against `StorageError`.
impl From<SchemaError> for crate::error::StorageError {
  fn from(err: SchemaError) -> Self {
    crate::error::StorageError::Validation(err.to_string())
  }
}

/// Readiness report: incomplete instances can be saved but cannot execute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadinessReport {
  pub ready: bool,
  pub missing_required: Vec<String>,
}

/// Host-owned resolver for the closed schema v1 option source set. A plugin never supplies
/// this value set; callers must provide the current application-supported language values.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostOptionResolver {
  supported_languages: HashSet<String>,
}

impl HostOptionResolver {
  pub fn supported_languages<I: IntoIterator<Item = String>>(values: I) -> Self {
    Self {
      supported_languages: values.into_iter().collect(),
    }
  }

  fn contains(&self, source_id: &str, value: &str) -> bool {
    source_id == HOST_SUPPORTED_LANGUAGES_SOURCE_ID && self.supported_languages.contains(value)
  }
}

/// Deserialize a schema with `deny_unknown_fields` and map serde errors to schema errors.
pub fn parse_schema(json: &str) -> Result<PluginSchemaV1, SchemaError> {
  serde_json::from_str::<PluginSchemaV1>(json).map_err(|err| {
    let msg = err.to_string();
    let code = if msg.contains("unknown field") {
      SchemaErrorCode::UnknownKey
    } else {
      SchemaErrorCode::InvalidField
    };
    SchemaError::new(code, msg)
  })
}

/// Validate schema structure, bounds, option sources, and cross-field references.
///
/// `visibleWhen` is validated in two passes so forward references are allowed; the
/// `equals` value's JSON type must match the referenced field's control kind.
pub fn validate_schema(schema: &PluginSchemaV1) -> Result<(), SchemaError> {
  if schema.version != SCHEMA_VERSION_V1 {
    return Err(SchemaError::new(
      SchemaErrorCode::UnknownVersion,
      format!(
        "unsupported schema version {} (expected {SCHEMA_VERSION_V1})",
        schema.version
      ),
    ));
  }
  if schema.fields.len() > SCHEMA_MAX_FIELDS {
    return Err(SchemaError::new(
      SchemaErrorCode::LimitExceeded,
      format!("schema exceeds {SCHEMA_MAX_FIELDS} fields"),
    ));
  }
  if schema.groups.len() > SCHEMA_MAX_GROUPS {
    return Err(SchemaError::new(
      SchemaErrorCode::LimitExceeded,
      format!("schema exceeds {SCHEMA_MAX_GROUPS} groups"),
    ));
  }

  // Pass 1: field ids, control validity, localization text.
  let mut field_ids = HashSet::new();
  for field in &schema.fields {
    validate_field_id(&field.id)
      .map_err(|e| SchemaError::new(SchemaErrorCode::InvalidField, format!("field id: {e}")))?;
    if !field_ids.insert(field.id.clone()) {
      return Err(SchemaError::new(
        SchemaErrorCode::DuplicateId,
        format!("duplicate field id: {}", field.id),
      ));
    }
    validate_field_control(&field.control, &field.id)?;
    validate_localization_text(&field.label_key, "labelKey")?;
    validate_localization_text(&field.label_fallback, "labelFallback")?;
    validate_localization_text(&field.description_key, "descriptionKey")?;
    validate_localization_text(&field.description_fallback, "descriptionFallback")?;
  }

  // Pass 2: visibleWhen references (forward refs allowed) and equals type check.
  for field in &schema.fields {
    if let Some(visible_when) = &field.visible_when {
      let control = find_control(schema, &visible_when.field).ok_or_else(|| {
        SchemaError::new(
          SchemaErrorCode::UndeclaredReference,
          format!("visibleWhen.field {} does not exist", visible_when.field),
        )
      })?;
      let expected = field_equals_type(control);
      if !value_matches_type(expected, &visible_when.equals) {
        return Err(SchemaError::new(
          SchemaErrorCode::InvalidField,
          format!(
            "visibleWhen.equals type does not match field {} control kind",
            visible_when.field
          ),
        ));
      }
    }
  }

  let mut group_ids = HashSet::new();
  for group in &schema.groups {
    validate_field_id(&group.id)
      .map_err(|e| SchemaError::new(SchemaErrorCode::InvalidField, format!("group id: {e}")))?;
    if !group_ids.insert(group.id.clone()) {
      return Err(SchemaError::new(
        SchemaErrorCode::DuplicateId,
        format!("duplicate group id: {}", group.id),
      ));
    }
    let mut seen_group_fields = HashSet::new();
    if group.fields.len() > field_ids.len() {
      return Err(SchemaError::new(
        SchemaErrorCode::LimitExceeded,
        format!("group {} references more fields than the schema declares", group.id),
      ));
    }
    for field_id in &group.fields {
      if !field_ids.contains(field_id) {
        return Err(SchemaError::new(
          SchemaErrorCode::UndeclaredReference,
          format!("group {} references unknown field {}", group.id, field_id),
        ));
      }
      if !seen_group_fields.insert(field_id.clone()) {
        return Err(SchemaError::new(
          SchemaErrorCode::DuplicateId,
          format!("group {} repeats field {}", group.id, field_id),
        ));
      }
    }
  }

  Ok(())
}

/// Cross-validate a schema against a validated manifest's declared credential slot ids.
/// Every `credential-slot` control must reference a slot declared by the validated manifest;
/// the slot-id set is derived from the unforgeable `ValidatedPluginManifest`.
pub fn validate_schema_for_manifest(
  schema: &PluginSchemaV1,
  manifest: &ValidatedPluginManifest,
) -> Result<(), SchemaError> {
  for field in &schema.fields {
    if let FieldControl::CredentialSlot(spec) = &field.control {
      if !manifest.credential_slot_ids().any(|id| id == spec.slot_id) {
        return Err(SchemaError::new(
          SchemaErrorCode::InvalidField,
          format!(
            "credential field {} references undeclared manifest slot {}",
            field.id, spec.slot_id
          ),
        ));
      }
    }
  }
  Ok(())
}

fn find_control<'a>(schema: &'a PluginSchemaV1, field_id: &str) -> Option<&'a FieldControl> {
  schema.fields.iter().find(|f| f.id == field_id).map(|f| &f.control)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EqualsType {
  String,
  Bool,
  Number,
  StringArray,
}

fn field_equals_type(control: &FieldControl) -> EqualsType {
  match control {
    FieldControl::String(_)
    | FieldControl::MultilineString(_)
    | FieldControl::Enum(_)
    | FieldControl::CredentialSlot(_) => EqualsType::String,
    FieldControl::Boolean(_) => EqualsType::Bool,
    FieldControl::Number(_) => EqualsType::Number,
    FieldControl::MultiEnum(_) => EqualsType::StringArray,
  }
}

fn value_matches_type(ty: EqualsType, v: &Value) -> bool {
  match (ty, v) {
    (EqualsType::String, Value::String(_)) => true,
    (EqualsType::Bool, Value::Bool(_)) => true,
    (EqualsType::Number, Value::Number(_)) => true,
    (EqualsType::StringArray, Value::Array(a)) => a.iter().all(|x| x.is_string()),
    _ => false,
  }
}

fn validate_field_control(control: &FieldControl, field_id: &str) -> Result<(), SchemaError> {
  match control {
    FieldControl::String(spec) | FieldControl::MultilineString(spec) => {
      if let Some(max_length) = spec.max_length {
        if max_length == 0 {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidField,
            format!("field {field_id} maxLength must be >= 1"),
          ));
        }
      }
      if let Some(default) = &spec.default {
        if let Some(max_length) = spec.max_length {
          if default.chars().count() as u32 > max_length {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {field_id} default exceeds maxLength"),
            ));
          }
        }
      }
    }
    FieldControl::Number(spec) => {
      if let Some(step) = spec.step {
        if !step.is_finite() || step <= 0.0 {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidField,
            format!("field {field_id} step must be a positive finite number"),
          ));
        }
      }
      if let (Some(min), Some(max)) = (spec.min, spec.max) {
        if min > max {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidField,
            format!("field {field_id} min must be <= max"),
          ));
        }
      }
      if let Some(default) = spec.default {
        if !default.is_finite() {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidValue,
            format!("field {field_id} default must be finite"),
          ));
        }
        if let Some(min) = spec.min {
          if default < min {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {field_id} default is below min"),
            ));
          }
        }
        if let Some(max) = spec.max {
          if default > max {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {field_id} default is above max"),
            ));
          }
        }
        if !is_step_aligned(default, spec.min, spec.step) {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidValue,
            format!("field {field_id} default is not step-aligned"),
          ));
        }
      }
    }
    FieldControl::Boolean(_) => {}
    FieldControl::Enum(spec) => {
      validate_option_source(&spec.source, field_id)?;
      if let Some(default) = &spec.default {
        if let OptionSource::Fixed { .. } = &spec.source {
          let valid_values = option_values(&spec.source);
          if !valid_values.contains(&default.as_str()) {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {field_id} default value {default} is not a valid option"),
            ));
          }
        }
      }
    }
    FieldControl::MultiEnum(spec) => {
      validate_option_source(&spec.source, field_id)?;
      if spec.max_selected == 0 {
        return Err(SchemaError::new(
          SchemaErrorCode::InvalidField,
          format!("field {field_id} maxSelected must be >= 1"),
        ));
      }
      if spec.max_selected > MULTI_ENUM_MAX_SELECTED {
        return Err(SchemaError::new(
          SchemaErrorCode::LimitExceeded,
          format!("field {field_id} maxSelected exceeds {MULTI_ENUM_MAX_SELECTED}"),
        ));
      }
      if let OptionSource::Fixed { .. } = &spec.source {
        let valid_values = option_values(&spec.source);
        for default in &spec.default {
          if !valid_values.contains(&default.as_str()) {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {field_id} default value {default} is not a valid option"),
            ));
          }
        }
      }
      if spec.default.len() as u32 > spec.max_selected {
        return Err(SchemaError::new(
          SchemaErrorCode::InvalidValue,
          format!("field {field_id} default exceeds maxSelected"),
        ));
      }
    }
    FieldControl::CredentialSlot(spec) => {
      validate_slot_id(&spec.slot_id)
        .map_err(|e| SchemaError::new(SchemaErrorCode::InvalidField, format!("field {field_id} slotId: {e}")))?;
    }
  }
  Ok(())
}

fn validate_option_source(source: &OptionSource, field_id: &str) -> Result<(), SchemaError> {
  match source {
    OptionSource::Fixed { options } => {
      if options.len() > SCHEMA_MAX_OPTIONS {
        return Err(SchemaError::new(
          SchemaErrorCode::LimitExceeded,
          format!("field {field_id} exceeds {SCHEMA_MAX_OPTIONS} options"),
        ));
      }
      let mut seen = HashSet::new();
      for option in options {
        if option.value.is_empty() || option.value.chars().count() > OPTION_VALUE_MAX_LEN {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidField,
            format!("field {field_id} option value must be 1..{OPTION_VALUE_MAX_LEN} chars"),
          ));
        }
        if !seen.insert(option.value.clone()) {
          return Err(SchemaError::new(
            SchemaErrorCode::DuplicateId,
            format!("field {field_id} has duplicate option value {}", option.value),
          ));
        }
        validate_localization_text(&option.label_key, "option labelKey")?;
        validate_localization_text(&option.label_fallback, "option labelFallback")?;
      }
    }
    OptionSource::Host { id } => {
      if !HOST_OPTION_SOURCE_IDS.contains(&id.as_str()) {
        return Err(SchemaError::new(
          SchemaErrorCode::InvalidField,
          format!("field {field_id} host option source {id} is not supported"),
        ));
      }
    }
  }
  Ok(())
}

fn validate_localization_text(value: &Option<String>, field: &str) -> Result<(), SchemaError> {
  if let Some(text) = value {
    if text.chars().count() > SCHEMA_TEXT_MAX_LEN {
      return Err(SchemaError::new(
        SchemaErrorCode::LimitExceeded,
        format!("{field} exceeds {SCHEMA_TEXT_MAX_LEN} characters"),
      ));
    }
  }
  Ok(())
}

fn option_values(source: &OptionSource) -> Vec<&str> {
  match source {
    OptionSource::Fixed { options } => options.iter().map(|option| option.value.as_str()).collect(),
    OptionSource::Host { .. } => Vec::new(),
  }
}

fn option_value_is_allowed(source: &OptionSource, value: &str, host_options: &HostOptionResolver) -> bool {
  match source {
    OptionSource::Fixed { .. } => option_values(source).contains(&value),
    OptionSource::Host { id } => host_options.contains(id, value),
  }
}

/// True when `value` is aligned to `step` relative to `min` (defaulting base to 0).
fn is_step_aligned(value: f64, min: Option<f64>, step: Option<f64>) -> bool {
  match step {
    Some(s) if s.is_finite() && s > 0.0 => {
      let base = min.unwrap_or(0.0);
      let diff = (value - base).abs();
      let remainder = (diff % s).abs();
      remainder < STEP_ALIGNMENT_TOLERANCE || (s - remainder).abs() < STEP_ALIGNMENT_TOLERANCE
    }
    _ => true,
  }
}

fn is_field_visible(field: &SchemaField, config: &Map<String, Value>) -> bool {
  match &field.visible_when {
    None => true,
    Some(condition) => config
      .get(&condition.field)
      .map(|v| v == &condition.equals)
      .unwrap_or(false),
  }
}

/// Normalize a config instance against a schema: apply defaults, clamp numbers, enforce step
/// alignment, and validate enum values through fixed lists or a host-owned option resolver.
/// Returns the normalized flat config object.
///
/// Credential-slot fields are presentation-only references to host-owned vault slots. They
/// are excluded from normalized config JSON; neither a credential reference nor secret
/// material is persisted in plugin configuration.
pub fn normalize_config(
  schema: &PluginSchemaV1,
  config: &Value,
  host_options: &HostOptionResolver,
) -> Result<Value, SchemaError> {
  let mut output = Map::new();
  let input = config
    .as_object()
    .ok_or_else(|| SchemaError::new(SchemaErrorCode::InvalidValue, "config must be a JSON object"))?;
  for key in input.keys() {
    if !schema.fields.iter().any(|field| field.id == *key) {
      return Err(SchemaError::new(
        SchemaErrorCode::InvalidValue,
        format!("config contains unknown field {key}"),
      ));
    }
  }

  for field in &schema.fields {
    let present = input.get(&field.id);
    match &field.control {
      FieldControl::String(spec) | FieldControl::MultilineString(spec) => {
        let value = match present {
          Some(Value::String(s)) => Some(s.clone()),
          Some(Value::Null) | None => spec.default.clone(),
          Some(_) => {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be a string", field.id),
            ));
          }
        };
        if let Some(value) = &value {
          if let Some(max_length) = spec.max_length {
            if value.chars().count() as u32 > max_length {
              return Err(SchemaError::new(
                SchemaErrorCode::InvalidValue,
                format!("field {} exceeds maxLength", field.id),
              ));
            }
          }
          output.insert(field.id.clone(), Value::String(value.clone()));
        }
      }
      FieldControl::Number(spec) => {
        let value = match present {
          Some(Value::Number(n)) => Some(n.as_f64().ok_or_else(|| {
            SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be a finite number", field.id),
            )
          })?),
          Some(Value::Null) | None => spec.default,
          Some(_) => {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be a number", field.id),
            ));
          }
        };
        if let Some(mut value) = value {
          if !value.is_finite() {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be finite", field.id),
            ));
          }
          if let Some(min) = spec.min {
            if value < min {
              value = min;
            }
          }
          if let Some(max) = spec.max {
            if value > max {
              value = max;
            }
          }
          if !is_step_aligned(value, spec.min, spec.step) {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} value is not step-aligned", field.id),
            ));
          }
          output.insert(field.id.clone(), serde_json::json!(value));
        }
      }
      FieldControl::Boolean(spec) => {
        let value = match present {
          Some(Value::Bool(b)) => *b,
          Some(Value::Null) | None => spec.default,
          Some(_) => {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be a boolean", field.id),
            ));
          }
        };
        output.insert(field.id.clone(), Value::Bool(value));
      }
      FieldControl::Enum(spec) => {
        let value = match present {
          Some(Value::String(s)) => Some(s.clone()),
          Some(Value::Null) | None => spec.default.clone(),
          Some(_) => {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be a string", field.id),
            ));
          }
        };
        if let Some(value) = &value {
          if !option_value_is_allowed(&spec.source, value, host_options) {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} value {value} is not a valid option", field.id),
            ));
          }
          output.insert(field.id.clone(), Value::String(value.clone()));
        }
      }
      FieldControl::MultiEnum(spec) => {
        let values: Vec<String> = match present {
          Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
              v.as_str().map(String::from).ok_or_else(|| {
                SchemaError::new(
                  SchemaErrorCode::InvalidValue,
                  format!("field {} must be an array of strings", field.id),
                )
              })
            })
            .collect::<Result<_, _>>()?,
          Some(Value::Null) | None => spec.default.clone(),
          Some(_) => {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} must be an array", field.id),
            ));
          }
        };
        for value in &values {
          if !option_value_is_allowed(&spec.source, value, host_options) {
            return Err(SchemaError::new(
              SchemaErrorCode::InvalidValue,
              format!("field {} value {value} is not a valid option", field.id),
            ));
          }
        }
        if values.len() as u32 > spec.max_selected {
          return Err(SchemaError::new(
            SchemaErrorCode::LimitExceeded,
            format!("field {} exceeds maxSelected", field.id),
          ));
        }
        output.insert(
          field.id.clone(),
          Value::Array(values.into_iter().map(Value::String).collect()),
        );
      }
      FieldControl::CredentialSlot(_) => {
        // Credential bindings are host-owned vault metadata, not configuration. Reject any
        // non-null value so callers cannot smuggle a secret or credential reference into
        // persisted config JSON.
        if !matches!(present, Some(Value::Null) | None) {
          return Err(SchemaError::new(
            SchemaErrorCode::InvalidValue,
            format!("credential field {} must be omitted or null", field.id),
          ));
        }
      }
    }
  }

  Ok(Value::Object(output))
}

/// Check readiness against a VALIDATED manifest context. Every visible `requiredForReady`
/// field must be satisfied: credential-slot fields by a host-owned bound credential, other
/// fields by a non-empty normalized config value. Required credential slots are derived
/// internally from the unforgeable `ValidatedPluginManifest` (never a caller-supplied slice),
/// so they cannot be deleted or emptied to bypass readiness. Incomplete instances can be
/// saved but cannot execute.
pub fn check_readiness(
  schema: &PluginSchemaV1,
  config: &Value,
  manifest: &ValidatedPluginManifest,
  bound_slot_ids: &[String],
  host_options: &HostOptionResolver,
) -> Result<ReadinessReport, SchemaError> {
  // Readiness is only meaningful for the canonical config. This applies defaults before
  // evaluating visibility and rejects unknown/wrongly typed data instead of treating it as
  // accidentally ready.
  let normalized = normalize_config(schema, config, host_options)?;
  let map = normalized.as_object();
  let bound: HashSet<&str> = bound_slot_ids.iter().map(|slot| slot.as_str()).collect();
  let mut missing = Vec::new();
  for field in &schema.fields {
    if !field.required_for_ready {
      continue;
    }
    let visible = map.map(|m| is_field_visible(field, m)).unwrap_or(true);
    if !visible {
      continue;
    }
    let satisfied = match &field.control {
      FieldControl::CredentialSlot(spec) => bound.contains(spec.slot_id.as_str()),
      _ => map
        .and_then(|m| m.get(&field.id))
        .map(|v| !is_empty_value(v))
        .unwrap_or(false),
    };
    if !satisfied {
      missing.push(field.id.clone());
    }
  }
  // Required slots are derived from the VALIDATED manifest; a caller cannot delete or empty them.
  for slot in manifest.credential_slots() {
    if slot.required && !bound.contains(slot.id.as_str()) {
      missing.push(slot.id.clone());
    }
  }
  missing.sort();
  missing.dedup();
  Ok(ReadinessReport {
    ready: missing.is_empty(),
    missing_required: missing,
  })
}

/// Check config-only readiness (non-credential `requiredForReady` fields) without a
/// validated manifest. Bundled plugin registrations use this because their credential
/// slot satisfaction is enforced separately by the integration service, and they do not
/// carry a Phase 0 `ValidatedPluginManifest`. Credential-slot fields are skipped here.
pub fn check_config_readiness(
  schema: &PluginSchemaV1,
  config: &Value,
  host_options: &HostOptionResolver,
) -> Result<ReadinessReport, SchemaError> {
  let normalized = normalize_config(schema, config, host_options)?;
  let map = normalized.as_object();
  let mut missing = Vec::new();
  for field in &schema.fields {
    if !field.required_for_ready {
      continue;
    }
    if matches!(field.control, FieldControl::CredentialSlot(_)) {
      continue;
    }
    let visible = map.map(|m| is_field_visible(field, m)).unwrap_or(true);
    if !visible {
      continue;
    }
    let satisfied = map
      .and_then(|m| m.get(&field.id))
      .map(|v| !is_empty_value(v))
      .unwrap_or(false);
    if !satisfied {
      missing.push(field.id.clone());
    }
  }
  missing.sort();
  missing.dedup();
  Ok(ReadinessReport {
    ready: missing.is_empty(),
    missing_required: missing,
  })
}

fn is_empty_value(value: &Value) -> bool {
  match value {
    Value::Null => true,
    Value::String(s) => s.is_empty(),
    Value::Array(a) => a.is_empty(),
    _ => false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::plugin_schema::{
    BooleanControl, CredentialSlotControl, EnumControl, FieldControl, MultiEnumControl, NumberControl, OptionSource,
    PluginSchemaV1, SchemaField, SchemaOption, StringControl, VisibleWhen,
  };

  fn field(id: &str, control: FieldControl) -> SchemaField {
    SchemaField {
      id: id.into(),
      control,
      label_key: None,
      label_fallback: None,
      description_key: None,
      description_fallback: None,
      required_for_ready: false,
      visible_when: None,
    }
  }

  fn schema(fields: Vec<SchemaField>) -> PluginSchemaV1 {
    PluginSchemaV1 {
      version: 1,
      fields,
      groups: vec![],
    }
  }

  fn host_options() -> HostOptionResolver {
    HostOptionResolver::supported_languages(["en".to_string(), "zh".to_string()])
  }

  fn manifest_with_slots(slots: &[(&str, bool)]) -> crate::domain::runtime_plugin::PluginManifestV1 {
    use crate::domain::runtime_plugin::{
      CredentialSlotDecl, CredentialSlotKindV1, PermissionRequests, PluginManifestV1, PublisherDeclaration,
      RuntimeDescriptor, RuntimeKind, UiDeclaration,
    };
    PluginManifestV1 {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: "com.example.t".into(),
      version: "1.0.0".into(),
      publisher: PublisherDeclaration {
        key_id: "vendor.example".into(),
        key_fingerprint: "0".repeat(64),
      },
      runtime: RuntimeDescriptor {
        kind: RuntimeKind::BundledRust,
        artifact: None,
      },
      targets: vec![],
      files: vec![],
      capabilities: vec![],
      configuration_schema: None,
      config_schema_version: None,
      credential_slots: slots
        .iter()
        .map(|(id, required)| CredentialSlotDecl {
          id: (*id).into(),
          kind: CredentialSlotKindV1::SecretText,
          required: *required,
        })
        .collect(),
      permissions: PermissionRequests::default(),
      ui: UiDeclaration::default(),
    }
  }

  fn validated(
    manifest: &crate::domain::runtime_plugin::PluginManifestV1,
  ) -> crate::services::runtime_plugin_contracts::ValidatedPluginManifest {
    crate::services::runtime_plugin_contracts::validate_manifest(manifest).expect("manifest validates")
  }

  /// A validated manifest with no credential slots and no bound credentials.
  fn no_credentials() -> crate::services::runtime_plugin_contracts::ValidatedPluginManifest {
    validated(&manifest_with_slots(&[]))
  }

  #[test]
  fn plugin_schema_defaults_applied() {
    let s = schema(vec![
      field(
        "name",
        FieldControl::String(StringControl {
          max_length: Some(20),
          default: Some("default-name".into()),
        }),
      ),
      field("enabled", FieldControl::Boolean(BooleanControl { default: true })),
    ]);
    validate_schema(&s).unwrap();
    let normalized = normalize_config(&s, &serde_json::json!({}), &host_options()).unwrap();
    assert_eq!(normalized["name"], serde_json::json!("default-name"));
    assert_eq!(normalized["enabled"], serde_json::json!(true));
  }

  #[test]
  fn plugin_schema_normalization_clamps_numbers() {
    let s = schema(vec![field(
      "speed",
      FieldControl::Number(NumberControl {
        min: Some(0.0),
        max: Some(2.0),
        step: None,
        default: Some(1.0),
      }),
    )]);
    validate_schema(&s).unwrap();
    let clamped_high = normalize_config(&s, &serde_json::json!({"speed": 5.0}), &host_options()).unwrap();
    assert_eq!(clamped_high["speed"], serde_json::json!(2.0));
    let clamped_low = normalize_config(&s, &serde_json::json!({"speed": -3.0}), &host_options()).unwrap();
    assert_eq!(clamped_low["speed"], serde_json::json!(0.0));
  }

  #[test]
  fn plugin_schema_step_validation_and_alignment() {
    // step must be positive finite.
    let s = schema(vec![field(
      "n",
      FieldControl::Number(NumberControl {
        min: Some(0.0),
        max: Some(10.0),
        step: Some(0.0),
        default: Some(1.0),
      }),
    )]);
    assert_eq!(validate_schema(&s).unwrap_err().code, SchemaErrorCode::InvalidField);

    // default must be step-aligned (min=0, step=0.5 -> default 0.25 invalid).
    let s = schema(vec![field(
      "n",
      FieldControl::Number(NumberControl {
        min: Some(0.0),
        max: Some(10.0),
        step: Some(0.5),
        default: Some(0.25),
      }),
    )]);
    assert_eq!(validate_schema(&s).unwrap_err().code, SchemaErrorCode::InvalidValue);

    // Valid step + aligned default.
    let s = schema(vec![field(
      "n",
      FieldControl::Number(NumberControl {
        min: Some(0.0),
        max: Some(10.0),
        step: Some(0.5),
        default: Some(1.0),
      }),
    )]);
    validate_schema(&s).unwrap();
    // Aligned config value passes.
    let ok = normalize_config(&s, &serde_json::json!({"n": 2.5}), &host_options()).unwrap();
    assert_eq!(ok["n"], serde_json::json!(2.5));
    // Misaligned config value rejected.
    let err = normalize_config(&s, &serde_json::json!({"n": 2.3}), &host_options()).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidValue);
  }

  #[test]
  fn plugin_schema_visibility_evaluates_equality() {
    let mut channel_field = field(
      "channel",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Fixed {
          options: vec![
            SchemaOption {
              value: "gtx".into(),
              label_key: None,
              label_fallback: None,
            },
            SchemaOption {
              value: "proxy".into(),
              label_key: None,
              label_fallback: None,
            },
          ],
        },
        default: Some("gtx".into()),
      }),
    );
    channel_field.required_for_ready = true;
    let mut proxy_url = field(
      "proxy-url",
      FieldControl::String(StringControl {
        max_length: Some(100),
        default: None,
      }),
    );
    proxy_url.required_for_ready = true;
    proxy_url.visible_when = Some(VisibleWhen {
      field: "channel".into(),
      equals: serde_json::json!("proxy"),
    });
    let s = schema(vec![channel_field, proxy_url]);
    validate_schema(&s).unwrap();

    let creds = no_credentials();
    // channel=gtx -> proxy-url hidden -> ready despite proxy-url missing.
    let report = check_readiness(&s, &serde_json::json!({"channel": "gtx"}), &creds, &[], &host_options()).unwrap();
    assert!(
      report.ready,
      "hidden required field should not block readiness: {report:?}"
    );

    // channel=proxy -> proxy-url visible and missing -> not ready.
    let report = check_readiness(
      &s,
      &serde_json::json!({"channel": "proxy"}),
      &creds,
      &[],
      &host_options(),
    )
    .unwrap();
    assert!(!report.ready);
    assert_eq!(report.missing_required, vec!["proxy-url".to_string()]);
  }

  #[test]
  fn plugin_schema_readiness_normalizes_defaults_and_rejects_invalid_config() {
    let mut proxy_url = field(
      "proxy-url",
      FieldControl::String(StringControl {
        max_length: Some(100),
        default: None,
      }),
    );
    proxy_url.required_for_ready = true;
    proxy_url.visible_when = Some(VisibleWhen {
      field: "channel".into(),
      equals: serde_json::json!("proxy"),
    });
    let channel = field(
      "channel",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Fixed {
          options: vec![SchemaOption {
            value: "proxy".into(),
            label_key: None,
            label_fallback: None,
          }],
        },
        default: Some("proxy".into()),
      }),
    );
    let s = schema(vec![proxy_url, channel]);
    validate_schema(&s).unwrap();
    let report = check_readiness(&s, &serde_json::json!({}), &no_credentials(), &[], &host_options()).unwrap();
    assert!(
      !report.ready,
      "default channel must make proxy-url visible and required"
    );
    assert_eq!(report.missing_required, vec!["proxy-url".to_string()]);
    assert!(
      check_readiness(
        &s,
        &serde_json::json!({"channel": true}),
        &no_credentials(),
        &[],
        &host_options()
      )
      .is_err()
    );
  }

  #[test]
  fn plugin_schema_visible_when_allows_forward_reference_and_type_check() {
    // proxy-url declared BEFORE channel, referencing channel forward.
    let mut proxy_url = field(
      "proxy-url",
      FieldControl::String(StringControl {
        max_length: Some(100),
        default: None,
      }),
    );
    proxy_url.visible_when = Some(VisibleWhen {
      field: "channel".into(),
      equals: serde_json::json!("proxy"),
    });
    let channel_field = field(
      "channel",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Fixed {
          options: vec![SchemaOption {
            value: "proxy".into(),
            label_key: None,
            label_fallback: None,
          }],
        },
        default: Some("proxy".into()),
      }),
    );
    let s = schema(vec![proxy_url, channel_field]);
    validate_schema(&s).expect("forward reference allowed");

    // Type mismatch: equals is a bool but channel is an enum (string).
    let mut bad = field(
      "a",
      FieldControl::String(StringControl {
        max_length: None,
        default: None,
      }),
    );
    let b = field("b", FieldControl::Boolean(BooleanControl { default: false }));
    bad.visible_when = Some(VisibleWhen {
      field: "b".into(),
      equals: serde_json::json!("not-a-bool"),
    });
    let _ = b;
    let s = schema(vec![bad, b]);
    assert_eq!(validate_schema(&s).unwrap_err().code, SchemaErrorCode::InvalidField);
  }

  #[test]
  fn plugin_schema_bounds_reject_invalid_default() {
    let s = schema(vec![field(
      "n",
      FieldControl::Number(NumberControl {
        min: Some(0.0),
        max: Some(10.0),
        step: None,
        default: Some(100.0),
      }),
    )]);
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidValue);
  }

  #[test]
  fn plugin_schema_max_length_counts_unicode_chars_not_bytes() {
    // CJK chars are 3 UTF-8 bytes each; maxLength counts Unicode chars, not bytes.
    // 5 CJK chars (15 bytes) with maxLength 5 passes, proving char semantics.
    let s = schema(vec![field(
      "name",
      FieldControl::String(StringControl {
        max_length: Some(5),
        default: None,
      }),
    )]);
    validate_schema(&s).unwrap();
    let ok = normalize_config(&s, &serde_json::json!({"name": "你好世界呀"}), &host_options()).unwrap();
    assert_eq!(ok["name"], serde_json::json!("你好世界呀"));
    // 6 CJK chars with maxLength 5 fails (6 chars > 5), even though 18 bytes > 5 too.
    let err = normalize_config(&s, &serde_json::json!({"name": "你好世界呀哈"}), &host_options()).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidValue);
    // A default above maxLength by char count is rejected at schema validation.
    let bad = schema(vec![field(
      "name",
      FieldControl::String(StringControl {
        max_length: Some(5),
        default: Some("你好世界呀哈".into()),
      }),
    )]);
    assert_eq!(validate_schema(&bad).unwrap_err().code, SchemaErrorCode::InvalidValue);
  }

  #[test]
  fn plugin_schema_readiness_separates_from_structure() {
    let mut name = field(
      "name",
      FieldControl::String(StringControl {
        max_length: Some(50),
        default: None,
      }),
    );
    name.required_for_ready = true;
    let s = schema(vec![name]);
    validate_schema(&s).unwrap();
    let creds = no_credentials();
    let report = check_readiness(&s, &serde_json::json!({}), &creds, &[], &host_options()).unwrap();
    assert!(!report.ready);
    assert_eq!(report.missing_required, vec!["name".to_string()]);
    let report = check_readiness(&s, &serde_json::json!({"name": "ok"}), &creds, &[], &host_options()).unwrap();
    assert!(report.ready);
  }

  #[test]
  fn plugin_schema_unknown_key_rejected() {
    let json = r#"{
      "version": 1,
      "fields": [],
      "bogus": true
    }"#;
    let err = parse_schema(json).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::UnknownKey);
  }

  #[test]
  fn plugin_schema_nested_unknown_keys_in_control_specs_fail_closed() {
    // Unknown keys inside each control variant's `spec` are rejected by deny_unknown_fields.
    let cases: &[(&str, &str)] = &[
      ("string", r#"{"maxLength": 5, "bogus": true}"#),
      ("multiline-string", r#"{"maxLength": 5, "bogus": true}"#),
      ("number", r#"{"min": 0.0, "bogus": true}"#),
      ("boolean", r#"{"default": true, "bogus": true}"#),
      ("enum", r#"{"source": {"type": "fixed", "options": []}, "bogus": true}"#),
      (
        "multi-enum",
        r#"{"source": {"type": "fixed", "options": []}, "maxSelected": 1, "bogus": true}"#,
      ),
      ("credential-slot", r#"{"slotId": "api-key", "bogus": true}"#),
    ];
    for (kind, spec) in cases {
      let json = format!(r#"{{"version":1,"fields":[{{"id":"f","control":{{"kind":"{kind}","spec":{spec}}}}}]}}"#);
      let err = parse_schema(&json).expect_err("control spec unknown key must fail closed");
      assert_eq!(
        err.code,
        SchemaErrorCode::UnknownKey,
        "{kind} control spec unknown key must fail closed"
      );
    }

    // Unknown keys inside option-source and option records are rejected too.
    let option_unknown = r#"{"version":1,"fields":[{"id":"f","control":{"kind":"enum","spec":{"source":{"type":"fixed","options":[{"value":"a","bogus":true}]}}}}]}"#;
    assert_eq!(
      parse_schema(option_unknown).unwrap_err().code,
      SchemaErrorCode::UnknownKey
    );
    let host_unknown = r#"{"version":1,"fields":[{"id":"f","control":{"kind":"enum","spec":{"source":{"type":"host","id":"host.supported-languages@1","bogus":true}}}}]}"#;
    assert_eq!(
      parse_schema(host_unknown).unwrap_err().code,
      SchemaErrorCode::UnknownKey
    );
    // Unknown key inside visibleWhen and inside a group.
    let visible_unknown = r#"{"version":1,"fields":[{"id":"a","control":{"kind":"string","spec":{}},"visibleWhen":{"field":"a","equals":"x","bogus":true}}]}"#;
    assert_eq!(
      parse_schema(visible_unknown).unwrap_err().code,
      SchemaErrorCode::UnknownKey
    );
    let group_unknown = r#"{"version":1,"fields":[{"id":"a","control":{"kind":"string","spec":{}}}],"groups":[{"id":"g","fields":["a"],"bogus":true}]}"#;
    assert_eq!(
      parse_schema(group_unknown).unwrap_err().code,
      SchemaErrorCode::UnknownKey
    );
  }

  #[test]
  fn plugin_schema_control_level_unknown_keys_fail_closed() {
    // Unknown keys at the control object level (siblings of kind/spec) are rejected by the
    // custom FieldControl deserializer, closing the adjacently-tagged enum gap.
    let json = r#"{"version":1,"fields":[{"id":"f","control":{"kind":"string","spec":{"maxLength":5},"bogus":true}}]}"#;
    assert_eq!(parse_schema(json).unwrap_err().code, SchemaErrorCode::UnknownKey);
  }

  #[test]
  fn plugin_schema_scripts_validators_and_refs_rejected() {
    // The closed dialect has no script/validator/$ref fields; any such field is an unknown key.
    for bad_field in ["script", "validator", "$ref", "html", "css"] {
      let json = format!(
        r#"{{"version":1,"fields":[{{"id":"f","control":{{"kind":"string","spec":{{"{bad_field}":"x"}}}}}}]}}"#
      );
      assert_eq!(
        parse_schema(&json).unwrap_err().code,
        SchemaErrorCode::UnknownKey,
        "{bad_field} must be rejected"
      );
      // At the field level too.
      let json = serde_json::json!({
        "version": 1,
        "fields": [
          {"id": "f", "control": {"kind": "string", "spec": {}}, bad_field: "x"}
        ]
      })
      .to_string();
      assert_eq!(
        parse_schema(&json).unwrap_err().code,
        SchemaErrorCode::UnknownKey,
        "{bad_field} at field level must be rejected"
      );
    }
  }

  #[test]
  fn plugin_schema_unknown_version_rejected() {
    let json = r#"{ "version": 2, "fields": [] }"#;
    let parsed = parse_schema(json).expect("version 2 parses as u32");
    let err = validate_schema(&parsed).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::UnknownVersion);
    let s = PluginSchemaV1 {
      version: 2,
      fields: vec![],
      groups: vec![],
    };
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::UnknownVersion);
  }

  #[test]
  fn plugin_schema_credential_slot_readiness_uses_host_owned_status() {
    let mut cred = field(
      "api-key-ref",
      FieldControl::CredentialSlot(CredentialSlotControl {
        slot_id: "api-key".into(),
      }),
    );
    cred.required_for_ready = true;
    let s = schema(vec![cred]);
    validate_schema(&s).unwrap();

    // Config never carries secret material; the slot id is NOT auto-written.
    let normalized = normalize_config(&s, &serde_json::json!({}), &host_options()).unwrap();
    assert!(
      normalized.as_object().unwrap().get("api-key-ref").is_none(),
      "no auto-fill"
    );
    // Credential values and references are both rejected from config JSON.
    let err = normalize_config(&s, &serde_json::json!({"api-key-ref": "raw-secret"}), &host_options()).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidValue);
    let err = normalize_config(&s, &serde_json::json!({"api-key-ref": 123}), &host_options()).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidValue);
    let err = normalize_config(&s, &serde_json::json!({"api-key": "raw-secret"}), &host_options()).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidValue);

    // Readiness is host-owned: not ready when slot unbound, ready when bound.
    let v = validated(&manifest_with_slots(&[("api-key", false)]));
    assert!(
      !check_readiness(&s, &serde_json::json!({}), &v, &[], &host_options())
        .unwrap()
        .ready
    );
    assert!(
      check_readiness(
        &s,
        &serde_json::json!({}),
        &v,
        &["api-key".to_string()],
        &host_options()
      )
      .unwrap()
      .ready
    );
  }

  #[test]
  fn plugin_schema_required_manifest_credential_blocks_readiness() {
    let s = schema(vec![]);
    let v = validated(&manifest_with_slots(&[("api-key", true)]));
    let report = check_readiness(&s, &serde_json::json!({}), &v, &[], &host_options()).unwrap();
    assert!(!report.ready);
    assert_eq!(report.missing_required, vec!["api-key".to_string()]);
    assert!(
      check_readiness(
        &s,
        &serde_json::json!({}),
        &v,
        &["api-key".to_string()],
        &host_options()
      )
      .unwrap()
      .ready
    );
  }

  #[test]
  fn plugin_schema_readiness_reads_required_slots_from_validated_manifest() {
    // The readiness check depends on a validated manifest: the required-slot set is read
    // directly from the `ValidatedPluginManifest` (only obtainable from `validate_manifest`),
    // so a caller cannot delete or empty required slots to bypass the common readiness path.
    let s = schema(vec![]);
    let v = validated(&manifest_with_slots(&[("api-key", true)]));
    let report = check_readiness(&s, &serde_json::json!({}), &v, &[], &host_options()).unwrap();
    assert!(!report.ready);
    assert_eq!(report.missing_required, vec!["api-key".to_string()]);
    assert!(
      check_readiness(
        &s,
        &serde_json::json!({}),
        &v,
        &["api-key".to_string()],
        &host_options()
      )
      .unwrap()
      .ready
    );

    // A non-required slot never blocks readiness even when unbound.
    let optional = validated(&manifest_with_slots(&[("api-key", false)]));
    assert!(
      check_readiness(&s, &serde_json::json!({}), &optional, &[], &host_options())
        .unwrap()
        .ready
    );
  }

  #[test]
  fn plugin_schema_credential_slot_cross_validates_manifest() {
    let s = schema(vec![field(
      "api-key-ref",
      FieldControl::CredentialSlot(CredentialSlotControl {
        slot_id: "api-key".into(),
      }),
    )]);
    // Manifest declares the slot -> ok.
    validate_schema_for_manifest(&s, &validated(&manifest_with_slots(&[("api-key", false)]))).unwrap();
    // Manifest does not declare the slot -> error.
    let err = validate_schema_for_manifest(&s, &validated(&manifest_with_slots(&[("other-slot", false)]))).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidField);
  }

  #[test]
  fn plugin_schema_multi_enum_bounds_enforced() {
    let s = schema(vec![field(
      "langs",
      FieldControl::MultiEnum(MultiEnumControl {
        source: OptionSource::Fixed {
          options: vec![
            SchemaOption {
              value: "en".into(),
              label_key: None,
              label_fallback: None,
            },
            SchemaOption {
              value: "zh".into(),
              label_key: None,
              label_fallback: None,
            },
          ],
        },
        max_selected: 1,
        default: vec![],
      }),
    )]);
    validate_schema(&s).unwrap();
    let err = normalize_config(&s, &serde_json::json!({"langs": ["en", "zh"]}), &host_options()).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::LimitExceeded);
  }

  #[test]
  fn plugin_schema_undeclared_visible_when_rejected() {
    let mut f = field(
      "a",
      FieldControl::String(StringControl {
        max_length: None,
        default: None,
      }),
    );
    f.visible_when = Some(VisibleWhen {
      field: "missing".into(),
      equals: serde_json::json!("x"),
    });
    let s = schema(vec![f]);
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::UndeclaredReference);
  }

  #[test]
  fn plugin_schema_host_option_source_closed() {
    let s = schema(vec![field(
      "lang",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Host {
          id: "host.supported-languages@1".into(),
        },
        default: None,
      }),
    )]);
    validate_schema(&s).unwrap();

    let s = schema(vec![field(
      "lang",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Host {
          id: "host.unknown-source@1".into(),
        },
        default: None,
      }),
    )]);
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::InvalidField);
  }

  #[test]
  fn plugin_schema_field_ids_are_canonical_and_untrimmed() {
    for invalid in [" field", "field ", "field_name", "field--name", "-field", "field-"] {
      assert!(validate_field_id(invalid).is_err(), "{invalid} must be rejected");
    }
    assert!(validate_field_id("field-name-1").is_ok());
  }

  #[test]
  fn plugin_schema_host_options_use_current_host_resolver_membership() {
    let s = schema(vec![
      field(
        "source-language",
        FieldControl::Enum(EnumControl {
          source: OptionSource::Host {
            id: "host.supported-languages@1".into(),
          },
          default: None,
        }),
      ),
      field(
        "target-languages",
        FieldControl::MultiEnum(MultiEnumControl {
          source: OptionSource::Host {
            id: "host.supported-languages@1".into(),
          },
          max_selected: 2,
          default: vec![],
        }),
      ),
    ]);
    validate_schema(&s).unwrap();
    let resolver = HostOptionResolver::supported_languages(["en".to_string(), "zh".to_string()]);
    assert!(
      normalize_config(
        &s,
        &serde_json::json!({"source-language": "en", "target-languages": ["zh"]}),
        &resolver,
      )
      .is_ok()
    );
    assert!(normalize_config(&s, &serde_json::json!({"source-language": "de"}), &resolver).is_err());
    assert!(normalize_config(&s, &serde_json::json!({"target-languages": ["en", "de"]}), &resolver).is_err());
  }

  #[test]
  fn plugin_schema_duplicate_field_rejected() {
    let s = schema(vec![
      field(
        "name",
        FieldControl::String(StringControl {
          max_length: None,
          default: None,
        }),
      ),
      field(
        "name",
        FieldControl::String(StringControl {
          max_length: None,
          default: None,
        }),
      ),
    ]);
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::DuplicateId);
  }

  #[test]
  fn plugin_schema_group_field_refs_bounded_and_unique() {
    use crate::domain::plugin_schema::SchemaGroup;
    let a = field(
      "a",
      FieldControl::String(StringControl {
        max_length: None,
        default: None,
      }),
    );
    let b = field(
      "b",
      FieldControl::String(StringControl {
        max_length: None,
        default: None,
      }),
    );
    // Valid group: references existing fields, no duplicates, within bounds.
    let mut s = schema(vec![a, b]);
    s.groups = vec![SchemaGroup {
      id: "g".into(),
      label_key: None,
      label_fallback: None,
      fields: vec!["a".into(), "b".into()],
    }];
    validate_schema(&s).unwrap();

    // Duplicate field reference within a group is rejected (schema has 2 fields so the bound
    // check passes and the duplicate check fires).
    let mut s = schema(vec![
      field(
        "a",
        FieldControl::String(StringControl {
          max_length: None,
          default: None,
        }),
      ),
      field(
        "b",
        FieldControl::String(StringControl {
          max_length: None,
          default: None,
        }),
      ),
    ]);
    s.groups = vec![SchemaGroup {
      id: "g".into(),
      label_key: None,
      label_fallback: None,
      fields: vec!["a".into(), "a".into()],
    }];
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::DuplicateId);

    // More field references than the schema declares is rejected as a bound violation.
    let mut s = schema(vec![field(
      "a",
      FieldControl::String(StringControl {
        max_length: None,
        default: None,
      }),
    )]);
    s.groups = vec![SchemaGroup {
      id: "g".into(),
      label_key: None,
      label_fallback: None,
      fields: vec!["a".into(), "b".into(), "c".into()],
    }];
    let err = validate_schema(&s).unwrap_err();
    assert_eq!(err.code, SchemaErrorCode::LimitExceeded);
  }

  #[test]
  fn plugin_schema_option_value_length_counts_unicode_chars() {
    // OPTION_VALUE_MAX_LEN (128) counts Unicode chars, not bytes. 128 CJK chars (384 bytes)
    // pass; 129 CJK chars fail.
    let at_limit: String = "\u{4e2d}".repeat(128);
    let over_limit: String = "\u{4e2d}".repeat(129);
    let at = schema(vec![field(
      "lang",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Fixed {
          options: vec![SchemaOption {
            value: at_limit,
            label_key: None,
            label_fallback: None,
          }],
        },
        default: None,
      }),
    )]);
    validate_schema(&at).unwrap();
    let over = schema(vec![field(
      "lang",
      FieldControl::Enum(EnumControl {
        source: OptionSource::Fixed {
          options: vec![SchemaOption {
            value: over_limit,
            label_key: None,
            label_fallback: None,
          }],
        },
        default: None,
      }),
    )]);
    assert_eq!(validate_schema(&over).unwrap_err().code, SchemaErrorCode::InvalidField);
  }
}
