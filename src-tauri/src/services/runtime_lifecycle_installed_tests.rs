// ABOUTME: Phase 4 installed synthetic lifecycle conformance and CAS failure-injection tests.
// ABOUTME: Install → pin → Translate/Detect via router → Wasm migration → upgrade → rollback.
#![cfg(test)]

use crate::domain::cancel::CancelToken;
use crate::domain::import_export::{
  ConfigurationExport, ImportConflictMode, IntegrationInstanceExport, parse_and_normalize_export_document,
};
use crate::domain::runtime_lifecycle::{
  ApplyRuntimeRollbackInput, ApplyRuntimeUpgradeInput, InstanceRuntimeState, RuntimeRequirementExport,
};
use crate::domain::runtime_plugin::{FileRole, HttpMethod};
use crate::domain::service_capability::{DetectLanguageRequest, ExecutionContext, TranslateTextRequest};
use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
use crate::domain::settings::AppSettingsV1;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{integration_instances, plugin_upgrade_snapshots};
use crate::services::import_validation::build_validated_plan;
use crate::services::plugin_catalog::PluginCatalog;
use crate::services::runtime_lifecycle::{RuntimeLifecycleService, UpgradeApplyFault};
use crate::services::runtime_router::RuntimeRouter;
use crate::services::service_capabilities::ServiceCapabilityService;
use crate::services::test_support::{
  SyntheticPlugin, catalog_with_synthetic, registry_from_catalog, token_service, user_store, wasm_runtime,
};
use crate::storage::Database;
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

fn setup() -> (
  tempfile::TempDir,
  Database,
  Arc<PluginCatalog>,
  RuntimeLifecycleService,
  ServiceCapabilityService,
) {
  let dir = tempfile::tempdir().unwrap();
  let db = Database::new(dir.path()).unwrap();
  db.initialize().unwrap();
  // Both conformance plugins are built-in catalog content at their base version.
  let catalog = catalog_with_synthetic(
    db.clone(),
    dir.path(),
    &[],
    &[
      conformance_fixture(
        TRANSLATE_PLUGIN_ID,
        "1.0.0",
        TRANSLATE_WASM,
        "artifacts/plugin.wasm",
        &[TRANSLATE_CAP],
        None,
        true,
      ),
      conformance_fixture(
        DETECT_PLUGIN_ID,
        "1.0.0",
        DETECT_WASM,
        "artifacts/detect.wasm",
        &[DETECT_CAP],
        None,
        false,
      ),
    ],
  );
  let registry = registry_from_catalog(&catalog);
  let wasm = wasm_runtime();
  let tokens = token_service(&db, Arc::new(crate::credentials::MemoryCredentialVault::default()));
  let lifecycle =
    RuntimeLifecycleService::new(db.clone(), catalog.clone(), registry.clone()).with_runtime(wasm.clone(), tokens);
  let router = RuntimeRouter::new(db.clone(), registry.clone(), catalog.clone(), wasm.clone());
  let caps = ServiceCapabilityService::new(db.clone(), registry)
    .with_catalog(catalog.clone())
    .with_router(router, wasm);
  (dir, db, catalog, lifecycle, caps)
}

/// Build one conformance catalog fixture: runtime artifact, schemas, capability, endpoint
/// authority, and an optional migration component.
fn conformance_fixture(
  plugin_id: &str,
  version: &str,
  runtime_wasm: &[u8],
  runtime_path: &str,
  capabilities: &[&str],
  extra_endpoint: Option<&str>,
  include_migration: bool,
) -> SyntheticPlugin {
  // Fixture declares host config_schema_version on the manifest (not package semver, not dialect).
  let config_schema_version: u32 = version
    .split('.')
    .next()
    .and_then(|m| m.parse().ok())
    .filter(|v| *v > 0)
    .unwrap_or(1);
  // PluginSchemaV1.version is the dialect (always 1); migration revision lives on the manifest.
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
  let mut plugin = SyntheticPlugin::new(plugin_id, version, runtime_path, runtime_wasm)
    .with_config_schema(schema_json, config_schema_version)
    .with_network_endpoint("approved", &["https://conformance.example"], &[HttpMethod::Get])
    .with_auth_policy("host.none.v1");
  if let Some(id) = extra_endpoint {
    plugin = plugin.with_network_endpoint(id, &["https://conformance.example"], &[HttpMethod::Get]);
  }
  for capability in capabilities {
    plugin = plugin.with_capability_and_preferences(capability, prefs_json);
  }
  if include_migration {
    plugin = plugin.add_file("artifacts/migration.wasm", FileRole::Other, MIGRATION_WASM);
  }
  plugin
}

/// Publish one fixture as built-in catalog content and return its content digest.
fn publish_fixture(catalog: &PluginCatalog, plugin: &SyntheticPlugin) -> String {
  plugin.publish(catalog)
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
  let (_dir, db, catalog, lifecycle, _caps) = setup();
  let pkg_a = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let pkg_b = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  let digest_a = publish_fixture(&catalog, &pkg_a);
  let digest_b = publish_fixture(&catalog, &pkg_b);
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
fn unsigned_integration_upgrade_apply_and_rollback_revalidate_exact_digest() {
  let (_dir, db, catalog, lifecycle, _caps) = setup();
  let fixture = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let digest = publish_fixture(&catalog, &fixture);
  let instance_id = seed_instance(
    &db,
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    r#"{"mode":"success","label":"before"}"#,
    1,
  );
  activate(&lifecycle, instance_id, &digest, true).unwrap();
  let active = db.read(|conn| integration_instances::get(conn, instance_id)).unwrap();
  assert_eq!(active.package_digest.as_deref(), Some(digest.as_str()));
  assert_eq!(active.runtime_kind, "wasm-component");

  let preview = lifecycle.preview_upgrade(instance_id, &digest).unwrap();
  // Content is immutable and digest-addressed: a snapshot that disappears from the catalog
  // cannot be re-applied, and the active pin stays on the original digest.
  let snapshot_dir = catalog
    .snapshot(&digest)
    .expect("pinned snapshot resolves")
    .snapshot_dir;
  assert!(snapshot_dir.is_dir());
  std::fs::remove_dir_all(&snapshot_dir).unwrap();
  assert!(
    lifecycle
      .apply_upgrade(ApplyRuntimeUpgradeInput {
        preview_id: preview.preview_id,
        acknowledge_permissions: true,
      })
      .is_err(),
    "final apply recheck must reject a snapshot that is no longer available"
  );
  let unchanged = db.read(|conn| integration_instances::get(conn, instance_id)).unwrap();
  assert_eq!(unchanged.package_digest.as_deref(), Some(digest.as_str()));
  assert_eq!(unchanged.runtime_kind, "wasm-component");
}

#[test]
fn runtime_compatible_migration_translate_detect_upgrade_rollback_uninstall() {
  let (_dir, db, catalog, lifecycle, caps) = setup();
  // Translate lifecycle packages: v1 → v2 (compatible migration + expanded permission).
  let pkg_v1 = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let pkg_v2 = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  let pkg_bad = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "9.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  // Detect package for typed Detect through the same router.
  let pkg_detect = conformance_fixture(
    DETECT_PLUGIN_ID,
    "1.0.0",
    DETECT_WASM,
    "artifacts/detect.wasm",
    &[DETECT_CAP],
    None,
    false,
  );
  let digest_v1 = publish_fixture(&catalog, &pkg_v1);
  let digest_v2 = publish_fixture(&catalog, &pkg_v2);
  let digest_bad = publish_fixture(&catalog, &pkg_bad);
  let digest_detect = publish_fixture(&catalog, &pkg_detect);

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

  // Dependency-safe removal: a user archive pinned by an instance cannot be removed.
  let store = user_store(db.clone(), _dir.path());
  let user_plugin_id = "com.example.user-conformance";
  let user_archive = conformance_fixture(
    user_plugin_id,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  )
  .archive_in(_dir.path(), "user-conformance");
  let user_digest = crate::services::test_support::install_user_archive(&store, &user_archive);
  // The public install command refreshes the catalog after the store write.
  catalog.refresh().expect("catalog refresh after user install");
  let user_instance = seed_instance(&db, user_plugin_id, "1.0.0", r#"{"mode":"success"}"#, 1);
  activate(&lifecycle, user_instance, &user_digest, true).unwrap();
  let err = store.remove_user_archive(&user_digest).unwrap_err();
  assert!(matches!(err, StorageError::InUse(_)), "{err:?}");
}

#[test]
fn runtime_plugin_export_v8_missing_package_restores_unresolved_exact_requirement() {
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
    plugin_api_version: Some("1.0".into()),
    config_schema_version: 1,
    required_capability_majors: vec![TRANSLATE_CAP.into()],
  };
  let doc = ConfigurationExport {
    format_version: 8,
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
    .read(|conn| build_validated_plan(conn, &normalized, ImportConflictMode::Merge, None, None))
    .unwrap();
  assert!(plan.preview.valid, "{:?}", plan.preview.validation_errors);
  let row = &plan.integrations[0];
  assert_eq!(row.runtime_kind, "wasm-component");
  // Import never installs content: no pin is written, the exact digest stays in the requirement.
  assert!(row.package_digest.is_none());
  assert!(row.execution_grant_set_revision.is_none());
  assert_eq!(row.runtime_state, "unavailable");
  let requirement: RuntimeRequirementExport =
    serde_json::from_str(row.runtime_requirement_json.as_deref().unwrap()).unwrap();
  assert_eq!(requirement.package_digest.as_deref(), Some(digest.as_str()));
  assert_eq!(requirement.required_capability_majors, req.required_capability_majors);
}

#[test]
fn runtime_rollback_stale_preview_and_missing_snapshot_fail_closed() {
  let (_dir, db, catalog, lifecycle, _) = setup();
  let pkg_a = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let pkg_b = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  let digest_a = publish_fixture(&catalog, &pkg_a);
  let digest_b = publish_fixture(&catalog, &pkg_b);
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
  let (_dir, db, catalog, lifecycle, caps) = setup();
  let pkg_a = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let digest_a = publish_fixture(&catalog, &pkg_a);
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
  let (_dir, db, catalog, lifecycle, _) = setup();
  let pkg_a = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "1.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let pkg_b = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    Some("slow"),
    true,
  );
  let digest_a = publish_fixture(&catalog, &pkg_a);
  let digest_b = publish_fixture(&catalog, &pkg_b);
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
  let (_dir, db, catalog, lifecycle, _caps) = setup();
  // Real target package (the upgrade candidate).
  let pkg_target = conformance_fixture(
    TRANSLATE_PLUGIN_ID,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let digest_target = publish_fixture(&catalog, &pkg_target);
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
        execution_grant_set_revision: Some(1),
        runtime_state: "active".into(),
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
    matches!(err, StorageError::PluginUnavailable(_) | StorageError::NotFound(_)),
    "expected fail-closed missing-source error, got {err:?}"
  );
  let after = db.read(|conn| integration_instances::get(conn, id)).unwrap();
  assert_eq!(after.package_digest, before.package_digest);
  assert_eq!(after.updated_at, before.updated_at);
}

#[test]
fn runtime_upgrade_preview_from_pending_missing_source_to_matching_package_succeeds() {
  let (_dir, db, catalog, lifecycle, _caps) = setup();
  // Target package for a plugin id that is NOT in the bundled registry.
  let missing_plugin_id = "langnext.conformance.missing";
  let pkg_target = conformance_fixture(
    missing_plugin_id,
    "2.0.0",
    TRANSLATE_WASM,
    "artifacts/plugin.wasm",
    &[TRANSLATE_CAP],
    None,
    true,
  );
  let digest_target = publish_fixture(&catalog, &pkg_target);
  let id = seed_instance(&db, missing_plugin_id, "1.0.0", r#"{"mode":"success"}"#, 1);
  let preview = lifecycle.preview_upgrade(id, &digest_target).unwrap();
  assert_eq!(preview.target.package_digest.as_deref(), Some(digest_target.as_str()));
}
