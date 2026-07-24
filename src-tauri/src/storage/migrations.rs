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
  include_str!("../../migrations/0012_service_integrations.sql"),
  include_str!("../../migrations/0013_translation_profile_engines.sql"),
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
    // v12 service integration tables exist and are empty on a fresh database.
    let integration_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM integration_instances", [], |r| r.get(0))
      .unwrap();
    assert_eq!(integration_count, 0);
    let binding_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM integration_credential_bindings", [], |r| r.get(0))
      .unwrap();
    assert_eq!(binding_count, 0);
    // v12 journal has non-null slot_id.
    let has_slot_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('credential_operations') WHERE name = 'slot_id'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_slot_col, 1);
    // v13 engine_kind column exists on translation_profiles.
    let has_engine_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('translation_profiles') WHERE name = 'engine_kind'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_engine_col, 1);
    let has_integration_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('translation_profiles') WHERE name = 'integration_instance_id'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_integration_col, 1);
  }

  #[test]
  fn migrate_v12_to_v13_backfills_llm_engine_kind_byte_equivalent() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..12]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 12);

    // Seed an LLM profile at v12 shape (no engine_kind).
    conn
      .execute(
        "INSERT INTO translation_profiles (
          id, name, enabled, template_version, default_prompt_template_id,
          temperature, max_output_tokens, provider_options_json,
          source_lang, target_lang, primary_lang, preferred_target_lang,
          language_detection_json, created_at, updated_at
        ) VALUES (
          'profile-1', 'Legacy LLM', 1, 1, 'template-1',
          0.2, 1024, NULL,
          'zh', 'en', 'zh', 'en',
          NULL, 't0', 't1'
        )",
        [],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 13);

    let (
      engine_kind,
      name,
      template_version,
      default_prompt_template_id,
      temperature,
      max_output_tokens,
      source_lang,
      target_lang,
      primary_lang,
      preferred_target_lang,
      created_at,
      updated_at,
      integration_instance_id,
    ): (
      String,
      String,
      i32,
      String,
      f64,
      i64,
      String,
      String,
      String,
      String,
      String,
      String,
      Option<String>,
    ) = conn
      .query_row(
        "SELECT engine_kind, name, template_version, default_prompt_template_id,
                temperature, max_output_tokens, source_lang, target_lang,
                primary_lang, preferred_target_lang, created_at, updated_at,
                integration_instance_id
         FROM translation_profiles WHERE id = 'profile-1'",
        [],
        |r| {
          Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
            r.get(9)?,
            r.get(10)?,
            r.get(11)?,
            r.get(12)?,
          ))
        },
      )
      .unwrap();

    assert_eq!(engine_kind, "llm_model_chain");
    assert_eq!(name, "Legacy LLM");
    assert_eq!(template_version, 1);
    assert_eq!(default_prompt_template_id, "template-1");
    assert!((temperature - 0.2).abs() < f64::EPSILON);
    assert_eq!(max_output_tokens, 1024);
    assert_eq!(source_lang, "zh");
    assert_eq!(target_lang, "en");
    assert_eq!(primary_lang, "zh");
    assert_eq!(preferred_target_lang, "en");
    assert_eq!(created_at, "t0");
    assert_eq!(updated_at, "t1");
    assert!(integration_instance_id.is_none());
  }

  #[test]
  fn migrate_v11_to_v12_preserves_credential_journal_rows() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..11]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 11);

    conn
      .execute(
        "INSERT INTO credential_operations (
          id, owner_kind, owner_id, expected_old_ref, new_ref, state, created_at
        ) VALUES (
          'op-1', 'provider', 'prov-1', NULL, 'provider/prov-1/op-1', 'prepared', 't'
        )",
        [],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    let (owner_kind, owner_id, slot_id, new_ref, state): (String, String, String, String, String) = conn
      .query_row(
        "SELECT owner_kind, owner_id, slot_id, new_ref, state FROM credential_operations WHERE id = 'op-1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
      )
      .unwrap();
    assert_eq!(owner_kind, "provider");
    assert_eq!(owner_id, "prov-1");
    assert_eq!(slot_id, "primary");
    assert_eq!(new_ref, "provider/prov-1/op-1");
    assert_eq!(state, "prepared");

    // Fresh integration tables are empty after upgrade.
    let integration_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM integration_instances", [], |r| r.get(0))
      .unwrap();
    assert_eq!(integration_count, 0);
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
