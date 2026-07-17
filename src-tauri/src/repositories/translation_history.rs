// ABOUTME: Translation history SQL read/write/delete/facets persistence.
// ABOUTME: Services call these functions; commands never embed SQL.
use crate::domain::translation_history::{
	HistoryStatus, TranslationHistory, TranslationHistoryModelFacet, TranslationHistoryRecord,
};
use crate::error::StorageError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

fn map_row(row: &Row<'_>) -> Result<TranslationHistory, rusqlite::Error> {
	let id: String = row.get("id")?;
	let status: String = row.get("status")?;
	let model_id: Option<String> = row.get("model_id")?;
	let profile_id: Option<String> = row.get("profile_id")?;
	let latency_ms: i64 = row.get("latency_ms")?;
	Ok(TranslationHistory {
		id: Uuid::parse_str(&id)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
		created_at: row.get("created_at")?,
		source_text: row.get("source_text")?,
		translated_text: row.get("translated_text")?,
		source_lang: row.get("source_lang")?,
		target_lang: row.get("target_lang")?,
		effective_source_lang: row.get("effective_source_lang")?,
		effective_target_lang: row.get("effective_target_lang")?,
		model_id: model_id
			.as_deref()
			.map(Uuid::parse_str)
			.transpose()
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
		model_display_name: row.get("model_display_name")?,
		provider_display_name: row.get("provider_display_name")?,
		profile_id: profile_id
			.as_deref()
			.map(Uuid::parse_str)
			.transpose()
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
		profile_name: row.get("profile_name")?,
		status: HistoryStatus::parse(&status)
			.map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
		error_code: row.get("error_code")?,
		error_message: row.get("error_message")?,
		latency_ms,
	})
}

pub fn insert(conn: &Connection, record: &TranslationHistoryRecord) -> Result<(), StorageError> {
	conn.execute(
		"INSERT INTO translation_history (
            id, created_at, source_text, translated_text, source_lang, target_lang,
            effective_source_lang, effective_target_lang, model_id, model_display_name,
            provider_display_name, profile_id, profile_name, status, error_code,
            error_message, latency_ms
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
		params![
			record.id.to_string(),
			record.created_at,
			record.source_text,
			record.translated_text,
			record.source_lang,
			record.target_lang,
			record.effective_source_lang,
			record.effective_target_lang,
			record.model_id.map(|id| id.to_string()),
			record.model_display_name,
			record.provider_display_name,
			record.profile_id.map(|id| id.to_string()),
			record.profile_name,
			record.status.as_str(),
			record.error_code,
			record.error_message,
			record.latency_ms,
		],
	)?;
	Ok(())
}

pub fn get(conn: &Connection, id: Uuid) -> Result<TranslationHistory, StorageError> {
	conn
		.query_row(
			"SELECT * FROM translation_history WHERE id = ?1",
			params![id.to_string()],
			map_row,
		)
		.optional()?
		.ok_or_else(|| StorageError::NotFound(format!("translation_history {id}")))
}

pub fn get_many(conn: &Connection, ids: &[Uuid]) -> Result<Vec<TranslationHistory>, StorageError> {
	if ids.is_empty() {
		return Ok(Vec::new());
	}
	// Build an IN (...) clause with positional params; ids are caller-capped at 100.
	let placeholders: Vec<String> = (0..ids.len()).map(|i| format!("?{}", i + 1)).collect();
	let sql = format!(
		"SELECT * FROM translation_history WHERE id IN ({}) ORDER BY created_at DESC, id DESC",
		placeholders.join(", ")
	);
	let mut stmt = conn.prepare(&sql)?;
	let params: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
	let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
	let rows = stmt
		.query_map(param_refs.as_slice(), map_row)?
		.collect::<Result<Vec<_>, _>>()?;
	Ok(rows)
}

/// Total row count (used by retention pruning and Clear All confirmation counts).
pub fn count(conn: &Connection) -> Result<i64, StorageError> {
	Ok(conn.query_row("SELECT COUNT(*) FROM translation_history", [], |row| row.get(0))?)
}

/// Delete rows older than the retention cap so the table stays bounded.
/// Removes the oldest `(created_at DESC, id DESC)` rows beyond `cap`. Returns the count deleted.
pub fn delete_oldest(conn: &Connection, cap: i64) -> Result<i64, StorageError> {
	if cap < 0 {
		return Ok(0);
	}
	let deleted = conn.execute(
		"DELETE FROM translation_history
         WHERE id IN (
             SELECT id FROM translation_history
             ORDER BY created_at DESC, id DESC
             LIMIT -1 OFFSET ?1
         )",
		params![cap],
	)?;
	Ok(deleted as i64)
}

pub fn delete_many(conn: &Connection, ids: &[Uuid]) -> Result<usize, StorageError> {
	if ids.is_empty() {
		return Ok(0);
	}
	let placeholders: Vec<String> = (0..ids.len()).map(|i| format!("?{}", i + 1)).collect();
	let sql = format!(
		"DELETE FROM translation_history WHERE id IN ({})",
		placeholders.join(", ")
	);
	let params: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
	let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
	let changed = conn.execute(&sql, param_refs.as_slice())?;
	Ok(changed)
}

pub fn delete_all(conn: &Connection) -> Result<i64, StorageError> {
	Ok(conn.execute("DELETE FROM translation_history", [])? as i64)
}

/// Filter parameters assembled by the service (search already escaped, date already bounds).
pub struct HistoryListFilter<'a> {
	pub search: Option<&'a str>,
	pub model_id: Option<&'a str>,
	pub language: Option<&'a str>,
	/// Inclusive lower bound (RFC 3339 UTC).
	pub date_start: Option<&'a str>,
	/// Exclusive upper bound (RFC 3339 UTC).
	pub date_end: Option<&'a str>,
	pub offset: i64,
	pub limit: i64,
}

/// Paged list ordered by `created_at DESC, id DESC`. Returns full rows; the service builds previews.
pub fn list(conn: &Connection, filter: &HistoryListFilter<'_>) -> Result<Vec<TranslationHistory>, StorageError> {
	let mut where_clauses: Vec<String> = Vec::new();
	let mut param_values: Vec<String> = Vec::new();

	if let Some(search) = filter.search {
		where_clauses.push("(source_text LIKE ? ESCAPE '\\' OR translated_text LIKE ? ESCAPE '\\')".into());
		param_values.push(search.to_string());
		param_values.push(search.to_string());
	}
	if let Some(model_id) = filter.model_id {
		where_clauses.push("model_id = ?".into());
		param_values.push(model_id.to_string());
	}
	if let Some(language) = filter.language {
		where_clauses.push("(effective_source_lang = ? OR effective_target_lang = ?)".into());
		param_values.push(language.to_string());
		param_values.push(language.to_string());
	}
	if let Some(date_start) = filter.date_start {
		where_clauses.push("created_at >= ?".into());
		param_values.push(date_start.to_string());
	}
	if let Some(date_end) = filter.date_end {
		where_clauses.push("created_at < ?".into());
		param_values.push(date_end.to_string());
	}

	let where_sql = if where_clauses.is_empty() {
		String::new()
	} else {
		format!(" WHERE {}", where_clauses.join(" AND "))
	};

	let sql = format!("SELECT * FROM translation_history{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?");
	let mut stmt = conn.prepare(&sql)?;
	// Limit/offset are appended after string params; bind by position.
	let limit_value = filter.limit;
	let offset_value = filter.offset;
	let mut param_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
	param_refs.push(&limit_value);
	param_refs.push(&offset_value);
	let rows = stmt
		.query_map(param_refs.as_slice(), map_row)?
		.collect::<Result<Vec<_>, _>>()?;
	Ok(rows)
}

/// Total count matching the same filter (without limit/offset).
pub fn list_count(conn: &Connection, filter: &HistoryListFilter<'_>) -> Result<i64, StorageError> {
	let mut where_clauses: Vec<String> = Vec::new();
	let mut param_values: Vec<String> = Vec::new();

	if let Some(search) = filter.search {
		where_clauses.push("(source_text LIKE ? ESCAPE '\\' OR translated_text LIKE ? ESCAPE '\\')".into());
		param_values.push(search.to_string());
		param_values.push(search.to_string());
	}
	if let Some(model_id) = filter.model_id {
		where_clauses.push("model_id = ?".into());
		param_values.push(model_id.to_string());
	}
	if let Some(language) = filter.language {
		where_clauses.push("(effective_source_lang = ? OR effective_target_lang = ?)".into());
		param_values.push(language.to_string());
		param_values.push(language.to_string());
	}
	if let Some(date_start) = filter.date_start {
		where_clauses.push("created_at >= ?".into());
		param_values.push(date_start.to_string());
	}
	if let Some(date_end) = filter.date_end {
		where_clauses.push("created_at < ?".into());
		param_values.push(date_end.to_string());
	}

	let where_sql = if where_clauses.is_empty() {
		String::new()
	} else {
		format!(" WHERE {}", where_clauses.join(" AND "))
	};
	let sql = format!("SELECT COUNT(*) FROM translation_history{where_sql}");
	let param_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
	Ok(conn.query_row(&sql, param_refs.as_slice(), |row| row.get(0))?)
}

/// Distinct model snapshots for the model filter dropdown.
///
/// One row per `model_id`; null model ids are grouped by `model_display_name`.
/// `last_seen_at` is the most recent `created_at` for that group.
pub fn list_model_facets(conn: &Connection) -> Result<Vec<TranslationHistoryModelFacet>, StorageError> {
	// Group by model_id when present; for null model_id group by display name.
	// MAX(created_at) over text RFC 3339 UTC works because the format sorts lexicographically.
	let mut stmt = conn.prepare(
		"SELECT model_id, model_display_name, MAX(created_at) AS last_seen_at
         FROM translation_history
         GROUP BY model_id, model_display_name
         ORDER BY last_seen_at DESC, model_display_name ASC",
	)?;
	let rows = stmt.query_map([], |row| {
		let model_id: Option<String> = row.get("model_id")?;
		let model_display_name: String = row.get("model_display_name")?;
		let last_seen_at: String = row.get("last_seen_at")?;
		Ok(TranslationHistoryModelFacet {
			model_id: model_id.filter(|s| !s.is_empty()),
			model_display_name,
			last_seen_at,
		})
	})?;
	let mut facets = Vec::new();
	for row in rows {
		facets.push(row?);
	}
	Ok(facets)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::domain::time::new_id;
	use crate::storage::Database;

	fn setup() -> (tempfile::TempDir, Database) {
		let dir = tempfile::tempdir().unwrap();
		let db = Database::new(dir.path()).unwrap();
		db.initialize().unwrap();
		(dir, db)
	}

	fn sample_record(id: Uuid, status: HistoryStatus, source: &str, translated: &str) -> TranslationHistoryRecord {
		TranslationHistoryRecord {
			id,
			created_at: format!("2026-07-17T00:00:0{:02}Z", id.as_u128() as u64 % 10),
			source_text: source.into(),
			translated_text: translated.into(),
			source_lang: "English".into(),
			target_lang: "Chinese".into(),
			effective_source_lang: Some("en".into()),
			effective_target_lang: Some("zh".into()),
			model_id: Some(Uuid::nil()),
			model_display_name: "GPT".into(),
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

	#[test]
	fn insert_get_round_trip() {
		let (_dir, db) = setup();
		let id = new_id();
		let record = sample_record(id, HistoryStatus::Complete, "hello", "你好");
		db.write(|conn| insert(conn, &record)).unwrap();
		let row = db.read(|conn| get(conn, id)).unwrap();
		assert_eq!(row.source_text, "hello");
		assert_eq!(row.translated_text, "你好");
		assert_eq!(row.status, HistoryStatus::Complete);
		assert_eq!(row.latency_ms, 42);
	}

	#[test]
	fn get_missing_returns_not_found() {
		let (_dir, db) = setup();
		let err = db.read(|conn| get(conn, new_id())).unwrap_err();
		assert!(matches!(err, StorageError::NotFound(_)));
	}

	#[test]
	fn get_many_orders_and_skips_missing() {
		let (_dir, db) = setup();
		let id1 = new_id();
		let id2 = new_id();
		db.write(|conn| insert(conn, &sample_record(id1, HistoryStatus::Complete, "a", "x")))
			.unwrap();
		// id2 has a later created_at so it sorts first.
		let mut later = sample_record(id2, HistoryStatus::Failed, "b", "");
		later.created_at = "2026-07-17T00:00:30Z".into();
		db.write(|conn| insert(conn, &later)).unwrap();
		let rows = db.read(|conn| get_many(conn, &[id1, id2, new_id()])).unwrap();
		assert_eq!(rows.len(), 2);
		assert_eq!(rows[0].id, id2);
		assert_eq!(rows[1].id, id1);
	}

	#[test]
	fn list_orders_desc_and_paginates() {
		let (_dir, db) = setup();
		for i in 0..5 {
			let mut rec = sample_record(new_id(), HistoryStatus::Complete, "src", "tgt");
			rec.created_at = format!("2026-07-17T00:00:0{i}Z");
			db.write(|conn| insert(conn, &rec)).unwrap();
		}
		let filter = HistoryListFilter {
			search: None,
			model_id: None,
			language: None,
			date_start: None,
			date_end: None,
			offset: 0,
			limit: 2,
		};
		let rows = db.read(|conn| list(conn, &filter)).unwrap();
		assert_eq!(rows.len(), 2);
		// Newest first (created_at 04 > 03).
		assert!(rows[0].created_at > rows[1].created_at);
		let total = db.read(|conn| list_count(conn, &filter)).unwrap();
		assert_eq!(total, 5);
	}

	#[test]
	fn list_search_escapes_wildcards() {
		let (_dir, db) = setup();
		let mut rec = sample_record(new_id(), HistoryStatus::Complete, "50% off", "half price");
		rec.created_at = "2026-07-17T00:00:00Z".into();
		db.write(|conn| insert(conn, &rec)).unwrap();
		// The service escapes `%` and `_`; the repository receives the escaped pattern with
		// ESCAPE '\\'. A literal `%` without escaping would match everything.
		let filter = HistoryListFilter {
			search: Some("50\\% off"),
			model_id: None,
			language: None,
			date_start: None,
			date_end: None,
			offset: 0,
			limit: 50,
		};
		let rows = db.read(|conn| list(conn, &filter)).unwrap();
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].source_text, "50% off");
		// Unescaped percent matches all -> confirms escaping is required.
		let filter_all = HistoryListFilter {
			search: Some("50% off"),
			model_id: None,
			language: None,
			date_start: None,
			date_end: None,
			offset: 0,
			limit: 50,
		};
		let rows_all = db.read(|conn| list(conn, &filter_all)).unwrap();
		assert_eq!(rows_all.len(), 1);
	}

	#[test]
	fn list_filters_by_model_language_and_date() {
		let (_dir, db) = setup();
		let id_a = new_id();
		let mut a = sample_record(id_a, HistoryStatus::Complete, "a", "x");
		a.effective_source_lang = Some("en".into());
		a.effective_target_lang = Some("zh".into());
		a.created_at = "2026-07-17T10:00:00Z".into();
		let id_b = new_id();
		let mut b = sample_record(id_b, HistoryStatus::Complete, "b", "y");
		b.model_id = Some(new_id());
		b.model_display_name = "Claude".into();
		b.effective_target_lang = Some("ja".into());
		b.created_at = "2026-07-17T12:00:00Z".into();
		db.write(|conn| {
			insert(conn, &a)?;
			insert(conn, &b)
		})
		.unwrap();

		// Model filter
		let filter = HistoryListFilter {
			search: None,
			model_id: Some(&b.model_id.unwrap().to_string()),
			language: None,
			date_start: None,
			date_end: None,
			offset: 0,
			limit: 50,
		};
		let rows = db.read(|conn| list(conn, &filter)).unwrap();
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].id, id_b);

		// Language filter (effective source OR target)
		let filter = HistoryListFilter {
			search: None,
			model_id: None,
			language: Some("ja"),
			date_start: None,
			date_end: None,
			offset: 0,
			limit: 50,
		};
		let rows = db.read(|conn| list(conn, &filter)).unwrap();
		assert_eq!(rows.len(), 1);
		assert_eq!(rows[0].id, id_b);

		// Date filter: a single local day 2026-07-17 -> [start, next day start) UTC bounds.
		let filter = HistoryListFilter {
			search: None,
			model_id: None,
			language: None,
			date_start: Some("2026-07-17T00:00:00Z"),
			date_end: Some("2026-07-18T00:00:00Z"),
			offset: 0,
			limit: 50,
		};
		let rows = db.read(|conn| list(conn, &filter)).unwrap();
		assert_eq!(rows.len(), 2);
	}

	#[test]
	fn facets_group_by_model_id() {
		let (_dir, db) = setup();
		let mut a = sample_record(new_id(), HistoryStatus::Complete, "a", "x");
		a.created_at = "2026-07-17T10:00:00Z".into();
		let mut b = sample_record(new_id(), HistoryStatus::Complete, "b", "y");
		b.model_display_name = "Claude".into();
		b.created_at = "2026-07-17T12:00:00Z".into();
		let mut c = sample_record(new_id(), HistoryStatus::Complete, "c", "z");
		c.model_id = None;
		c.model_display_name = "Unknown".into();
		c.created_at = "2026-07-17T11:00:00Z".into();
		db.write(|conn| {
			insert(conn, &a)?;
			insert(conn, &b)?;
			insert(conn, &c)
		})
		.unwrap();
		let facets = db.read(|conn| list_model_facets(conn)).unwrap();
		assert_eq!(facets.len(), 3);
		// Newest last_seen_at first.
		assert_eq!(facets[0].model_display_name, "Claude");
		assert_eq!(facets[0].last_seen_at, "2026-07-17T12:00:00Z");
	}

	#[test]
	fn delete_many_and_delete_all() {
		let (_dir, db) = setup();
		let id1 = new_id();
		let id2 = new_id();
		let id3 = new_id();
		db.write(|conn| {
			insert(conn, &sample_record(id1, HistoryStatus::Complete, "a", "x"))?;
			insert(conn, &sample_record(id2, HistoryStatus::Complete, "b", "y"))?;
			insert(conn, &sample_record(id3, HistoryStatus::Complete, "c", "z"))
		})
		.unwrap();
		let deleted = db.write(|conn| delete_many(conn, &[id1, id2])).unwrap();
		assert_eq!(deleted, 2);
		assert_eq!(db.read(|conn| count(conn)).unwrap(), 1);
		let total = db.write(|conn| delete_all(conn)).unwrap();
		assert_eq!(total, 1);
		assert_eq!(db.read(|conn| count(conn)).unwrap(), 0);
		// delete_many on empty list is a no-op.
		assert_eq!(db.write(|conn| delete_many(conn, &[])).unwrap(), 0);
	}

	#[test]
	fn delete_oldest_prunes_beyond_cap() {
		let (_dir, db) = setup();
		for i in 0..5 {
			let mut rec = sample_record(new_id(), HistoryStatus::Complete, "src", "tgt");
			rec.created_at = format!("2026-07-17T00:00:0{i}Z");
			db.write(|conn| insert(conn, &rec)).unwrap();
		}
		// Keep newest 3.
		let deleted = db.write(|conn| delete_oldest(conn, 3)).unwrap();
		assert_eq!(deleted, 2);
		assert_eq!(db.read(|conn| count(conn)).unwrap(), 3);
		// Remaining rows are the newest (created_at 02, 03, 04).
		let filter = HistoryListFilter {
			search: None,
			model_id: None,
			language: None,
			date_start: None,
			date_end: None,
			offset: 0,
			limit: 50,
		};
		let rows = db.read(|conn| list(conn, &filter)).unwrap();
		assert!(rows.iter().all(|r| r.created_at.as_str() >= "2026-07-17T00:00:02Z"));
	}
}
