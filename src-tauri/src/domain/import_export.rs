// ABOUTME: Versioned configuration import/export document and preview types.
// ABOUTME: Documents never carry secrets, credential refs, or device state.
use crate::domain::language_detection::LanguageDetectorConfig;
use crate::domain::model::ProviderModel;
use crate::domain::ocr_service::{BaiduOcrAction, OcrProviderType};
use crate::domain::provider::ProviderExport;
use crate::domain::settings::AppSettingsV1;
use crate::domain::translation_profile::{
  LlmModelChainEngine, TranslationProfile, TranslationProfileEngine, TranslationProfilePromptTemplate,
  TranslationProfileTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Current configuration export format version (runtime requirements + Speech + OCR + integrations).
pub const EXPORT_FORMAT_VERSION: u32 = 7;
/// Supported import format versions (normalized sequentially to v7).
pub const SUPPORTED_EXPORT_FORMAT_VERSIONS: &[u32] = &[2, 3, 4, 5, 6, 7];

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
  /// Exact runtime requirement (v7+). Older formats normalize to bundled-rust.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub runtime: Option<crate::domain::runtime_lifecycle::RuntimeRequirementExport>,
  pub created_at: String,
  pub updated_at: String,
}

/// Sanitized OCR service for export/import (no vault refs or secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrServiceExport {
  pub id: Uuid,
  pub provider_type: OcrProviderType,
  pub display_name: String,
  pub enabled: bool,
  pub sort_order: i32,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub baidu_action: Option<BaiduOcrAction>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub provider_model_id: Option<Uuid>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub temperature: Option<f64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default_prompt_template_id: Option<Uuid>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub integration_instance_id: Option<Uuid>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ocr_capability_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_preferences_version: Option<i32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_preferences: Option<Value>,
  pub created_at: String,
  pub updated_at: String,
}

/// AI OCR prompt template row for export/import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPromptTemplateExport {
  pub id: Uuid,
  pub ocr_service_id: Uuid,
  pub name: String,
  pub system_template: String,
  pub user_template: String,
  pub sort_order: i32,
}

/// Sanitized Speech service for export/import (no audio, text, or credentials).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechServiceExport {
  pub id: Uuid,
  pub display_name: String,
  pub enabled: bool,
  pub sort_order: i32,
  pub integration_instance_id: Uuid,
  pub capability_id: String,
  pub preferences_schema_version: i32,
  pub preferences: Value,
  pub created_at: String,
  pub updated_at: String,
}

/// Current (v7) configuration export document.
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
  /// OCR services (baidu/ai/plugin); secrets omitted.
  #[serde(default)]
  pub ocr_services: Vec<OcrServiceExport>,
  /// Ordered AI OCR prompt templates for all OCR services.
  #[serde(default)]
  pub ocr_prompt_templates: Vec<OcrPromptTemplateExport>,
  /// Speech services (capability-backed); audio/text/credentials omitted.
  #[serde(default)]
  pub speech_services: Vec<SpeechServiceExport>,
  pub app_settings: AppSettingsV1,
}

/// v6 document shape (Speech services; no required runtime requirement records).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExportV6 {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfile>,
  pub profile_models: Vec<TranslationProfileTarget>,
  pub profile_prompt_templates: Vec<TranslationProfilePromptTemplate>,
  #[serde(default)]
  pub integration_instances: Vec<IntegrationInstanceExport>,
  #[serde(default)]
  pub ocr_services: Vec<OcrServiceExport>,
  #[serde(default)]
  pub ocr_prompt_templates: Vec<OcrPromptTemplateExport>,
  #[serde(default)]
  pub speech_services: Vec<SpeechServiceExport>,
  pub app_settings: AppSettingsV1,
}

/// v5 document shape (OCR services + templates; no Speech arrays).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExportV5 {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfile>,
  pub profile_models: Vec<TranslationProfileTarget>,
  pub profile_prompt_templates: Vec<TranslationProfilePromptTemplate>,
  #[serde(default)]
  pub integration_instances: Vec<IntegrationInstanceExport>,
  #[serde(default)]
  pub ocr_services: Vec<OcrServiceExport>,
  #[serde(default)]
  pub ocr_prompt_templates: Vec<OcrPromptTemplateExport>,
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

/// v4 document shape (engine-tagged profiles + integrations; no OCR arrays).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExportV4 {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfile>,
  pub profile_models: Vec<TranslationProfileTarget>,
  pub profile_prompt_templates: Vec<TranslationProfilePromptTemplate>,
  #[serde(default)]
  pub integration_instances: Vec<IntegrationInstanceExport>,
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
  #[serde(default)]
  pub ocr_services_create: u32,
  #[serde(default)]
  pub ocr_services_update: u32,
  #[serde(default)]
  pub ocr_services_copy: u32,
  #[serde(default)]
  pub speech_services_create: u32,
  #[serde(default)]
  pub speech_services_update: u32,
  #[serde(default)]
  pub speech_services_copy: u32,
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
  /// Baidu OCR service IDs that need API/secret re-entry after import.
  #[serde(default)]
  pub ocr_requires_authentication: Vec<Uuid>,
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
pub fn normalize_v3_to_v4(value: serde_json::Value) -> Result<ConfigurationExportV4, String> {
  let v3: ConfigurationExportV3 =
    serde_json::from_value(value).map_err(|e| format!("invalid v3 configuration document: {e}"))?;
  if v3.format_version != 3 {
    return Err(format!(
      "normalize_v3_to_v4 expects formatVersion 3, got {}",
      v3.format_version
    ));
  }
  Ok(ConfigurationExportV4 {
    format_version: 4,
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

/// Normalize a v4 document to v5 (add empty OCR arrays).
pub fn normalize_v4_to_v5(value: serde_json::Value) -> Result<ConfigurationExportV5, String> {
  let v4: ConfigurationExportV4 =
    serde_json::from_value(value).map_err(|e| format!("invalid v4 configuration document: {e}"))?;
  if v4.format_version != 4 {
    return Err(format!(
      "normalize_v4_to_v5 expects formatVersion 4, got {}",
      v4.format_version
    ));
  }
  Ok(ConfigurationExportV5 {
    format_version: 5,
    exported_at: v4.exported_at,
    providers: v4.providers,
    models: v4.models,
    translation_profiles: v4.translation_profiles,
    profile_models: v4.profile_models,
    profile_prompt_templates: v4.profile_prompt_templates,
    integration_instances: v4.integration_instances,
    ocr_services: Vec::new(),
    ocr_prompt_templates: Vec::new(),
    app_settings: v4.app_settings,
  })
}

/// Normalize a v5 document to v6 (add empty Speech services array).
pub fn normalize_v5_to_v6(value: serde_json::Value) -> Result<ConfigurationExportV6, String> {
  let v5: ConfigurationExportV5 =
    serde_json::from_value(value).map_err(|e| format!("invalid v5 configuration document: {e}"))?;
  if v5.format_version != 5 {
    return Err(format!(
      "normalize_v5_to_v6 expects formatVersion 5, got {}",
      v5.format_version
    ));
  }
  Ok(ConfigurationExportV6 {
    format_version: 6,
    exported_at: v5.exported_at,
    providers: v5.providers,
    models: v5.models,
    translation_profiles: v5.translation_profiles,
    profile_models: v5.profile_models,
    profile_prompt_templates: v5.profile_prompt_templates,
    integration_instances: v5.integration_instances,
    ocr_services: v5.ocr_services,
    ocr_prompt_templates: v5.ocr_prompt_templates,
    speech_services: Vec::new(),
    app_settings: v5.app_settings,
  })
}

/// Normalize a v6 document to v7 (map integrations/providers to Bundled Rust identities).
pub fn normalize_v6_to_v7(value: serde_json::Value) -> Result<ConfigurationExport, String> {
  let v6: ConfigurationExportV6 =
    serde_json::from_value(value).map_err(|e| format!("invalid v6 configuration document: {e}"))?;
  if v6.format_version != 6 {
    return Err(format!(
      "normalize_v6_to_v7 expects formatVersion 6, got {}",
      v6.format_version
    ));
  }
  let integration_instances = v6
    .integration_instances
    .into_iter()
    .map(|mut row| {
      if row.runtime.is_none() {
        row.runtime = Some(crate::domain::runtime_lifecycle::RuntimeRequirementExport {
          plugin_id: row.plugin_id.clone(),
          plugin_version: row.plugin_version.clone(),
          runtime_kind: "bundled-rust".into(),
          package_digest: None,
          publisher_key_id: None,
          publisher_key_fingerprint: None,
          plugin_api_version: None,
          config_schema_version: row.config_schema_version,
          required_capability_majors: Vec::new(),
          provider_runtime_kind: None,
          provider_package_digest: None,
        });
      }
      row
    })
    .collect();
  Ok(ConfigurationExport {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: v6.exported_at,
    providers: v6.providers,
    models: v6.models,
    translation_profiles: v6.translation_profiles,
    profile_models: v6.profile_models,
    profile_prompt_templates: v6.profile_prompt_templates,
    integration_instances,
    ocr_services: v6.ocr_services,
    ocr_prompt_templates: v6.ocr_prompt_templates,
    speech_services: v6.speech_services,
    app_settings: v6.app_settings,
  })
}

/// Parse an untrusted JSON value into a normalized v7 configuration document.
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
      let v4 = normalize_v3_to_v4(v3_value)?;
      let v5 = normalize_v4_to_v5(serde_json::to_value(v4).map_err(|e| e.to_string())?)?;
      let v6 = normalize_v5_to_v6(serde_json::to_value(v5).map_err(|e| e.to_string())?)?;
      normalize_v6_to_v7(serde_json::to_value(v6).map_err(|e| e.to_string())?)
    }
    3 => {
      let v4 = normalize_v3_to_v4(value)?;
      let v5 = normalize_v4_to_v5(serde_json::to_value(v4).map_err(|e| e.to_string())?)?;
      let v6 = normalize_v5_to_v6(serde_json::to_value(v5).map_err(|e| e.to_string())?)?;
      normalize_v6_to_v7(serde_json::to_value(v6).map_err(|e| e.to_string())?)
    }
    4 => {
      let v5 = normalize_v4_to_v5(value)?;
      let v6 = normalize_v5_to_v6(serde_json::to_value(v5).map_err(|e| e.to_string())?)?;
      normalize_v6_to_v7(serde_json::to_value(v6).map_err(|e| e.to_string())?)
    }
    5 => {
      let v6 = normalize_v5_to_v6(value)?;
      normalize_v6_to_v7(serde_json::to_value(v6).map_err(|e| e.to_string())?)
    }
    6 => normalize_v6_to_v7(value),
    7 => {
      let doc: ConfigurationExport =
        serde_json::from_value(value).map_err(|e| format!("invalid v7 configuration document: {e}"))?;
      // v7 documents must carry explicit runtime records; only v2–v6 normalization may synthesize
      // bundled identities. Fail closed on missing/malformed package-backed fields.
      for row in &doc.integration_instances {
        let Some(req) = row.runtime.as_ref() else {
          return Err(format!(
            "v7 integration {} is missing required runtime requirement",
            row.id
          ));
        };
        if req.plugin_id != row.plugin_id || req.plugin_version != row.plugin_version {
          return Err(format!(
            "v7 integration {} runtime identity does not match outer fields",
            row.id
          ));
        }
        if req.config_schema_version != row.config_schema_version {
          return Err(format!(
            "v7 integration {} runtime config_schema_version mismatch",
            row.id
          ));
        }
        let kind = crate::domain::runtime_lifecycle::parse_runtime_kind(&req.runtime_kind)
          .map_err(|e| format!("v7 integration {} has invalid runtimeKind: {e}", row.id))?;
        // Domain parsers for plugin identity and schema majors (fail closed).
        crate::domain::runtime_plugin::SemVerVersion::parse(&req.plugin_version)
          .map_err(|e| format!("v7 integration {} has invalid pluginVersion: {e}", row.id))?;
        if req.config_schema_version < 1 {
          return Err(format!("v7 integration {} config_schema_version must be >= 1", row.id));
        }
        for major in &req.required_capability_majors {
          crate::domain::runtime_plugin::CapabilityId::parse(major).map_err(|e| {
            format!(
              "v7 integration {} has invalid requiredCapabilityMajors entry: {e:?}",
              row.id
            )
          })?;
        }
        match kind {
          crate::domain::runtime_plugin::RuntimeKind::WasmComponent
          | crate::domain::runtime_plugin::RuntimeKind::TrustedNativeWorker => {
            // Trim only for empty-presence checks; domain parsers receive the raw string
            // so surrounding whitespace fails closed.
            let digest = req.package_digest.as_deref().ok_or_else(|| {
              format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              )
            })?;
            if digest.trim().is_empty() {
              return Err(format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              ));
            }
            crate::domain::runtime_plugin::PackageDigest::parse(digest)
              .map_err(|e| format!("v7 integration {} has invalid packageDigest: {e}", row.id))?;
            let key_id = req.publisher_key_id.as_deref().ok_or_else(|| {
              format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              )
            })?;
            if key_id.trim().is_empty() {
              return Err(format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              ));
            }
            crate::domain::runtime_plugin::PublisherKeyId::parse(key_id)
              .map_err(|e| format!("v7 integration {} has invalid publisherKeyId: {e}", row.id))?;
            let fingerprint = req.publisher_key_fingerprint.as_deref().ok_or_else(|| {
              format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              )
            })?;
            if fingerprint.trim().is_empty() {
              return Err(format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              ));
            }
            crate::domain::runtime_plugin::PublisherKeyFingerprint::parse(fingerprint)
              .map_err(|e| format!("v7 integration {} has invalid publisherKeyFingerprint: {e}", row.id))?;
            let api = req.plugin_api_version.as_deref().ok_or_else(|| {
              format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              )
            })?;
            if api.trim().is_empty() {
              return Err(format!(
                "v7 integration {} package-backed runtime is missing mandatory fields",
                row.id
              ));
            }
            crate::domain::runtime_plugin::PluginApiVersion::parse(api)
              .map_err(|e| format!("v7 integration {} has invalid pluginApiVersion: {e}", row.id))?;
          }
          crate::domain::runtime_plugin::RuntimeKind::BundledRust => {
            if req.package_digest.is_some() {
              return Err(format!(
                "v7 integration {} bundled runtime must not include package digest",
                row.id
              ));
            }
          }
          crate::domain::runtime_plugin::RuntimeKind::LegacyFrontendProvider => {}
        }
      }
      Ok(doc)
    }
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
  // Speech runtime payloads must never appear in configuration documents.
  "audioContent",
  "audio_content",
  "mp3Bytes",
  "mp3_bytes",
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
      ocr_services: vec![],
      ocr_prompt_templates: vec![],
      speech_services: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let json = serde_json::to_string(&doc).unwrap();
    assert!(json.contains("formatVersion"));
    assert!(json.contains("profilePromptTemplates"));
    assert!(json.contains("integrationInstances"));
    assert!(json.contains("ocrServices"));
    assert!(json.contains("ocrPromptTemplates"));
    assert!(json.contains("speechServices"));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("credential_ref"));
    assert!(!json.contains("audioContent"));
    assert!(!json.contains("mp3Bytes"));
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
      r#"{"response":{"audioContent":"ID3fake"}}"#,
      r#"{"payload":{"mp3Bytes":"not-exported"}}"#,
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
    let v5 = normalize_v4_to_v5(serde_json::to_value(&v4).unwrap()).unwrap();
    assert_eq!(v5.format_version, 5);
    assert!(v5.ocr_services.is_empty());
    assert!(v5.ocr_prompt_templates.is_empty());
    let v6 = normalize_v5_to_v6(serde_json::to_value(&v5).unwrap()).unwrap();
    assert_eq!(v6.format_version, 6);
    assert!(v6.speech_services.is_empty());
  }

  #[test]
  fn normalize_v4_to_v5_adds_empty_ocr_arrays() {
    let v4 = ConfigurationExportV4 {
      format_version: 4,
      exported_at: "t".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      integration_instances: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let v5 = normalize_v4_to_v5(serde_json::to_value(&v4).unwrap()).unwrap();
    assert_eq!(v5.format_version, 5);
    assert!(v5.ocr_services.is_empty());
    assert!(v5.ocr_prompt_templates.is_empty());
  }

  #[test]
  fn normalize_v5_to_v6_adds_empty_speech_services() {
    let v5 = ConfigurationExportV5 {
      format_version: 5,
      exported_at: "t".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      integration_instances: vec![],
      ocr_services: vec![],
      ocr_prompt_templates: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let v6 = normalize_v5_to_v6(serde_json::to_value(&v5).unwrap()).unwrap();
    assert_eq!(v6.format_version, 6);
    assert!(v6.speech_services.is_empty());
  }

  #[test]
  fn import_format_v2_through_v7_normalizes_to_current() {
    for version in [2_u32, 3, 4, 5, 6, 7] {
      let mut value = serde_json::json!({
        "formatVersion": version,
        "exportedAt": "t",
        "providers": [],
        "models": [],
        "translationProfiles": [],
        "profileModels": [],
        "profilePromptTemplates": [],
        "appSettings": AppSettingsV1::default_document(),
      });
      if version >= 3 {
        // v3+ flat profile shape is accepted by sequential normalization helpers.
      }
      if version == 7 {
        value["integrationInstances"] = serde_json::json!([]);
        value["ocrServices"] = serde_json::json!([]);
        value["ocrPromptTemplates"] = serde_json::json!([]);
        value["speechServices"] = serde_json::json!([]);
      }
      let doc = parse_and_normalize_export_document(value).unwrap_or_else(|e| panic!("v{version}: {e}"));
      assert_eq!(doc.format_version, EXPORT_FORMAT_VERSION, "version {version}");
    }
  }

  #[test]
  fn parse_and_normalize_v5_yields_v7_empty_speech() {
    let v5 = ConfigurationExportV5 {
      format_version: 5,
      exported_at: "t".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      integration_instances: vec![],
      ocr_services: vec![],
      ocr_prompt_templates: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let doc = parse_and_normalize_export_document(serde_json::to_value(&v5).unwrap()).unwrap();
    assert_eq!(doc.format_version, 7);
    assert!(doc.speech_services.is_empty());
  }

  #[test]
  fn runtime_plugin_export_v7_maps_legacy_integrations_to_bundled_rust() {
    let v6 = ConfigurationExportV6 {
      format_version: 6,
      exported_at: "t".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      profile_prompt_templates: vec![],
      integration_instances: vec![IntegrationInstanceExport {
        id: uuid::Uuid::nil(),
        plugin_id: "com.langnext.google-cloud".into(),
        plugin_version: "1.0.0".into(),
        display_name: "Cloud".into(),
        enabled: true,
        config_json: "{}".into(),
        config_schema_version: 1,
        health_status: "ready".into(),
        runtime: None,
        created_at: "t".into(),
        updated_at: "t".into(),
      }],
      ocr_services: vec![],
      ocr_prompt_templates: vec![],
      speech_services: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let doc = normalize_v6_to_v7(serde_json::to_value(&v6).unwrap()).unwrap();
    assert_eq!(doc.format_version, 7);
    let runtime = doc.integration_instances[0].runtime.as_ref().unwrap();
    assert_eq!(runtime.runtime_kind, "bundled-rust");
    assert!(runtime.package_digest.is_none());
  }

  #[test]
  fn parse_and_normalize_rejects_unsupported_version() {
    let value = serde_json::json!({ "formatVersion": 99, "exportedAt": "t" });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(err.contains("unsupported formatVersion"));
  }

  #[test]
  fn v7_missing_runtime_fails_closed() {
    let value = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000001",
        "pluginId": "com.langnext.google-translate-web",
        "pluginVersion": "1.0.0",
        "displayName": "Web",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("missing required runtime") || err.contains("runtime"),
      "expected missing runtime error, got {err}"
    );
  }

  #[test]
  fn v7_package_backed_missing_fingerprint_fails_closed() {
    let value = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000002",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "Wasm",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "publisherKeyId": "com.example.keys.1",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["translate.text@1"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("mandatory fields") || err.contains("fingerprint"),
      "expected package-backed mandatory field error, got {err}"
    );
  }

  #[test]
  fn v7_unknown_runtime_kind_fails_closed() {
    let value = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000099",
        "pluginId": "com.example.x",
        "pluginVersion": "1.0.0",
        "displayName": "X",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "com.example.x",
          "pluginVersion": "1.0.0",
          "runtimeKind": "not-a-real-kind",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": []
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(value).unwrap_err();
    assert!(
      err.contains("invalid runtimeKind") || err.contains("runtimeKind"),
      "expected unknown runtimeKind error, got {err}"
    );
  }

  #[test]
  fn v7_invalid_package_digest_fails_closed() {
    let doc = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000001",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "x",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": "not-hex",
          "publisherKeyId": "langnext.vendor.test",
          "publisherKeyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["translate.text@1"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(doc).unwrap_err();
    assert!(
      err.contains("packageDigest") || err.contains("package digest"),
      "expected package digest error, got {err}"
    );
  }

  #[test]
  fn v7_invalid_publisher_key_id_fails_closed() {
    let doc = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000002",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "x",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "publisherKeyId": "BAD KEY",
          "publisherKeyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["translate.text@1"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(doc).unwrap_err();
    assert!(
      err.contains("publisherKeyId") || err.contains("publisher key id"),
      "expected publisher key id error, got {err}"
    );
  }

  #[test]
  fn v7_invalid_capability_major_fails_closed() {
    let doc = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000003",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "x",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "publisherKeyId": "langnext.vendor.test",
          "publisherKeyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["not-a-capability"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(doc).unwrap_err();
    assert!(
      err.contains("requiredCapabilityMajors") || err.contains("capability"),
      "expected capability major error, got {err}"
    );
  }

  #[test]
  fn v7_package_digest_surrounding_whitespace_fails_closed() {
    let padded = format!(" {} ", "a".repeat(64));
    let doc = serde_json::json!({
      "formatVersion": 7,
      "exportedAt": "t",
      "providers": [],
      "models": [],
      "translationProfiles": [],
      "profileModels": [],
      "profilePromptTemplates": [],
      "integrationInstances": [{
        "id": "00000000-0000-0000-0000-000000000011",
        "pluginId": "langnext.conformance",
        "pluginVersion": "1.0.0",
        "displayName": "x",
        "enabled": true,
        "configJson": "{}",
        "configSchemaVersion": 1,
        "healthStatus": "ready",
        "runtime": {
          "pluginId": "langnext.conformance",
          "pluginVersion": "1.0.0",
          "runtimeKind": "wasm-component",
          "packageDigest": padded,
          "publisherKeyId": "langnext.vendor.test",
          "publisherKeyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pluginApiVersion": "1.0",
          "configSchemaVersion": 1,
          "requiredCapabilityMajors": ["translate.text@1"]
        },
        "createdAt": "t",
        "updatedAt": "t"
      }],
      "ocrServices": [],
      "ocrPromptTemplates": [],
      "speechServices": [],
      "appSettings": AppSettingsV1::default_document(),
    });
    let err = parse_and_normalize_export_document(doc).unwrap_err();
    assert!(
      err.contains("packageDigest") || err.contains("package digest") || err.contains("whitespace"),
      "expected whitespace digest fail, got {err}"
    );
  }
}
