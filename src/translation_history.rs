//! Local history of completed Quick Translate actions.

use std::path::{Path, PathBuf};

use nsh_core::prelude::*;
use rusqlite::{Connection, params};

const HISTORY_FILE: &str = "translation-history.sqlite3";
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

/// The Quick Translate history database in the app's data directory.
#[module]
pub struct TranslationHistoryNative;

#[module]
impl TranslationHistoryNative {
    /// Returns the most recent completed actions in newest-first order.
    pub async fn list_recent() -> Result<Vec<HistorySummary>, String> {
        run_history(|db| list_recent(db)).await
    }

    /// Reads an action and its completed results, or null if it is no longer retained.
    pub async fn read(id: String) -> Result<Option<HistorySnapshot>, String> {
        run_history(move |db| read(db, &id)).await
    }

    /// Saves a successful result. A non-null source starts the action's history entry.
    pub async fn record(
        id: String,
        source_text: Option<String>,
        result: HistoryResult,
    ) -> Result<(), String> {
        run_history(move |db| record(db, &id, source_text.as_deref(), &result)).await
    }
}

async fn run_history<T: Send + 'static>(
    operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String> {
    let failure = || "Could not access translation history.".to_owned();
    let dir = data_dir().ok_or_else(failure)?;
    blocking(move || {
        let path = history_path(&dir)?;
        let mut db = Connection::open(path).map_err(|_| failure())?;
        initialize(&db).map_err(|_| failure())?;
        operation(&mut db).map_err(|_| failure())
    })
    .await
    .map_err(|_| failure())?
}

fn history_path(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|_| "Could not create the app data directory.".to_owned())?;
    Ok(dir.join(HISTORY_FILE))
}

fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS history (
             sequence INTEGER PRIMARY KEY,
             id TEXT NOT NULL UNIQUE,
             source_text TEXT NOT NULL,
             preview TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS history_result (
             history_sequence INTEGER NOT NULL REFERENCES history(sequence) ON DELETE CASCADE,
             position INTEGER NOT NULL,
             preset_name TEXT NOT NULL,
             source_language TEXT NOT NULL,
             target_language TEXT NOT NULL,
             translated_text TEXT NOT NULL,
             PRIMARY KEY (history_sequence, position)
         );",
    )
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
            "INSERT OR IGNORE INTO history (id, source_text, preview) VALUES (?1, ?2, ?3)",
            params![id, text, preview(text)],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO history_result
             (history_sequence, position, preset_name, source_language, target_language, translated_text)
         SELECT sequence, ?2, ?3, ?4, ?5, ?6 FROM history WHERE id = ?1",
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
            "DELETE FROM history WHERE sequence <= (
                 SELECT sequence FROM history ORDER BY sequence DESC LIMIT 1 OFFSET ?1
             )",
            [RETENTION_COUNT],
        )?;
    }
    tx.commit()
}

fn list_recent(db: &Connection) -> rusqlite::Result<Vec<HistorySummary>> {
    let mut query =
        db.prepare("SELECT id, preview FROM history ORDER BY sequence DESC LIMIT ?1")?;
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
         FROM history AS h JOIN history_result AS r ON r.history_sequence = h.sequence
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
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

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
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        let dir = TestDir(std::env::temp_dir().join(format!(
            "my-translator-history-{}-{}",
            std::process::id(),
            stamp.as_nanos()
        )));
        let path = history_path(&dir.0).unwrap();
        let input = "  Original\n原文  ";
        let first = result(0, "第一条\n译文");
        let second = result(1, "第二条");
        {
            let mut db = Connection::open(&path).unwrap();
            initialize(&db).unwrap();
            record(&mut db, "older", Some(input), &second).unwrap();
            record(&mut db, "newer", Some("Newer"), &first).unwrap();
            record(&mut db, "older", None, &first).unwrap();
        }
        let db = Connection::open(&path).unwrap();
        initialize(&db).unwrap();
        let entries = list_recent(&db).unwrap();
        assert_eq!(entries[0].id, "newer");
        assert_eq!(entries[1].preview, "Original 原文");
        let restored = read(&db, "older").unwrap().unwrap();
        assert_eq!(restored.source_text, input);
        assert_eq!(restored.results, vec![first, second]);
    }

    #[test]
    fn prunes_entire_actions_and_does_not_revive_them_on_late_result() {
        let mut db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
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
            .query_row("SELECT count(*) FROM history_result", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, RETENTION_COUNT);
    }

    #[test]
    fn bounds_only_the_preview_at_a_unicode_boundary() {
        let text = "译".repeat(PREVIEW_LENGTH + 10);
        assert_eq!(preview(&text), format!("{}…", "译".repeat(PREVIEW_LENGTH)));
    }
}
