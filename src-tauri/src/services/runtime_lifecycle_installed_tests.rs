// ABOUTME: Phase 4 installed synthetic lifecycle conformance and CAS failure-injection tests.
// ABOUTME: Install → pin → Translate/Detect via router → Wasm migration → upgrade → rollback.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::import_export::{
  ConfigurationExport, ImportConflictMode, IntegrationInstanceExport, parse_and_normalize_export_document,
};
use crate::domain::plugin_package::ApprovePluginPackageInput;
use crate::domain::runtime_lifecycle::{
  ApplyRuntimeRollbackInput, ApplyRuntimeUpgradeInput, InstanceRuntimeState, RuntimeRequirementExport,
};
use crate::domain::runtime_plugin::{
  FileRole, MANIFEST_FILE_PATH, PluginManifestV1, RuntimeDescriptor, RuntimeKind, SIGNATURE_FILE_PATH,
};
use crate::domain::service_capability::{DetectLanguageRequest, ExecutionContext, TranslateTextRequest};
use crate::domain::service_integration::{
  IntegrationCapabilityDescriptor, IntegrationHealthStatus, IntegrationInstance, ServiceIntegrationManifest,
};
use crate::domain::settings::AppSettingsV1;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{integration_instances, plugin_upgrade_snapshots};
use crate::services::import_validation::build_validated_plan;
use crate::services::plugin_package::{hash_archive_bytes, public_sha256_hex};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_lifecycle::{RuntimeLifecycleService, UpgradeApplyFault};
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_capabilities::{ServiceCapabilityRegistry, ServiceCapabilityService};
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
const DETECT_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-detect-component/fixtures/langnext-conformance-detect-wasm.wasm"
));
const MIGRATION_WASM: &[u8] = include_bytes!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../runtime-plugins/conformance/wasm-migration-component/fixtures/langnext_conformance_migration_wasm.wasm"
));
const TRANSLATE_PLUGIN_ID: &str = "langnext.conformance";
const DETECT_PLUGIN_ID: &str = "langnext.conformance.detect";
const TRANSLATE_CAP: &str = "translate.text@1";
const DETECT_CAP: &str = "translate.detect@1";

/// Minimal registry-backed manifest for a synthetic conformance plugin so bundled->Wasm upgrades
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
  ServiceCapabilityService,
) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let packages =
    PluginPackageService::with_vendor_roots(db.clone(), dir.path().to_path_buf(), vec![fixture_vendor_public_key()]);
  let mut registry = ServiceIntegrationRegistry::bundled().unwrap();
  registry.register_test_manifest(conformance_manifest(TRANSLATE_PLUGIN_ID, TRANSLATE_CAP));
  registry.register_test_manifest(conformance_manifest(DETECT_PLUGIN_ID, DETECT_CAP));
  let registry = Arc::new(registry);
  let wasm = Arc::new(WasmRuntime::new().unwrap());
  // Minimal token service for cache eviction wiring (no vault needed for empty grants).
  let tokens = Arc::new(TokenGrantService::new(Arc::new(
    crate::services::google_service_account::GoogleServiceAccountExchanger::new(
      db.clone(),
      Arc::new(crate::credentials::MemoryCredentialVault::default()),
    ),
  )));
  let lifecycle =
    RuntimeLifecycleService::new(db.clone(), packages.clone(), registry.clone()).with_runtime(wasm.clone(), tokens);
  let handlers = Arc::new(ServiceCapabilityRegistry::new());
  let router = RuntimeRouter::new(
    db.clone(),
    registry.clone(),
    handlers.clone(),
    packages.clone(),
    wasm.clone(),
  );
  let caps = ServiceCapabilityService::new(db.clone(), registry, handlers).with_router(router, wasm);
  (dir, db, packages, lifecycle, caps)
}

fn build_signed_package(
  plugin_id: &str,
  version: &str,
  runtime_wasm: &[u8],
  runtime_path: &str,
  capabilities: &[&str],
  extra_endpoint: Option<&str>,
  include_migration: bool,
) -> (Vec<u8>, String) {
  let mut network = vec![crate::domain::runtime_plugin::NetworkEndpointRequest {
    id: "approved".into(),
    origins: vec!["https://conformance.example".into()],
    methods: vec![crate::domain::runtime_plugin::HttpMethod::Get],
    instance_origin_config_field: None,
  }];
  if let Some(id) = extra_endpoint {
    network.push(crate::domain::runtime_plugin::NetworkEndpointRequest {
      id: id.into(),
      origins: vec!["https://conformance.example".into()],
      methods: vec![crate::domain::runtime_plugin::HttpMethod::Get],
      instance_origin_config_field: None,
    });
  }
  // Fixture declares host config_schema_version on the manifest (not package semver, not dialect).
  let config_schema_version: u32 = version
    .split('.')
    .next()
    .and_then(|m| m.parse().ok())
    .filter(|v| *v > 0)
    .unwrap_or(1);
  // PluginSchemaV1.version is the dialect (always 1); migration revision lives on the manifest.
  // Real fields so normalize_config is always exercised for empty/non-empty payloads.
  let schema_json = if config_schema_version >= 2 {
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"title","control":{"kind":"string","spec":{}}}],"groups":[]}"#
  } else {
    r#"{"version":1,"fields":[{"id":"mode","control":{"kind":"string","spec":{}}},{"id":"label","control":{"kind":"string","spec":{}}}],"groups":[]}"#
  };
  let schema_bytes = schema_json.as_bytes().to_vec();
  let prefs_json = if config_schema_version >= 2 {
    r#"{"version":1,"fields":[{"id":"title","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#
  } else {
    r#"{"version":1,"fields":[{"id":"label","control":{"kind":"string","spec":{}}},{"id":"language","control":{"kind":"string","spec":{}}},{"id":"confidence","control":{"kind":"number","spec":{"min":0,"max":1}}}],"groups":[]}"#
  };
  let prefs_bytes = prefs_json.as_bytes().to_vec();
  let files = vec![
    crate::domain::runtime_plugin::PluginFileEntry {
      path: runtime_path.into(),
      role: FileRole::RuntimeArtifact,
      bytes: runtime_wasm.len() as u64,
      sha256: public_sha256_hex(runtime_wasm),
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
  let zip_owned: Vec<(String, Vec<u8>)> = vec![
    ("schemas/config.json".into(), schema_bytes),
    ("schemas/preferences.json".into(), prefs_bytes),
  ];
  let mut zip_files: Vec<(&str, &[u8])> = vec![(runtime_path, runtime_wasm)];
  if include_migration {
    // files is immutable after build; push via rebuild below if needed.
  }
  let mut files = files;
  if include_migration {
    files.push(crate::domain::runtime_plugin::PluginFileEntry {
      path: "artifacts/migration.wasm".into(),
      role: FileRole::Other,
      bytes: MIGRATION_WASM.len() as u64,
      sha256: public_sha256_hex(MIGRATION_WASM),
    });
    zip_files.push(("artifacts/migration.wasm", MIGRATION_WASM));
  }
  let manifest = PluginManifestV1 {
    manifest_version: 1,
    plugin_api_version: "1.0".into(),
    id: plugin_id.into(),
    version: version.into(),
    publisher: crate::domain::runtime_plugin::PublisherDeclaration {
      key_id: VENDOR_PUBLISHER_KEY_ID.into(),
      key_fingerprint: fixture_vendor_fingerprint(),
    },
    runtime: RuntimeDescriptor {
      kind: RuntimeKind::WasmComponent,
      artifact: Some(runtime_path.into()),
      native_protocol_version: None,
      native_dependencies: None,
    },
    targets: vec![],
    files,
    capabilities: capabilities
      .iter()
      .map(|id| crate::domain::runtime_plugin::CapabilityDeclaration {
        id: (*id).into(),
        preferences_schema: Some("schemas/preferences.json".into()),
        artifact: None,
      })
      .collect(),
    configuration_schema: Some("schemas/config.json".into()),
    config_schema_version: Some(config_schema_version),
    credential_slots: vec![],
    permissions: crate::domain::runtime_plugin::PermissionRequests {
      network,
      auth_policies: vec!["host.none.v1".into()],
    },
    ui: Default::default(),
    provider_runtime: None,
    model_resources: None,
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
    for (path, bytes) in zip_files {
      zip.start_file(path, options).unwrap();
      zip.write_all(bytes).unwrap();
    }
    for (path, bytes) in &zip_owned {
      zip.start_file(path.as_str(), options).unwrap();
      zip.write_all(bytes).unwrap();
    }
    zip.start_file(SIGNATURE_FILE_PATH, options).unwrap();
    zip.write_all(&signature).unwrap();
    zip.finish().unwrap();
  }
  let pkg = cursor.into_inner();
  let digest = hash_archive_bytes(&pkg);
  (pkg, digest)
}

fn install_package(packages: &PluginPackageService, dir: &std::path::Path, bytes: &[u8], set_default: bool) -> String {
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

fn seed_instance(db: &Database, plugin_id: &str, plugin_version: &str, config_json: &str, schema: u32) -> Uuid {
  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: plugin_id.into(),
        plugin_version: plugin_version.into(),
        display_name: "Conformance".into(),
        enabled: true,
        config_json: config_json.into(),
        config_schema_version: schema,
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

fn activate(
  lifecycle: &RuntimeLifecycleService,
  instance_id: Uuid,
  digest: &str,
  acknowledge: bool,
) -> Result<(), StorageError> {
  let preview = lifecycle.preview_upgrade(instance_id, digest)?;
  lifecycle.apply_upgrade(ApplyRuntimeUpgradeInput {
    preview_id: preview.preview_id,
    acknowledge_permissions: acknowledge,
  })?;
  Ok(())
}

fn block_on<T>(fut: impl std::future::Future<Output = T>) -> T {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
    .block_on(fut)
}

#[test]
fn runtime_upgrade_apply_failure_injection_leaves_source_unchanged() {
  let (dir, db, packages, lifecycle, _caps) = setup();
  let (pkg_a, digest_a) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let (pkg_b, digest_b) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  install_package(&packages, dir.path(), &pkg_a, true);
  install_package(&packages, dir.path(), &pkg_b, false);
  let id = seed_instance(
    &db,
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    r#"{"mode":"success","label":"v1"}"#,
    1,
  );
  activate(&lifecycle, id, &digest_a, true).unwrap();
  let source = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  let source_updated = source.updated_at.clone();
  let source_config = source.config_json.clone();
  let source_digest = source.package_digest.clone();

  for fault in [
    UpgradeApplyFault::BeforeSnapshot,
    UpgradeApplyFault::AfterSnapshotBeforeGrant,
    UpgradeApplyFault::AfterGrantBeforePin,
    UpgradeApplyFault::AfterPinBeforePreferences,
    UpgradeApplyFault::AfterPreferencesBeforeCommit,
  ] {
    let preview = lifecycle.preview_upgrade(id, &digest_b).unwrap();
    assert!(preview.requires_permission_approval);
    lifecycle.set_apply_fault(Some(fault));
    let err = lifecycle
      .apply_upgrade(ApplyRuntimeUpgradeInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Internal(_)), "{fault:?}: {err:?}");
    let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
    assert_eq!(after.package_digest, source_digest);
    assert_eq!(after.updated_at, source_updated);
    assert_eq!(after.config_json, source_config);
  }
}

#[test]
fn runtime_compatible_migration_translate_detect_upgrade_rollback_uninstall() {
  let (dir, db, packages, lifecycle, caps) = setup();
  // Translate lifecycle packages: v1 → v2 (compatible migration + expanded permission).
  let (pkg_v1, digest_v1) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let (pkg_v2, digest_v2) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  let (pkg_bad, digest_bad) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "9.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  // Detect package for typed Detect through the same router.
  let (pkg_detect, digest_detect) = build_signed_package(
    DETECT_PLUGIN_ID,
    "1.0.0",
    DETECT_WASM,
    "artifacts/detect.wasm",
    &[DETECT_CAP],
    None,
    false,
  );
  install_package(&packages, dir.path(), &pkg_v1, true);
  install_package(&packages, dir.path(), &pkg_v2, false);
  install_package(&packages, dir.path(), &pkg_bad, false);
  install_package(&packages, dir.path(), &pkg_detect, true);

  let translate_id = seed_instance(
    &db,
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    r#"{"mode":"success","label":"before"}"#,
    1,
  );
  activate(&lifecycle, translate_id, &digest_v1, true).unwrap();

  // Real profile + exact preference TEXT bound before upgrade (formal command path after migrate).
  let profile_id = {
    use crate::domain::translation_profile::{PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine};
    use crate::repositories::translation_profiles;
    let pid = new_id();
    let now = now_rfc3339();
    let prefs_text = r#"{ "label" : "pref-v1", "language" : "fr" }"#;
    db.transaction(|uow| {
      translation_profiles::insert_profile(
        uow.conn(),
        &TranslationProfile {
          id: pid,
          name: "E2E Prefs".into(),
          enabled: true,
          source_lang: Some("en".into()),
          target_lang: Some("zh".into()),
          primary_lang: Some("en".into()),
          preferred_target_lang: Some("zh".into()),
          engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
            integration_instance_id: translate_id,
            translate_capability_id: TRANSLATE_CAP.into(),
            detect_capability_id: Some(DETECT_CAP.into()),
            capability_preferences_version: 1,
            capability_preferences: serde_json::json!({"label": "pref-v1", "language": "fr"}),
          }),
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      uow.conn().execute(
        "UPDATE translation_profiles SET capability_preferences_json = ?2 WHERE id = ?1",
        rusqlite::params![pid.to_string(), prefs_text],
      )?;
      Ok(())
    })
    .unwrap();
    pid
  };

  // Translate via router.
  let translate = caps
    .resolve_translate(translate_id, TRANSLATE_CAP, b"{}".to_vec())
    .unwrap();
  let ctx = ExecutionContext {
    request_id: "req-tr".into(),
    cancel: CancelToken::new(),
    deadline: None,
    integration_instance_id: translate_id,
    plugin_id: TRANSLATE_PLUGIN_ID.into(),
    capability_id: TRANSLATE_CAP.into(),
    provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
  };
  let tr = block_on(translate.translate(
    translate_id,
    TranslateTextRequest {
      text: "hello".into(),
      source_language_id: "en".into(),
      target_language_id: "zh".into(),
    },
    ctx,
  ))
  .expect("translate");
  assert!(tr.translated_text.contains("hello") || !tr.translated_text.is_empty());

  // Detect via separate instance + router.
  let detect_id = seed_instance(&db, DETECT_PLUGIN_ID, "1.0.0", r#"{"mode":"success"}"#, 1);
  activate(&lifecycle, detect_id, &digest_detect, true).unwrap();
  let detect = caps.resolve_detect(detect_id, DETECT_CAP, b"{}".to_vec()).unwrap();
  let dctx = ExecutionContext {
    request_id: "req-dt".into(),
    cancel: CancelToken::new(),
    deadline: None,
    integration_instance_id: detect_id,
    plugin_id: DETECT_PLUGIN_ID.into(),
    capability_id: DETECT_CAP.into(),
    provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
  };
  let det = block_on(detect.detect(detect_id, DetectLanguageRequest { text: "hello".into() }, dctx)).expect("detect");
  assert!(det.language_id == "en" || det.language_id.starts_with("en"));

  // Compatible upgrade with Wasm migration 1→2 + expanded permissions.
  let before = db.read(|conn| integration_instances::get(conn, translate_id)).unwrap();
  let preview = lifecycle.preview_upgrade(translate_id, &digest_v2).unwrap();
  assert!(preview.requires_permission_approval);
  assert!(
    preview
      .schema_migrations
      .iter()
      .any(|m| m.status == "migrated" && m.kind == "config"),
    "expected Wasm config migration: {:?}",
    preview.schema_migrations
  );
  assert!(preview.target_plugin_version.starts_with('2'));
  // Approval required.
  let denied = lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id.clone(),
      acknowledge_permissions: false,
    })
    .unwrap_err();
  assert!(matches!(denied, StorageError::Validation(_)));
  let preview = lifecycle.preview_upgrade(translate_id, &digest_v2).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let upgraded = db.read(|conn| integration_instances::get(conn, translate_id)).unwrap();
  assert_eq!(upgraded.package_digest.as_deref(), Some(digest_v2.as_str()));
  assert_eq!(upgraded.config_schema_version, 2);
  assert!(
    upgraded.config_json.contains("\"title\"") || upgraded.config_json.contains("schemaVersion"),
    "migrated config: {}",
    upgraded.config_json
  );
  assert!(!upgraded.config_json.contains("\"label\""), "label should be renamed");
  // Formal command workflow: same snapshot + resolve_from_snapshot path as translate_service_profile.
  let tr_snap = caps
    .load_profile_invocation_snapshot(
      profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Translate,
    )
    .unwrap();
  let prefs_text = String::from_utf8_lossy(&tr_snap.preferences_json).into_owned();
  assert!(
    prefs_text.contains("title") && prefs_text.contains("language"),
    "expected migrated preference TEXT with title+language, got {prefs_text}"
  );
  assert!(
    !prefs_text.contains("\"label\""),
    "migrated preference TEXT must not retain label key: {prefs_text}"
  );
  let translate_after = caps.resolve_translate_from_snapshot(&tr_snap).unwrap();
  let tr_after = block_on(translate_after.translate(
    tr_snap.instance_id,
    TranslateTextRequest {
      text: "hello".into(),
      source_language_id: "en".into(),
      target_language_id: "zh".into(),
    },
    ExecutionContext {
      request_id: "req-tr-prefs".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: tr_snap.instance_id,
      plugin_id: tr_snap.plugin_id.clone(),
      capability_id: tr_snap.capability_id.clone(),
      provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
    },
  ))
  .expect("translate with prefs");
  // Guest success mode surfaces exact preferences payload after the text marker.
  let expected_guest = format!("[hello]|prefs:{prefs_text}");
  assert_eq!(
    tr_after.translated_text, expected_guest,
    "guest must observe exact SQLite preference TEXT"
  );

  // Formal detect path: profile bound to detect instance with the same persisted preference TEXT.
  let detect_profile_id = {
    use crate::domain::translation_profile::{PluginCapabilityEngine, TranslationProfile, TranslationProfileEngine};
    use crate::repositories::translation_profiles;
    let pid = new_id();
    let now = now_rfc3339();
    db.transaction(|uow| {
      translation_profiles::insert_profile(
        uow.conn(),
        &TranslationProfile {
          id: pid,
          name: "E2E Detect Prefs".into(),
          enabled: true,
          source_lang: Some("en".into()),
          target_lang: Some("zh".into()),
          primary_lang: Some("en".into()),
          preferred_target_lang: Some("zh".into()),
          engine: TranslationProfileEngine::PluginCapability(PluginCapabilityEngine {
            integration_instance_id: detect_id,
            translate_capability_id: TRANSLATE_CAP.into(),
            detect_capability_id: Some(DETECT_CAP.into()),
            capability_preferences_version: 2,
            capability_preferences: serde_json::from_str(&prefs_text).unwrap_or(serde_json::json!({})),
          }),
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      uow.conn().execute(
        "UPDATE translation_profiles SET capability_preferences_json = ?2 WHERE id = ?1",
        rusqlite::params![pid.to_string(), prefs_text],
      )?;
      Ok(())
    })
    .unwrap();
    pid
  };
  let det_snap = caps
    .load_profile_invocation_snapshot(
      detect_profile_id,
      crate::services::service_capabilities::ProfileCapabilityKind::Detect,
    )
    .unwrap();
  assert_eq!(
    String::from_utf8_lossy(&det_snap.preferences_json),
    prefs_text,
    "detect snapshot must load exact SQLite preference TEXT"
  );
  let detect_after = caps.resolve_detect_from_snapshot(&det_snap).unwrap();
  let det_after = block_on(detect_after.detect(
    det_snap.instance_id,
    DetectLanguageRequest { text: "hello".into() },
    ExecutionContext {
      request_id: "req-dt-prefs".into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: det_snap.instance_id,
      plugin_id: det_snap.plugin_id.clone(),
      capability_id: det_snap.capability_id.clone(),
      provider_attempt: crate::domain::service_capability::ProviderAttemptTracker::new(),
    },
  ))
  .expect("detect with prefs");
  assert_eq!(det_after.language_id, "fr");
  assert_eq!(det_after.confidence, Some(0.91));

  // Incompatible migration cannot mutate.
  let err = lifecycle.preview_upgrade(translate_id, &digest_bad).unwrap_err();
  assert!(
    matches!(err, StorageError::Validation(_)),
    "incompatible migration must fail closed: {err:?}"
  );
  let still = db.read(|conn| integration_instances::get(conn, translate_id)).unwrap();
  assert_eq!(still.package_digest.as_deref(), Some(digest_v2.as_str()));

  // Rollback restores prior non-secret identity/config.
  let rb = lifecycle.preview_rollback(translate_id).unwrap();
  assert_eq!(rb.target.package_digest, before.package_digest);
  lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap();
  let restored = db.read(|conn| integration_instances::get(conn, translate_id)).unwrap();
  assert_eq!(restored.package_digest, before.package_digest);
  assert_eq!(restored.config_json, before.config_json);
  assert_eq!(restored.config_schema_version, before.config_schema_version);

  // Dependency-safe uninstall while pinned.
  let err = packages.uninstall_version(&digest_v1).unwrap_err();
  assert!(matches!(err, StorageError::InUse(_)));
}

#[test]
fn runtime_plugin_export_v7_missing_package_restores_unresolved_exact_requirement() {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  let digest = "a".repeat(64);
  let instance_id = new_id();
  let req = RuntimeRequirementExport {
    plugin_id: TRANSLATE_PLUGIN_ID.into(),
    plugin_version: "1.0.0".into(),
    runtime_kind: "wasm-component".into(),
    package_digest: Some(digest.clone()),
    publisher_key_id: Some(VENDOR_PUBLISHER_KEY_ID.into()),
    publisher_key_fingerprint: Some(fixture_vendor_fingerprint()),
    plugin_api_version: Some("1.0".into()),
    config_schema_version: 1,
    required_capability_majors: vec![TRANSLATE_CAP.into()],
    provider_runtime_kind: None,
    provider_package_digest: None,
  };
  let doc = ConfigurationExport {
    format_version: 7,
    exported_at: now_rfc3339(),
    providers: vec![],
    models: vec![],
    translation_profiles: vec![],
    profile_models: vec![],
    profile_prompt_templates: vec![],
    integration_instances: vec![IntegrationInstanceExport {
      id: instance_id,
      plugin_id: TRANSLATE_PLUGIN_ID.into(),
      plugin_version: "1.0.0".into(),
      display_name: "Missing".into(),
      enabled: true,
      config_json: "{}".into(),
      config_schema_version: 1,
      health_status: "ready".into(),
      runtime: Some(req.clone()),
      created_at: now_rfc3339(),
      updated_at: now_rfc3339(),
    }],
    ocr_services: vec![],
    ocr_prompt_templates: vec![],
    speech_services: vec![],
    app_settings: AppSettingsV1::default_document(),
  };
  let normalized = parse_and_normalize_export_document(serde_json::to_value(&doc).unwrap()).unwrap();
  let plan = db
    .read(|conn| build_validated_plan(conn, &normalized, ImportConflictMode::Merge))
    .unwrap();
  assert!(plan.preview.valid, "{:?}", plan.preview.validation_errors);
  let row = &plan.integrations[0];
  assert_eq!(row.runtime_kind, "wasm-component");
  assert_eq!(row.package_digest.as_deref(), Some(digest.as_str()));
  assert!(row.execution_grant_set_revision.is_none());
  assert_eq!(row.runtime_state, "unavailable");
  let stored: RuntimeRequirementExport =
    serde_json::from_str(row.runtime_requirement_json.as_deref().unwrap()).unwrap();
  assert_eq!(stored.publisher_key_fingerprint, req.publisher_key_fingerprint);
  assert_eq!(stored.required_capability_majors, req.required_capability_majors);
}

#[test]
fn runtime_rollback_stale_preview_and_missing_snapshot_fail_closed() {
  let (dir, db, packages, lifecycle, _) = setup();
  let (pkg_a, digest_a) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let (pkg_b, digest_b) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  install_package(&packages, dir.path(), &pkg_a, true);
  install_package(&packages, dir.path(), &pkg_b, false);
  let id = seed_instance(&db, TRANSLATE_PLUGIN_ID, "1.0.0", r#"{"mode":"success"}"#, 1);
  activate(&lifecycle, id, &digest_a, true).unwrap();
  let preview = lifecycle.preview_upgrade(id, &digest_b).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let rb = lifecycle.preview_rollback(id).unwrap();
  let now = now_rfc3339();
  db.transaction(|uow| {
    let cur = integration_instances::get(uow.conn(), id)?;
    integration_instances::set_enabled(uow.conn(), id, cur.enabled, &now)?;
    Ok(())
  })
  .unwrap();
  let err = lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: rb.preview_id,
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)));
  let err = lifecycle
    .apply_rollback(ApplyRuntimeRollbackInput {
      preview_id: "rrb_missing".into(),
    })
    .unwrap_err();
  assert!(matches!(err, StorageError::Conflict(_)));
}

#[test]
fn runtime_router_selects_wasm_adapter_for_active_pin() {
  let (dir, db, packages, lifecycle, caps) = setup();
  let (pkg_a, digest_a) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  install_package(&packages, dir.path(), &pkg_a, true);
  let id = seed_instance(&db, TRANSLATE_PLUGIN_ID, "1.0.0", r#"{"mode":"success"}"#, 1);
  activate(&lifecycle, id, &digest_a, true).unwrap();
  let _ = caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()).unwrap();
  db.transaction(|uow| {
    let cur = integration_instances::get(uow.conn(), id)?;
    integration_instances::compare_and_set_runtime_pin(
      uow.conn(),
      id,
      &cur.updated_at,
      &cur.plugin_version,
      &cur.config_json,
      cur.config_schema_version,
      "wasm-component",
      Some(&digest_a),
      None,
      InstanceRuntimeState::Unavailable.as_str(),
      Some("plugin_missing"),
      Some("grant revoked"),
      None,
      &now_rfc3339(),
    )?;
    Ok(())
  })
  .unwrap();
  match caps.resolve_translate(id, TRANSLATE_CAP, b"{}".to_vec()) {
    Ok(_) => panic!("expected plugin unavailable"),
    Err(err) => assert_eq!(
      err.code,
      crate::domain::service_capability::CapabilityErrorCode::PluginUnavailable
    ),
  }
}

#[test]
fn runtime_discard_snapshot_and_migration_trap_no_mutation() {
  let (dir, db, packages, lifecycle, _) = setup();
  let (pkg_a, digest_a) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let (pkg_b, digest_b) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  install_package(&packages, dir.path(), &pkg_a, true);
  install_package(&packages, dir.path(), &pkg_b, false);
  let id = seed_instance(&db, TRANSLATE_PLUGIN_ID, "1.0.0", r#"{"mode":"success"}"#, 1);
  activate(&lifecycle, id, &digest_a, true).unwrap();
  let preview = lifecycle.preview_upgrade(id, &digest_b).unwrap();
  lifecycle
    .apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions: true,
    })
    .unwrap();
  let snaps = db
    .read(|conn| plugin_upgrade_snapshots::list_active_for_instance(conn, id))
    .unwrap();
  assert!(!snaps.is_empty());
  let snap_id = snaps[0].id;
  lifecycle.discard_rollback_snapshot(snap_id).unwrap();
  let after = db
    .read(|conn| plugin_upgrade_snapshots::list_active_for_instance(conn, id))
    .unwrap();
  assert!(
    after.iter().all(|s| s.id != snap_id || s.discarded_at.is_some()) || after.is_empty() || after[0].id != snap_id
  );

  // Invalid JSON migration path: corrupt source config then attempt upgrade from a fresh pin.
  // Use a package without migration for same-schema first, then force schema jump with bad JSON.
  let id2 = seed_instance(&db, TRANSLATE_PLUGIN_ID, "1.0.0", r#"{"mode":"success"}"#, 1);
  activate(&lifecycle, id2, &digest_a, true).unwrap();
  // Manually set invalid config then preview to v2 (requires migration).
  db.transaction(|uow| {
    let cur = integration_instances::get(uow.conn(), id2)?;
    integration_instances::compare_and_set(
      uow.conn(),
      id2,
      &cur.updated_at,
      &cur.display_name,
      cur.enabled,
      "not-json",
      cur.config_schema_version,
      cur.health_status,
      None,
      None,
      &now_rfc3339(),
    )?;
    Ok(())
  })
  .unwrap();
  let before = db.read(|conn| integration_instances::get(conn, id2)).unwrap();
  let err = lifecycle.preview_upgrade(id2, &digest_b).unwrap_err();
  assert!(matches!(err, StorageError::Validation(_)), "{err:?}");
  let still = db.read(|conn| integration_instances::get(conn, id2)).unwrap();
  assert_eq!(still.package_digest, before.package_digest);
  assert_eq!(still.config_json, "not-json");
}

#[test]
fn runtime_upgrade_preview_fails_closed_when_source_package_version_missing() {
  let (dir, db, packages, lifecycle, _caps) = setup();
  // Real target package (the upgrade candidate).
  let (pkg_target, digest_target) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  install_package(&packages, dir.path(), &pkg_target, false);
  // Instance pinned to a digest whose installed version row is missing (corruption / uninstall).
  // source_capability_majors must fail closed instead of returning an empty set.
  let id = new_id();
  let now = now_rfc3339();
  db.transaction(|uow| {
    integration_instances::insert(
      uow.conn(),
      &IntegrationInstance {
        id,
        plugin_id: TRANSLATE_PLUGIN_ID.into(),
        plugin_version: "1.0.0".into(),
        display_name: "Missing Source".into(),
        enabled: true,
        config_json: r#"{"mode":"success"}"#.into(),
        config_schema_version: 1,
        health_status: IntegrationHealthStatus::Ready,
        last_validated_at: None,
        last_error_code: None,
        runtime_kind: "wasm-component".into(),
        package_digest: Some("a".repeat(64)),
        execution_grant_set_revision: None,
        runtime_state: "unavailable".into(),
        runtime_error_code: None,
        runtime_error_message: None,
        runtime_requirement_json: None,
        created_at: now.clone(),
        updated_at: now,
      },
    )?;
    Ok::<_, StorageError>(())
  })
  .unwrap();
  let before = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  let err = lifecycle.preview_upgrade(id, &digest_target).unwrap_err();
  assert!(
    matches!(err, StorageError::PluginUnavailable(_)),
    "expected fail-closed PluginUnavailable, got {err:?}"
  );
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.updated_at, before.updated_at);
}

#[test]
fn runtime_upgrade_preview_fails_closed_when_bundled_registry_definition_missing() {
  let (dir, db, packages, lifecycle, _caps) = setup();
  // Target package for a plugin id that is NOT in the bundled registry.
  let missing_plugin_id = "langnext.conformance.missing";
  let (pkg_target, digest_target) = build_signed_package(
    missing_plugin_id,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  install_package(&packages, dir.path(), &pkg_target, false);
  // Bundled-rust instance whose plugin definition is absent from the host registry.
  let id = seed_instance(&db, missing_plugin_id, "1.0.0", r#"{"mode":"success"}"#, 1);
  let err = lifecycle.preview_upgrade(id, &digest_target).unwrap_err();
  assert!(
    matches!(err, StorageError::PluginUnavailable(_)),
    "expected fail-closed PluginUnavailable, got {err:?}"
  );
}

#[test]
fn pin_default_skips_non_google_web_plugin_leaves_bundled_rust() {
  let (dir, db, packages, lifecycle, _caps) = setup();
  // A non-Google-Web plugin set as its catalog default must never be auto-pinned/acknowledged.
  let (pkg, _digest) = build_signed_package(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  install_package(&packages, dir.path(), &pkg, true);
  let id = seed_instance(&db, TRANSLATE_PLUGIN_ID, "1.0.0", r#"{"mode":"success"}"#, 1);
  lifecycle.pin_default_package_for_new_instance(id).unwrap();
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.runtime_kind, "bundled-rust");
  assert!(
    after.package_digest.is_none(),
    "non-Google-Web plugin must not be auto-pinned"
  );
  assert!(after.execution_grant_set_revision.is_none());
}
