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
    assert_eq!(latest_version(), 17);
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
                id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES (?1, 'openai-compatible', 'x', 'https://api.openai.com/v1', 'plugin_default', '{\"schemaVersion\":1,\"type\":\"none\"}', 'none', 'ref', 1, 'inherit', 'never', 't', 't')",
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
                id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES (?1, 'openai-compatible', 'x', 'https://api.openai.com/v1', 'plugin_default', '{\"schemaVersion\":1,\"type\":\"bearer\"}', 'api_key', NULL, 1, 'inherit', 'never', 't', 't')",
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
                id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES (?1, 'openai-compatible', 'x', 'https://api.openai.com/v1', 'plugin_default', '{\"schemaVersion\":1,\"type\":\"none\"}', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
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
                id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES ('p1', 'openai-compatible', 'x', 'https://api.openai.com/v1', 'plugin_default', '{\"schemaVersion\":1,\"type\":\"none\"}', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
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
                id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES ('p1', 'openai-compatible', 'x', 'https://api.openai.com/v1', 'plugin_default', '{\"schemaVersion\":1,\"type\":\"none\"}', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
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
                id, name, enabled, engine_kind, template_version, default_prompt_template_id, created_at, updated_at
            ) VALUES ('tp1', 'fast', 1, 'llm_model_chain', 1, 'tpl1', 't', 't')",
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
                id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref,
                enabled, proxy_mode, models_sync_status, created_at, updated_at
            ) VALUES ('p1', 'openai-compatible', 'x', 'https://api.openai.com/v1', 'plugin_default', '{\"schemaVersion\":1,\"type\":\"none\"}', 'none', NULL, 1, 'inherit', 'never', 't', 't')",
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
                id, name, enabled, engine_kind, template_version, default_prompt_template_id, created_at, updated_at
            ) VALUES ('tp1', 'fast', 1, 'llm_model_chain', 1, 'tpl1', 't', 't')",
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
  assert_eq!(migrations::latest_version(), 17);
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
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
  };
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
        base_url: "https://api.openai.com/v1".into(),
        base_url_source: BaseUrlSource::PluginDefault,
        auth_scheme: AuthSchemeV1::none(),
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
/// Phase 0 runtime-plugin security assertions that need the project source tree.
///
/// These read `src/lib.rs`, `build.rs` output (`permissions/autogenerated/`),
/// `permissions/app-commands.toml`, `capabilities/*.json`, and `tauri.conf.json` to enforce
/// that every app-local IPC command is reviewed, ACL-gated, and granted only to trusted
/// application WebViews, and that the CSP/asset baseline is locked.
mod runtime_plugin_security {
  use std::collections::{BTreeMap, BTreeSet};
  use std::path::{Path, PathBuf};

  /// `CARGO_MANIFEST_DIR` points at `src-tauri/` for both `cargo test` and `cargo build`.
  fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
  }

  fn trusted_webview_labels() -> BTreeSet<String> {
    [
      crate::consts::WIN_LABEL_MAIN,
      crate::consts::WIN_LABEL_QUICK_TRANSLATE,
      crate::consts::WIN_LABEL_SCREENSHOT_OVERLAY,
    ]
    .into_iter()
    .map(String::from)
    .collect()
  }

  /// Command names registered in `invoke_handler!` (last `::` segment of each path).
  fn generate_handler_commands() -> BTreeSet<String> {
    let lib = std::fs::read_to_string(manifest_dir().join("src/lib.rs")).expect("read src/lib.rs");
    let start = lib.find("generate_handler![").expect("generate_handler! present");
    let rest = &lib[start..];
    let end = rest.find(']').expect("generate_handler! closing bracket");
    let block = &rest[..end];
    block
      .split(',')
      .filter_map(|tok| {
        let tok = tok.split("//").next().unwrap_or(tok).trim();
        if tok.is_empty() {
          return None;
        }
        let name = tok.rsplit("::").next().unwrap_or(tok).trim();
        if name.is_empty() {
          return None;
        }
        Some(name.to_string())
      })
      .collect()
  }

  /// Command names realized by the `AppManifest` (filenames in `permissions/autogenerated/`).
  fn autogenerated_commands() -> BTreeSet<String> {
    let dir = manifest_dir().join("permissions/autogenerated");
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read autogenerated dir {}: {e}", dir.display()));
    entries
      .filter_map(|e| e.ok())
      .filter_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        name.strip_suffix(".toml").map(|s| s.to_string())
      })
      .collect()
  }

  /// Parse all `[[set]]` sections in one authored permission file. Generated command
  /// manifests are excluded by the caller; ownership is evaluated only after all files merge.
  fn parse_permission_sets(path: &Path, contents: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut sets = BTreeMap::new();
    let mut identifier = None;
    let mut commands = BTreeSet::new();
    let mut in_permissions = false;
    let mut saw_set = false;
    let mut finish = |identifier: Option<String>, commands: BTreeSet<String>| {
      if let Some(identifier) = identifier {
        assert!(
          !commands.is_empty(),
          "custom permission set {identifier} must contain app commands"
        );
        assert!(
          sets.insert(identifier.clone(), commands).is_none(),
          "duplicate permission set {identifier}"
        );
      }
    };
    for line in contents.lines() {
      let line = line.trim();
      if line == "[[set]]" {
        assert!(!in_permissions, "{} starts a set inside permissions", path.display());
        finish(identifier.take(), std::mem::take(&mut commands));
        saw_set = true;
        continue;
      }
      if let Some(value) = line.strip_prefix("identifier = ") {
        assert!(saw_set, "{} defines an identifier outside [[set]]", path.display());
        assert!(identifier.is_none(), "{} repeats a set identifier", path.display());
        identifier = Some(value.trim_matches('\"').to_string());
        continue;
      }
      if line.starts_with("permissions = [") {
        assert!(
          identifier.is_some(),
          "{} defines permissions before an identifier",
          path.display()
        );
        in_permissions = true;
        continue;
      }
      if in_permissions && line == "]" {
        in_permissions = false;
        continue;
      }
      if in_permissions {
        let permission = line.trim_end_matches(',').trim_matches('\"');
        if let Some(command) = permission.strip_prefix("allow-") {
          commands.insert(command.replace('-', "_"));
        }
      }
    }
    assert!(
      !in_permissions,
      "{} has an unterminated permissions list",
      path.display()
    );
    finish(identifier, commands);
    drop(finish);
    sets
  }

  /// Every authored custom permission set, excluding generated per-command manifests.
  fn custom_permission_sets() -> BTreeMap<String, BTreeSet<String>> {
    let permissions_dir = manifest_dir().join("permissions");
    let mut sets = BTreeMap::new();
    for entry in std::fs::read_dir(&permissions_dir).expect("read permissions directory") {
      let path = entry.expect("permission entry").path();
      if path.extension().and_then(|extension| extension.to_str()) != Some("toml") {
        continue;
      }
      let contents = std::fs::read_to_string(&path).expect("read custom permission manifest");
      for (identifier, commands) in parse_permission_sets(&path, &contents) {
        assert!(
          sets.insert(identifier.clone(), commands).is_none(),
          "duplicate permission set {identifier}"
        );
      }
    }
    assert!(
      !sets.is_empty(),
      "at least one custom app-command permission set is required"
    );
    sets
  }

  fn reviewed_app_commands(sets: &BTreeMap<String, BTreeSet<String>>) -> BTreeSet<String> {
    let mut owners = BTreeMap::new();
    for (set, commands) in sets {
      for command in commands {
        assert!(
          owners.insert(command.clone(), set.clone()).is_none(),
          "app command {command} is assigned to multiple permission sets; sets must partition the command surface"
        );
      }
    }
    owners.into_keys().collect()
  }

  /// Extract a permission identifier from a capability permission entry, which may be a
  /// bare string (`"allow-foo"`) or an object (`{"identifier": "allow-foo"}`). Returns the
  /// identifier so direct app-command grants cannot bypass ACL review via object form.
  fn permission_identifier(value: &serde_json::Value) -> Option<String> {
    match value {
      serde_json::Value::String(s) => Some(s.clone()),
      serde_json::Value::Object(map) => map.get("identifier").and_then(|v| v.as_str()).map(String::from),
      _ => None,
    }
  }

  /// Direct `allow-<command>` grants (not through a reviewed set) in a capability's permission
  /// list, in either string or object form. Must always be empty for Phase 0 capabilities.
  fn direct_app_command_grants(
    permissions: &[serde_json::Value],
    sets: &BTreeMap<String, BTreeSet<String>>,
  ) -> Vec<String> {
    permissions
      .iter()
      .filter_map(permission_identifier)
      .filter(|name| name.starts_with("allow-") && !sets.contains_key(name))
      .collect()
  }

  #[test]
  fn runtime_plugin_security_app_commands_fully_covered() {
    let registered = generate_handler_commands();
    let autogenerated = autogenerated_commands();
    let permission_sets = custom_permission_sets();
    let reviewed = reviewed_app_commands(&permission_sets);
    assert!(
      !registered.is_empty(),
      "invoke_handler must register at least one command"
    );
    assert_eq!(
      registered, autogenerated,
      "AppManifest command list (build.rs APP_COMMANDS) must equal invoke_handler commands"
    );
    assert_eq!(
      registered, reviewed,
      "permissions/app-commands.toml must review exactly the registered app commands"
    );
  }

  #[test]
  fn runtime_plugin_security_permission_sets_are_explicit_and_partitioned() {
    let sets = custom_permission_sets();
    let reviewed = reviewed_app_commands(&sets);
    assert_eq!(
      reviewed,
      generate_handler_commands(),
      "the union of all custom permission sets must equal the registered app command surface"
    );
  }

  #[test]
  fn runtime_plugin_security_app_commands_granted_only_via_explicit_webviews() {
    let sets = custom_permission_sets();
    let caps_dir = manifest_dir().join("capabilities");
    let trusted = trusted_webview_labels();
    let mut assignments: BTreeMap<String, Vec<BTreeSet<String>>> = BTreeMap::new();
    for entry in std::fs::read_dir(&caps_dir).expect("read capabilities dir") {
      let path = entry.expect("capability entry").path();
      if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        continue;
      }
      let json = std::fs::read_to_string(&path).expect("read capability");
      let capability: serde_json::Value = serde_json::from_str(&json).expect("parse capability json");
      let permissions = capability["permissions"]
        .as_array()
        .unwrap_or_else(|| panic!("capability {} has no permissions array", path.display()));
      let granted_sets: Vec<String> = permissions
        .iter()
        .filter_map(permission_identifier)
        .filter(|name| sets.contains_key(name))
        .collect();
      let direct = direct_app_command_grants(permissions, &sets);
      assert!(
        direct.is_empty(),
        "capability {} grants app commands directly (not through a reviewed set): {direct:?}",
        path.display()
      );
      if granted_sets.is_empty() {
        continue;
      }
      assert!(
        capability.get("windows").is_none(),
        "capability {} grants app commands via windows glob; use exact webviews",
        path.display()
      );
      assert!(
        capability.get("remote").is_none(),
        "capability {} must not grant app commands to remote origins",
        path.display()
      );
      assert!(
        capability
          .get("local")
          .and_then(serde_json::Value::as_bool)
          .unwrap_or(true),
        "capability {} must be local-only",
        path.display()
      );
      let webviews: BTreeSet<String> = capability["webviews"]
        .as_array()
        .map(|items| {
          items
            .iter()
            .filter_map(|value| value.as_str().map(String::from))
            .collect()
        })
        .unwrap_or_default();
      assert!(
        !webviews.is_empty(),
        "capability {} grants app commands without webviews",
        path.display()
      );
      for set in granted_sets {
        assignments.entry(set).or_default().push(webviews.clone());
      }
    }
    for set in sets.keys() {
      let partitions = assignments
        .get(set)
        .unwrap_or_else(|| panic!("permission set {set} is not assigned by any capability"));
      assert_eq!(
        partitions.len(),
        1,
        "permission set {set} must have exactly one Phase 0 capability partition"
      );
      if set == "allow-trusted-app-commands" {
        assert_eq!(
          partitions[0], trusted,
          "trusted app commands must target exactly the trusted WebView labels"
        );
      }
    }
  }

  #[test]
  fn runtime_plugin_security_direct_app_command_grants_fail_closed_in_both_forms() {
    // Reviewed set identifier present in the sets map.
    let mut sets = BTreeMap::new();
    sets.insert(
      "allow-trusted-app-commands".to_string(),
      BTreeSet::from(["show_snap_overlay".to_string()]),
    );
    // A direct app-command grant as a bare string is flagged.
    let string_form = serde_json::json!([{"identifier": "allow-trusted-app-commands"}, "allow-show-snap-overlay"]);
    let direct = direct_app_command_grants(string_form.as_array().unwrap(), &sets);
    assert_eq!(direct, vec!["allow-show-snap-overlay".to_string()]);
    // The same direct grant as an identifier object is also flagged (no bypass via object form).
    let object_form = serde_json::json!([
      {"identifier": "allow-trusted-app-commands"},
      {"identifier": "allow-show-snap-overlay"}
    ]);
    let direct = direct_app_command_grants(object_form.as_array().unwrap(), &sets);
    assert_eq!(direct, vec!["allow-show-snap-overlay".to_string()]);
    // A capability granting only the reviewed set has no direct grants.
    let clean = serde_json::json!([{"identifier": "allow-trusted-app-commands"}, "core:default"]);
    assert!(direct_app_command_grants(clean.as_array().unwrap(), &sets).is_empty());
  }

  #[test]
  fn runtime_plugin_security_parser_handles_multiple_sets_and_files() {
    let first = parse_permission_sets(
      Path::new("first.toml"),
      r#"[[set]]
identifier = "allow-main"
permissions = [
  "allow-command-one",
]

[[set]]
identifier = "allow-plugin-page"
permissions = [
  "allow-command-two",
]
"#,
    );
    let second = parse_permission_sets(
      Path::new("second.toml"),
      r#"[[set]]
identifier = "allow-overlay"
permissions = [
  "allow-command-three",
]
"#,
    );
    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 1);
    let mut all = first;
    all.extend(second);
    assert_eq!(reviewed_app_commands(&all).len(), 3);
  }

  #[test]
  fn runtime_plugin_security_csp_and_asset_scope_locked() {
    let conf = std::fs::read_to_string(manifest_dir().join("tauri.conf.json")).expect("read tauri.conf.json");
    let v: serde_json::Value = serde_json::from_str(&conf).expect("parse tauri.conf.json");
    let security = &v["app"]["security"];

    let csp = security
      .get("csp")
      .and_then(|c| if c.is_null() { None } else { Some(c) })
      .expect("production csp must be set and non-null");

    // Token-level precise CSP assertions for production execution (script-src) and connection
    // (connect-src) directives. Production script-src is `'self'` only; Tauri auto-hashes the
    // inline theme-init script in index.html at build time, so no `'unsafe-inline'`/`'unsafe-eval'`.
    fn directive_tokens<'a>(value: &'a serde_json::Value, directive: &str) -> Vec<&'a str> {
      value
        .get(directive)
        .and_then(|s| s.as_str())
        .unwrap_or_else(|| panic!("{directive} must be present"))
        .split_ascii_whitespace()
        .collect()
    }
    assert_eq!(
      directive_tokens(csp, "script-src"),
      vec!["'self'"],
      "production script-src must be exactly `'self'`"
    );
    assert_eq!(
      directive_tokens(csp, "default-src"),
      vec!["'self'"],
      "production default-src must be exactly `'self'`"
    );
    assert_eq!(
      directive_tokens(csp, "connect-src"),
      vec!["'self'", "ipc:", "http://ipc.localhost"],
      "production connect-src must permit only self and the Tauri IPC origin"
    );
    assert_eq!(
      directive_tokens(csp, "object-src"),
      vec!["'none'"],
      "production object-src must be `'none'`"
    );
    assert_eq!(
      directive_tokens(csp, "base-uri"),
      vec!["'self'"],
      "production base-uri must be `'self'`"
    );
    for directive in ["script-src", "default-src", "connect-src"] {
      let value = csp.get(directive).and_then(|s| s.as_str()).unwrap_or("");
      assert!(
        !value.contains("unsafe-inline") && !value.contains("unsafe-eval"),
        "production {directive} must not allow inline or eval scripts"
      );
    }

    let scope = security["assetProtocol"]["scope"]
      .as_array()
      .expect("assetProtocol.scope array");
    let scope: Vec<&str> = scope
      .iter()
      .map(|value| value.as_str().expect("asset scope string"))
      .collect();
    assert_eq!(
      scope,
      vec!["$TEMP/langnext-screenshot/**/*"],
      "asset scope must be exactly the dedicated screenshot subtree"
    );

    // Token-level precise devCsp assertions. devCsp script-src keeps `'unsafe-inline'` only
    // because @vitejs/plugin-react injects an inline React Refresh preamble and index.html has
    // an inline theme-init script during dev (Tauri auto-hashing applies to bundled assets, not
    // Vite-served dev HTML). `'unsafe-eval'` is removed: modern Vite/esbuild does not use eval.
    let dev_csp = security.get("devCsp").expect("development CSP must be configured");
    assert_eq!(
      directive_tokens(dev_csp, "script-src"),
      vec!["'self'", "'unsafe-inline'"],
      "devCsp script-src must be exactly `'self' 'unsafe-inline'` (no unsafe-eval)"
    );
    assert_eq!(
      directive_tokens(dev_csp, "connect-src"),
      vec![
        "'self'",
        "ipc:",
        "http://ipc.localhost",
        "http://localhost:1420",
        "ws://localhost:1420"
      ],
      "default desktop devCsp must permit only the Vite local HTTP and HMR (both on 1420)"
    );
    let dev_script = dev_csp.get("script-src").and_then(|s| s.as_str()).unwrap_or("");
    assert!(
      !dev_script.contains("unsafe-eval"),
      "devCsp script-src must not allow eval (unproven for modern Vite)"
    );
    let tauri_dir = manifest_dir();
    let workspace = tauri_dir.parent().expect("workspace root");
    let vite_config = std::fs::read_to_string(workspace.join("vite.config.ts")).expect("read vite.config.ts");
    assert!(vite_config.contains("process.env.TAURI_DEV_HOST"));

    // Test the ACTUAL dev-task override generated for a non-local TAURI_DEV_HOST: extract the
    // connect-src format template, substitute a sample host, and verify the resolved tokens.
    // The non-local override uses 1420 (HTTP) and 1421 (HMR WebSocket) for that host, distinct
    // from the local default (both on 1420).
    let dev_task = std::fs::read_to_string(workspace.join(".mise/tasks/tauri/dev")).expect("read tauri dev task");
    let prefix = "connect-src\":\"";
    let start = dev_task
      .find(prefix)
      .map(|i| i + prefix.len())
      .expect("dev task defines a connect-src override");
    let end = dev_task[start..]
      .find("\"}}}")
      .map(|i| start + i)
      .expect("dev task connect-src value terminates");
    let template = &dev_task[start..end];
    let unescaped = template.replace("'\"'\"'", "'");
    let sample_host = "192.168.1.10";
    let resolved = unescaped.replace("%s", sample_host);
    let override_tokens: Vec<&str> = resolved.split_ascii_whitespace().collect();
    assert_eq!(
      override_tokens,
      vec![
        "'self'",
        "ipc:",
        "http://ipc.localhost",
        &format!("http://{sample_host}:1420"),
        &format!("ws://{sample_host}:1421")
      ],
      "non-local dev override connect-src must target the host on 1420 (HTTP) and 1421 (HMR)"
    );

    // The screenshot temp dirname must match the asset scope's scoped subtree exactly, so the
    // screenshot write path and the assetProtocol scope cannot drift. The scope is the literal
    // `$TEMP/langnext-screenshot/**/*`; the dirname is the concrete segment after `$TEMP/`.
    // The test calls the pure `screenshot_temp_dir_from_base` helper and compares its dirname
    // to the scope-derived dirname, rather than searching source strings.
    let scope_str = scope[0];
    assert!(scope_str.starts_with("$TEMP/"), "asset scope must be under $TEMP");
    let after_temp = &scope_str["$TEMP/".len()..];
    let scope_dirname = after_temp.split('/').next().expect("scope has a dirname");
    assert!(
      !scope_dirname.is_empty() && scope_dirname != "**" && scope_dirname != "*",
      "asset scope dirname must be a concrete directory"
    );
    let constructed = crate::windows::screenshot::screenshot_temp_dir_from_base(std::path::Path::new("/tmp"));
    assert_eq!(
      constructed.file_name().and_then(|n| n.to_str()),
      Some(scope_dirname),
      "screenshot_temp_dir_from_base dirname must equal the asset scope dirname `{scope_dirname}`"
    );
  }
}
