// ABOUTME: Translation history domain entity, list/preview/full DTOs, and facets.
// ABOUTME: One row = one completed translate attempt (main Translate or Quick Translate).
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Persisted outcome of a completed translate attempt.
///
/// `Early` validation/config failures and cancellations are never recorded; only success
/// and real soft-fail (after at least one provider attempt) reach the repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryStatus {
	Complete,
	Failed,
}

impl HistoryStatus {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Complete => "complete",
			Self::Failed => "failed",
		}
	}

	pub fn parse(value: &str) -> Result<Self, String> {
		match value {
			"complete" => Ok(Self::Complete),
			"failed" => Ok(Self::Failed),
			other => Err(format!("invalid history status: {other}")),
		}
	}
}

/// Full history row stored in SQLite. Full source/translated text is kept (no truncation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationHistory {
	pub id: Uuid,
	pub created_at: String,
	pub source_text: String,
	pub translated_text: String,
	pub source_lang: String,
	pub target_lang: String,
	pub effective_source_lang: Option<String>,
	pub effective_target_lang: Option<String>,
	pub model_id: Option<Uuid>,
	pub model_display_name: String,
	pub provider_display_name: Option<String>,
	pub profile_id: Option<Uuid>,
	pub profile_name: Option<String>,
	pub status: HistoryStatus,
	pub error_code: Option<String>,
	pub error_message: Option<String>,
	pub latency_ms: i64,
}

/// Full DTO returned by `get` / `get_many` and consumed by CSV export.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationHistoryDto {
	pub id: String,
	pub created_at: String,
	pub source_text: String,
	pub translated_text: String,
	pub source_lang: String,
	pub target_lang: String,
	pub effective_source_lang: Option<String>,
	pub effective_target_lang: Option<String>,
	pub model_id: Option<String>,
	pub model_display_name: String,
	pub provider_display_name: Option<String>,
	pub profile_id: Option<String>,
	pub profile_name: Option<String>,
	pub status: HistoryStatus,
	pub error_code: Option<String>,
	pub error_message: Option<String>,
	pub latency_ms: i64,
}

impl From<&TranslationHistory> for TranslationHistoryDto {
	fn from(row: &TranslationHistory) -> Self {
		Self {
			id: row.id.to_string(),
			created_at: row.created_at.clone(),
			source_text: row.source_text.clone(),
			translated_text: row.translated_text.clone(),
			source_lang: row.source_lang.clone(),
			target_lang: row.target_lang.clone(),
			effective_source_lang: row.effective_source_lang.clone(),
			effective_target_lang: row.effective_target_lang.clone(),
			model_id: row.model_id.map(|id| id.to_string()),
			model_display_name: row.model_display_name.clone(),
			provider_display_name: row.provider_display_name.clone(),
			profile_id: row.profile_id.map(|id| id.to_string()),
			profile_name: row.profile_name.clone(),
			status: row.status,
			error_code: row.error_code.clone(),
			error_message: row.error_message.clone(),
			latency_ms: row.latency_ms,
		}
	}
}

/** List row: previews instead of full text (built by the service). */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationHistoryListItemDto {
	pub id: String,
	pub created_at: String,
	pub source_text_preview: String,
	pub translated_text_preview: String,
	pub source_text_truncated: bool,
	pub translated_text_truncated: bool,
	pub source_lang: String,
	pub target_lang: String,
	pub effective_source_lang: Option<String>,
	pub effective_target_lang: Option<String>,
	pub model_id: Option<String>,
	pub model_display_name: String,
	pub provider_display_name: Option<String>,
	pub profile_id: Option<String>,
	pub profile_name: Option<String>,
	pub status: HistoryStatus,
	pub error_code: Option<String>,
	pub latency_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslationHistoryListQuery {
	#[serde(default)]
	pub search: Option<String>,
	#[serde(default)]
	pub model_id: Option<String>,
	/// Effective source OR target language id filter.
	#[serde(default)]
	pub language: Option<String>,
	/// UI sends a local YYYY-MM-DD day; the service expands it to UTC bounds.
	#[serde(default)]
	pub date: Option<String>,
	/// Client UTC offset in minutes (positive east of UTC), used to expand `date` into
	/// local-day UTC bounds. Absent => treat the day as UTC.
	#[serde(default)]
	pub offset_minutes: Option<i32>,
	/// 1-based page number (clamped to >= 1 by the service).
	pub page: i64,
	/// Page size (default 20, clamped 1..=100 by the service).
	#[serde(default)]
	pub page_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationHistoryListResult {
	pub items: Vec<TranslationHistoryListItemDto>,
	pub total: i64,
	pub page: i64,
	pub page_size: i64,
}

/// Distinct model snapshot used to populate the model filter dropdown.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranslationHistoryModelFacet {
	pub model_id: Option<String>,
	pub model_display_name: String,
	pub last_seen_at: String,
}

/// Snapshot input for a history insert. The service assembles this from a translate result.
#[derive(Debug, Clone)]
pub struct TranslationHistoryRecord {
	pub id: Uuid,
	pub created_at: String,
	pub source_text: String,
	pub translated_text: String,
	pub source_lang: String,
	pub target_lang: String,
	pub effective_source_lang: Option<String>,
	pub effective_target_lang: Option<String>,
	pub model_id: Option<Uuid>,
	pub model_display_name: String,
	pub provider_display_name: Option<String>,
	pub profile_id: Option<Uuid>,
	pub profile_name: Option<String>,
	pub status: HistoryStatus,
	pub error_code: Option<String>,
	pub error_message: Option<String>,
	pub latency_ms: i64,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn status_round_trip() {
		assert_eq!(HistoryStatus::Complete.as_str(), "complete");
		assert_eq!(HistoryStatus::Failed.as_str(), "failed");
		assert_eq!(HistoryStatus::parse("complete").unwrap(), HistoryStatus::Complete);
		assert_eq!(HistoryStatus::parse("failed").unwrap(), HistoryStatus::Failed);
		assert!(HistoryStatus::parse("other").is_err());
	}

	#[test]
	fn dto_from_entity_serializes_camel_case() {
		let row = TranslationHistory {
			id: Uuid::nil(),
			created_at: "2026-07-17T00:00:00Z".into(),
			source_text: "hi".into(),
			translated_text: "你好".into(),
			source_lang: "English".into(),
			target_lang: "Chinese".into(),
			effective_source_lang: Some("en".into()),
			effective_target_lang: Some("zh".into()),
			model_id: None,
			model_display_name: "GPT".into(),
			provider_display_name: None,
			profile_id: None,
			profile_name: None,
			status: HistoryStatus::Complete,
			error_code: None,
			error_message: None,
			latency_ms: 12,
		};
		let dto = TranslationHistoryDto::from(&row);
		let json = serde_json::to_value(&dto).unwrap();
		assert_eq!(json["createdAt"], "2026-07-17T00:00:00Z");
		assert_eq!(json["sourceText"], "hi");
		assert_eq!(json["translatedText"], "你好");
		assert_eq!(json["effectiveSourceLang"], "en");
		assert_eq!(json["modelDisplayName"], "GPT");
		assert_eq!(json["status"], "complete");
		assert_eq!(json["latencyMs"], 12);
		assert!(json["modelId"].is_null());
	}
}
