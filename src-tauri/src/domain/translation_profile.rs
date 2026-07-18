// ABOUTME: Translation profile entities, ordered model targets, and DTOs.
// ABOUTME: Profiles own prompt templates, preferred languages, and fallback chains.
use crate::domain::language_detection::LanguageDetectorConfig;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Serde default for boolean flags that should be `true` when absent in legacy data.
pub fn default_true() -> bool {
  true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfile {
  pub id: Uuid,
  pub name: String,
  pub enabled: bool,
  pub template_version: i32,
  pub system_template: String,
  pub user_template: String,
  pub temperature: Option<f64>,
  pub max_output_tokens: Option<i64>,
  pub provider_options_json: Option<serde_json::Value>,
  /// Preferred source language id for the translate UI (e.g. `zh`). Optional.
  #[serde(default)]
  pub source_lang: Option<String>,
  /// Preferred target language id for the translate UI (e.g. `en`). Optional; may be `auto`
  /// to defer to the Primary/Target preference rule.
  #[serde(default)]
  pub target_lang: Option<String>,
  /// Whether translate requests using this profile stream output. Defaults to `true` for
  /// legacy rows/exports that predate the field.
  #[serde(default = "default_true")]
  pub stream_enabled: bool,
  /// Profile Primary preference: concrete supported id used as the Auto-target fallback when
  /// the effective source matches the Target preference. Optional for legacy rows.
  #[serde(default)]
  pub primary_lang: Option<String>,
  /// Profile Target preference: concrete supported id used as the Auto-target default when the
  /// effective source differs from it. Optional for legacy rows.
  #[serde(default)]
  pub preferred_target_lang: Option<String>,
  /// Optional language detector config. `None` means detect with the default LLM detector
  /// using this profile's primary model. Old profiles/exports without the field default to `None`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub language_detection: Option<LanguageDetectorConfig>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfileDto {
  #[serde(flatten)]
  pub profile: TranslationProfile,
  pub targets: Vec<TranslationProfileTarget>,
}

/// Write input for a profile and its complete ordered target list.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProfileWrite {
  pub id: Option<Uuid>,
  pub name: String,
  pub enabled: bool,
  pub template_version: i32,
  pub system_template: String,
  pub user_template: String,
  pub temperature: Option<f64>,
  pub max_output_tokens: Option<i64>,
  pub provider_options_json: Option<serde_json::Value>,
  #[serde(default)]
  pub source_lang: Option<String>,
  #[serde(default)]
  pub target_lang: Option<String>,
  /// Whether translate requests using this profile stream output. Absent on legacy writes
  /// defaults to `true`.
  #[serde(default = "default_true")]
  pub stream_enabled: bool,
  /// Profile Primary preference (concrete supported id). Absent on legacy writes.
  #[serde(default)]
  pub primary_lang: Option<String>,
  /// Profile Target preference (concrete supported id). Absent on legacy writes.
  #[serde(default)]
  pub preferred_target_lang: Option<String>,
  /// Optional language detector config. `None`/absent clears to the default LLM detector.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub language_detection: Option<LanguageDetectorConfig>,
  /// Ordered provider_model_ids; priority is assigned as 0..n-1.
  pub target_model_ids: Vec<Uuid>,
}

pub type TranslationProfileExport = TranslationProfile;
pub type ProfileTargetExport = TranslationProfileTarget;
