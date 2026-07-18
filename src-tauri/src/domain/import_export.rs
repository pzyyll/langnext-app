// ABOUTME: Versioned configuration import/export document and preview types.
// ABOUTME: Documents never carry secrets, credential refs, or device state.
use crate::domain::model::ProviderModel;
use crate::domain::provider::ProviderExport;
use crate::domain::settings::AppSettingsV1;
use crate::domain::translation_profile::{TranslationProfile, TranslationProfileTarget};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const EXPORT_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationExport {
  pub format_version: u32,
  pub exported_at: String,
  pub providers: Vec<ProviderExport>,
  pub models: Vec<ProviderModel>,
  pub translation_profiles: Vec<TranslationProfile>,
  pub profile_models: Vec<TranslationProfileTarget>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
  pub valid: bool,
  pub counts: ImportPreviewCounts,
  pub validation_errors: Vec<String>,
  /// Provider IDs (post-import IDs for copy mode) that need credentials.
  pub requires_authentication: Vec<Uuid>,
  pub proxy_requires_authentication: bool,
  pub default_profile_cleared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
  pub preview: ImportPreview,
  pub applied: bool,
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::settings::AppSettingsV1;

  #[test]
  fn export_document_round_trip() {
    let doc = ConfigurationExport {
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: "2026-07-10T00:00:00Z".into(),
      providers: vec![],
      models: vec![],
      translation_profiles: vec![],
      profile_models: vec![],
      app_settings: AppSettingsV1::default_document(),
    };
    let json = serde_json::to_string(&doc).unwrap();
    assert!(json.contains("formatVersion"));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("credential_ref"));
    let back: ConfigurationExport = serde_json::from_str(&json).unwrap();
    assert_eq!(back, doc);
  }
}
