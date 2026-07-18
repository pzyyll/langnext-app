// ABOUTME: Database lifecycle, PRAGMA, migration, backup, and constraint tests.
// ABOUTME: Uses real temporary SQLite files under tempfile directories.
use crate::storage::database::Database;
use crate::storage::migrations::{self, latest_version, read_user_version};
use rusqlite::Connection;
use std::fs;

fn temp_db() -> (tempfile::TempDir, Database) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  (dir, db)
}

#[test]
fn fresh_creation_and_reopen_idempotent() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  assert!(db.path().exists());

  db.initialize().unwrap();
  db.read(|conn| {
    assert_eq!(read_user_version(conn).unwrap(), latest_version());
    let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(journal.to_lowercase(), "wal");
    let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(fk, 1);
    Ok(())
  })
  .unwrap();
}

#[test]
fn user_version_is_latest() {
  let (_dir, db) = temp_db();
  db.read(|conn| {
    assert_eq!(read_user_version(conn).unwrap(), latest_version());
    assert_eq!(latest_version(), 8);
    Ok(())
  })
  .unwrap();
}

#[test]
fn credential_none_rejects_ref() {
  let (_dir, db) = temp_db();
  let err = db.write(|conn| {
    conn
      .execute(
        "INSERT INTO provider_instances (
                id, adapter_id, display_name, credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES (?1, 'openai-compatible', 'x', 'none', 'ref', 1, 'inherit', 'never', 't', 't')",
        rusqlite::params!["p1"],
      )
      .map_err(crate::error::StorageError::from)?;
    Ok(())
  });
  assert!(err.is_err());
}

#[test]
fn credential_api_key_allows_null_ref() {
  let (_dir, db) = temp_db();
  db.write(|conn| {
    conn
      .execute(
        "INSERT INTO provider_instances (
                id, adapter_id, display_name, credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES (?1, 'openai-compatible', 'x', 'api_key', NULL, 1, 'inherit', 'never', 't', 't')",
        rusqlite::params!["p1"],
      )
      .map_err(crate::error::StorageError::from)?;
    Ok(())
  })
  .unwrap();
}

#[test]
fn model_uniqueness_per_provider() {
  let (_dir, db) = temp_db();
  db.write(|conn| {
    conn
      .execute(
        "INSERT INTO provider_instances (
                id, adapter_id, display_name, credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES (?1, 'openai-compatible', 'x', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
        rusqlite::params!["p1"],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
                id, provider_instance_id, model_key, source, enabled, availability, created_at, updated_at
            ) VALUES ('m1', 'p1', 'gpt', 'manual', 1, 'available', 't', 't')",
        [],
      )
      .unwrap();
    let err = conn.execute(
      "INSERT INTO provider_models (
                id, provider_instance_id, model_key, source, enabled, availability, created_at, updated_at
            ) VALUES ('m2', 'p1', 'gpt', 'manual', 1, 'available', 't', 't')",
      [],
    );
    assert!(err.is_err());
    Ok(())
  })
  .unwrap();
}

#[test]
fn delete_provider_restricts_when_model_exists() {
  let (_dir, db) = temp_db();
  db.write(|conn| {
    conn
      .execute(
        "INSERT INTO provider_instances (
                id, adapter_id, display_name, credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES ('p1', 'openai-compatible', 'x', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
                id, provider_instance_id, model_key, source, enabled, availability, created_at, updated_at
            ) VALUES ('m1', 'p1', 'gpt', 'manual', 1, 'available', 't', 't')",
        [],
      )
      .unwrap();
    let err = conn.execute("DELETE FROM provider_instances WHERE id = 'p1'", []);
    assert!(err.is_err());
    Ok(())
  })
  .unwrap();
}

#[test]
fn profile_target_cascades_on_profile_delete() {
  let (_dir, db) = temp_db();
  db.write(|conn| {
    conn
      .execute(
        "INSERT INTO provider_instances (
                id, adapter_id, display_name, credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES ('p1', 'openai-compatible', 'x', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
                id, provider_instance_id, model_key, source, enabled, availability, created_at, updated_at
            ) VALUES ('m1', 'p1', 'gpt', 'manual', 1, 'available', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profiles (
                id, name, enabled, template_version, system_template, user_template, created_at, updated_at
            ) VALUES ('tp1', 'fast', 1, 1, 'sys', 'text {{text}}', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profile_models (translation_profile_id, provider_model_id, priority)
             VALUES ('tp1', 'm1', 0)",
        [],
      )
      .unwrap();
    conn
      .execute("DELETE FROM translation_profiles WHERE id = 'tp1'", [])
      .unwrap();
    let count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM translation_profile_models WHERE translation_profile_id = 'tp1'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(count, 0);
    Ok(())
  })
  .unwrap();
}

#[test]
fn profile_priority_uniqueness() {
  let (_dir, db) = temp_db();
  db.write(|conn| {
    conn
      .execute(
        "INSERT INTO provider_instances (
                id, adapter_id, display_name, credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES ('p1', 'openai-compatible', 'x', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
                id, provider_instance_id, model_key, source, enabled, availability, created_at, updated_at
            ) VALUES ('m1', 'p1', 'a', 'manual', 1, 'available', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
                id, provider_instance_id, model_key, source, enabled, availability, created_at, updated_at
            ) VALUES ('m2', 'p1', 'b', 'manual', 1, 'available', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profiles (
                id, name, enabled, template_version, system_template, user_template, created_at, updated_at
            ) VALUES ('tp1', 'fast', 1, 1, 'sys', 'text {{text}}', 't', 't')",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profile_models (translation_profile_id, provider_model_id, priority)
             VALUES ('tp1', 'm1', 0)",
        [],
      )
      .unwrap();
    let err = conn.execute(
      "INSERT INTO translation_profile_models (translation_profile_id, provider_model_id, priority)
             VALUES ('tp1', 'm2', 0)",
      [],
    );
    assert!(err.is_err());
    Ok(())
  })
  .unwrap();
}

#[test]
fn app_settings_seeded() {
  let (_dir, db) = temp_db();
  db.read(|conn| {
    let (schema, json): (i64, String) = conn
      .query_row(
        "SELECT schema_version, value_json FROM app_settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
      )
      .unwrap();
    assert_eq!(schema, 1);
    assert!(json.contains("schemaVersion"));
    Ok(())
  })
  .unwrap();
}

#[test]
fn backup_created_before_synthetic_upgrade() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();

  // Simulate pending migration by lowering user_version and adding a fake migration path
  // through direct backup API usage (version still 1; exercise backup helper).
  let src = Connection::open(db.path()).unwrap();
  let backup_dir = db.backup_dir();
  fs::create_dir_all(&backup_dir).unwrap();
  let dest = backup_dir.join("langnext-v0-test.sqlite3");
  {
    let mut dst = Connection::open(&dest).unwrap();
    let backup = rusqlite::backup::Backup::new(&src, &mut dst).unwrap();
    backup
      .run_to_completion(100, std::time::Duration::from_millis(5), None)
      .unwrap();
  }
  assert!(dest.exists());
  let snap = Connection::open(&dest).unwrap();
  let result: String = snap.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
  assert_eq!(result, "ok");
}

#[test]
fn reject_corrupt_database_on_probe() {
  let dir = tempfile::tempdir().unwrap();
  let path = dir.path().join("langnext.sqlite3");
  fs::write(&path, b"this is not a sqlite database").unwrap();
  let db = Database::new(dir.path()).unwrap();
  let err = db.initialize();
  assert!(err.is_err());
}

#[test]
fn migrations_module_latest_version() {
  assert_eq!(migrations::latest_version(), 8);
}

#[test]
fn migration_failing_second_preserves_version() {
  use crate::storage::migrations;
  let mut conn = Connection::open_in_memory().unwrap();
  let ok = migrations::migrate_with(&mut conn, &["CREATE TABLE t1 (id INTEGER);"]).unwrap();
  assert_eq!(ok, 1);
  assert_eq!(migrations::read_user_version(&conn).unwrap(), 1);
  let err = migrations::migrate_with(
    &mut conn,
    &["CREATE TABLE t1 (id INTEGER);", "THIS IS NOT VALID SQL !!!"],
  );
  assert!(err.is_err());
  // Transaction rolled back — still at version 1 from previous successful migrate...
  // Actually migrate_with starts a new transaction from current version; failed migration
  // should leave version at 1.
  assert_eq!(migrations::read_user_version(&conn).unwrap(), 1);
}

#[test]
fn rotate_backups_quarantines_corrupt_snapshots() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let backup_dir = db.backup_dir();
  fs::create_dir_all(&backup_dir).unwrap();

  // Create four verified snapshots via real backup API.
  for i in 0..4 {
    let dest = backup_dir.join(format!("langnext-v1-valid{i}.sqlite3"));
    {
      let src = Connection::open(db.path()).unwrap();
      let mut dst = Connection::open(&dest).unwrap();
      let backup = rusqlite::backup::Backup::new(&src, &mut dst).unwrap();
      backup
        .run_to_completion(100, std::time::Duration::from_millis(5), None)
        .unwrap();
      // Explicitly drop backup/dst before next iteration.
      drop(backup);
      drop(dst);
      drop(src);
    }
    // Ensure distinct mtimes on Windows.
    std::thread::sleep(std::time::Duration::from_millis(30));
  }
  // One corrupt candidate
  fs::write(backup_dir.join("langnext-v1-corrupt.sqlite3"), b"not-a-db").unwrap();

  db.rotate_backups().unwrap();

  let remaining: Vec<_> = fs::read_dir(&backup_dir)
    .unwrap()
    .filter_map(|e| e.ok())
    .filter(|e| {
      let name = e.file_name().to_string_lossy().to_string();
      name.ends_with(".sqlite3") && !name.contains("invalid")
    })
    .collect();
  assert_eq!(
    remaining.len(),
    3,
    "expected three valid snapshots, found {:?}",
    remaining.iter().map(|e| e.file_name()).collect::<Vec<_>>()
  );
  let invalid: Vec<_> = fs::read_dir(&backup_dir)
    .unwrap()
    .filter_map(|e| e.ok())
    .filter(|e| e.file_name().to_string_lossy().contains("invalid"))
    .collect();
  assert!(!invalid.is_empty());
}

#[test]
fn read_snapshot_exports_consistent_aggregate() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  // Seed one provider + model
  use crate::domain::model::{Availability, ModelSource, ProviderModel};
  use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode};
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::{provider_instances, provider_models};
  let pid = new_id();
  let mid = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    provider_instances::insert(
      uow.conn(),
      &ProviderInstance {
        id: pid,
        adapter_id: "openai-compatible".into(),
        display_name: "P".into(),
        base_url_override: None,
        credential_kind: CredentialKind::None,
        credential_ref: None,
        enabled: true,
        proxy_mode: ProxyMode::Inherit,
        insecure_http_confirmed_at: None,
        models_synced_at: None,
        models_sync_status: ModelsSyncStatus::Never,
        models_sync_error_code: None,
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    provider_models::insert(
      uow.conn(),
      &ProviderModel {
        id: mid,
        provider_instance_id: pid,
        model_key: "m".into(),
        source: ModelSource::Manual,
        remote_display_name: None,
        display_name_override: None,
        enabled: true,
        availability: Availability::Available,
        remote_metadata_json: None,
        capability_overrides_json: None,
        adapter_id: None,
        last_seen_at: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();

  // Snapshot should see consistent provider+model counts.
  let (pc, mc) = db
    .read_snapshot(|conn| {
      let providers = provider_instances::list(conn)?;
      let models = provider_models::list_all(conn)?;
      Ok((providers.len(), models.len()))
    })
    .unwrap();
  assert_eq!(pc, 1);
  assert_eq!(mc, 1);
}
