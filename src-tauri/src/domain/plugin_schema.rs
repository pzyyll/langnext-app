// ABOUTME: Limited plugin UI schema v1 domain types (controls, fields, groups, options).
// ABOUTME: Deliberately closed: no recursion, HTML/CSS, scripts, validators, or remote refs.
use serde::{Deserialize, Serialize};

/// Schema dialect version produced and consumed by Phase 0.
pub const SCHEMA_VERSION_V1: u32 = 1;
pub const SCHEMA_MAX_FIELDS: usize = 64;
pub const SCHEMA_MAX_GROUPS: usize = 16;
pub const SCHEMA_MAX_OPTIONS: usize = 128;
pub const MULTI_ENUM_MAX_SELECTED: u32 = 32;
pub const FIELD_ID_MAX_LEN: usize = 64;
pub const SCHEMA_TEXT_MAX_LEN: usize = 256;
pub const OPTION_VALUE_MAX_LEN: usize = 128;
/// The single closed v1 host option source: the current application-supported language set.
pub const HOST_SUPPORTED_LANGUAGES_SOURCE_ID: &str = "host.supported-languages@1";
/// Closed host option source ids accepted by schema v1.
pub const HOST_OPTION_SOURCE_IDS: &[&str] = &[HOST_SUPPORTED_LANGUAGES_SOURCE_ID];

/// Field control kinds supported by schema v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlKind {
  String,
  MultilineString,
  Number,
  Boolean,
  Enum,
  MultiEnum,
  CredentialSlot,
}

/// Source of options for enum/multi-enum controls. Fixed arrays or closed host sources only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OptionSource {
  Fixed {
    #[serde(default)]
    options: Vec<SchemaOption>,
  },
  Host {
    id: String,
  },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaOption {
  pub value: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_key: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_fallback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StringControl {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max_length: Option<u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NumberControl {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub min: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub step: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BooleanControl {
  #[serde(default)]
  pub default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnumControl {
  pub source: OptionSource,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MultiEnumControl {
  pub source: OptionSource,
  pub max_selected: u32,
  #[serde(default)]
  pub default: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialSlotControl {
  pub slot_id: String,
}

/// Tagged control payload. Adjacent tagging keeps `deny_unknown_fields` reliable per variant
/// for keys inside `spec`. Unknown keys at the control object level (siblings of `kind`/
/// `spec`) are rejected by `deserialize_field_control` so unknown keys fail closed at every
/// nesting level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "spec", rename_all = "kebab-case")]
pub enum FieldControl {
  String(StringControl),
  MultilineString(StringControl),
  Number(NumberControl),
  Boolean(BooleanControl),
  Enum(EnumControl),
  MultiEnum(MultiEnumControl),
  CredentialSlot(CredentialSlotControl),
}

/// Deserialize a `FieldControl` while rejecting unknown keys at the control object level
/// (siblings of `kind`/`spec`). The adjacently-tagged enum derive rejects unknown keys inside
/// each variant's `spec`, but not at the control object level; this wrapper closes that gap so
/// unknown keys fail closed at every nesting level.
fn deserialize_field_control<'de, D>(deserializer: D) -> Result<FieldControl, D::Error>
where
  D: serde::Deserializer<'de>,
{
  let value = serde_json::Value::deserialize(deserializer)?;
  if let Some(object) = value.as_object() {
    for key in object.keys() {
      if key != "kind" && key != "spec" {
        return Err(serde::de::Error::unknown_field(key, &["kind", "spec"]));
      }
    }
  }
  serde_json::from_value::<FieldControl>(value).map_err(serde::de::Error::custom)
}

impl FieldControl {
  pub fn kind(&self) -> ControlKind {
    match self {
      Self::String(_) => ControlKind::String,
      Self::MultilineString(_) => ControlKind::MultilineString,
      Self::Number(_) => ControlKind::Number,
      Self::Boolean(_) => ControlKind::Boolean,
      Self::Enum(_) => ControlKind::Enum,
      Self::MultiEnum(_) => ControlKind::MultiEnum,
      Self::CredentialSlot(_) => ControlKind::CredentialSlot,
    }
  }
}

/// Simple equality visibility condition. The referenced field must exist in the schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleWhen {
  pub field: String,
  pub equals: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaField {
  pub id: String,
  #[serde(deserialize_with = "deserialize_field_control")]
  pub control: FieldControl,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_key: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_fallback: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description_key: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description_fallback: Option<String>,
  #[serde(default)]
  pub required_for_ready: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub visible_when: Option<VisibleWhen>,
}

/// Presentation-only group. References field ids; does not alter persisted config shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaGroup {
  pub id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_key: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_fallback: Option<String>,
  #[serde(default)]
  pub fields: Vec<String>,
}

/// Plugin schema v1: flat field list plus presentation-only groups.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSchemaV1 {
  pub version: u32,
  #[serde(default)]
  pub fields: Vec<SchemaField>,
  #[serde(default)]
  pub groups: Vec<SchemaGroup>,
}

/// Validate a canonical field id: lowercase ASCII alphanumeric segments separated by one
/// hyphen. IDs are never trimmed or normalized, so persisted config keys are stable.
pub fn validate_field_id(value: &str) -> Result<(), String> {
  if value.is_empty() {
    return Err("field id is required".into());
  }
  if value != value.trim() {
    return Err("field id must not have surrounding whitespace".into());
  }
  if value.len() > FIELD_ID_MAX_LEN {
    return Err(format!("field id exceeds {FIELD_ID_MAX_LEN} characters"));
  }
  if !value
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
  {
    return Err("field id must be lowercase ASCII alphanumeric or hyphen".into());
  }
  if value.starts_with('-') || value.ends_with('-') || value.contains("--") {
    return Err("field id must use single hyphens between alphanumeric segments".into());
  }
  Ok(())
}
