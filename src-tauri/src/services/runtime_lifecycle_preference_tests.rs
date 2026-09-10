// ABOUTME: Preference snapshot/CAS and grant-restore E2E tests for runtime lifecycle.
// ABOUTME: Proves pre-migration snapshots, stale CAS, and grant_snapshot_json restore.
#![cfg(test)]

use crate::domain::ocr_service::{OcrProviderType, OcrService};
use crate::domain::runtime_lifecycle::{
  ApplyRuntimeRollbackInput, ApplyRuntimeUpgradeInput, ExecutionGrantSetBundle, GrantSubjectKind,
};
use crate::domain::runtime_plugin::{FileRole, HttpMethod};
use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
use crate::domain::speech_service::SpeechService;
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine};
use crate::error::StorageError;
use crate::repositories::{
  integration_instances, ocr_services, plugin_permission_grants, plugin_upgrade_snapshots, speech_services,
  translation_profiles,
};
use crate::services::plugin_catalog::PluginCatalog;
use crate::services::runtime_lifecycle::RuntimeLifecycleService;
use crate::services::test_support::{
  SyntheticPlugin, catalog_with_synthetic, registry_from_catalog, token_service, wasm_runtime,
};
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use std::sync::Arc;
use uuid::Uuid;

const TRANSLATE_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-component/fixtures/langnext-conformance-wasm.wasm"
));
const MIGRATION_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-migration-component/fixtures/langnext_conformance_migration_wasm.wasm"
));
const PLUGIN_ID: &str = "langnext.conformance";
const TRANSLATE_CAP: &str = "translate.text@1";

fn setup() -> (tempfile::TempDir, Database, Arc<PluginCatalog>, RuntimeLifecycleService) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let catalog = catalog_with_synthetic(db.clone(), dir.path(), &[], &[build_pkg("1.0.0", None)]);
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let tokens = token_service(&db, Arc::new(crate::credentials::MemoryCredentialVault::default()));
  let lifecycle = RuntimeLifecycleService::new(db.clone(), catalog.clone(), registry).with_runtime(wasm, tokens);
  (dir, db, catalog, lifecycle)
}

/// Conformance catalog fixture for one version: runtime artifact, migration component,
/// schemas, capabilities, and endpoint authority.
fn build_pkg(version: &str, extra: Option<&str>) -> SyntheticPlugin {
  let runtime_path = "artifacts/plugin.wasm";
  let config_schema_version: u32 = version
    .split('.')
    .next()
    .and_then(|m| m.parse().ok())
    .filter(|v| *v > 0)
    .unwrap_or(1);
  // Real schema fields/type so normalize_config is exercised (field ids are lowercase/hyphen only).
  let schema_json = if config_schema_version >= 2 {
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"title","control":{"kind":"string","spec":{}}}],"groups":[]}"#
  } else {
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"label","control":{"kind":"string","spec":{}}}],"groups":[]}"#
  };
  let prefs_json = if config_schema_version >= 2 {
    r#"{"version":1,"fields":[{"id":"title","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#
  } else {
    r#"{"version":1,"fields":[{"id":"label","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#
  };
  let mut plugin = SyntheticPlugin::new(PLUGIN_ID, version, runtime_path, TRANSLATE_WASM)
    .with_config_schema(schema_json, config_schema_version)
    .add_file("artifacts/migration.wasm", FileRole::Other, MIGRATION_WASM)
    .with_network_endpoint("approved", &["https://conformance.example"], &[HttpMethod::Get])
    .with_auth_policy("host.none.v1");
  if let Some(id) = extra {
    plugin = plugin.with_network_endpoint(id, &["https://conformance.example"], &[HttpMethod::Get]);
  }
  plugin = plugin.with_capabilities_and_preferences(&[TRANSLATE_CAP, "ocr.image@1", "speech.synthesize@1"], prefs_json);
  plugin
}

/// Publish one fixture as built-in catalog content and return its content digest.
fn publish_fixture(catalog: &PluginCatalog, plugin: &SyntheticPlugin) -> String {
  plugin.publish(catalog)
}

fn seed_instance(db: &Database) -> Uuid {
  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Prefs".into(),
        enabled: true,
        config_json: r#"{"mode":"success","label":"cfg-v1"}"#.into(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "wasm-component".into(),
        package_digest: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
        execution_grant_set_revision: None,
        runtime_state: "pending_activation".into(),
        runtime_error_code: None,
        runtime_error_message: None,
        runtime_requirement_json: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();
  id
}

fn seed_prefs(db: &Database, instance_id: Uuid) -> (Uuid, Uuid, Uuid) {
  let now = now_rfc3339();
  let profile_id = new_id();
  let ocr_id = new_id();
  let speech_id = new_id();
  db.transaction(|uow| {
    translation_profiles::insert_profile(
      uow.conn(),
      &TranslationProfile {
        id: profile_id,
        name: "Pref Profile".into(),
        enabled: true,
        source_lang: Some("en".into()),
        target_lang: Some("zh".into()),
        primary_lang: Some("en".into()),
        preferred_target_lang: Some("zh".into()),
        engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
          integration_instance_id: instance_id,
          translate_capability_id: TRANSLATE_CAP.into(),
          detect_capability_id: None,
          capability_preferences_version: 1,
          capability_preferences: serde_json::json!({"label": "pref-v1"}),
        }),
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    ocr_services::insert(
      uow.conn(),
      &OcrService {
        id: ocr_id,
        provider_type: OcrProviderType::PluginCapability,
        display_name: "Pref OCR".into(),
        enabled: true,
        sort_order: 0,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        integration_instance_id: Some(instance_id),
        ocr_capability_id: Some("ocr.image@1".into()),
        capability_preferences_version: Some(1),
        capability_preferences: Some(serde_json::json!({"label": "ocr-v1"})),
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    speech_services::insert(
      uow.conn(),
      &SpeechService {
        id: speech_id,
        display_name: "Pref Speech".into(),
        enabled: true,
        sort_order: 0,
        integration_instance_id: instance_id,
        capability_id: "speech.synthesize@1".into(),
        preferences_schema_version: 1,
        preferences: serde_json::json!({"label": "speech-v1"}),
        created_at: now.clone(),
        updated_at: now.clone(),
      },
    )?;
    Ok(())
  })
  .unwrap();
  (profile_id, ocr_id, speech_id)
}

fn activate(lifecycle: &RuntimeLifecycleService, id: Uuid, digest: &str) {
  let preview = lifecycle.preview_upgrade(id, digest).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
}

#[test]
fn runtime_preference_snapshot_is_pre_migration_and_rollback_restores_exact_json() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, ocr_id, speech_id) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);

  let before_profile_json = serde_json::to_string(
    &db
      .read(|c| translation_profiles::get(c, profile_id))
      .unwrap()
      .profile
      .engine
      .as_plugin()
      .unwrap()
      .capability_preferences,
  )
  .unwrap();
  let before_ocr_json = serde_json::to_string(
    db.read(|c| ocr_services::get(c, ocr_id))
      .unwrap()
      .capability_preferences
      .as_ref()
      .unwrap(),
  )
  .unwrap();
  let before_speech_json =
    serde_json::to_string(&db.read(|c| speech_services::get(c, speech_id)).unwrap().preferences).unwrap();

  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();

  let mid = serde_json::to_string(
    &db
      .read(|c| translation_profiles::get(c, profile_id))
      .unwrap()
      .profile
      .engine
      .as_plugin()
      .unwrap()
      .capability_preferences,
  )
  .unwrap();
  assert_ne!(mid, before_profile_json);

  let snaps = db
    .read(|c| plugin_upgrade_snapshots::list_active_for_instance(c, id))
    .unwrap();
  assert!(
    snaps[0]
      .translation_preferences
      .iter()
      .any(|r| r.preferences_json == before_profile_json)
  );
  assert!(
    snaps[0]
      .ocr_preferences
      .iter()
      .any(|r| r.preferences_json == before_ocr_json)
  );
  assert!(
    snaps[0]
      .speech_preferences
      .iter()
      .any(|r| r.preferences_json == before_speech_json)
  );

  let rb = lifecycle.preview_rollback(id).unwrap();
  lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let after = serde_json::to_string(
    &db
      .read(|c| translation_profiles::get(c, profile_id))
      .unwrap()
      .profile
      .engine
      .as_plugin()
      .unwrap()
      .capability_preferences,
  )
  .unwrap();
  assert_eq!(after, before_profile_json);
  assert_eq!(
    serde_json::to_string(
      db.read(|c| ocr_services::get(c, ocr_id))
        .unwrap()
        .capability_preferences
        .as_ref()
        .unwrap()
    )
    .unwrap(),
    before_ocr_json
  );
  assert_eq!(
    serde_json::to_string(&db.read(|c| speech_services::get(c, speech_id)).unwrap().preferences).unwrap(),
    before_speech_json
  );
}

#[test]
fn runtime_rollback_restores_grant_from_snapshot_when_live_grant_missing() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  let rev = before.execution_grant_set_revision.unwrap();
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE subject_id = ?1 AND package_digest = ?2 AND revision = ?3",
      rusqlite::params![id.to_string(), d1, rev as i64],
    )?;
    Ok(())
  })
  .unwrap();
  assert!(
    db.read(|c| plugin_permission_grants::get_bundle_for_subject_package_revision(
      c,
      GrantSubjectKind::IntegrationInstance,
      id,
      &d1,
      rev
    ))
    .is_err()
  );
  let rb = lifecycle.preview_rollback(id).unwrap();
  lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let restored = db
    .read(|c| {
      plugin_permission_grants::get_bundle_for_subject_package_revision(
        c,
        GrantSubjectKind::IntegrationInstance,
        id,
        &d1,
        rev,
      )
    })
    .unwrap();
  assert_eq!(restored.header.package_digest, d1);
  assert_eq!(restored.header.revision, rev);
}

#[test]
fn runtime_preference_stale_cas_fails_without_partial_mutation() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  db.transaction(|uow| {
    let mut dto = translation_profiles::get(uow.conn(), profile_id)?;
    if let TranslationProfileEngine::PluginCapability(plugin) = &mut dto.profile.engine {
      plugin.capability_preferences = serde_json::json!({"label": "stale"});
      dto.profile.updated_at = now_rfc3339();
      translation_profiles::update_profile(uow.conn(), &dto.profile)?;
    }
    Ok(())
  })
  .unwrap();
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  let err = lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.config_json, before.config_json);
}

#[test]
fn runtime_preference_byte_exact_whitespace_preserved_in_snapshot() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  // Inject non-canonical JSON TEXT after activation so the next upgrade snapshot preserves it.
  let exact = "{  \"label\" : \"pref-v1\" , \"language\" : \"fr\" }";
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET capability_preferences_json = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), exact, now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let snaps = db
    .read(|c| plugin_upgrade_snapshots::list_active_for_instance(c, id))
    .unwrap();
  let row = snaps[0]
    .translation_preferences
    .iter()
    .find(|r| r.id == profile_id)
    .unwrap();
  assert_eq!(row.preferences_json, exact);
  let rb = lifecycle.preview_rollback(id).unwrap();
  lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let restored: String = db
    .read(|c| {
      c.query_row(
        "SELECT capability_preferences_json FROM translation_profiles WHERE id = ?1",
        rusqlite::params![profile_id.to_string()],
        |row| row.get(0),
      )
      .map_err(StorageError::from)
    })
    .unwrap();
  assert_eq!(restored, exact);
}

#[test]
fn runtime_rollback_foreign_or_stale_dependency_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let other = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let rb = lifecycle.preview_rollback(id).unwrap();
  // Stale dependency edit after preview.
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET updated_at = ?2 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "{err:?}");

  // Foreign-row injection: rebind profile to another instance after a fresh preview.
  let rb2 = lifecycle.preview_rollback(id).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET integration_instance_id = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), other.to_string(), now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb2.preview_id,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "{err:?}");
  // No pin mutation on fail-closed rollback.
  let pin = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(pin.package_digest.as_deref(), Some(d2.as_str()));
}

#[test]
fn runtime_grant_snapshot_tamper_matrix_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  activate(&lifecycle, id, &d1);
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let snaps = db
    .read(|c| plugin_upgrade_snapshots::list_active_for_instance(c, id))
    .unwrap();
  let snap = &snaps[0];
  let mut bundle: ExecutionGrantSetBundle = serde_json::from_str(snap.grant_snapshot_json.as_deref().unwrap()).unwrap();
  // Tamper network child authority.
  bundle.network[0].origin = "https://evil.example".into();
  let tampered = serde_json::to_string(&bundle).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE plugin_upgrade_snapshots SET grant_snapshot_json = ?2 WHERE id = ?1",
      rusqlite::params![snap.id.to_string(), tampered],
    )?;
    // Drop live grant so restore path runs.
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE package_digest = ?1 AND subject_id = ?2",
      rusqlite::params![d1, id.to_string()],
    )?;
    Ok(())
  })
  .unwrap();
  let rb = lifecycle.preview_rollback(id).unwrap();
  let err = lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap_err();
  assert!(
    matches!(err, StorageError::Validation(_)) || matches!(err, StorageError::Conflict(_)),
    "{err:?}"
  );
  let pin = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(pin.package_digest.as_deref(), Some(d2.as_str()));
}

#[test]
fn runtime_removal_blocks_pin_grant_snapshot_dependencies_and_preserves_files() {
  let (_dir, db, catalog, lifecycle) = setup();
  // User content is the only removable source. It stays blocked while an instance, grant, or
  // rollback snapshot references it, and the archive file is preserved.
  let store = crate::services::test_support::user_store(db.clone(), _dir.path());
  let user_plugin_id = "com.example.user-conformance";
  let user_fixture = SyntheticPlugin::new(
    user_plugin_id,
    "1.0.0",
    "artifacts/plugin.wasm",
    TRANSLATE_WASM,
  )
  .with_config_schema(
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"label","control":{"kind":"string","spec":{}}}],"groups":[]}"#,
    1,
  )
  .with_capability_and_preferences(
    TRANSLATE_CAP,
    r#"{"version":1,"fields":[{"id":"label","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#,
  );
  let archive = user_fixture.archive_in(_dir.path(), "user-conformance");
  let user_digest = crate::services::test_support::install_user_archive(&store, &archive);
  catalog.refresh().expect("catalog refresh after user install");

  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: user_plugin_id.into(),
        plugin_version: "1.0.0".into(),
        display_name: "User".into(),
        enabled: true,
        config_json: r#"{"mode":"success","label":"cfg-v1"}"#.into(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "wasm-component".into(),
        package_digest: Some(user_digest.clone()),
        execution_grant_set_revision: None,
        runtime_state: "pending_activation".into(),
        runtime_error_code: None,
        runtime_error_message: None,
        runtime_requirement_json: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();
  activate(&lifecycle, id, &user_digest);
  let installed = store.list_installed().unwrap();
  assert_eq!(installed.len(), 1);
  let archive_path = store.user_archive_path(&installed[0].file_name);
  assert!(archive_path.is_file());

  let err = store.remove_user_archive(&user_digest).unwrap_err();
  assert!(matches!(err, StorageError::InUse(_)), "{err:?}");
  assert!(archive_path.is_file(), "pinned user archive must stay on disk");
  assert_eq!(store.list_installed().unwrap().len(), 1);
  assert!(catalog.snapshot_optional(&user_digest).is_some());
}

#[test]
fn runtime_rollback_dependency_extra_row_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  let rb = lifecycle.preview_rollback(id).unwrap();
  // Add an extra translation dependency after preview.
  let extra = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    translation_profiles::insert_profile(
      uow.conn(),
      &TranslationProfile {
        id: extra,
        name: "Extra".into(),
        enabled: true,
        source_lang: Some("en".into()),
        target_lang: Some("zh".into()),
        primary_lang: Some("en".into()),
        preferred_target_lang: Some("zh".into()),
        engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
          integration_instance_id: id,
          translate_capability_id: TRANSLATE_CAP.into(),
          detect_capability_id: None,
          capability_preferences_version: 2,
          capability_preferences: serde_json::json!({"title": "extra"}),
        }),
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.config_json, before.config_json);
  let _ = profile_id;
}

#[test]
fn runtime_migration_schema_unknown_field_fails_preview_zero_mutation() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET capability_preferences_json = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![
        profile_id.to_string(),
        r#"{"label":"ok","unknown-field":true}"#,
        now_rfc3339()
      ],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle.preview_upgrade(id, &d2).unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.updated_at, before.updated_at);
  assert_eq!(after.config_json, before.config_json);
  assert_eq!(after.package_digest, before.package_digest);
}

#[test]
fn runtime_migration_schema_wrong_type_fails_preview_zero_mutation() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET capability_preferences_json = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), r#"{"label":1}"#, now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle.preview_upgrade(id, &d2).unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.updated_at, before.updated_at);
  assert_eq!(after.package_digest, before.package_digest);
}

#[test]
fn runtime_migration_schema_wrong_capability_fails_preview_zero_mutation() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET translate_capability_id = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), "translate.missing@1", now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle.preview_upgrade(id, &d2).unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.updated_at, before.updated_at);
  assert_eq!(after.package_digest, before.package_digest);
}

#[test]
fn runtime_migration_normalized_output_enters_apply_db() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  // Extra whitespace is normalized on apply into prepared payload.
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET capability_preferences_json = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), r#"{ "label" : "pref-v1" }"#, now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let live: String = db
    .read(|c| {
      c.query_row(
        "SELECT capability_preferences_json FROM translation_profiles WHERE id = ?1",
        rusqlite::params![profile_id.to_string()],
        |row| row.get(0),
      )
      .map_err(StorageError::from)
    })
    .unwrap();
  // normalize_config rewrites label→title via migration then serializes compact JSON.
  assert!(live.contains("\"title\""), "{live}");
  assert!(!live.contains("\"label\""), "{live}");
  assert_eq!(
    live,
    serde_json::to_string(&serde_json::from_str::<serde_json::Value>(&live).unwrap()).unwrap()
  );
}

#[test]
fn runtime_upgrade_dependency_add_translation_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let _ = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  // Add a translation dependency after preview.
  let extra = new_id();
  db.transaction(|uow| {
    translation_profiles::insert_profile(
      uow.conn(),
      &TranslationProfile {
        id: extra,
        name: "Extra".into(),
        enabled: true,
        source_lang: Some("en".into()),
        target_lang: Some("zh".into()),
        primary_lang: Some("en".into()),
        preferred_target_lang: Some("zh".into()),
        engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
          integration_instance_id: id,
          translate_capability_id: TRANSLATE_CAP.into(),
          detect_capability_id: None,
          capability_preferences_version: 1,
          capability_preferences: serde_json::json!({"label": "x"}),
        }),
        created_at: now_rfc3339(),
        updated_at: now_rfc3339(),
      },
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.updated_at, before.updated_at);
  assert_eq!(after.config_json, before.config_json);
}

#[test]
fn runtime_upgrade_dependency_delete_ocr_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let (_, ocr_id, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM ocr_services WHERE id = ?1",
      rusqlite::params![ocr_id.to_string()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(
    matches!(err, StorageError::Conflict(_)) || matches!(err, StorageError::NotFound(_)),
    "{err:?}"
  );
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.updated_at, before.updated_at);
}

#[test]
fn runtime_upgrade_dependency_rebind_speech_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let pkg2 = build_pkg("2.0.0", Some("slow"));
  let d1 = publish_fixture(&catalog, &pkg1);
  let d2 = publish_fixture(&catalog, &pkg2);
  let id = seed_instance(&db);
  let other = seed_instance(&db);
  let (_, _, speech_id) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let before = db.read(|c| integration_instances::get(c, id)).unwrap();
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE speech_services SET integration_instance_id = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![speech_id.to_string(), other.to_string(), now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)), "{err:?}");
  let after = db.read(|c| integration_instances::get(c, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.updated_at, before.updated_at);
}

#[test]
fn runtime_grant_canonical_bind_permission_digest_mismatch_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let d1 = publish_fixture(&catalog, &pkg1);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let router =
    crate::services::runtime_router::RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry)
    .with_catalog(catalog.clone())
    .with_router(router, wasm);
  let snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE execution_grant_sets SET permission_request_digest = ?2 WHERE package_digest = ?1",
      rusqlite::params![d1, "f".repeat(64)],
    )?;
    Ok(())
  })
  .unwrap();
  let snap2 = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  let err = match caps.resolve_translate_from_snapshot(&snap2) {
    Ok(_) => panic!("expected grant permission digest mismatch to fail closed"),
    Err(e) => e,
  };
  assert!(
    matches!(
      err.code,
      crate::domain::service_capability::CapabilityErrorCode::PermissionDenied
        | crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
        | crate::domain::service_capability::CapabilityErrorCode::InvalidConfiguration
    ),
    "{err:?}"
  );
  let recheck = caps.recheck_invocation_snapshot(
    &snap,
    crate::services::service_capabilities::ProfileCapabilityKind::Translate,
  );
  assert!(recheck.is_err(), "stale snapshot must fail against mutated grant");
  let _ = lifecycle;
}

#[test]
fn runtime_grant_canonical_bind_plugin_id_mismatch_fails_closed() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let d1 = publish_fixture(&catalog, &pkg1);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let router =
    crate::services::runtime_router::RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry)
    .with_catalog(catalog.clone())
    .with_router(router, wasm);
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE execution_grant_sets SET plugin_id = 'evil.plugin' WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    Ok(())
  })
  .unwrap();
  let snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  let err = match caps.resolve_translate_from_snapshot(&snap) {
    Ok(_) => panic!("expected grant plugin_id mismatch to fail closed"),
    Err(e) => e,
  };
  assert!(
    matches!(
      err.code,
      crate::domain::service_capability::CapabilityErrorCode::PermissionDenied
        | crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
        | crate::domain::service_capability::CapabilityErrorCode::InvalidConfiguration
    ),
    "{err:?}"
  );
  let _ = lifecycle;
}

#[test]
fn runtime_recheck_matrix_profile_and_package_mutations() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let d1 = publish_fixture(&catalog, &pkg1);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let router =
    crate::services::runtime_router::RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry)
    .with_catalog(catalog.clone())
    .with_router(router, wasm);
  let snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  caps
    .recheck_invocation_snapshot(
      &snap,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .expect("control recheck");
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET enabled = 0, updated_at = ?2 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  assert!(
    caps
      .recheck_invocation_snapshot(
        &snap,
        crate::services::service_capabilities::ProfileCapabilityKind::Translate,
      )
      .is_err()
  );
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET enabled = 1, updated_at = ?2 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), snap.profile_updated_at.clone()],
    )?;
    Ok(())
  })
  .unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET capability_preferences_json = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![profile_id.to_string(), r#"{"label":"mutated"}"#, now_rfc3339()],
    )?;
    Ok(())
  })
  .unwrap();
  assert!(
    caps
      .recheck_invocation_snapshot(
        &snap,
        crate::services::service_capabilities::ProfileCapabilityKind::Translate,
      )
      .is_err()
  );
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE translation_profiles SET capability_preferences_json = ?2, updated_at = ?3 WHERE id = ?1",
      rusqlite::params![
        profile_id.to_string(),
        String::from_utf8(snap.preferences_json.clone()).unwrap(),
        snap.profile_updated_at.clone()
      ],
    )?;
    Ok(())
  })
  .unwrap();
  // Package mutation: the pinned content disappears from the catalog.
  assert!(crate::services::test_support::remove_builtin_fixture(
    &catalog,
    &pkg1.manifest
  ));
  assert!(
    caps
      .recheck_invocation_snapshot(
        &snap,
        crate::services::service_capabilities::ProfileCapabilityKind::Translate,
      )
      .is_err()
  );
  let _ = lifecycle;
  let _ = d1;
}

#[test]
fn runtime_missing_grant_maps_plugin_unavailable_via_formal_translate() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let d1 = publish_fixture(&catalog, &pkg1);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  // Delete live grant row after activation so snapshot load hits real NotFound at grant boundary.
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM execution_grant_capability_entries WHERE grant_set_id IN (
         SELECT id FROM execution_grant_sets WHERE package_digest = ?1
       )",
      rusqlite::params![d1],
    )?;
    uow.conn().execute(
      "DELETE FROM execution_grant_network_entries WHERE grant_set_id IN (
         SELECT id FROM execution_grant_sets WHERE package_digest = ?1
       )",
      rusqlite::params![d1],
    )?;
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    Ok(())
  })
  .unwrap();
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let router =
    crate::services::runtime_router::RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry)
    .with_catalog(catalog.clone())
    .with_router(router, wasm);
  let sessions = crate::domain::cancel::RequestSessionRegistry::new();
  let result = tauri::async_runtime::block_on(crate::cmds::service_translation::run_translate_service_profile(
    &caps,
    &sessions,
    crate::cmds::service_translation::ServiceProfileTranslateInput {
      request_id: "req-missing-grant".into(),
      profile_id,
      text: "hello".into(),
      source_lang: "en".into(),
      target_lang: "zh".into(),
    },
  ));
  assert!(!result.ok, "{result:?}");
  assert_eq!(result.error_code.as_deref(), Some("plugin_unavailable"), "{result:?}");
  assert_ne!(result.error_code.as_deref(), Some("not_found"));
}

#[test]
fn runtime_migration_guest_renames_key_not_value() {
  let runtime = WasmRuntime::new().unwrap();
  let bytes = MIGRATION_WASM;
  let input = br#"{"label":"label","nested":{"label":"keep"},"arr":[{"label":"x"}]}"#;
  let out = tauri::async_runtime::block_on(runtime.execute_migrate_config(bytes, 1, 2, input.to_vec())).unwrap();
  let s = String::from_utf8(out).unwrap();
  assert!(
    s.contains("\"title\":\"label\""),
    "top-level key renamed, value kept: {s}"
  );
  assert!(s.contains("\"title\":\"keep\""), "nested key renamed: {s}");
  assert!(s.contains("\"title\":\"x\""), "array object key renamed: {s}");
  assert!(!s.contains("\"label\":"), "no remaining label keys: {s}");
}

#[test]
fn execution_dispatch_probe_records_migration() {
  use crate::services::execution_dispatch_probe::scope;
  let _probe = scope();
  let runtime = WasmRuntime::new().unwrap();
  let bytes = MIGRATION_WASM;
  let input = br#"{"label":"label"}"#;
  let out = tauri::async_runtime::block_on(runtime.execute_migrate_config(bytes, 1, 2, input.to_vec())).unwrap();
  assert!(!out.is_empty());
  // Current-thread counts: other tests dispatch in parallel in the same process.
  let counts = _probe.snapshot_current_thread();
  assert_eq!(counts.migration, 1, "one real migration execution must be observed");
  assert_eq!(counts.total(), 1, "no other dispatch category may fire");
}

#[test]
fn runtime_post_compile_recheck_rejects_grant_delete() {
  let (_dir, db, catalog, lifecycle) = setup();
  let pkg1 = build_pkg("1.0.0", None);
  let d1 = publish_fixture(&catalog, &pkg1);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let db_hook = db.clone();
  let digest = d1.clone();
  wasm.set_compile_side_effect(move || {
    let _ = db_hook.transaction(|uow| {
      uow.conn().execute(
        "DELETE FROM execution_grant_capability_entries WHERE grant_set_id IN (
           SELECT id FROM execution_grant_sets WHERE package_digest = ?1)",
        rusqlite::params![digest],
      )?;
      uow.conn().execute(
        "DELETE FROM execution_grant_network_entries WHERE grant_set_id IN (
           SELECT id FROM execution_grant_sets WHERE package_digest = ?1)",
        rusqlite::params![digest],
      )?;
      uow.conn().execute(
        "DELETE FROM execution_grant_sets WHERE package_digest = ?1",
        rusqlite::params![digest],
      )?;
      Ok(())
    });
  });
  let router =
    crate::services::runtime_router::RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry)
    .with_catalog(catalog.clone())
    .with_router(router, wasm);
  let snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  assert!(caps.resolve_translate_from_snapshot(&snap).is_err());
  let _ = lifecycle;
}

#[test]
fn runtime_migration_guest_rejects_malformed_and_renames_escaped_keys() {
  let runtime = WasmRuntime::new().unwrap();
  let bytes = MIGRATION_WASM;
  // Malformed JSON fails closed.
  let bad = tauri::async_runtime::block_on(runtime.execute_migrate_config(bytes, 1, 2, b"{not-json".to_vec()));
  assert!(bad.is_err(), "malformed JSON must fail");
  // Unicode-escaped key name \u006cabel parses to label then renames to title.
  let escaped = br#"{"\u006cabel":"keep-value","nested":{"\u006cabel":"n"}}"#;
  let out = tauri::async_runtime::block_on(runtime.execute_migrate_config(bytes, 1, 2, escaped.to_vec())).unwrap();
  let s = String::from_utf8(out).unwrap();
  let v: serde_json::Value = serde_json::from_str(&s).unwrap();
  assert_eq!(v["title"], "keep-value");
  assert_eq!(v["nested"]["title"], "n");
  assert!(v.get("label").is_none());
}
