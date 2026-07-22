// ABOUTME: Ordered embedded SQL migration runner using PRAGMA user_version.
// ABOUTME: Migrations apply inside one transaction; SQL must stay transaction-compatible.
use crate::error::StorageError;
use rusqlite::Connection;

/// Embedded migrations in application order. Index 0 is version 1.
pub const MIGRATIONS: &[&str] = &[
  include_str!("../../migrations/0001_initial.sql"),
  include_str!("../../migrations/0002_provider_sort_order.sql"),
  include_str!("../../migrations/0003_profile_languages.sql"),
  include_str!("../../migrations/0004_model_adapter_id.sql"),
  include_str!("../../migrations/0005_profile_language_detection.sql"),
  include_str!("../../migrations/0006_profile_language_preferences.sql"),
  include_str!("../../migrations/0007_profile_streaming.sql"),
  include_str!("../../migrations/0008_translation_history.sql"),
  include_str!("../../migrations/0009_profile_prompt_templates.sql"),
  include_str!("../../migrations/0010_ocr_services.sql"),
  include_str!("../../migrations/0011_provider_transport_contract.sql"),
];

pub fn latest_version() -> i32 {
  MIGRATIONS.len() as i32
}

pub fn read_user_version(conn: &Connection) -> Result<i32, StorageError> {
  conn
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .map_err(StorageError::from)
}

pub fn set_user_version(conn: &Connection, version: i32) -> Result<(), StorageError> {
  conn
    .execute_batch(&format!("PRAGMA user_version = {version}"))
    .map_err(StorageError::from)
}

/// Apply all pending migrations inside the current connection (caller owns transaction).
pub fn apply_pending(conn: &Connection, from_version: i32) -> Result<(), StorageError> {
  apply_pending_with(conn, from_version, MIGRATIONS)
}

/// Apply migrations from an explicit ordered slice (production or test injection).
pub fn apply_pending_with(conn: &Connection, from_version: i32, migrations: &[&str]) -> Result<(), StorageError> {
  let target = migrations.len() as i32;
  if from_version > target {
    return Err(StorageError::StorageVersionUnsupported(format!(
      "database version {from_version} is newer than application version {target}"
    )));
  }
  if from_version == target {
    return Ok(());
  }

  for (index, sql) in migrations.iter().enumerate() {
    let version = (index + 1) as i32;
    if version <= from_version {
      continue;
    }
    conn
      .execute_batch(sql)
      .map_err(|e| StorageError::Migration(format!("migration {version} failed: {e}")))?;
    set_user_version(conn, version)?;
  }
  Ok(())
}

/// Run migrations in a single transaction on a writable connection.
pub fn migrate(conn: &mut Connection) -> Result<i32, StorageError> {
  migrate_with(conn, MIGRATIONS)
}

/// Run an explicit migration slice in one transaction (test injection for failure paths).
pub fn migrate_with(conn: &mut Connection, migrations: &[&str]) -> Result<i32, StorageError> {
  let from = read_user_version(conn)?;
  let target = migrations.len() as i32;
  if from > target {
    return Err(StorageError::StorageVersionUnsupported(format!(
      "database version {from} is newer than application version {target}"
    )));
  }
  if from == target {
    return Ok(from);
  }

  // Table rebuilds (rename/drop) require foreign_keys off; PRAGMA is a no-op inside a transaction.
  conn
    .execute_batch("PRAGMA foreign_keys = OFF")
    .map_err(|e| StorageError::Migration(format!("disable foreign_keys for migration: {e}")))?;
  let result = (|| {
    let tx = conn
      .transaction()
      .map_err(|e| StorageError::Migration(format!("begin migration transaction: {e}")))?;
    apply_pending_with(&tx, from, migrations)?;
    tx.commit()
      .map_err(|e| StorageError::Migration(format!("commit migration: {e}")))?;
    Ok(target)
  })();
  let _ = conn.execute_batch("PRAGMA foreign_keys = ON");
  result
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::{Connection, OptionalExtension};

  #[test]
  fn migrate_empty_database_to_latest() {
    let mut conn = Connection::open_in_memory().unwrap();
    let version = migrate(&mut conn).unwrap();
    assert_eq!(version, latest_version());
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM app_settings", [], |r| r.get(0))
      .unwrap();
    assert_eq!(count, 1);
    // v3 columns exist for profile language prefs.
    let _: Option<String> = conn
      .query_row("SELECT source_lang FROM translation_profiles LIMIT 1", [], |r| r.get(0))
      .optional()
      .unwrap();
    // v4 optional per-model API Type override.
    let _: Option<String> = conn
      .query_row("SELECT adapter_id FROM provider_models LIMIT 1", [], |r| r.get(0))
      .optional()
      .unwrap();
    // v5 optional profile language detector config JSON.
    let _: Option<String> = conn
      .query_row(
        "SELECT language_detection_json FROM translation_profiles LIMIT 1",
        [],
        |r| r.get(0),
      )
      .optional()
      .unwrap();
    // v6 optional profile Primary/Target preference columns.
    let _: Option<String> = conn
      .query_row("SELECT primary_lang FROM translation_profiles LIMIT 1", [], |r| {
        r.get(0)
      })
      .optional()
      .unwrap();
    let _: Option<String> = conn
      .query_row(
        "SELECT preferred_target_lang FROM translation_profiles LIMIT 1",
        [],
        |r| r.get(0),
      )
      .optional()
      .unwrap();
    // v7 is a no-op historical slot (stream toggle removed).
    // v8 translation_history table exists and is empty on a fresh database.
    let history_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM translation_history", [], |r| r.get(0))
      .unwrap();
    assert_eq!(history_count, 0);
    // v9 multi prompt-template table exists on a fresh database.
    let template_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM translation_profile_prompt_templates", [], |r| {
        r.get(0)
      })
      .unwrap();
    assert_eq!(template_count, 0);
    // v9 profile rows use default_prompt_template_id (no system_template/user_template).
    let has_default_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('translation_profiles') WHERE name = 'default_prompt_template_id'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_default_col, 1);
    // v10 OCR services tables exist and are empty on a fresh database.
    let ocr_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM ocr_services", [], |r| r.get(0))
      .unwrap();
    assert_eq!(ocr_count, 0);
    let ocr_template_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM ocr_prompt_templates", [], |r| r.get(0))
      .unwrap();
    assert_eq!(ocr_template_count, 0);
  }

  #[test]
  fn migrate_v4_through_latest_wipes_legacy_profiles_for_template_schema() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..4]).unwrap();
    conn
      .execute(
        "INSERT INTO translation_profiles (
                                id, name, enabled, template_version, system_template, user_template,
                                source_lang, target_lang, created_at, updated_at
                        ) VALUES ('profile-1', 'Legacy', 1, 1, 'system', '{{text}}', 'zh', 'en', 't', 't')",
        [],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    // v9 discards pre-multi-template profile rows (no legacy template compatibility).
    let count: i64 = conn
      .query_row("SELECT COUNT(*) FROM translation_profiles", [], |r| r.get(0))
      .unwrap();
    assert_eq!(count, 0);
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());
  }

  #[test]
  fn migrate_v6_to_v7_no_op_keeps_profile_rows() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..6]).unwrap();
    conn
      .execute(
        "INSERT INTO translation_profiles (
                                id, name, enabled, template_version, system_template, user_template,
                                source_lang, target_lang, primary_lang, preferred_target_lang, created_at, updated_at
                        ) VALUES ('profile-v7', 'Legacy', 1, 1, 'system', '{{text}}', 'zh', 'en', 'zh', 'en', 't', 't')",
        [],
      )
      .unwrap();

    migrate_with(&mut conn, &MIGRATIONS[..7]).unwrap();
    let count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM translation_profiles WHERE id = 'profile-v7'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(count, 1);
    assert_eq!(read_user_version(&conn).unwrap(), 7);
  }

  #[test]
  fn migrate_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());
  }
}
