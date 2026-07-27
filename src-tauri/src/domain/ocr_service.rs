// ABOUTME: OCR service domain entities, write inputs, and sanitized DTOs.
// ABOUTME: Vault refs and secrets never appear on IPC DTOs.
use crate::domain::provider::CredentialUpdate;
use crate::domain::service_capability::{OcrImageOperation, OcrImagePreferences};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

/// Maximum length for OCR service display names.
pub const OCR_DISPLAY_NAME_MAX_LEN: usize = 128;
/// Maximum length for OCR AI prompt template names.
pub const OCR_PROMPT_TEMPLATE_NAME_MAX_LEN: usize = 64;
/// Google Vision OCR preferences schema version (v1: operation + languageHints).
pub const GOOGLE_VISION_PREFERENCES_SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrProviderType {
  Baidu,
  Ai,
  PluginCapability,
}

impl OcrProviderType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Baidu => "baidu",
      Self::Ai => "ai",
      Self::PluginCapability => "plugin_capability",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "baidu" => Ok(Self::Baidu),
      "ai" => Ok(Self::Ai),
      "plugin_capability" => Ok(Self::PluginCapability),
      other => Err(format!("invalid ocr provider_type: {other}")),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BaiduOcrAction {
  Accurate,
  AccurateBasic,
  General,
  GeneralBasic,
}

impl BaiduOcrAction {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Accurate => "accurate",
      Self::AccurateBasic => "accurate_basic",
      Self::General => "general",
      Self::GeneralBasic => "general_basic",
    }
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    match value {
      "accurate" => Ok(Self::Accurate),
      "accurate_basic" => Ok(Self::AccurateBasic),
      "general" => Ok(Self::General),
      "general_basic" => Ok(Self::GeneralBasic),
      other => Err(format!("invalid baidu_action: {other}")),
    }
  }
}

/// Default Google Vision OCR preferences for schema v1.
pub fn default_google_vision_preferences() -> Value {
  json!({
    "operation": "document_text_detection",
    "language-hints": [],
  })
}

/// Parse stored preferences JSON into typed OCR image preferences.
pub fn parse_ocr_image_preferences(value: &Value) -> Result<OcrImagePreferences, String> {
  serde_json::from_value(value.clone()).map_err(|e| format!("invalid OCR preferences: {e}"))
}

/// Internal OCR service row including opaque vault references.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrService {
  pub id: Uuid,
  pub provider_type: OcrProviderType,
  pub display_name: String,
  pub enabled: bool,
  pub sort_order: i32,
  pub baidu_action: Option<BaiduOcrAction>,
  pub api_key_ref: Option<String>,
  pub secret_key_ref: Option<String>,
  pub provider_model_id: Option<Uuid>,
  pub temperature: Option<f64>,
  pub default_prompt_template_id: Option<Uuid>,
  /// Plugin-only: integration instance binding.
  pub integration_instance_id: Option<Uuid>,
  /// Plugin-only: capability id (e.g. `ocr.image@1`).
  pub ocr_capability_id: Option<String>,
  /// Plugin-only: preferences schema version.
  pub capability_preferences_version: Option<i32>,
  /// Plugin-only: preferences JSON object.
  pub capability_preferences: Option<Value>,
  pub created_at: String,
  pub updated_at: String,
}

/// One named prompt template belonging to an AI OCR service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrPromptTemplate {
  pub id: Uuid,
  pub name: String,
  pub system_template: String,
  pub user_template: String,
}

/// Persistence row for an OCR prompt template (includes ownership + list order).
#[derive(Debug, Clone, PartialEq)]
pub struct OcrPromptTemplateRow {
  pub id: Uuid,
  pub ocr_service_id: Uuid,
  pub name: String,
  pub system_template: String,
  pub user_template: String,
  pub sort_order: i32,
}

/// Sanitized OCR service DTO for IPC. Never includes vault refs or secrets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrServiceDto {
  pub id: Uuid,
  pub provider_type: OcrProviderType,
  pub display_name: String,
  pub enabled: bool,
  pub sort_order: i32,
  /// Baidu only; null for ai / plugin.
  pub baidu_action: Option<BaiduOcrAction>,
  pub has_api_key: bool,
  pub has_secret_key: bool,
  /// AI only; null for baidu / plugin.
  pub provider_model_id: Option<Uuid>,
  pub temperature: Option<f64>,
  pub default_prompt_template_id: Option<Uuid>,
  /// Empty for baidu / plugin; ordered templates for ai.
  pub prompt_templates: Vec<OcrPromptTemplate>,
  /// Plugin only; null for baidu / ai.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub integration_instance_id: Option<Uuid>,
  /// Plugin only; null for baidu / ai.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ocr_capability_id: Option<String>,
  /// Plugin only; null for baidu / ai.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_preferences_version: Option<i32>,
  /// Plugin only; null for baidu / ai.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub capability_preferences: Option<Value>,
  pub created_at: String,
  pub updated_at: String,
}

impl OcrServiceDto {
  pub fn from_service(service: &OcrService, prompt_templates: Vec<OcrPromptTemplate>) -> Self {
    Self {
      id: service.id,
      provider_type: service.provider_type,
      display_name: service.display_name.clone(),
      enabled: service.enabled,
      sort_order: service.sort_order,
      baidu_action: service.baidu_action,
      has_api_key: service.api_key_ref.is_some(),
      has_secret_key: service.secret_key_ref.is_some(),
      provider_model_id: service.provider_model_id,
      temperature: service.temperature,
      default_prompt_template_id: service.default_prompt_template_id,
      prompt_templates,
      integration_instance_id: service.integration_instance_id,
      ocr_capability_id: service.ocr_capability_id.clone(),
      capability_preferences_version: service.capability_preferences_version,
      capability_preferences: service.capability_preferences.clone(),
      created_at: service.created_at.clone(),
      updated_at: service.updated_at.clone(),
    }
  }
}

/// Input for one-shot image OCR recognition.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRecognizeInput {
  /// Cropped PNG image encoded as standard base64 (no data-URL prefix).
  pub png_base64: String,
  /// Explicit service; when null/absent the app settings default is used.
  #[serde(default)]
  pub ocr_service_id: Option<Uuid>,
  /// Optional client request id for cancellation via the shared session registry.
  #[serde(default)]
  pub request_id: Option<String>,
}

/// Recognized plain text from an OCR service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OcrRecognizeResult {
  pub text: String,
  pub ocr_service_id: Uuid,
}

/// Input for creating or updating an OCR service.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrServiceWrite {
  pub id: Option<Uuid>,
  pub provider_type: OcrProviderType,
  pub display_name: String,
  pub enabled: bool,
  /// Baidu required on baidu writes.
  #[serde(default)]
  pub baidu_action: Option<BaiduOcrAction>,
  #[serde(default)]
  pub api_key: CredentialUpdate,
  #[serde(default)]
  pub secret_key: CredentialUpdate,
  /// AI required on ai writes.
  #[serde(default)]
  pub provider_model_id: Option<Uuid>,
  #[serde(default)]
  pub temperature: Option<f64>,
  #[serde(default)]
  pub default_prompt_template_id: Option<Uuid>,
  /// Full ordered list; required for ai (≥1). Empty/ignored for baidu / plugin.
  #[serde(default)]
  pub prompt_templates: Vec<OcrPromptTemplate>,
  /// Plugin required on plugin writes.
  #[serde(default)]
  pub integration_instance_id: Option<Uuid>,
  /// Plugin required on plugin writes (e.g. `ocr.image@1`).
  #[serde(default)]
  pub ocr_capability_id: Option<String>,
  /// Plugin required on plugin writes.
  #[serde(default)]
  pub capability_preferences_version: Option<i32>,
  /// Plugin required on plugin writes (JSON object).
  #[serde(default)]
  pub capability_preferences: Option<Value>,
  /// Required on update.
  #[serde(default)]
  pub expected_updated_at: Option<String>,
}

/// Build a default typed preferences object for Google Vision schema v1.
pub fn default_ocr_image_preferences() -> OcrImagePreferences {
  OcrImagePreferences {
    operation: OcrImageOperation::DocumentTextDetection,
    language_hints: vec![],
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::time::{new_id, now_rfc3339};

  #[test]
  fn dto_json_omits_vault_refs() {
    let service = OcrService {
      id: new_id(),
      provider_type: OcrProviderType::Baidu,
      display_name: "Baidu".into(),
      enabled: true,
      sort_order: 0,
      baidu_action: Some(BaiduOcrAction::Accurate),
      api_key_ref: Some("ocr/api/secret".into()),
      secret_key_ref: Some("ocr/secret/secret".into()),
      provider_model_id: None,
      temperature: None,
      default_prompt_template_id: None,
      integration_instance_id: None,
      ocr_capability_id: None,
      capability_preferences_version: None,
      capability_preferences: None,
      created_at: now_rfc3339(),
      updated_at: now_rfc3339(),
    };
    let dto = OcrServiceDto::from_service(&service, vec![]);
    let json = serde_json::to_string(&dto).unwrap();
    assert!(!json.contains("apiKeyRef"));
    assert!(!json.contains("secretKeyRef"));
    assert!(!json.contains("ocr/api/secret"));
    assert!(json.contains("\"hasApiKey\":true"));
    assert!(json.contains("\"hasSecretKey\":true"));
    assert!(json.contains("\"baiduAction\":\"accurate\""));
  }

  #[test]
  fn baidu_action_serde_snake_case() {
    let value = serde_json::to_value(BaiduOcrAction::AccurateBasic).unwrap();
    assert_eq!(value, serde_json::json!("accurate_basic"));
    let parsed: BaiduOcrAction = serde_json::from_value(value).unwrap();
    assert_eq!(parsed, BaiduOcrAction::AccurateBasic);
  }

  #[test]
  fn plugin_provider_type_roundtrip() {
    assert_eq!(OcrProviderType::PluginCapability.as_str(), "plugin_capability");
    assert_eq!(
      OcrProviderType::parse("plugin_capability").unwrap(),
      OcrProviderType::PluginCapability
    );
  }

  #[test]
  fn default_google_vision_preferences_shape() {
    let prefs = default_google_vision_preferences();
    assert_eq!(prefs["operation"], "document_text_detection");
    assert_eq!(prefs["language-hints"], json!([]));
    let typed = parse_ocr_image_preferences(&prefs).unwrap();
    assert_eq!(typed.operation, OcrImageOperation::DocumentTextDetection);
    assert!(typed.language_hints.is_empty());
  }
}
