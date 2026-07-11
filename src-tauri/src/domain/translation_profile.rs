// ABOUTME: Translation profile entities, ordered model targets, and DTOs.
// ABOUTME: Profiles own prompt templates, preferred languages, and fallback chains.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
	/// Preferred target language id for the translate UI (e.g. `en`). Optional.
	#[serde(default)]
	pub target_lang: Option<String>,
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
	/// Ordered provider_model_ids; priority is assigned as 0..n-1.
	pub target_model_ids: Vec<Uuid>,
}

pub type TranslationProfileExport = TranslationProfile;
pub type ProfileTargetExport = TranslationProfileTarget;
