//! Local history of completed Quick Translate actions.

use nsh_core::prelude::*;
use rusqlite::{Connection, params};

use crate::database;

const RETENTION_COUNT: u32 = 30;
const PREVIEW_LENGTH: usize = 160;

/// One row in the recent translation menu.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct HistorySummary {
    /// Stable identifier of the translation action.
    pub id: String,
    /// A short, single-line preview of the original text.
    pub preview: String,
}

/// One completed result card from a translation action.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct HistoryResult {
    /// Position of the result card when translation started.
    pub position: u32,
    /// Name of the preset used for this result.
    pub preset_name: String,
    /// Effective source language ID.
    pub source_language: String,
    /// Effective target language ID.
    pub target_language: String,
    /// Complete translated text.
    pub text: String,
}

/// A saved translation to restore in the quick window.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct HistorySnapshot {
    /// Stable identifier of the translation action.
    pub id: String,
    /// Full original text, including spaces and line breaks.
    pub source_text: String,
    /// Completed result cards, in their original order.
    pub results: Vec<HistoryResult>,
}

/// Native operations for saved Quick Translate results.
#[module]
pub struct TranslationHistoryNative;

#[module]
impl TranslationHistoryNative {
    /// Returns the most recent completed actions in newest-first order.
    pub async fn list_recent() -> Result<Vec<HistorySummary>, String> {
        database::run(|db| list_recent(db)).await
    }

    /// Reads an action and its completed results, or null if it is no longer retained.
    pub async fn read(id: String) -> Result<Option<HistorySnapshot>, String> {
        database::run(move |db| read(db, &id)).await
    }

    /// Saves a successful result. A non-null source starts the action's history entry.
    pub async fn record(
        id: String,
        source_text: Option<String>,
        result: HistoryResult,
    ) -> Result<(), String> {
        database::run(move |db| record(db, &id, source_text.as_deref(), &result)).await
    }
}

fn preview(text: &str) -> String {
    let mut chars = text
        .split_whitespace()
        .enumerate()
        .flat_map(|(index, word)| (index > 0).then_some(' ').into_iter().chain(word.chars()));
    let mut preview: String = chars.by_ref().take(PREVIEW_LENGTH).collect();
    if chars.next().is_some() {
        preview.push('…');
    }
    preview
}

fn record(
    db: &mut Connection,
    id: &str,
    source_text: Option<&str>,
    result: &HistoryResult,
) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    if let Some(text) = source_text {
        tx.execute(
            "INSERT OR IGNORE INTO translation_history (id, source_text, preview) VALUES (?1, ?2, ?3)",
            params![id, text, preview(text)],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO translation_history_result
             (history_sequence, position, preset_name, source_language, target_language, translated_text)
         SELECT sequence, ?2, ?3, ?4, ?5, ?6 FROM translation_history WHERE id = ?1",
        params![
            id,
            result.position,
            result.preset_name,
            result.source_language,
            result.target_language,
            result.text
        ],
    )?;
    if source_text.is_some() {
        tx.execute(
            "DELETE FROM translation_history WHERE sequence <= (
                 SELECT sequence FROM translation_history ORDER BY sequence DESC LIMIT 1 OFFSET ?1
             )",
            [RETENTION_COUNT],
        )?;
    }
    tx.commit()
}

fn list_recent(db: &Connection) -> rusqlite::Result<Vec<HistorySummary>> {
    let mut query =
        db.prepare("SELECT id, preview FROM translation_history ORDER BY sequence DESC LIMIT ?1")?;
    query
        .query_map([RETENTION_COUNT], |row| {
            Ok(HistorySummary {
                id: row.get(0)?,
                preview: row.get(1)?,
            })
        })?
        .collect()
}

fn read(db: &Connection, id: &str) -> rusqlite::Result<Option<HistorySnapshot>> {
    let mut query = db.prepare(
        "SELECT h.source_text, r.position, r.preset_name, r.source_language,
                r.target_language, r.translated_text
         FROM translation_history AS h JOIN translation_history_result AS r
              ON r.history_sequence = h.sequence
         WHERE h.id = ?1 ORDER BY r.position",
    )?;
    let mut rows = query.query([id])?;
    let Some(first) = rows.next()? else {
        return Ok(None);
    };
    let source_text = first.get(0)?;
    let mut results = vec![read_result(first)?];
    while let Some(row) = rows.next()? {
        results.push(read_result(row)?);
    }
    Ok(Some(HistorySnapshot {
        id: id.to_owned(),
        source_text,
        results,
    }))
}

fn read_result(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryResult> {
    Ok(HistoryResult {
        position: row.get(1)?,
        preset_name: row.get(2)?,
        source_language: row.get(3)?,
        target_language: row.get(4)?,
        text: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let ordinal = NEXT.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
            Self(std::env::temp_dir().join(format!(
                "my-translator-history-{}-{}-{ordinal}",
                std::process::id(),
                stamp.as_nanos()
            )))
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn result(position: u32, text: &str) -> HistoryResult {
        HistoryResult {
            position,
            preset_name: "Test preset".into(),
            source_language: "en".into(),
            target_language: "zh".into(),
            text: text.into(),
        }
    }

    #[test]
    fn reopens_complete_snapshots_in_original_card_order() {
        let dir = TestDir::new();
        let input = "  Original\n原文  ";
        let first = result(0, "第一条\n译文");
        let second = result(1, "第二条");
        {
            let mut db = database::open_at(&dir.0).unwrap();
            record(&mut db, "older", Some(input), &second).unwrap();
            record(&mut db, "newer", Some("Newer"), &first).unwrap();
            record(&mut db, "older", None, &first).unwrap();
        }
        let db = database::open_at(&dir.0).unwrap();
        let entries = list_recent(&db).unwrap();
        assert_eq!(entries[0].id, "newer");
        assert_eq!(entries[1].preview, "Original 原文");
        let restored = read(&db, "older").unwrap().unwrap();
        assert_eq!(restored.source_text, input);
        assert_eq!(restored.results, vec![first, second]);
    }

    #[test]
    fn prunes_entire_actions_and_does_not_revive_them_on_late_result() {
        let dir = TestDir::new();
        let mut db = database::open_at(&dir.0).unwrap();
        for n in 0..=RETENTION_COUNT {
            record(&mut db, &n.to_string(), Some("Input"), &result(0, "Output")).unwrap();
        }
        record(&mut db, "0", None, &result(1, "Late")).unwrap();
        let entries = list_recent(&db).unwrap();
        assert_eq!(entries.len(), RETENTION_COUNT as usize);
        assert_eq!(entries.first().unwrap().id, RETENTION_COUNT.to_string());
        assert_eq!(entries.last().unwrap().id, "1");
        assert!(read(&db, "0").unwrap().is_none());
        let count: u32 = db
            .query_row(
                "SELECT count(*) FROM translation_history_result",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, RETENTION_COUNT);
    }

    #[test]
    fn bounds_only_the_preview_at_a_unicode_boundary() {
        let text = "译".repeat(PREVIEW_LENGTH + 10);
        assert_eq!(preview(&text), format!("{}…", "译".repeat(PREVIEW_LENGTH)));
    }
}
