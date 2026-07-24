// ABOUTME: Versioned configuration import/export document and preview types.
// ABOUTME: Documents never carry secrets, credential refs, or device state.
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::ProviderModel;
use crate::domain::provider::ProviderExport;
use crate::domain::settings::AppSettingsV1;
use crate::domain::translation_profile::{
  LlmModelChainEngine, TranslationProfile, TranslationProfileEngine, TranslationProfilePromptTemplate,
  TranslationProfileTarget,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Current configuration export format version (engine-tagged profiles + integrations).
pub const EXPORT_FORMAT_VERSION: u32 = 4;
/// Supported import format versions (normalized sequentially to v4).
pub const SUPPORTED_EXPORT_FORMAT_VERSIONS: &[u32] = &[2, 3, 4];

/// Sanitized integration instance row for export/import (no secrets, refs, or journal data).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInstanceExport {
  pub id: Uuid,
  pub plugin_id: String,
  pub plugin_version: String,
  pub display_name: String,
  pub enabled: bool,
  /// Non-secret common config JSON string.
  pub config_json: String,
  pub config_schema_version: u32,
  /// Last known health (may become unconfigured after import until re-auth).
  pub health_status: String,
  pub created_at: String,
  pub updated_at: String,
}

/// Current (v4) configuration export document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExport {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfile>,
  pub profile_models: Vec<TranslationProfileTarget>,
  /// Ordered prompt templates for all profiles (sort_order ascending within each profile).
  pub profile_prompt_templates: Vec<TranslationProfilePromptTemplate>,
  /// Sanitized integration instances (no credentials/refs).
  #[serde(default)]
  pub integration_instances: Vec<IntegrationInstanceExport>,
  pub app_settings: AppSettingsV1,
}

/// Flat LLM profile shape used by v2/v3 exports before the engine union.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfileV3 {
  pub id: Uuid,
  pub name: String,
  pub enabled: bool,
  pub template_version: i32,
  pub default_prompt_template_id: Uuid,
  pub temperature: Option<f64>,
  pub max_output_tokens: Option<i64>,
  pub provider_options_json: Option<serde_json::Value>,
  #[serde(default)]
  pub source_lang: Option<String>,
  #[serde(default)]
  pub target_lang: Option<String>,
  #[serde(default)]
  pub primary_lang: Option<String>,
  #[serde(default)]
  pub preferred_target_lang: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub language_detection: Option<LanguageDetectorConfig>,
  pub created_at: String,
  pub updated_at: String,
}

impl TranslationProfileV3 {
  pub fn into_v4_profile(self) -> TranslationProfile {
    TranslationProfile {
      id: self.id,
      name: self.name,
      enabled: self.enabled,
      source_lang: self.source_lang,
      target_lang: self.target_lang,
      primary_lang: self.primary_lang,
      preferred_target_lang: self.preferred_target_lang,
      engine: TranslationProfileEngine::LlmModelChain(LlmModelChainEngine {
        template_version: self.template_version,
        default_prompt_template_id: self.default_prompt_template_id,
        temperature: self.temperature,
        max_output_tokens: self.max_output_tokens,
        provider_options_json: self.provider_options_json,
        language_detection: self.language_detection,
      }),
      created_at: self.created_at,
      updated_at: self.updated_at,
    }
  }
}

/// v2/v3 document shape (no integration instances; flat profiles).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExportV3 {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfileV3>,
  pub profile_models: Vec<TranslationProfileTarget>,
  pub profile_prompt_templates: Vec<TranslationProfilePromptTemplate>,
  pub app_settings: AppSettingsV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportConflictMode {
  Merge,
  Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewCounts {
  pub providers_create: u32,
  pub providers_update: u32,
  pub providers_copy: u32,
  pub models_create: u32,
  pub models_update: u32,
  pub models_copy: u32,
  pub profiles_create: u32,
  pub profiles_update: u32,
  pub profiles_copy: u32,
  #[serde(default)]
  pub integrations_create: u32,
  #[serde(default)]
  pub integrations_update: u32,
  #[serde(default)]
  pub integrations_copy: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
  pub valid: bool,
  pub counts: ImportPreviewCounts,
  pub validation_errors: Vec<String>,
  /// Provider IDs (post-import IDs for copy mode) that need credentials.
  pub requires_authentication: Vec<Uuid>,
  /// Integration instance IDs that need credential re-entry after import.
  #[serde(default)]
  pub integration_requires_authentication: Vec<Uuid>,
  pub proxy_requires_authentication: bool,
  pub default_profile_cleared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
  pub preview: ImportPreview,
  pub applied: bool,
}

/// Normalize a v2 document value to the v3 structural shape (formatVersion bump only).
pub fn normalize_v2_to_v3(mut value: serde_json::Value) -> Result<serde_json::Value, String> {
  let obj = value
    .as_object_mut()
    .ok_or_else(|| "configuration root must be an object".to_string())?;
  let version = obj
    .get("formatVersion")
    .and_then(|v| v.as_u64())
    .ok_or_else(|| "missing formatVersion".to_string())? as u32;
  if version != 2 {
    return Err(format!("normalize_v2_to_v3 expects formatVersion 2, got {version}"));
  }
  obj.insert("formatVersion".into(), serde_json::json!(3));
  Ok(value)
}

/// Normalize a v3 document value to v4 (flat profiles → engine union, empty integrations).
pub fn normalize_v3_to_v4(value: serde_json::Value) -> Result<ConfigurationExport, String> {
  let v3: ConfigurationExportV3 =
    serde_json::from_value(value).map_err(|e| format!("invalid v3 configuration document: {e}"))?;
  if v3.format_version != 3 {
    return Err(format!(
      "normalize_v3_to_v4 expects formatVersion 3, got {}",
      v3.format_version
    ));
  }
  Ok(ConfigurationExport {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: v3.exported_at,
    providers: v3.providers,
    models: v3.models,
    translation_profiles: v3
      .translation_profiles
      .into_iter()
      .map(TranslationProfileV3::into_v4_profile)
      .collect(),
    profile_models: v3.profile_models,
    profile_prompt_templates: v3.profile_prompt_templates,
    integration_instances: Vec::new(),
    app_settings: v3.app_settings,
  })
}

/// Parse an untrusted JSON value into a normalized v4 configuration document.
pub fn parse_and_normalize_export_document(value: serde_json::Value) -> Result<ConfigurationExport, String> {
  let version = value
    .get("formatVersion")
    .and_then(|v| v.as_u64())
    .ok_or_else(|| "missing formatVersion".to_string())? as u32;
  if !SUPPORTED_EXPORT_FORMAT_VERSIONS.contains(&version) {
    return Err(format!("unsupported formatVersion {version}"));
  }
  match version {
    2 => {
      let v3_value = normalize_v2_to_v3(value)?;
      normalize_v3_to_v4(v3_value)
    }
    3 => normalize_v3_to_v4(value),
    4 => serde_json::from_value(value).map_err(|e| format!("invalid v4 configuration document: {e}")),
    other => Err(format!("unsupported formatVersion {other}")),
  }
}

/// Secret-like field names that must never appear in serialized export JSON.
pub const FORBIDDEN_EXPORT_SECRET_KEYS: &[&str] = &[
  "credentialRef",
  "credential_ref",
  "apiKeyRef",
  "secretKeyRef",
  "private_key",
  "privateKey",
  "client_email",
  "clientEmail",
  "access_token",
  "accessToken",
  "serviceAccountJson",
  "service_account_json",
  "newRef",
  "expectedOldRef",
];

/// Scan serialized export JSON text for forbidden secret/ref keys.
pub fn export_json_contains_forbidden_secret_keys(json: &str) -> Vec<String> {
  let mut found = Vec::new();
  for key in FORBIDDEN_EXPORT_SECRET_KEYS {
    // Match JSON object keys: "key":
    let needle = format!("\"{key}\"");
    if json.contains(&needle) {
      found.push((*key).to_string());
    }
  }
  found
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::settings::AppSettingsV1;
  use crate::domain::time::{new_id, now_rfc3339};

  #[test]
  fn export_document_round_trip() {
    let doc = ConfigurationExport {
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: "2026-07-10T00:00:00Z".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      integration_instances: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let json = serde_json::to_string(&doc).unwrap();
    assert!(json.contains("formatVersion"));
    assert!(json.contains("profilePromptTemplates"));
    assert!(json.contains("integrationInstances"));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("credential_ref"));
    let back: ConfigurationExport = serde_json::from_str(&json).unwrap();
    assert_eq!(back, doc);
    assert!(export_json_contains_forbidden_secret_keys(&json).is_empty());
  }

  #[test]
  fn secret_scan_catches_event_error_and_log_like_fixtures() {
    let fixtures = [
      r#"{"event":"credential","credentialRef":"provider/x","status":"ok"}"#,
      r#"{"errorCode":"auth","private_key":"BEGIN","message":"no"}"#,
      r#"{"log":"token","access_token":"ya29.abc","level":"info"}"#,
      r#"{"binding":{"service_account_json":"{}"}}"#,
    ];
    for fixture in fixtures {
      let found = export_json_contains_forbidden_secret_keys(fixture);
      assert!(
        !found.is_empty(),
        "expected forbidden keys in fixture {fixture}, found {found:?}"
      );
    }
    // Clean capability error/event shapes must remain free of secret keys.
    let clean = r#"{"errorCode":"auth","message":"auth failed","modelId":null,"ok":false}"#;
    assert!(export_json_contains_forbidden_secret_keys(clean).is_empty());
  }

  #[test]
  fn normalize_v3_flat_profile_to_engine_union() {
    let template_id = new_id();
    let profile_id = new_id();
    let now = now_rfc3339();
    let v3 = ConfigurationExportV3 {
      format_version: 3,
      exported_at: now.clone(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![TranslationProfileV3 {
        id: profile_id,
        name: "Legacy".into(),
        enabled: true,
        template_version: 1,
        default_prompt_template_id: template_id,
        temperature: Some(0.2),
        max_output_tokens: Some(128),
        provider_options_json: None,
        source_lang: Some("zh".into()),
        target_lang: Some("en".into()),
        primary_lang: Some("zh".into()),
        preferred_target_lang: Some("en".into()),
        language_detection: None,
        created_at: now.clone(),
        updated_at: now,
      }],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let value = serde_json::to_value(&v3).unwrap();
    let v4 = normalize_v3_to_v4(value).unwrap();
    assert_eq!(v4.format_version, 4);
    assert!(v4.integration_instances.is_empty());
    assert!(v4.translation_profiles[0].engine.is_llm());
    assert_eq!(
      v4.translation_profiles[0]
        .engine
        .as_llm()
        .unwrap()
        .default_prompt_template_id,
      template_id
    );
  }

  #[test]
  fn parse_and_normalize_rejects_unsupported_version() {
    let value = serde_json::json!({ "formatVersion": 99, "exportedAt": "t" });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(err.contains("unsupported formatVersion"));
  }
}
