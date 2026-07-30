// ABOUTME: Preference snapshot/CAS and grant-restore E2E tests for runtime lifecycle.
// ABOUTME: Proves pre-migration snapshots, stale CAS, and grant_snapshot_json restore.
#![cfg(test)]

use crate::domain::ocr_service::{OcrProviderType, OcrService};
use crate::domain::plugin_package::ApprovePluginPackageInput;
use crate::domain::runtime_lifecycle::{
  ApplyRuntimeRollbackInput, ApplyRuntimeUpgradeInput, ExecutionGrantSetBundle, GrantSubjectKind,
};
use crate::domain::runtime_plugin::{
  FileRole, MANIFEST_FILE_PATH, PluginManifestV1, RuntimeDescriptor, RuntimeKind, SIGNATURE_FILE_PATH,
};
use crate::domain::service_integration::{
  IntegrationCapabilityDescriptor, IntegrationHealthStatus, IntegrationInstance, ServiceIntegrationManifest,
};
use crate::domain::speech_service::SpeechService;
use crate::domain::time::{new_id, now_rfc3339};
use crate::domain::translation_profile::{PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine};
use crate::error::StorageError;
use crate::repositories::{
  integration_instances, ocr_services, plugin_permission_grants, plugin_upgrade_snapshots, speech_services,
  translation_profiles,
};
use crate::services::plugin_package::{hash_archive_bytes, public_sha256_hex};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_lifecycle::RuntimeLifecycleService;
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::token_grant::TokenGrantService;
use crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
use crate::services::vendor_trust::test_vendor_fixture::{
  fixture_vendor_fingerprint, fixture_vendor_public_key, fixture_vendor_signing_key,
};
use crate::services::wasm_runtime::WasmRuntime;
use crate::storage::Database;
use ed25519_dalek::Signer;
use std::io::Write;
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

/// Minimal registry-backed manifest for the synthetic conformance plugin so bundled->Wasm upgrades
/// have a verifiable source capability identity (the source major must be preserved by the target).
fn conformance_manifest(plugin_id: &str, capability_id: &str) -> ServiceIntegrationManifest {
  ServiceIntegrationManifest {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: plugin_id.into(),
    version: "1.0.0".into(),
    display_name_key: "conformance".into(),
    min_host_version: "0.1.0".into(),
    config_schema_version: 1,
    credential_slots: vec![],
    endpoints: vec![],
    capabilities: vec![IntegrationCapabilityDescriptor {
      id: capability_id.into(),
      preferences_schema_version: 1,
      endpoint_aliases: vec![],
    }],
  }
}

fn setup() -> (
  tempfile::TempDir,
  Database,
  PluginPackageService,
  RuntimeLifecycleService,
) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let mut registry = ServiceIntegrationRegistry::bundled().unwrap();
  registry.register_test_manifest(conformance_manifest(PLUGIN_ID, TRANSLATE_CAP));
  let registry = Arc::new(registry);
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let tokens = Arc::new(TokenGrantService::new(Arc::new(
    crate::services::google_service_account::GoogleServiceAccountExchanger::new(
      db.clone(),
      Arc::new(crate::credentials::MemoryCredentialVault::default()),
    ),
  )));
  let lifecycle = RuntimeLifecycleService::new(db.clone(), packages.clone(), registry).with_runtime(wasm, tokens);
  (dir, db, packages, lifecycle)
}

fn build_pkg(version: &str, extra: Option<&str>) -> (Vec<u8>, String) {
  let runtime_path = "artifacts/plugin.wasm";
  let mut network = vec![crate::domain::runtime_plugin::NetworkEndpointRequest {
    id: "approved".into(),
    origins: vec!["https://conformance.example".into()],
    methods: vec![crate::domain::runtime_plugin::HttpMethod::Get],
    instance_origin_config_field: None,
  }];
  if let Some(id) = extra {
    network.push(crate::domain::runtime_plugin::NetworkEndpointRequest {
      id: id.into(),
      origins: vec!["https://conformance.example".into()],
      methods: vec![crate::domain::runtime_plugin::HttpMethod::Get],
      instance_origin_config_field: None,
    });
  }
  let config_schema_version: u32 = version
    .split('.')
    .next()
    .and_then(|m| m.parse().ok())
    .filter(|v| *v > 0)
    .unwrap_or(1);
  // Real schema fields/type so normalize_config is exercised (field ids are lowercase/hyphen only).
  let schema_bytes = if config_schema_version >= 2 {
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"title","control":{"kind":"string","spec":{}}}],"groups":[]}"#
      .as_bytes()
      .to_vec()
  } else {
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"label","control":{"kind":"string","spec":{}}}],"groups":[]}"#
      .as_bytes()
      .to_vec()
  };
  let prefs_bytes = if config_schema_version >= 2 {
    r#"{"version":1,"fields":[{"id":"title","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#
      .as_bytes()
      .to_vec()
  } else {
    r#"{"version":1,"fields":[{"id":"label","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#
      .as_bytes()
      .to_vec()
  };
  let files = vec![
    crate::domain::runtime_plugin::PluginFileEntry {
      path: runtime_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: TRANSLATE_WASM.len() as u64,
      sha256: public_sha256_hex(TRANSLATE_WASM),
    },
    crate::domain::runtime_plugin::PluginFileEntry {
      path: "artifacts/migration.wasm".into(),
      role: FileRole::Other,
      bytes: MIGRATION_WASM.len() as u64,
      sha256: public_sha256_hex(MIGRATION_WASM),
    },
    crate::domain::runtime_plugin::PluginFileEntry {
      path: "schemas/config.json".into(),
      role: FileRole::ConfigSchema,
      bytes: schema_bytes.len() as u64,
      sha256: public_sha256_hex(&schema_bytes),
    },
    crate::domain::runtime_plugin::PluginFileEntry {
      path: "schemas/preferences.json".into(),
      role: FileRole::PreferenceSchema,
      bytes: prefs_bytes.len() as u64,
      sha256: public_sha256_hex(&prefs_bytes),
    },
  ];
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: PLUGIN_ID.into(),
    version: version.into(),
    publisher: crate::domain::runtime_plugin::PublisherDeclaration {
      key_id: VENDOR_PUBLISHER_KEY_ID.into(),
      key_fingerprint: fixture_vendor_fingerprint(),
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(runtime_path.into()),
    },
    targets: vec![],
    files,
    capabilities: vec![
      crate::domain::runtime_plugin::CapabilityDeclaration {
        id: TRANSLATE_CAP.into(),
        preferences_schema: Some("schemas/preferences.json".into()),
        artifact: None,
      },
      crate::domain::runtime_plugin::CapabilityDeclaration {
        id: "ocr.image@1".into(),
        preferences_schema: Some("schemas/preferences.json".into()),
        artifact: None,
      },
      crate::domain::runtime_plugin::CapabilityDeclaration {
        id: "speech.synthesize@1".into(),
        preferences_schema: Some("schemas/preferences.json".into()),
        artifact: None,
      },
    ],
    configuration_schema: Some("schemas/config.json".into()),
    config_schema_version: Some(config_schema_version),
    credential_slots: vec![],
    permissions: crate::domain::runtime_plugin::PermissionRequests {
      network,
      auth_policies: vec!["host.none.v1".into()],
    },
    ui: Default::default(),
  };
  let sk = fixture_vendor_signing_key();
  let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
  let signature = sk.sign(&manifest_bytes).to_bytes().to_vec();
  let mut cursor = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(MANIFEST_FILE_PATH, options).unwrap();
    zip.write_all(&manifest_bytes).unwrap();
    zip.start_file(runtime_path, options).unwrap();
    zip.write_all(TRANSLATE_WASM).unwrap();
    zip.start_file("artifacts/migration.wasm", options).unwrap();
    zip.write_all(MIGRATION_WASM).unwrap();
    zip.start_file("schemas/config.json", options).unwrap();
    zip.write_all(&schema_bytes).unwrap();
    zip.start_file("schemas/preferences.json", options).unwrap();
    zip.write_all(&prefs_bytes).unwrap();
    zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
    zip.write_all(&signature).unwrap();
    zip.finish().unwrap();
  }
  let pkg = cursor.into_inner();
  let digest = hash_archive_bytes(&pkg);
  (pkg, digest)
}

fn install(packages: &PluginPackageService, dir: &std::path::Path, bytes: &[u8], set_default: bool) -> String {
  let src = dir.join(format!("{}.lnplugin", new_id()));
  std::fs::write(&src, bytes).unwrap();
  let preview = packages.preview_package(&src).unwrap();
  packages
    .approve_package(ApprovePluginPackageInput {
      preview_id: preview.preview_id,
      approve_publisher: false,
      publisher_public_key_hex: None,
      acknowledge_permissions: true,
      set_as_default: set_default,
    })
    .unwrap()
    .version
    .package_digest
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
        runtime_kind: "bundled-rust".into(),
        package_digest: None,
        execution_grant_set_revision: None,
        runtime_state: "active".into(),
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
        baidu_action: None,
        api_key_ref: None,
        secret_key_ref: None,
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
fn runtime_uninstall_blocks_pin_grant_snapshot_dependencies_and_preserves_files() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
  let id = seed_instance(&db);
  activate(&lifecycle, id, &d1);
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  // v1 is snapshot + grant dependency (not current pin).
  let path_v1 = packages.package_content_path(&d1);
  assert!(path_v1.exists());
  let err = packages.uninstall_version(&d1).unwrap_err();
  assert!(matches!(err, StorageError::InUse(_)), "{err:?}");
  assert!(
    path_v1.exists(),
    "snapshot/grant dependency must keep package content in place"
  );

  // Current pin blocks v2.
  let path_v2 = packages.package_content_path(&d2);
  let err = packages.uninstall_version(&d2).unwrap_err();
  assert!(matches!(err, StorageError::InUse(_)), "{err:?}");
  assert!(path_v2.exists());

  // Discard snapshot, remove grants for v1, clear default, then uninstall v1 succeeds.
  let snaps = db
    .read(|c| plugin_upgrade_snapshots::list_active_for_instance(c, id))
    .unwrap();
  lifecycle.discard_rollback_snapshot(snaps[0].id).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    uow.conn().execute(
      "DELETE FROM plugin_default_versions WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    Ok(())
  })
  .unwrap();
  packages.uninstall_version(&d1).unwrap();
  assert!(!packages.package_content_path(&d1).join("plugin.json").exists());
}

#[test]
fn runtime_rollback_dependency_extra_row_fails_closed() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
fn runtime_uninstall_restore_failure_keeps_content_unavailable() {
  use crate::services::plugin_store::UninstallRestoreFault;
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
  let id = seed_instance(&db);
  activate(&lifecycle, id, &d1);
  // Upgrade so v1 is not the current pin.
  let preview = lifecycle.preview_upgrade(id, &d2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  // Clear dependencies so uninstall can pass gates and reach catalog/restore.
  let snaps = db
    .read(|c| plugin_upgrade_snapshots::list_active_for_instance(c, id))
    .unwrap();
  lifecycle.discard_rollback_snapshot(snaps[0].id).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    uow.conn().execute(
      "DELETE FROM plugin_default_versions WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    Ok(())
  })
  .unwrap();
  // Quarantine succeeds, catalog fails, restore is injected-fail: content stays unavailable.
  packages.set_catalog_delete_fault(true);
  packages.set_restore_fault(Some(UninstallRestoreFault::BeforeRestore));
  let err = packages.uninstall_version(&d1).unwrap_err();
  let dbg = format!("{err:?}");
  assert!(
    dbg.contains("injected restore failure") || dbg.contains("restore/reverify failed"),
    "expected restore-path failure, got: {err:?}"
  );
  let version = db
    .read(|c| crate::repositories::installed_plugin_versions::get(c, &d1))
    .expect("version row must remain after failed uninstall restore");
  assert!(
    !version.content_available,
    "restore failure must keep content_available=false"
  );
}

#[test]
fn runtime_invocation_recheck_rejects_publisher_revoke() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  // Build capabilities with router like production.
  let registry =
    Arc::new(crate::services::service_integration_registry::ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(crate::services::wasm_runtime::WasmRuntime::new().unwrap());
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
    .with_router(router, wasm);
  let snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  // Revoke publisher after snapshot.
  db.transaction(|uow| {
    uow.conn().execute(
      "UPDATE plugin_publishers SET revoked = 1, enabled = 0 WHERE key_id = ?1",
      rusqlite::params![crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID],
    )?;
    Ok(())
  })
  .unwrap();
  let err = caps
    .recheck_invocation_snapshot(
      &snap,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap_err();
  assert_eq!(
    err.code,
    crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
  );
  let _ = lifecycle;
}

#[test]
fn runtime_migration_schema_unknown_field_fails_preview_zero_mutation() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
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
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
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
    uow.conn().execute(
      "UPDATE plugin_publishers SET revoked = 1, enabled = 0 WHERE key_id = ?1",
      rusqlite::params![VENDOR_PUBLISHER_KEY_ID],
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
  let _ = lifecycle;
  let _ = d1;
}

#[test]
fn runtime_uninstall_rehash_fault_keeps_content_unavailable() {
  use crate::services::plugin_store::UninstallRestoreFault;
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  lifecycle.discard_rollback_snapshot(snaps[0].id).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    uow.conn().execute(
      "DELETE FROM plugin_default_versions WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    Ok(())
  })
  .unwrap();
  packages.set_catalog_delete_fault(true);
  packages.set_restore_fault(Some(UninstallRestoreFault::AfterRestoreBeforeRehash));
  let err = packages.uninstall_version(&d1).unwrap_err();
  let dbg = format!("{err:?}");
  assert!(
    dbg.contains("rehash") || dbg.contains("restore/reverify failed"),
    "expected rehash-path failure, got: {err:?}"
  );
  let version = db
    .read(|c| crate::repositories::installed_plugin_versions::get(c, &d1))
    .expect("version row remains");
  assert!(
    !version.content_available,
    "rehash failure must keep content unavailable"
  );
}

#[test]
fn runtime_missing_grant_maps_plugin_unavailable_via_formal_translate() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
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
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
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
fn runtime_uninstall_crash_after_restore_reopens_availability_on_recover() {
  use crate::services::plugin_store::UninstallRestoreFault;
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  let (pkg2, d2) = build_pkg("2.0.0", Some("slow"));
  install(&packages, dir.path(), &pkg1, true);
  install(&packages, dir.path(), &pkg2, false);
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
  lifecycle.discard_rollback_snapshot(snaps[0].id).unwrap();
  db.transaction(|uow| {
    uow.conn().execute(
      "DELETE FROM execution_grant_sets WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    uow.conn().execute(
      "DELETE FROM plugin_default_versions WHERE package_digest = ?1",
      rusqlite::params![d1],
    )?;
    Ok(())
  })
  .unwrap();
  packages.set_catalog_delete_fault(true);
  packages.set_restore_fault(Some(UninstallRestoreFault::AfterRehashBeforeAvailability));
  let _ = packages.uninstall_version(&d1).unwrap_err();
  let mid = db
    .read(|c| crate::repositories::installed_plugin_versions::get(c, &d1))
    .unwrap();
  assert!(!mid.content_available, "pre-recover must keep unavailable");
  assert!(
    packages.package_archive_path(&d1).is_file(),
    "store archive must exist after restore"
  );
  packages.recover_install_operations().unwrap();
  let after = db
    .read(|c| crate::repositories::installed_plugin_versions::get(c, &d1))
    .unwrap();
  assert!(
    after.content_available,
    "recovery must reopen availability for verified store content"
  );
  assert!(packages.package_archive_path(&d1).is_file());
  // Terminal restored: excluded from unfinished; second recover is a no-op (no replay).
  let unfinished = db
    .read(crate::repositories::plugin_uninstall_operations::list_unfinished)
    .unwrap();
  assert!(
    unfinished.iter().all(|op| op.package_digest != d1),
    "restored ops must be excluded from unfinished"
  );
  packages.recover_install_operations().unwrap();
  let after2 = db
    .read(|c| crate::repositories::installed_plugin_versions::get(c, &d1))
    .unwrap();
  assert!(after2.content_available);
  assert_eq!(after2.package_digest, after.package_digest);
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
fn runtime_post_compile_recheck_rejects_publisher_revoke() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  // During compile, revoke publisher so post-compile recheck fails and discards handler.
  let db_hook = db.clone();
  wasm.set_compile_side_effect(move || {
    let _ = db_hook.transaction(|uow| {
      uow.conn().execute(
        "UPDATE plugin_publishers SET revoked = 1, enabled = 0 WHERE key_id = ?1",
        rusqlite::params![VENDOR_PUBLISHER_KEY_ID],
      )?;
      Ok(())
    });
  });
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
    .with_router(router, wasm);
  let snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  let err = match caps.resolve_translate_from_snapshot(&snap) {
    Ok(_) => panic!("expected post-compile recheck to reject"),
    Err(e) => e,
  };
  assert!(
    matches!(
      err.code,
      crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
        | crate::domain::service_capability::CapabilityErrorCode::PermissionDenied
    ),
    "{err:?}"
  );
  let _ = lifecycle;
  let _ = d1;
}

#[test]
fn runtime_post_compile_recheck_rejects_grant_delete() {
  let (dir, db, packages, lifecycle) = setup();
  let (pkg1, d1) = build_pkg("1.0.0", None);
  install(&packages, dir.path(), &pkg1, true);
  let id = seed_instance(&db);
  let (profile_id, _, _) = seed_prefs(&db, id);
  activate(&lifecycle, id, &d1);
  let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
  let handlers = Arc::new(crate::services::service_capabilities::ServiceCapabilityRegistry::new());
  let wasm = Arc::new(WasmRuntime::new().unwrap());
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
  let router = crate::services::runtime_router::RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = crate::services::service_capabilities::ServiceCapabilityService::new(db.clone(), registry, handlers)
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
