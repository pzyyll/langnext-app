// ABOUTME: Translation history service: validation, preview building, date bounds, retention.
// ABOUTME: Called by IPC commands and by ModelService after a real translate attempt.
use crate::domain::time::{format_rfc3339, new_id, now_rfc3339};
use crate::domain::translation::TranslateResult;
use crate::domain::translation_history::{
	HistoryStatus, TranslationHistoryDto, TranslationHistoryListItemDto, TranslationHistoryListQuery,
	TranslationHistoryListResult, TranslationHistoryModelFacet, TranslationHistoryRecord,
};
use crate::error::StorageError;
use crate::repositories::translation_history as repo;
use crate::repositories::translation_history::HistoryListFilter;
use crate::storage::Database;
use time::{Date, Month, PrimitiveDateTime, Time, UtcOffset};
use uuid::Uuid;

/// Hard cap on persisted history rows. Oldest rows are pruned after each insert.
pub const HISTORY_RETENTION_CAP: i64 = 10_000;
/// Maximum number of Unicode scalars kept in a list preview.
const PREVIEW_SCALAR_CAP: usize = 160;
/// Maximum search query length accepted from the UI.
const MAX_SEARCH_LEN: usize = 200;
/// Maximum number of ids accepted by `get_many`.
pub const GET_MANY_MAX_IDS: usize = 100;
/// Default page size when the caller omits or sends an invalid value.
const DEFAULT_PAGE_SIZE: i64 = 20;
const MIN_PAGE_SIZE: i64 = 1;
const MAX_PAGE_SIZE: i64 = 100;

/// Snapshot of model/provider/profile display data used to populate a history row.
#[derive(Debug, Clone)]
pub struct TranslateHistorySnapshot {
	pub model_id: Option<Uuid>,
	pub model_display_name: String,
	pub provider_display_name: Option<String>,
	pub profile_id: Option<Uuid>,
	pub profile_name: Option<String>,
}

#[derive(Clone)]
pub struct TranslationHistoryService {
	db: Database,
}

impl TranslationHistoryService {
	pub fn new(db: Database) -> Self {
		Self { db }
	}

	/// Paged list with previews. Full text never leaves the service; only previews do.
	pub fn list(&self, query: TranslationHistoryListQuery) -> Result<TranslationHistoryListResult, StorageError> {
		let (page, page_size) = normalize_paging(query.page, query.page_size)?;
		let search = normalize_search(query.search)?;
		let model_id = normalize_optional_id(query.model_id, "modelId")?;
		let language = normalize_optional_language(query.language)?;
		let (date_start, date_end) = normalize_date_bounds(query.date, query.offset_minutes)?;

		let filter = HistoryListFilter {
			search: search.as_deref(),
			model_id: model_id.as_deref(),
			language: language.as_deref(),
			date_start: date_start.as_deref(),
			date_end: date_end.as_deref(),
			offset: (page - 1) * page_size,
			limit: page_size,
		};

		let (rows, total) = self.db.read(|conn| {
			let rows = repo::list(conn, &filter)?;
			let total = repo::list_count(conn, &filter)?;
			Ok((rows, total))
		})?;

		let items = rows.iter().map(list_item_from).collect();
		Ok(TranslationHistoryListResult {
			items,
			total,
			page,
			page_size,
		})
	}

	pub fn get(&self, id: Uuid) -> Result<TranslationHistoryDto, StorageError> {
		self
			.db
			.read(|conn| repo::get(conn, id).map(|row| TranslationHistoryDto::from(&row)))
	}

	pub fn get_many(&self, ids: Vec<Uuid>) -> Result<Vec<TranslationHistoryDto>, StorageError> {
		if ids.len() > GET_MANY_MAX_IDS {
			return Err(StorageError::Validation(format!(
				"get_many accepts at most {GET_MANY_MAX_IDS} ids"
			)));
		}
		self
			.db
			.read(|conn| repo::get_many(conn, &ids).map(|rows| rows.iter().map(TranslationHistoryDto::from).collect()))
	}

	pub fn list_model_facets(&self) -> Result<Vec<TranslationHistoryModelFacet>, StorageError> {
		self.db.read(|conn| repo::list_model_facets(conn))
	}

	/// Delete rows by id. Absent ids are ignored (idempotent). Returns the count deleted.
	pub fn delete_many(&self, ids: Vec<Uuid>) -> Result<usize, StorageError> {
		if ids.is_empty() {
			return Ok(0);
		}
		self.db.write(|conn| repo::delete_many(conn, &ids))
	}

	/// Clear the entire history table. Returns the count deleted.
	pub fn delete_all(&self) -> Result<i64, StorageError> {
		self.db.write(|conn| repo::delete_all(conn))
	}

	/// Total row count (for Clear All confirmation and diagnostics).
	pub fn count(&self) -> Result<i64, StorageError> {
		self.db.read(|conn| repo::count(conn))
	}

	/// Record one completed translate attempt and prune to the retention cap.
	///
	/// Called by `ModelService` only after `run_translate_attempts` returns a non-cancelled
	/// result. Insert failure is logged and never propagated so translate stays unaffected.
	pub fn record_from_translate(
		&self,
		result: &TranslateResult,
		input: &TranslateInputSnapshot,
		snapshot: &TranslateHistorySnapshot,
	) {
		let status = if result.ok {
			HistoryStatus::Complete
		} else {
			HistoryStatus::Failed
		};
		let record = TranslationHistoryRecord {
			id: new_id(),
			created_at: now_rfc3339(),
			source_text: input.source_text.clone(),
			translated_text: result.translated_text.clone(),
			source_lang: input.source_lang.clone(),
			target_lang: input.target_lang.clone(),
			effective_source_lang: input.effective_source_lang.clone(),
			effective_target_lang: input.effective_target_lang.clone(),
			model_id: result.model_id.or(snapshot.model_id),
			model_display_name: snapshot.model_display_name.clone(),
			provider_display_name: snapshot.provider_display_name.clone(),
			profile_id: snapshot.profile_id,
			profile_name: snapshot.profile_name.clone(),
			status,
			error_code: result.error_code.clone(),
			error_message: if result.ok { None } else { Some(result.message.clone()) },
			latency_ms: result.latency_ms as i64,
		};

		if let Err(err) = self.record_internal(&record) {
			log::error!("history_record_failed error={err}");
		}
	}

	fn record_internal(&self, record: &TranslationHistoryRecord) -> Result<(), StorageError> {
		self.db.transaction(|uow| {
			repo::insert(uow.conn(), record)?;
			repo::delete_oldest(uow.conn(), HISTORY_RETENTION_CAP)?;
			Ok(())
		})
	}
}

/// Language-id metadata captured from a `TranslateInput` for history recording.
/// `source_lang` / `target_lang` are the configured labels sent to the model; the
/// `effective_*` fields carry the concrete ids actually used (when known).
#[derive(Debug, Clone)]
pub struct TranslateInputSnapshot {
	pub source_text: String,
	pub source_lang: String,
	pub target_lang: String,
	pub effective_source_lang: Option<String>,
	pub effective_target_lang: Option<String>,
}

/// Build a list item DTO (previews + truncated flags) from a full row.
fn list_item_from(row: &crate::domain::translation_history::TranslationHistory) -> TranslationHistoryListItemDto {
	let (source_preview, source_truncated) = build_preview(&row.source_text);
	let (target_preview, target_truncated) = build_preview(&row.translated_text);
	TranslationHistoryListItemDto {
		id: row.id.to_string(),
		created_at: row.created_at.clone(),
		source_text_preview: source_preview,
		translated_text_preview: target_preview,
		source_text_truncated: source_truncated,
		translated_text_truncated: target_truncated,
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
		latency_ms: row.latency_ms,
	}
}

/// Truncate to at most `PREVIEW_SCALAR_CAP` Unicode scalars, returning the preview and a
/// truncation flag. Operates on `chars()` (Unicode scalar values) per the plan.
fn build_preview(text: &str) -> (String, bool) {
	let mut chars = text.chars();
	let mut out: String = chars.by_ref().take(PREVIEW_SCALAR_CAP).collect();
	let truncated = chars.next().is_some();
	if truncated && !out.ends_with('…') {
		out.push('…');
	}
	(out, truncated)
}

fn normalize_paging(page: i64, page_size: Option<i64>) -> Result<(i64, i64), StorageError> {
	let page = if page < 1 { 1 } else { page };
	let page_size = page_size.unwrap_or(DEFAULT_PAGE_SIZE);
	let page_size = page_size.clamp(MIN_PAGE_SIZE, MAX_PAGE_SIZE);
	Ok((page, page_size))
}

/// Trim, clamp length, and escape LIKE wildcards (`%`, `_`) and the escape char `\`.
/// Returns `None` for empty/whitespace-only search. The repository uses `ESCAPE '\\'`.
fn normalize_search(raw: Option<String>) -> Result<Option<String>, StorageError> {
	let Some(value) = raw else {
		return Ok(None);
	};
	let trimmed = value.trim();
	if trimmed.is_empty() {
		return Ok(None);
	}
	if trimmed.chars().count() > MAX_SEARCH_LEN {
		return Err(StorageError::Validation(format!(
			"search must be at most {MAX_SEARCH_LEN} characters"
		)));
	}
	let mut escaped = String::with_capacity(trimmed.len() + 2);
	escaped.push('%');
	for ch in trimmed.chars() {
		match ch {
			'\\' | '%' | '_' => {
				escaped.push('\\');
				escaped.push(ch);
			}
			_ => escaped.push(ch),
		}
	}
	escaped.push('%');
	Ok(Some(escaped))
}

fn normalize_optional_id(raw: Option<String>, field: &str) -> Result<Option<String>, StorageError> {
	match raw {
		None => Ok(None),
		Some(value) => {
			let trimmed = value.trim();
			if trimmed.is_empty() {
				return Ok(None);
			}
			Uuid::parse_str(trimmed).map_err(|_| StorageError::Validation(format!("{field} must be a valid id")))?;
			Ok(Some(trimmed.to_string()))
		}
	}
}

fn normalize_optional_language(raw: Option<String>) -> Result<Option<String>, StorageError> {
	match raw {
		None => Ok(None),
		Some(value) => {
			let trimmed = value.trim();
			if trimmed.is_empty() {
				return Ok(None);
			}
			Ok(Some(trimmed.to_string()))
		}
	}
}

/// Expand a local `YYYY-MM-DD` calendar day into UTC `[start, end)` RFC 3339 bounds.
///
/// `offset_minutes` is the client UTC offset in minutes (positive east of UTC), e.g. `480`
/// for UTC+8. When absent, the day is interpreted as a UTC day. This keeps the expansion
/// logic in the service (per the plan) while honoring the user's local calendar day.
fn normalize_date_bounds(
	date: Option<String>,
	offset_minutes: Option<i32>,
) -> Result<(Option<String>, Option<String>), StorageError> {
	let Some(date) = date else {
		return Ok((None, None));
	};
	let trimmed = date.trim();
	if trimmed.is_empty() {
		return Ok((None, None));
	}
	let (start, end) = expand_local_day(trimmed, offset_minutes.unwrap_or(0))?;
	Ok((Some(start), Some(end)))
}

fn expand_local_day(value: &str, offset_minutes: i32) -> Result<(String, String), StorageError> {
	let (year, month, day) = parse_calendar_date(value)?;
	let offset = UtcOffset::from_whole_seconds(offset_minutes.saturating_mul(60))
		.map_err(|e| StorageError::Validation(format!("invalid timezone offset: {e}")))?;
	let date =
		Date::from_calendar_date(year, month, day).map_err(|e| StorageError::Validation(format!("invalid date: {e}")))?;
	let midnight = Time::from_hms(0, 0, 0).map_err(|e| StorageError::Validation(format!("invalid time: {e}")))?;
	let start_local = PrimitiveDateTime::new(date, midnight).assume_offset(offset);
	let start_utc = start_local.to_offset(UtcOffset::UTC);
	// Next day: adding 1 day is safe for any valid calendar date.
	let end_local = start_local
		.checked_add(time::Duration::days(1))
		.ok_or_else(|| StorageError::Validation("date arithmetic overflow".into()))?
		.to_offset(UtcOffset::UTC);
	Ok((format_rfc3339(start_utc)?, format_rfc3339(end_local)?))
}

fn parse_calendar_date(value: &str) -> Result<(i32, Month, u8), StorageError> {
	let parts: Vec<&str> = value.split('-').collect();
	if parts.len() != 3 {
		return Err(StorageError::Validation("date must be YYYY-MM-DD".into()));
	}
	let year: i32 = parts[0]
		.parse()
		.map_err(|_| StorageError::Validation("date year must be numeric".into()))?;
	let month: u8 = parts[1]
		.parse()
		.map_err(|_| StorageError::Validation("date month must be numeric".into()))?;
	let day: u8 = parts[2]
		.parse()
		.map_err(|_| StorageError::Validation("date day must be numeric".into()))?;
	let month = Month::try_from(month).map_err(|_| StorageError::Validation("invalid date month".into()))?;
	Ok((year, month, day))
}

#[cfg(test)]
pub(crate) mod test_helpers {
	use super::*;
	use crate::domain::translation_history::HistoryStatus;

	pub fn sample_record(model_display_name: &str, status: HistoryStatus) -> TranslationHistoryRecord {
		TranslationHistoryRecord {
			id: new_id(),
			created_at: now_rfc3339(),
			source_text: "hello".into(),
			translated_text: if status == HistoryStatus::Complete {
				"你好".into()
			} else {
				String::new()
			},
			source_lang: "English".into(),
			target_lang: "Chinese".into(),
			effective_source_lang: Some("en".into()),
			effective_target_lang: Some("zh".into()),
			model_id: Some(Uuid::nil()),
			model_display_name: model_display_name.into(),
			provider_display_name: Some("Test".into()),
			profile_id: None,
			profile_name: None,
			status,
			error_code: if status == HistoryStatus::Failed {
				Some("network".into())
			} else {
				None
			},
			error_message: if status == HistoryStatus::Failed {
				Some("boom".into())
			} else {
				None
			},
			latency_ms: 42,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::domain::translation::TranslateResult;
	use crate::storage::Database;

	fn setup() -> (tempfile::TempDir, TranslationHistoryService) {
		let dir = tempfile::tempdir().unwrap();
		let db = Database::new(dir.path()).unwrap();
		db.initialize().unwrap();
		(dir, TranslationHistoryService::new(db))
	}

	#[test]
	fn list_returns_previews_and_truncation_flags() {
		let (_dir, svc) = setup();
		let long_source = "a".repeat(500);
		let long_target = "b".repeat(500);
		let record = TranslationHistoryRecord {
			source_text: long_source,
			translated_text: long_target,
			..test_helpers::sample_record("GPT", HistoryStatus::Complete)
		};
		svc.record_internal(&record).unwrap();

		let result = svc
			.list(TranslationHistoryListQuery {
				page: 1,
				page_size: Some(10),
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.total, 1);
		assert_eq!(result.items.len(), 1);
		let item = &result.items[0];
		// 160 scalars + ellipsis marker.
		assert_eq!(item.source_text_preview.chars().count(), 161);
		assert!(item.source_text_truncated);
		assert!(item.translated_text_truncated);
	}

	#[test]
	fn get_returns_full_text() {
		let (_dir, svc) = setup();
		let record = test_helpers::sample_record("GPT", HistoryStatus::Complete);
		let id = record.id;
		svc.record_internal(&record).unwrap();
		let dto = svc.get(id).unwrap();
		assert_eq!(dto.source_text, "hello");
		assert_eq!(dto.translated_text, "你好");
		assert_eq!(dto.model_display_name, "GPT");
	}

	#[test]
	fn get_many_caps_at_100() {
		let (_dir, svc) = setup();
		let ids: Vec<Uuid> = (0..101).map(|_| new_id()).collect();
		let err = svc.get_many(ids).unwrap_err();
		assert!(matches!(err, StorageError::Validation(_)));
	}

	#[test]
	fn search_escapes_wildcards_and_matches() {
		let (_dir, svc) = setup();
		let record = TranslationHistoryRecord {
			source_text: "50% off today".into(),
			..test_helpers::sample_record("GPT", HistoryStatus::Complete)
		};
		svc.record_internal(&record).unwrap();
		let result = svc
			.list(TranslationHistoryListQuery {
				search: Some("50% off".into()),
				page: 1,
				page_size: Some(10),
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.total, 1);
		assert_eq!(result.items[0].source_text_preview, "50% off today");
	}

	#[test]
	fn search_rejects_oversized_query() {
		let (_dir, svc) = setup();
		let query = TranslationHistoryListQuery {
			search: Some("x".repeat(MAX_SEARCH_LEN + 1)),
			page: 1,
			page_size: Some(10),
			..Default::default()
		};
		let err = svc.list(query).unwrap_err();
		assert!(matches!(err, StorageError::Validation(_)));
	}

	#[test]
	fn date_filter_uses_local_day_bounds() {
		let (_dir, svc) = setup();
		// A record at 2026-07-17T16:30:00Z = 2026-07-18T00:30:00 in UTC+8.
		let record = TranslationHistoryRecord {
			created_at: "2026-07-17T16:30:00Z".into(),
			..test_helpers::sample_record("GPT", HistoryStatus::Complete)
		};
		svc.record_internal(&record).unwrap();
		// Local day 2026-07-18 with offset +480 should include the record.
		let result = svc
			.list(TranslationHistoryListQuery {
				date: Some("2026-07-18".into()),
				offset_minutes: Some(480),
				page: 1,
				page_size: Some(10),
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.total, 1);
		// Local day 2026-07-17 with offset +480 should exclude it.
		let result = svc
			.list(TranslationHistoryListQuery {
				date: Some("2026-07-17".into()),
				offset_minutes: Some(480),
				page: 1,
				page_size: Some(10),
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.total, 0);
	}

	#[test]
	fn paging_clamps_and_defaults() {
		let (_dir, svc) = setup();
		for _ in 0..3 {
			svc
				.record_internal(&test_helpers::sample_record("GPT", HistoryStatus::Complete))
				.unwrap();
		}
		// page 0 -> clamped to 1; missing page_size -> default 20.
		let result = svc
			.list(TranslationHistoryListQuery {
				page: 0,
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.page, 1);
		assert_eq!(result.page_size, 20);
		assert_eq!(result.total, 3);
		// page_size 0 -> clamped to 1.
		let result = svc
			.list(TranslationHistoryListQuery {
				page: 1,
				page_size: Some(0),
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.page_size, 1);
		assert_eq!(result.items.len(), 1);
		// page_size 999 -> clamped to 100.
		let result = svc
			.list(TranslationHistoryListQuery {
				page: 1,
				page_size: Some(999),
				..Default::default()
			})
			.unwrap();
		assert_eq!(result.page_size, 100);
	}

	#[test]
	fn delete_and_count() {
		let (_dir, svc) = setup();
		svc
			.record_internal(&test_helpers::sample_record("GPT", HistoryStatus::Complete))
			.unwrap();
		svc
			.record_internal(&test_helpers::sample_record("GPT", HistoryStatus::Complete))
			.unwrap();
		assert_eq!(svc.count().unwrap(), 2);
		let ids: Vec<Uuid> = vec![first_history_id(&svc)];
		assert_eq!(svc.delete_many(ids).unwrap(), 1);
		assert_eq!(svc.count().unwrap(), 1);
		assert_eq!(svc.delete_all().unwrap(), 1);
		assert_eq!(svc.count().unwrap(), 0);
	}

	#[test]
	fn retention_prunes_to_cap() {
		let (_dir, svc) = setup();
		// Insert cap+5 rows and verify only `cap` remain, oldest removed.
		for _ in 0..(HISTORY_RETENTION_CAP + 5) {
			svc
				.record_internal(&test_helpers::sample_record("GPT", HistoryStatus::Complete))
				.unwrap();
		}
		assert_eq!(svc.count().unwrap(), HISTORY_RETENTION_CAP);
	}

	#[test]
	fn record_from_translate_persists_success_and_failure() {
		let (_dir, svc) = setup();
		let input = TranslateInputSnapshot {
			source_text: "hi".into(),
			source_lang: "English".into(),
			target_lang: "Chinese".into(),
			effective_source_lang: Some("en".into()),
			effective_target_lang: Some("zh".into()),
		};
		let snapshot = TranslateHistorySnapshot {
			model_id: Some(Uuid::nil()),
			model_display_name: "GPT".into(),
			provider_display_name: Some("Test".into()),
			profile_id: None,
			profile_name: None,
		};
		svc.record_from_translate(
			&TranslateResult::success_with_model("你好".into(), 10, Uuid::nil()),
			&input,
			&snapshot,
		);
		svc.record_from_translate(&TranslateResult::failure("network", "boom", 5), &input, &snapshot);
		assert_eq!(svc.count().unwrap(), 2);
	}

	fn first_history_id(svc: &TranslationHistoryService) -> Uuid {
		let result = svc
			.list(TranslationHistoryListQuery {
				page: 1,
				page_size: Some(10),
				..Default::default()
			})
			.unwrap();
		Uuid::parse_str(&result.items[0].id).unwrap()
	}
}
