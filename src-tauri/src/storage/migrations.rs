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
  include_str!("../../migrations/0014_ocr_service_integration_binding.sql"),
  include_str!("../../migrations/0015_speech_services.sql"),
  include_str!("../../migrations/0016_runtime_plugin_packages.sql"),
  include_str!("../../migrations/0017_runtime_plugin_instance_pins.sql"),
  include_str!("../../migrations/0018_plugin_uninstall_restored_states.sql"),
  include_str!("../../migrations/0019_execution_grant_origin_kind.sql"),
  include_str!("../../migrations/0020_execution_grant_response_body_modes.sql"),
  include_str!("../../migrations/0021_integration_endpoint_trusts.sql"),
  include_str!("../../migrations/0022_execution_grant_base_urls.sql"),
  include_str!("../../migrations/0023_integration_capability_health.sql"),
  include_str!("../../migrations/0024_runtime_provider_bindings.sql"),
  include_str!("../../migrations/0025_provider_runtime_interface_bindings.sql"),
  include_str!("../../migrations/0026_plugin_model_resources.sql"),
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
  use crate::domain::provider::ProviderInstanceDto;
  use crate::repositories::{provider_instances, provider_runtime_bindings};
  use rusqlite::{Connection, OptionalExtension, params};
  use uuid::Uuid;

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
    // v14 OCR plugin binding columns exist on a fresh database.
    let has_ocr_integration_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ocr_services') WHERE name = 'integration_instance_id'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_ocr_integration_col, 1);
    // v15 speech_services table exists and is empty on a fresh database.
    let speech_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM speech_services", [], |r| r.get(0))
      .unwrap();
    assert_eq!(speech_count, 0);
    // v16 plugin package lifecycle tables exist and are empty on a fresh database.
    for table in [
      "plugin_publishers",
      "installed_plugin_versions",
      "plugin_package_approvals",
      "plugin_default_versions",
      "plugin_install_operations",
      "execution_grant_sets",
    ] {
      let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or_else(|e| panic!("{table} missing: {e}"));
      assert_eq!(count, 0, "{table} should be empty");
    }
    // v17 runtime pin columns and grant-entry/snapshot tables exist.
    let has_runtime_kind: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('integration_instances') WHERE name = 'runtime_kind'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_runtime_kind, 1);
    for table in [
      "execution_grant_capability_entries",
      "execution_grant_network_entries",
      "execution_grant_page_entries",
      "plugin_upgrade_snapshots",
    ] {
      let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or_else(|e| panic!("{table} missing: {e}"));
      assert_eq!(count, 0, "{table} should be empty");
    }
    let has_origin_kind: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('execution_grant_network_entries') WHERE name = 'origin_kind'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_origin_kind, 1);
    let endpoint_trust_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM integration_endpoint_trusts", [], |r| r.get(0))
      .unwrap();
    assert_eq!(endpoint_trust_count, 0);
    // v24/v25 provider runtime binding tables exist and are empty on a fresh database.
    for table in ["provider_runtime_bindings", "provider_runtime_snapshot_sets"] {
      let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or_else(|e| panic!("{table} missing: {e}"));
      assert_eq!(count, 0, "{table} should be empty");
    }
  }

  #[test]
  fn migrate_v16_to_v17_backfills_bundled_runtime_pins() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..16]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 16);
    conn
      .execute(
        "INSERT INTO integration_instances (
          id, plugin_id, plugin_version, display_name, enabled,
          config_json, config_schema_version, health_status,
          last_validated_at, last_error_code, created_at, updated_at
        ) VALUES (
          'inst-1', 'com.langnext.google-cloud', '1.0.0', 'Cloud', 1,
          '{}', 1, 'ready',
          NULL, NULL, 't0', 't1'
        )",
        [],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    let (runtime_kind, package_digest, grant_rev, runtime_state): (String, Option<String>, Option<i64>, String) = conn
      .query_row(
        "SELECT runtime_kind, package_digest, execution_grant_set_revision, runtime_state
           FROM integration_instances WHERE id = 'inst-1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
      )
      .unwrap();
    assert_eq!(runtime_kind, "bundled-rust");
    assert!(package_digest.is_none());
    assert!(grant_rev.is_none());
    assert_eq!(runtime_state, "active");
  }

  #[test]
  fn migrate_v18_to_v19_backfills_legacy_grants_to_strict_origin_kind() {
    const VERSION_BEFORE_ORIGIN_KIND: usize = 18;
    const LEGACY_PUBLISHER_KEY_ID: &str = "legacy-publisher";
    const LEGACY_PUBLISHER_FINGERPRINT: &str = "legacy-fingerprint";
    const LEGACY_PUBLISHER_PUBLIC_KEY: &str = "legacy-public-key";
    const LEGACY_PACKAGE_DIGEST: &str = "legacy-package-digest";
    const LEGACY_PLUGIN_ID: &str = "legacy.plugin";
    const LEGACY_PLUGIN_VERSION: &str = "1.0.0";
    const LEGACY_GRANT_ID: &str = "legacy-grant";
    const LEGACY_NETWORK_ENTRY_ID: &str = "legacy-network-entry";
    const LEGACY_SUBJECT_ID: &str = "legacy-subject";
    const LEGACY_TIMESTAMP: &str = "legacy-time";
    const LEGACY_PERMISSION_DIGEST: &str = "legacy-permission-digest";
    const LEGACY_AUTHORITY_DIGEST: &str = "legacy-authority-digest";
    const LEGACY_NETWORK_ORIGIN: &str = "https://legacy.example";
    const INVALID_ORIGIN_KIND: &str = "invalid-origin-kind";
    const DEFAULT_ORIGIN_KIND: &str = "instance_configured";

    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..VERSION_BEFORE_ORIGIN_KIND]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), VERSION_BEFORE_ORIGIN_KIND as i32);
    conn
      .execute(
        "INSERT INTO plugin_publishers (
          key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'vendor', 1, 0, ?4, ?4)",
        params![
          LEGACY_PUBLISHER_KEY_ID,
          LEGACY_PUBLISHER_FINGERPRINT,
          LEGACY_PUBLISHER_PUBLIC_KEY,
          LEGACY_TIMESTAMP,
        ],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO installed_plugin_versions (
          package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
          runtime_kind, manifest_json, permission_request_digest, content_available, installed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'wasm-component', '{}', ?6, 1, ?7)",
        params![
          LEGACY_PACKAGE_DIGEST,
          LEGACY_PLUGIN_ID,
          LEGACY_PLUGIN_VERSION,
          LEGACY_PUBLISHER_KEY_ID,
          LEGACY_PUBLISHER_FINGERPRINT,
          LEGACY_PERMISSION_DIGEST,
          LEGACY_TIMESTAMP,
        ],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO execution_grant_sets (
          id, revision, subject_kind, subject_id, plugin_id, plugin_version,
          package_digest, permission_request_digest, authority_digest, approved_at
        ) VALUES (?1, 1, 'integration_instance', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
          LEGACY_GRANT_ID,
          LEGACY_SUBJECT_ID,
          LEGACY_PLUGIN_ID,
          LEGACY_PLUGIN_VERSION,
          LEGACY_PACKAGE_DIGEST,
          LEGACY_PERMISSION_DIGEST,
          LEGACY_AUTHORITY_DIGEST,
          LEGACY_TIMESTAMP,
        ],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO execution_grant_network_entries (
          id, grant_set_id, capability_id, endpoint_id, origin, method, auth_policy, resource_mode,
          max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms
        ) VALUES (?1, ?2, 'translate.text@1', 'legacy-endpoint', ?3, 'GET', 'host.none.v1', 'bounded',
          1, 1, 1, 1)",
        params![LEGACY_NETWORK_ENTRY_ID, LEGACY_GRANT_ID, LEGACY_NETWORK_ORIGIN],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());
    let origin_kind: String = conn
      .query_row(
        "SELECT origin_kind FROM execution_grant_network_entries WHERE id = ?1",
        params![LEGACY_NETWORK_ENTRY_ID],
        |row| row.get(0),
      )
      .unwrap();
    assert_eq!(origin_kind, DEFAULT_ORIGIN_KIND);
    assert!(
      conn
        .execute(
          "UPDATE execution_grant_network_entries SET origin_kind = ?1 WHERE id = ?2",
          params![INVALID_ORIGIN_KIND, LEGACY_NETWORK_ENTRY_ID],
        )
        .is_err(),
      "origin_kind CHECK must reject values outside the closed enum"
    );
  }

  #[test]
  fn migrate_v15_to_v16_creates_plugin_package_tables() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..15]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 15);

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    let publishers: i64 = conn
      .query_row("SELECT COUNT(*) FROM plugin_publishers", [], |r| r.get(0))
      .unwrap();
    assert_eq!(publishers, 0);
    let versions: i64 = conn
      .query_row("SELECT COUNT(*) FROM installed_plugin_versions", [], |r| r.get(0))
      .unwrap();
    assert_eq!(versions, 0);
    let approvals: i64 = conn
      .query_row("SELECT COUNT(*) FROM plugin_package_approvals", [], |r| r.get(0))
      .unwrap();
    assert_eq!(approvals, 0);
    let grants: i64 = conn
      .query_row("SELECT COUNT(*) FROM execution_grant_sets", [], |r| r.get(0))
      .unwrap();
    assert_eq!(grants, 0);
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
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

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
  fn migrate_v14_to_v15_creates_empty_speech_services() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..14]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 14);

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    let speech_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM speech_services", [], |r| r.get(0))
      .unwrap();
    assert_eq!(speech_count, 0);

    let has_capability_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('speech_services') WHERE name = 'capability_id'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_capability_col, 1);
  }

  #[test]
  fn migrate_v13_to_v14_preserves_ocr_rows_and_adds_plugin_columns() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..13]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 13);

    conn
      .execute(
        "INSERT INTO ocr_services (
          id, provider_type, display_name, enabled, sort_order,
          baidu_action, api_key_ref, secret_key_ref,
          provider_model_id, temperature, default_prompt_template_id,
          created_at, updated_at
        ) VALUES (
          'ocr-baidu-1', 'baidu', 'Baidu OCR', 1, 0,
          'accurate', 'ocr/api', 'ocr/secret',
          NULL, NULL, NULL,
          't0', 't1'
        )",
        [],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    let has_integration_col: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ocr_services') WHERE name = 'integration_instance_id'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(has_integration_col, 1);

    let (
      provider_type,
      display_name,
      baidu_action,
      api_key_ref,
      integration_instance_id,
      ocr_capability_id,
      capability_preferences_version,
      capability_preferences_json,
    ): (
      String,
      String,
      Option<String>,
      Option<String>,
      Option<String>,
      Option<String>,
      Option<i64>,
      Option<String>,
    ) = conn
      .query_row(
        "SELECT provider_type, display_name, baidu_action, api_key_ref,
                integration_instance_id, ocr_capability_id,
                capability_preferences_version, capability_preferences_json
         FROM ocr_services WHERE id = 'ocr-baidu-1'",
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
          ))
        },
      )
      .unwrap();

    assert_eq!(provider_type, "baidu");
    assert_eq!(display_name, "Baidu OCR");
    assert_eq!(baidu_action.as_deref(), Some("accurate"));
    assert_eq!(api_key_ref.as_deref(), Some("ocr/api"));
    assert!(integration_instance_id.is_none());
    assert!(ocr_capability_id.is_none());
    assert!(capability_preferences_version.is_none());
    assert!(capability_preferences_json.is_none());
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

  /// Phase 8 provider runtime bindings: a v23 database with a provider, model, profile,
  /// prompt template, profile target, credential reference, and sync state migrates without
  /// rewriting any provider-owned row, backfills one active legacy binding per provider, and
  /// exposes a sanitized DTO that never carries the credential reference.
  #[test]
  fn runtime_provider_binding_backfill_preserves_provider_rows() {
    const PROVIDER_ID: &str = "11111111-1111-4111-8111-111111111111";
    const PROVIDER_UUID: &str = "11111111-1111-4111-8111-111111111111";
    const MODEL_ID: &str = "22222222-2222-4222-8222-222222222222";
    const PROFILE_ID: &str = "33333333-3333-4333-8333-333333333333";
    const TEMPLATE_ID: &str = "44444444-4444-4444-8444-444444444444";
    const CREDENTIAL_REF: &str = "provider/11111111-1111-4111-8111-111111111111/op-1";

    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..23]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 23);

    // Fixed v23 fixture rows: provider with credential reference + sync state, model, profile
    // with prompt template and target, all with fixed UUIDs.
    conn
      .execute(
        "INSERT INTO provider_instances (
          id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
          credential_kind, credential_ref,
          enabled, proxy_mode, insecure_http_confirmed_at, models_synced_at,
          models_sync_status, models_sync_error_code, created_at, updated_at, sort_order
        ) VALUES (
          ?1, 'openai-compatible', 'Fixture Provider', 'https://api.openai.com/v1', 'plugin_default',
          '{\"schemaVersion\":1,\"type\":\"bearer\"}',
          'api_key', ?2, 1, 'inherit', NULL, '2026-01-02T00:00:00Z',
          'ok', 'sync_ok', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', 0
        )",
        params![PROVIDER_ID, CREDENTIAL_REF],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
          id, provider_instance_id, model_key, source, remote_display_name, display_name_override,
          enabled, availability, remote_metadata_json, capability_overrides_json, adapter_id,
          last_seen_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'gpt-4o', 'remote', 'GPT-4o', NULL,
          1, 'available', '{\"x\":1}', NULL, NULL,
          '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
        )",
        params![MODEL_ID, PROVIDER_ID],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profiles (
          id, name, enabled, engine_kind, template_version, default_prompt_template_id,
          temperature, max_output_tokens, provider_options_json, language_detection_json,
          integration_instance_id, translate_capability_id, detect_capability_id,
          capability_preferences_version, capability_preferences_json,
          source_lang, target_lang, primary_lang, preferred_target_lang,
          created_at, updated_at
        ) VALUES (
          ?1, 'Fixture Profile', 1, 'llm_model_chain', 1, ?2,
          0.2, 1024, NULL, NULL,
          NULL, NULL, NULL,
          NULL, NULL,
          'zh', 'en', 'zh', 'en',
          '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
        )",
        params![PROFILE_ID, TEMPLATE_ID],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profile_prompt_templates (
          id, translation_profile_id, name, system_template, user_template, sort_order
        ) VALUES (?1, ?2, 'Default', 'system {{text}}', 'user {{text}}', 0)",
        params![TEMPLATE_ID, PROFILE_ID],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO translation_profile_models (translation_profile_id, provider_model_id, priority)
         VALUES (?1, ?2, 0)",
        params![PROFILE_ID, MODEL_ID],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    // The provider row is byte-equivalent: every unchanged schema column keeps its exact value.
    let (
      id,
      adapter_id,
      display_name,
      base_url,
      base_url_source,
      auth_scheme_json,
      credential_kind,
      credential_ref,
      enabled,
      proxy_mode,
      insecure_http_confirmed_at,
      models_synced_at,
      models_sync_status,
      models_sync_error_code,
      created_at,
      updated_at,
      sort_order,
    ): (
      String,
      String,
      String,
      String,
      String,
      String,
      String,
      Option<String>,
      i64,
      String,
      Option<String>,
      Option<String>,
      String,
      Option<String>,
      String,
      String,
      i64,
    ) = conn
      .query_row(
        "SELECT id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
                credential_kind, credential_ref, enabled, proxy_mode, insecure_http_confirmed_at,
                models_synced_at, models_sync_status, models_sync_error_code, created_at, updated_at,
                sort_order
         FROM provider_instances WHERE id = ?1",
        params![PROVIDER_ID],
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
            r.get(13)?,
            r.get(14)?,
            r.get(15)?,
            r.get(16)?,
          ))
        },
      )
      .unwrap();
    assert_eq!(id, PROVIDER_ID);
    assert_eq!(adapter_id, "openai-compatible");
    assert_eq!(display_name, "Fixture Provider");
    assert_eq!(base_url, "https://api.openai.com/v1");
    assert_eq!(base_url_source, "plugin_default");
    assert_eq!(auth_scheme_json, "{\"schemaVersion\":1,\"type\":\"bearer\"}");
    assert_eq!(credential_kind, "api_key");
    assert_eq!(credential_ref.as_deref(), Some(CREDENTIAL_REF));
    assert_eq!(enabled, 1);
    assert_eq!(proxy_mode, "inherit");
    assert_eq!(insecure_http_confirmed_at, None);
    assert_eq!(models_synced_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    assert_eq!(models_sync_status, "ok");
    assert_eq!(models_sync_error_code.as_deref(), Some("sync_ok"));
    assert_eq!(created_at, "2026-01-01T00:00:00Z");
    assert_eq!(updated_at, "2026-01-03T00:00:00Z");
    assert_eq!(sort_order, 0);

    // Model, profile, prompt template, and profile target rows are unchanged.
    let (model_key, source, model_enabled, availability, adapter_id, model_created_at, model_updated_at): (
      String,
      String,
      i64,
      String,
      Option<String>,
      String,
      String,
    ) = conn
      .query_row(
        "SELECT model_key, source, enabled, availability, adapter_id, created_at, updated_at
           FROM provider_models WHERE id = ?1",
        params![MODEL_ID],
        |r| {
          Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
          ))
        },
      )
      .unwrap();
    assert_eq!(model_key, "gpt-4o");
    assert_eq!(source, "remote");
    assert_eq!(model_enabled, 1);
    assert_eq!(availability, "available");
    assert_eq!(adapter_id, None);
    assert_eq!(model_created_at, "2026-01-01T00:00:00Z");
    assert_eq!(model_updated_at, "2026-01-02T00:00:00Z");

    let (profile_name, engine_kind, template_version, default_prompt_template_id, temperature, profile_updated_at): (
      String,
      String,
      i64,
      String,
      f64,
      String,
    ) = conn
      .query_row(
        "SELECT name, engine_kind, template_version, default_prompt_template_id, temperature, updated_at
           FROM translation_profiles WHERE id = ?1",
        params![PROFILE_ID],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
      )
      .unwrap();
    assert_eq!(profile_name, "Fixture Profile");
    assert_eq!(engine_kind, "llm_model_chain");
    assert_eq!(template_version, 1);
    assert_eq!(default_prompt_template_id, TEMPLATE_ID);
    assert!((temperature - 0.2).abs() < f64::EPSILON);
    assert_eq!(profile_updated_at, "2026-01-02T00:00:00Z");

    let (template_profile_id, template_name, template_sort_order): (String, String, i64) = conn
      .query_row(
        "SELECT translation_profile_id, name, sort_order FROM translation_profile_prompt_templates WHERE id = ?1",
        params![TEMPLATE_ID],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .unwrap();
    assert_eq!(template_profile_id, PROFILE_ID);
    assert_eq!(template_name, "Default");
    assert_eq!(template_sort_order, 0);

    let (target_profile_id, target_model_id, priority): (String, String, i64) = conn
      .query_row(
        "SELECT translation_profile_id, provider_model_id, priority FROM translation_profile_models
           WHERE translation_profile_id = ?1 AND provider_model_id = ?2",
        params![PROFILE_ID, MODEL_ID],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
      )
      .unwrap();
    assert_eq!(target_profile_id, PROFILE_ID);
    assert_eq!(target_model_id, MODEL_ID);
    assert_eq!(priority, 0);

    // Every provider received exactly one active legacy binding with no package/grant pin.
    let binding_count: i64 = conn
      .query_row("SELECT COUNT(*) FROM provider_runtime_bindings", [], |r| r.get(0))
      .unwrap();
    assert_eq!(binding_count, 1);
    let (runtime_kind, package_digest, grant_revision, state, error_code, error_message, requirement_json): (
      String,
      Option<String>,
      Option<i64>,
      String,
      Option<String>,
      Option<String>,
      Option<String>,
    ) = conn
      .query_row(
        "SELECT runtime_kind, package_digest, grant_set_revision, state, error_code, error_message,
                runtime_requirement_json
           FROM provider_runtime_bindings WHERE provider_id = ?1",
        params![PROVIDER_ID],
        |r| {
          Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
          ))
        },
      )
      .unwrap();
    assert_eq!(runtime_kind, "legacy-frontend-provider");
    assert!(package_digest.is_none());
    assert!(grant_revision.is_none());
    assert_eq!(state, "active");
    assert!(error_code.is_none());
    assert!(error_message.is_none());
    assert!(requirement_json.is_none());

    // The sanitized DTO carries only runtime identity: no credential reference anywhere.
    let provider = provider_instances::get(&conn, Uuid::parse_str(PROVIDER_UUID).unwrap()).unwrap();
    let bindings = provider_runtime_bindings::list_by_provider(&conn, Uuid::parse_str(PROVIDER_UUID).unwrap()).unwrap();
    let dto = ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings);
    let json = serde_json::to_string(&dto).unwrap();
    assert!(json.contains("\"runtimeKind\":\"legacy-frontend-provider\""));
    assert!(json.contains("\"state\":\"active\""));
    assert!(!json.contains("credentialRef"));
    assert!(!json.contains("credential_ref"));
    assert!(!json.contains("provider/11111111"));
  }

  #[test]
  fn migrate_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());
  }

  /// Migration 0025 expands a singular v24 Wasm binding into adapter-keyed interface
  /// bindings: the Provider default and every persisted model override type become active
  /// rows when the installed manifest declares them as aliases (sharing the exact grant
  /// revision); the v24 snapshot migrates as a Provider-scoped snapshot set with children;
  /// remote model rows gain the Provider default as their discovery source API type.
  #[test]
  fn migrate_v24_wasm_binding_expands_into_interface_bindings() {
    const PROVIDER_ID: &str = "11111111-1111-4111-8111-111111111111";
    const MODEL_ID: &str = "22222222-2222-4222-8222-222222222222";
    const SNAPSHOT_ID: &str = "33333333-3333-4333-8333-333333333333";
    const PACKAGE_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..24]).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 24);

    // v24 fixture rows: provider, installed package whose manifest declares two aliases,
    // model with an override for the second alias, active wasm binding, and a v24 snapshot.
    conn
      .execute(
        "INSERT INTO provider_instances (
        id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
        credential_kind, credential_ref, enabled, proxy_mode, insecure_http_confirmed_at,
        models_synced_at, models_sync_status, models_sync_error_code, created_at, updated_at, sort_order
      ) VALUES (?1, 'openai-compatible', 'Fixture', 'https://api.openai.com/v1', 'plugin_default',
        '{\"schemaVersion\":1,\"type\":\"bearer\"}', 'api_key', NULL, 1, 'inherit', NULL,
        NULL, 'never', NULL, 't0', 't1', 0)",
        params![PROVIDER_ID],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_models (
        id, provider_instance_id, model_key, source, remote_display_name, display_name_override,
        enabled, availability, remote_metadata_json, capability_overrides_json, adapter_id,
        last_seen_at, created_at, updated_at
      ) VALUES (?1, ?2, 'gpt-5', 'remote', NULL, NULL, 1, 'available', NULL, NULL, 'openai-responses',
        NULL, 't0', 't1')",
        params![MODEL_ID, PROVIDER_ID],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO plugin_publishers (
        key_id, fingerprint, public_key_hex, source, enabled, revoked, created_at, updated_at
      ) VALUES ('k1', 'f1', 'pk', 'vendor', 1, 0, 't0', 't1')",
        [],
      )
      .unwrap();
    conn.execute(
      "INSERT INTO installed_plugin_versions (
        package_digest, plugin_id, version, publisher_key_id, publisher_fingerprint,
        runtime_kind, manifest_json, permission_request_digest, content_available, installed_at
      ) VALUES (?1, 'com.langnext.provider.openai-compatible', '1.0.0', 'k1', 'f1',
        'wasm-component', ?2, 'perm', 1, 't0')",
      params![PACKAGE_DIGEST, r#"{"manifestVersion":1,"pluginApiVersion":"1.0","id":"com.langnext.provider.openai-compatible","version":"1.0.0","publisher":{"keyId":"k1","keyFingerprint":"f1"},"runtime":{"kind":"wasm-component"},"files":[],"capabilities":[],"permissions":{"network":[],"authPolicies":["host.provider-instance.v1"]},"providerRuntime":{"legacyAliases":["openai-compatible","openai-responses"],"capabilities":{"llm.chat@1":"chat.wasm"},"endpoint":{"form":"provider-instance","authPolicy":"host.provider-instance.v1"}}}"#],
    )
    .unwrap();
    conn
      .execute(
        "INSERT INTO provider_runtime_bindings (
        provider_id, runtime_kind, package_digest, grant_set_revision, state,
        error_code, error_message, runtime_requirement_json, created_at, updated_at
      ) VALUES (?1, 'wasm-component', ?2, 1, 'active', NULL, NULL, NULL, 't0', 't1')",
        params![PROVIDER_ID, PACKAGE_DIGEST],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO provider_runtime_snapshots (
        id, provider_id, created_at, discarded_at, runtime_kind, package_digest,
        grant_set_revision, grant_set_id, plugin_id, plugin_version, publisher_key_id,
        publisher_fingerprint, plugin_api_version, capability_ids_json, updated_at
      ) VALUES (?1, ?2, 't0', NULL, 'wasm-component', ?3, 1, NULL,
        'com.langnext.provider.openai-compatible', '1.0.0', 'k1', 'f1', '1.0', '[]', 't1')",
        params![SNAPSHOT_ID, PROVIDER_ID, PACKAGE_DIGEST],
      )
      .unwrap();

    migrate(&mut conn).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), latest_version());

    // Both effective types became active interface bindings sharing the exact grant revision.
    let mut stmt = conn
      .prepare(
        "SELECT adapter_id, runtime_kind, package_digest, grant_set_revision, state
           FROM provider_runtime_bindings WHERE provider_id = ?1 ORDER BY adapter_id",
      )
      .unwrap();
    let rows: Vec<(String, String, Option<String>, Option<i64>, String)> = stmt
      .query_map(params![PROVIDER_ID], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
      })
      .unwrap()
      .collect::<Result<_, _>>()
      .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "openai-compatible");
    assert_eq!(rows[0].1, "wasm-component");
    assert_eq!(rows[0].2.as_deref(), Some(PACKAGE_DIGEST));
    assert_eq!(rows[0].3, Some(1));
    assert_eq!(rows[0].4, "active");
    assert_eq!(rows[1].0, "openai-responses");
    assert_eq!(rows[1].1, "wasm-component");
    assert_eq!(rows[1].2.as_deref(), Some(PACKAGE_DIGEST));
    assert_eq!(rows[1].3, Some(1));
    assert_eq!(rows[1].4, "active");

    // The v24 snapshot migrated as a Provider-scoped atomic set with both children.
    let (scope, package_digest, grant_revision): (String, Option<String>, Option<i64>) = conn
      .query_row(
        "SELECT scope, package_digest, grant_set_revision FROM provider_runtime_snapshot_sets WHERE id = ?1",
        params![SNAPSHOT_ID],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
      )
      .unwrap();
    assert_eq!(scope, "provider");
    assert_eq!(package_digest.as_deref(), Some(PACKAGE_DIGEST));
    assert_eq!(grant_revision, Some(1));
    let child_count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM provider_runtime_snapshot_bindings WHERE snapshot_set_id = ?1",
        params![SNAPSHOT_ID],
        |row| row.get(0),
      )
      .unwrap();
    assert_eq!(child_count, 2);
    assert!(
      conn.execute("SELECT * FROM provider_runtime_snapshots", []).is_err(),
      "v24 snapshot table is replaced"
    );

    // Remote model rows carry the Provider default as their discovery source.
    let (source_adapter_id, adapter_id): (String, Option<String>) = conn
      .query_row(
        "SELECT source_adapter_id, adapter_id FROM provider_models WHERE id = ?1",
        params![MODEL_ID],
        |row| Ok((row.get(0)?, row.get(1)?)),
      )
      .unwrap();
    assert_eq!(source_adapter_id, "openai-compatible");
    assert_eq!(adapter_id.as_deref(), Some("openai-responses"));
  }

  /// Migration 0025 never guesses an active route: a v24 Wasm binding whose installed
  /// manifest is missing (or whose effective type is not a declared alias) becomes a
  /// sanitized per-type unavailable requirement, never a guessed active or legacy route.
  #[test]
  fn migrate_v24_wasm_binding_without_alias_evidence_becomes_unavailable() {
    const PROVIDER_ID: &str = "44444444-4444-4444-8444-444444444444";
    const PACKAGE_DIGEST: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    let mut conn = Connection::open_in_memory().unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..24]).unwrap();

    conn
      .execute(
        "INSERT INTO provider_instances (
        id, adapter_id, display_name, base_url, base_url_source, auth_scheme_json,
        credential_kind, credential_ref, enabled, proxy_mode, insecure_http_confirmed_at,
        models_synced_at, models_sync_status, models_sync_error_code, created_at, updated_at, sort_order
      ) VALUES (?1, 'custom-relay', 'Fixture', 'https://relay.example', 'custom',
        '{\"schemaVersion\":1,\"type\":\"none\"}', 'none', NULL, 1, 'inherit', NULL,
        NULL, 'never', NULL, 't0', 't1', 0)",
        params![PROVIDER_ID],
      )
      .unwrap();
    // No installed_plugin_versions row at all: the manifest evidence is missing.
    conn
      .execute(
        "INSERT INTO provider_runtime_bindings (
        provider_id, runtime_kind, package_digest, grant_set_revision, state,
        error_code, error_message, runtime_requirement_json, created_at, updated_at
      ) VALUES (?1, 'wasm-component', ?2, 1, 'active', NULL, NULL, NULL, 't0', 't1')",
        params![PROVIDER_ID, PACKAGE_DIGEST],
      )
      .unwrap();

    migrate(&mut conn).unwrap();

    let (runtime_kind, state, package_digest, grant_revision, error_code): (
      String,
      String,
      Option<String>,
      Option<i64>,
      Option<String>,
    ) = conn
      .query_row(
        "SELECT runtime_kind, state, package_digest, grant_set_revision, error_code
           FROM provider_runtime_bindings WHERE provider_id = ?1 AND adapter_id = 'custom-relay'",
        params![PROVIDER_ID],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
      )
      .unwrap();
    assert_eq!(runtime_kind, "wasm-component");
    assert_eq!(state, "unavailable");
    assert_eq!(package_digest.as_deref(), Some(PACKAGE_DIGEST));
    assert!(grant_revision.is_none());
    assert_eq!(error_code.as_deref(), Some("plugin_unavailable"));
  }
}
