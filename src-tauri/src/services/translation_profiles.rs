// ABOUTME: Translation profile template/parameter validation and profile writes.
// ABOUTME: Engine-aware CRUD for LLM model chains and plugin capability bindings.

use crate::domain::language_detection::{LanguageDetectorConfig, SUPPORTED_LANGUAGES};
use crate::domain::service_integration::{GOOGLE_CLOUD_PLUGIN_ID, IntegrationHealthStatus, validate_capability_id};
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{
  GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION, LlmModelChainEngine, PluginCapabilityEngine, PromptTemplate,
  TranslationProfile, TranslationProfileDto, TranslationProfileEngine, TranslationProfileEngineWrite,
  TranslationProfileTarget, TranslationProfileWrite, empty_google_translate_preferences, is_empty_object_preferences,
};
use crate::error::StorageError;
use crate::repositories::{integration_instances, provider_models, translation_profiles};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::storage::Database;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use uuid::Uuid;

const ALLOWED_VARS: &[&str] = &["source_language", "target_language", "text"];
const AUTO_LANG: &str = "auto";
/// Translate capability name prefix before `@major`.
const TRANSLATE_TEXT_CAPABILITY_NAME: &str = "translate.text";
/// Detect capability name prefix before `@major`.
const DETECT_LANGUAGE_CAPABILITY_NAME: &str = "translate.detect";

#[derive(Clone)]
pub struct TranslationProfileService {
  db: Database,
  registry: Arc<ServiceIntegrationRegistry>,
}

impl TranslationProfileService {
  pub fn new(db: Database, registry: Arc<ServiceIntegrationRegistry>) -> Self {
    Self { db, registry }
  }

  /// List profiles with ordered target chains and prompt templates via bulk SQL (no N+1).
  ///
  /// SELECTs run inside one deferred read snapshot so a concurrent write
  /// cannot produce a torn view of profiles vs related rows.
  pub fn list(&self) -> Result<Vec<TranslationProfileDto>, StorageError> {
    self.db.read_snapshot(|conn| {
      let profiles = translation_profiles::list(conn)?;
      let all_targets = translation_profiles::list_all_targets(conn)?;
      let all_templates = translation_profiles::list_all_prompt_templates(conn)?;
      let mut targets_by_profile: HashMap<Uuid, Vec<TranslationProfileTarget>> = HashMap::new();
      for target in all_targets {
        targets_by_profile
          .entry(target.translation_profile_id)
          .or_default()
          .push(target);
      }
      let mut templates_by_profile: HashMap<Uuid, Vec<PromptTemplate>> = HashMap::new();
      for row in all_templates {
        templates_by_profile
          .entry(row.translation_profile_id)
          .or_default()
          .push(PromptTemplate {
            id: row.id,
            name: row.name,
            system_template: row.system_template,
            user_template: row.user_template,
          });
      }
      Ok(
        profiles
          .into_iter()
          .map(|profile| {
            let (targets, prompt_templates) = if profile.engine.is_llm() {
              (
                targets_by_profile.remove(&profile.id).unwrap_or_default(),
                templates_by_profile.remove(&profile.id).unwrap_or_default(),
              )
            } else {
              (Vec::new(), Vec::new())
            };
            TranslationProfileDto {
              profile,
              targets,
              prompt_templates,
            }
          })
          .collect(),
      )
    })
  }

  pub fn get(&self, id: Uuid) -> Result<TranslationProfileDto, StorageError> {
    self.db.read(|conn| translation_profiles::get(conn, id))
  }

  pub fn save(&self, input: TranslationProfileWrite) -> Result<TranslationProfileDto, StorageError> {
    self.db.transaction(|uow| {
      let conn = uow.conn();
      let now = now_rfc3339();
      let (id, created_at, is_new, existing_engine_kind, existing_plugin) = match input.id {
        None => (new_id(), now.clone(), true, None, None),
        Some(id) => {
          let existing = translation_profiles::get(conn, id)?;
          let existing_plugin = existing.profile.engine.as_plugin().cloned();
          (
            id,
            existing.profile.created_at,
            false,
            Some(existing.profile.engine.kind_str().to_string()),
            existing_plugin,
          )
        }
      };

      if let Some(existing_kind) = existing_engine_kind.as_deref() {
        if existing_kind != input.engine.kind_str() {
          return Err(StorageError::Validation(
            "profile engine_kind is immutable after creation".into(),
          ));
        }
      }

      validate_profile_language_preferences_for_save(&input.primary_lang, &input.preferred_target_lang)?;
      if input.name.trim().is_empty() {
        return Err(StorageError::Validation("profile name must not be empty".into()));
      }

      let (engine, targets, prompt_templates) = match &input.engine {
        TranslationProfileEngineWrite::LlmModelChain(llm) => {
          validate_llm_engine_write(conn, llm)?;
          let engine = TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
            template_version: llm.template_version,
            default_prompt_template_id: llm.default_prompt_template_id,
            temperature: llm.temperature,
            max_output_tokens: llm.max_output_tokens,
            provider_options_json: llm.provider_options_json.clone(),
            language_detection: llm.language_detection.clone(),
          });
          let targets: Vec<TranslationProfileTarget> = llm
            .target_model_ids
            .iter()
            .enumerate()
            .map(|(i, model_id)| TranslationProfileTarget {
              translation_profile_id: id,
              provider_model_id: *model_id,
              priority: i as i32,
            })
            .collect();
          (engine, targets, llm.prompt_templates.clone())
        }
        TranslationProfileEngineWrite::PluginCapability(plugin) => {
          validate_plugin_engine_write(conn, self.registry.as_ref(), plugin)?;
          if let Some(old_plugin) = existing_plugin.as_ref() {
            validate_plugin_rebind_compatibility(old_plugin, plugin)?;
          }
          let engine = TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
            integration_instance_id: plugin.integration_instance_id,
            translate_capability_id: plugin.translate_capability_id.trim().to_string(),
            detect_capability_id: plugin
              .detect_capability_id
              .as_ref()
              .map(|s| s.trim().to_string())
              .filter(|s| !s.is_empty()),
            capability_preferences_version: plugin.capability_preferences_version,
            capability_preferences: plugin.capability_preferences.clone(),
          });
          (engine, Vec::new(), Vec::new())
        }
      };

      let profile = TranslationProfile {
        id,
        name: input.name.clone(),
        enabled: input.enabled,
        source_lang: normalize_optional_lang(input.source_lang.as_deref()),
        target_lang: normalize_optional_lang(input.target_lang.as_deref()),
        primary_lang: normalize_optional_lang(input.primary_lang.as_deref()),
        preferred_target_lang: normalize_optional_lang(input.preferred_target_lang.as_deref()),
        engine,
        created_at,
        updated_at: now,
      };

      translation_profiles::save_with_targets(conn, &profile, &targets, &prompt_templates, is_new)?;
      translation_profiles::get(conn, id)
    })
  }

  pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<TranslationProfileDto, StorageError> {
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      translation_profiles::set_enabled(uow.conn(), id, enabled, &now)?;
      translation_profiles::get(uow.conn(), id)
    })
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    self.db.transaction(|uow| translation_profiles::delete(uow.conn(), id))
  }
}

fn validate_llm_engine_write(
  conn: &rusqlite::Connection,
  llm: &crate::domain::translation_profile::LlmModelChainEngineWrite,
) -> Result<(), StorageError> {
  if llm.target_model_ids.is_empty() {
    return Err(StorageError::Validation(
      "profile requires at least one target model".into(),
    ));
  }
  let mut seen = HashSet::new();
  for id in &llm.target_model_ids {
    if !seen.insert(*id) {
      return Err(StorageError::Validation("profile targets must be unique models".into()));
    }
    provider_models::get(conn, *id)?;
  }
  if let Some(temp) = llm.temperature {
    if temp < 0.0 {
      return Err(StorageError::Validation("temperature must be >= 0".into()));
    }
  }
  if let Some(tokens) = llm.max_output_tokens {
    if tokens <= 0 {
      return Err(StorageError::Validation("max_output_tokens must be > 0".into()));
    }
  }
  // Provider-specific profile options are unused; only empty/null objects are accepted.
  if let Some(options) = &llm.provider_options_json {
    if !options.is_null() && options.as_object().map(|o| !o.is_empty()).unwrap_or(true) {
      return Err(StorageError::Validation("provider_options_json must be empty".into()));
    }
  }
  // When a detector explicitly targets an LLM model, the model must exist.
  if let Some(LanguageDetectorConfig::Llm {
    model_id: Some(model_id),
  }) = llm.language_detection
  {
    provider_models::get(conn, model_id)?;
  }
  validate_prompt_templates(&llm.prompt_templates, llm.default_prompt_template_id)?;
  Ok(())
}

fn validate_plugin_engine_write(
  conn: &rusqlite::Connection,
  registry: &ServiceIntegrationRegistry,
  plugin: &crate::domain::translation_profile::PluginCapabilityEngineWrite,
) -> Result<(), StorageError> {
  let translate_id = plugin.translate_capability_id.trim();
  if translate_id.is_empty() {
    return Err(StorageError::Validation("translate_capability_id is required".into()));
  }
  validate_capability_id(translate_id).map_err(StorageError::Validation)?;
  if capability_name(translate_id) != Some(TRANSLATE_TEXT_CAPABILITY_NAME) {
    return Err(StorageError::Validation(
      "translate_capability_id must be a translate.text@N capability".into(),
    ));
  }

  let detect_id = plugin
    .detect_capability_id
    .as_ref()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
  if let Some(ref detect) = detect_id {
    validate_capability_id(detect).map_err(StorageError::Validation)?;
    if capability_name(detect) != Some(DETECT_LANGUAGE_CAPABILITY_NAME) {
      return Err(StorageError::Validation(
        "detect_capability_id must be a translate.detect@N capability".into(),
      ));
    }
  }

  let instance = integration_instances::get(conn, plugin.integration_instance_id)?;
  if !instance.enabled {
    return Err(StorageError::Validation(
      "integration instance must be enabled for plugin profiles".into(),
    ));
  }
  if !matches!(instance.health_status, IntegrationHealthStatus::Ready) {
    return Err(StorageError::Validation(
      "integration instance must be ready for plugin profiles".into(),
    ));
  }
  if !registry.contains(&instance.plugin_id) {
    return Err(StorageError::Validation(
      "integration plugin definition is missing".into(),
    ));
  }
  let manifest = registry
    .get(&instance.plugin_id)
    .ok_or_else(|| StorageError::Validation("integration plugin definition is missing".into()))?;

  if !manifest.capabilities.iter().any(|c| c.id == translate_id) {
    return Err(StorageError::Validation(format!(
      "translate capability {translate_id} is not declared on plugin {}",
      instance.plugin_id
    )));
  }
  if let Some(ref detect) = detect_id {
    if !manifest.capabilities.iter().any(|c| c.id == *detect) {
      return Err(StorageError::Validation(format!(
        "detect capability {detect} is not declared on plugin {}",
        instance.plugin_id
      )));
    }
  }

  // Google Translate preferences schema v1 = exactly `{}`.
  if instance.plugin_id == GOOGLE_CLOUD_PLUGIN_ID {
    if plugin.capability_preferences_version != GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION {
      return Err(StorageError::Validation(format!(
        "Google Translate preferences schema version must be {GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION}"
      )));
    }
    if !is_empty_object_preferences(&plugin.capability_preferences) {
      return Err(StorageError::Validation(
        "Google Translate preferences schema v1 must be exactly {}".into(),
      ));
    }
  } else if !is_empty_object_preferences(&plugin.capability_preferences)
    && plugin.capability_preferences_version == GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION
  {
    // Unknown plugins still reject unexpected keys on schema v1 empty-object convention.
    return Err(StorageError::Validation(
      "capability preferences contain unsupported keys".into(),
    ));
  }

  // Ensure stored preferences are a JSON object (not array/string/null).
  if !plugin.capability_preferences.is_object() {
    return Err(StorageError::Validation(
      "capability_preferences must be a JSON object".into(),
    ));
  }

  let _ = empty_google_translate_preferences();
  Ok(())
}

/// Extract capability name before `@major` (e.g. `translate.text` from `translate.text@1`).
pub fn capability_name(capability_id: &str) -> Option<&str> {
  capability_id.rsplit_once('@').map(|(name, _)| name)
}

/// Extract capability major version from a versioned id.
pub fn capability_major(capability_id: &str) -> Option<u32> {
  capability_id
    .rsplit_once('@')
    .and_then(|(_, version)| version.parse().ok())
}

/// True when two capability ids share name and major version.
pub fn capabilities_major_compatible(left: &str, right: &str) -> bool {
  capability_name(left) == capability_name(right) && capability_major(left) == capability_major(right)
}

/// Reject rebinds to instances whose translate/detect capability majors differ.
fn validate_plugin_rebind_compatibility(
  old_plugin: &PluginCapabilityEngine,
  new_plugin: &crate::domain::translation_profile::PluginCapabilityEngineWrite,
) -> Result<(), StorageError> {
  // No-op when binding target is unchanged.
  if old_plugin.integration_instance_id == new_plugin.integration_instance_id
    && old_plugin.translate_capability_id.trim() == new_plugin.translate_capability_id.trim()
  {
    let old_detect = old_plugin.detect_capability_id.as_deref().unwrap_or("");
    let new_detect = new_plugin.detect_capability_id.as_ref().map(|s| s.trim()).unwrap_or("");
    if old_detect == new_detect {
      return Ok(());
    }
  }

  let new_translate = new_plugin.translate_capability_id.trim();
  if !capabilities_major_compatible(&old_plugin.translate_capability_id, new_translate) {
    return Err(StorageError::Validation(
      "rebind rejected: translate capability major is incompatible".into(),
    ));
  }

  match (
    old_plugin.detect_capability_id.as_deref(),
    new_plugin
      .detect_capability_id
      .as_ref()
      .map(|s| s.trim().to_string())
      .filter(|s| !s.is_empty()),
  ) {
    (Some(old_detect), Some(new_detect)) => {
      if !capabilities_major_compatible(old_detect, &new_detect) {
        return Err(StorageError::Validation(
          "rebind rejected: detect capability major is incompatible".into(),
        ));
      }
    }
    // Losing or gaining optional detect is allowed when translate majors match.
    _ => {}
  }
  Ok(())
}

/// Validate the ordered prompt-template list and default selection for a profile write.
pub fn validate_prompt_templates(
  templates: &[PromptTemplate],
  default_prompt_template_id: Uuid,
) -> Result<(), StorageError> {
  if templates.is_empty() {
    return Err(StorageError::Validation(
      "profile requires at least one prompt template".into(),
    ));
  }
  let mut seen_ids = HashSet::new();
  for template in templates {
    if template.name.trim().is_empty() {
      return Err(StorageError::Validation(
        "prompt template name must not be empty".into(),
      ));
    }
    if !seen_ids.insert(template.id) {
      return Err(StorageError::Validation("prompt template ids must be unique".into()));
    }
    validate_template(&template.system_template, false)?;
    validate_template(&template.user_template, true)?;
  }
  if !seen_ids.contains(&default_prompt_template_id) {
    return Err(StorageError::Validation(
      "default_prompt_template_id must reference a template on this profile".into(),
    ));
  }
  Ok(())
}

/// Parse templates: allow only documented variables; user template requires `text` exactly once.
pub fn validate_template(template: &str, require_text_once: bool) -> Result<(), StorageError> {
  let mut text_count = 0usize;
  let mut rest = template;
  while let Some(start) = rest.find("{{") {
    let after = &rest[start + 2..];
    let Some(end) = after.find("}}") else {
      return Err(StorageError::Validation("unclosed template variable".into()));
    };
    let var = after[..end].trim();
    if !ALLOWED_VARS.contains(&var) {
      return Err(StorageError::Validation(format!("unknown template variable: {var}")));
    }
    if var == "text" {
      text_count += 1;
    }
    rest = &after[end + 2..];
  }
  if require_text_once && text_count != 1 {
    return Err(StorageError::Validation(
      "user_template must contain {{text}} exactly once".into(),
    ));
  }
  Ok(())
}

/// Render a profile template by substituting the three allowed variables.
pub fn render_template(template: &str, source_language: &str, target_language: &str, text: &str) -> String {
  let mut out = String::with_capacity(template.len() + text.len());
  let mut rest = template;
  while let Some(start) = rest.find("{{") {
    out.push_str(&rest[..start]);
    let after = &rest[start + 2..];
    let Some(end) = after.find("}}") else {
      out.push_str("{{");
      out.push_str(after);
      return out;
    };
    let var = after[..end].trim();
    match var {
      "source_language" => out.push_str(source_language),
      "target_language" => out.push_str(target_language),
      "text" => out.push_str(text),
      other => {
        out.push_str("{{");
        out.push_str(other);
        out.push_str("}}");
      }
    }
    rest = &after[end + 2..];
  }
  out.push_str(rest);
  out
}

fn normalize_optional_lang(value: Option<&str>) -> Option<String> {
  value.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_string())
}

/// Validate the profile Primary/Target preference pair.
///
/// Both fields are optional for backward compatibility with legacy rows/exports (both absent).
/// When supplied they must arrive together, be concrete supported ids (never `auto`), and differ.
/// This is the authoritative guard reused by import validation.
pub fn validate_profile_language_preferences(
  primary: &Option<String>,
  preferred_target: &Option<String>,
) -> Result<(), StorageError> {
  match (primary.as_deref(), preferred_target.as_deref()) {
    (None, None) => Ok(()),
    (Some(p), Some(t)) => {
      let p = p.trim();
      let t = t.trim();
      if p.is_empty() || t.is_empty() {
        return Err(StorageError::Validation(
          "primary_lang and preferred_target_lang must not be empty".into(),
        ));
      }
      if p == AUTO_LANG || t == AUTO_LANG {
        return Err(StorageError::Validation(
          "primary_lang and preferred_target_lang must not be auto".into(),
        ));
      }
      if !SUPPORTED_LANGUAGES.contains(&p) {
        return Err(StorageError::Validation(format!("unsupported primary_lang: {p}")));
      }
      if !SUPPORTED_LANGUAGES.contains(&t) {
        return Err(StorageError::Validation(format!(
          "unsupported preferred_target_lang: {t}"
        )));
      }
      if p == t {
        return Err(StorageError::Validation(
          "primary_lang and preferred_target_lang must differ".into(),
        ));
      }
      Ok(())
    }
    _ => Err(StorageError::Validation(
      "primary_lang and preferred_target_lang must be supplied together".into(),
    )),
  }
}

/// True when a profile preference field is absent or whitespace-only.
///
/// `normalize_optional_lang` stores such values as `None`, so legacy rows and exports with
/// missing/blank fields read back as `None` regardless of the input shape.
fn is_blank_lang(value: &Option<String>) -> bool {
  value.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none()
}

/// Validate the profile Primary/Target preference pair for a normal save (create/update).
///
/// A save through this service must carry a concrete, distinct preference pair: both fields
/// are required. This is stricter than [`validate_profile_language_preferences`], which still
/// accepts a legacy `(None, None)` pair so old rows/exports remain readable and importable.
pub fn validate_profile_language_preferences_for_save(
  primary: &Option<String>,
  preferred_target: &Option<String>,
) -> Result<(), StorageError> {
  validate_profile_language_preferences(primary, preferred_target)?;
  if is_blank_lang(primary) || is_blank_lang(preferred_target) {
    return Err(StorageError::Validation(
      "primary_lang and preferred_target_lang are required for profile save".into(),
    ));
  }
  Ok(())
}

/// Generate a new prompt-template id (used by callers that need a default template).
pub fn new_prompt_template_id() -> Uuid {
  new_id()
}
