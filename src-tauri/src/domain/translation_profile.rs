// ABOUTME: Translation profile entities with LLM vs plugin-capability engine union.
// ABOUTME: Common language fields sit outside the engine; child targets/templates are LLM-only.
use crate::domain::language_detection::LanguageDetectorConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// SQL / wire discriminant for LLM model-chain profiles.
pub const ENGINE_KIND_LLM_MODEL_CHAIN: &str = "llm_model_chain";
/// SQL / wire discriminant for plugin capability profiles.
pub const ENGINE_KIND_PLUGIN_CAPABILITY: &str = "plugin_capability";
/// Google Translate capability preferences schema version (v1 = empty object only).
pub const GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION: i32 = 1;

/// One named prompt template belonging to a translation profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
  pub id: Uuid,
  pub name: String,
  pub system_template: String,
  pub user_template: String,
}

/// LLM-owned profile fields: templates, sampling, and optional detector.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelChainEngine {
  pub template_version: i32,
  /// Id of the template used when translate does not pass an override.
  pub default_prompt_template_id: Uuid,
  pub temperature: Option<f64>,
  pub max_output_tokens: Option<i64>,
  pub provider_options_json: Option<Value>,
  /// Optional language detector config. `None` uses the default LLM detector with primary model.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub language_detection: Option<LanguageDetectorConfig>,
}

/// Plugin-owned profile fields: integration binding and capability preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapabilityEngine {
  pub integration_instance_id: Uuid,
  pub translate_capability_id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detect_capability_id: Option<String>,
  pub capability_preferences_version: i32,
  /// Capability-specific preferences. Google Translate v1 must be exactly `{}`.
  pub capability_preferences: Value,
}

/// Tagged profile engine. Discriminant serializes as snake_case (`llm_model_chain` / `plugin_capability`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranslationProfileEngine {
  LlmModelChain(LlmModelChainEngine),
  PluginCapability(PluginCapabilityEngine),
}

impl TranslationProfileEngine {
  pub fn kind_str(&self) -> &'static str {
    match self {
      Self::LlmModelChain(_) => ENGINE_KIND_LLM_MODEL_CHAIN,
      Self::PluginCapability(_) => ENGINE_KIND_PLUGIN_CAPABILITY,
    }
  }

  pub fn as_llm(&self) -> Option<&LlmModelChainEngine> {
    match self {
      Self::LlmModelChain(engine) => Some(engine),
      Self::PluginCapability(_) => None,
    }
  }

  pub fn as_plugin(&self) -> Option<&PluginCapabilityEngine> {
    match self {
      Self::PluginCapability(engine) => Some(engine),
      Self::LlmModelChain(_) => None,
    }
  }

  pub fn is_llm(&self) -> bool {
    matches!(self, Self::LlmModelChain(_))
  }

  pub fn is_plugin(&self) -> bool {
    matches!(self, Self::PluginCapability(_))
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfile {
  pub id: Uuid,
  pub name: String,
  pub enabled: bool,
  /// Preferred source language id for the translate UI (e.g. `zh`). Optional.
  #[serde(default)]
  pub source_lang: Option<String>,
  /// Preferred target language id for the translate UI (e.g. `en`). Optional; may be `auto`.
  #[serde(default)]
  pub target_lang: Option<String>,
  /// Profile Primary preference: concrete supported id used as the Auto-target fallback.
  #[serde(default)]
  pub primary_lang: Option<String>,
  /// Profile Target preference: concrete supported id used as the Auto-target default.
  #[serde(default)]
  pub preferred_target_lang: Option<String>,
  pub engine: TranslationProfileEngine,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfileTarget {
  pub translation_profile_id: Uuid,
  pub provider_model_id: Uuid,
  pub priority: i32,
}

/// Persistence row for a prompt template (includes profile ownership + list order).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfilePromptTemplate {
  pub id: Uuid,
  pub translation_profile_id: Uuid,
  pub name: String,
  pub system_template: String,
  pub user_template: String,
  pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfileDto {
  #[serde(flatten)]
  pub profile: TranslationProfile,
  /// Ordered model targets (LLM only; empty for plugin profiles).
  pub targets: Vec<TranslationProfileTarget>,
  /// Ordered prompt templates (LLM only; empty for plugin profiles).
  pub prompt_templates: Vec<PromptTemplate>,
}

/// Write input for LLM engine fields plus ordered targets/templates.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelChainEngineWrite {
  pub template_version: i32,
  /// Must reference one entry in `prompt_templates`.
  pub default_prompt_template_id: Uuid,
  /// Complete ordered template list for this profile (at least one).
  pub prompt_templates: Vec<PromptTemplate>,
  pub temperature: Option<f64>,
  pub max_output_tokens: Option<i64>,
  pub provider_options_json: Option<Value>,
  /// Optional language detector config. `None`/absent clears to the default LLM detector.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub language_detection: Option<LanguageDetectorConfig>,
  /// Ordered provider_model_ids; priority is assigned as 0..n-1.
  pub target_model_ids: Vec<Uuid>,
}

/// Write input for plugin engine fields.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapabilityEngineWrite {
  pub integration_instance_id: Uuid,
  pub translate_capability_id: String,
  #[serde(default)]
  pub detect_capability_id: Option<String>,
  pub capability_preferences_version: i32,
  pub capability_preferences: Value,
}

/// Tagged write engine. Discriminant matches persisted `engine_kind`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranslationProfileEngineWrite {
  LlmModelChain(LlmModelChainEngineWrite),
  PluginCapability(PluginCapabilityEngineWrite),
}

impl TranslationProfileEngineWrite {
  pub fn kind_str(&self) -> &'static str {
    match self {
      Self::LlmModelChain(_) => ENGINE_KIND_LLM_MODEL_CHAIN,
      Self::PluginCapability(_) => ENGINE_KIND_PLUGIN_CAPABILITY,
    }
  }
}

/// Write input for a profile and its engine-specific payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfileWrite {
  pub id: Option<Uuid>,
  pub name: String,
  pub enabled: bool,
  #[serde(default)]
  pub source_lang: Option<String>,
  #[serde(default)]
  pub target_lang: Option<String>,
  /// Profile Primary preference (concrete supported id). Absent on legacy writes.
  #[serde(default)]
  pub primary_lang: Option<String>,
  /// Profile Target preference (concrete supported id). Absent on legacy writes.
  #[serde(default)]
  pub preferred_target_lang: Option<String>,
  pub engine: TranslationProfileEngineWrite,
}

pub type TranslationProfileExport = TranslationProfile;
pub type ProfileTargetExport = TranslationProfileTarget;

/// Empty Google Translate preferences object (schema v1).
pub fn empty_google_translate_preferences() -> Value {
  Value::Object(serde_json::Map::new())
}

/// True when preferences are exactly the empty JSON object `{}`.
pub fn is_empty_object_preferences(value: &Value) -> bool {
  value.as_object().is_some_and(|obj| obj.is_empty())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::time::{new_id, now_rfc3339};

  #[test]
  fn translation_profile_engine_serde_snake_case_kind() {
    let llm = TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
      template_version: 1,
      default_prompt_template_id: new_id(),
      temperature: Some(0.2),
      max_output_tokens: Some(128),
      provider_options_json: None,
      language_detection: None,
    });
    let llm_json = serde_json::to_value(&llm).unwrap();
    assert_eq!(llm_json["kind"], "llm_model_chain");
    assert_eq!(llm_json["templateVersion"], 1);

    let plugin = TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
      integration_instance_id: new_id(),
      translate_capability_id: "translate.text@1".into(),
      detect_capability_id: Some("translate.detect@1".into()),
      capability_preferences_version: GOOGLE_TRANSLATE_PREFERENCES_SCHEMA_VERSION,
      capability_preferences: empty_google_translate_preferences(),
    });
    let plugin_json = serde_json::to_value(&plugin).unwrap();
    assert_eq!(plugin_json["kind"], "plugin_capability");
    assert_eq!(plugin_json["translateCapabilityId"], "translate.text@1");
    assert_eq!(plugin_json["capabilityPreferences"], serde_json::json!({}));
  }

  #[test]
  fn translation_profile_dto_flattens_common_fields() {
    let now = now_rfc3339();
    let template_id = new_id();
    let dto = TranslationProfileDto {
      profile: TranslationProfile {
        id: new_id(),
        name: "Demo".into(),
        enabled: true,
        source_lang: Some("zh".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        engine: TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
          template_version: 1,
          default_prompt_template_id: template_id,
          temperature: None,
          max_output_tokens: None,
          provider_options_json: None,
          language_detection: None,
        }),
        created_at: now.clone(),
        updated_at: now,
      },
      targets: vec![],
      prompt_templates: vec![PromptTemplate {
        id: template_id,
        name: "Default".into(),
        system_template: "s".into(),
        user_template: "{{text}}".into(),
      }],
    };
    let json = serde_json::to_value(&dto).unwrap();
    assert_eq!(json["name"], "Demo");
    assert_eq!(json["engine"]["kind"], "llm_model_chain");
    assert!(json["promptTemplates"].is_array());
    assert!(json.get("templateVersion").is_none());
  }
}
