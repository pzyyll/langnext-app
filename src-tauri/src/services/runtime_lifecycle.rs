// ABOUTME: Prepare/approve CAS upgrade and rollback for integration runtime pins.
// ABOUTME: Migrations run on copied non-secret JSON only; secrets never enter snapshots.
use crate::domain::endpoint_trust::{
  EDGE_TTS_TRUST_ENDPOINT_ALIAS, RuntimeIdentityFingerprintInput, configuration_fingerprint,
  runtime_identity_fingerprint,
};
use crate::domain::plugin_package::compute_permission_request_digest;
use crate::domain::plugin_package::runtime_kind_storage;
use crate::domain::runtime_lifecycle::{
  ApplyRuntimeRollbackInput, ApplyRuntimeUpgradeInput, CapabilityCompatibilityDto, CapabilityGrantEntryRecord,
  CredentialSlotCompatibilityDto, ExecutionGrantSetBundle, ExecutionGrantSetRecord, GrantSubjectKind,
  InstanceRuntimeState, MAX_ROLLBACK_SNAPSHOTS_PER_INSTANCE, NetworkGrantEntryRecord, PageGrantEntryRecord,
  PermissionDifferenceDto, PluginUpgradeSnapshot, PreferenceSnapshotRow, PublisherIdentityDto,
  RUNTIME_PREVIEW_TTL_SECS, RuntimeIdentityDto, RuntimeLifecycleResultDto, RuntimeRequirementExport,
  RuntimeRollbackPreviewDto, RuntimeUpgradePreviewDto, SchemaMigrationDto, runtime_kind_as_str,
};
use crate::domain::runtime_plugin::{
  AuthPolicyId, CapabilityId, EndpointId, ExecutionGrantSet, FileRole, GrantSetRevision, HttpsOrigin,
  NetworkEndpointRequest, NetworkGrantEntry, NetworkOriginKind, NetworkResourceMode, PackageDigest, PackageIdentity,
  PageGrantEntry, PluginId, PluginManifestV1, RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
  RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES, RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
  RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS, ResourceLimits, RuntimeIdentity, RuntimeKind, SemVerVersion,
};
use crate::domain::service_integration::{
  GOOGLE_TRANSLATE_WEB_GTX_ORIGIN, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, IntegrationInstance,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{
  installed_plugin_versions, integration_credential_bindings, integration_endpoint_trusts, integration_instances,
  plugin_permission_grants, plugin_publishers, plugin_upgrade_snapshots,
};
use crate::services::plugin_package::{VerifiedPackage, public_sha256_hex};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_router::{http_method_as_str, parse_http_method};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::storage::Database;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone)]
struct UpgradePreviewSession {
  preview_id: String,
  instance_id: Uuid,
  expected_updated_at: String,
  source_package_digest: Option<String>,
  source_grant_revision: Option<u64>,
  target_package_digest: String,
  target_plugin_version: String,
  target_config_json: String,
  target_config_schema_version: u32,
  migrated_config_digest: String,
  grant_bundle: ExecutionGrantSetBundle,
  requires_permission_approval: bool,
  requires_publisher_reapproval: bool,
  /// Pre-migration rows snapshotted for rollback (byte-exact non-secret state).
  source_translation_preferences: Vec<PreferenceSnapshotRow>,
  source_ocr_preferences: Vec<PreferenceSnapshotRow>,
  source_speech_preferences: Vec<PreferenceSnapshotRow>,
  /// Migrated rows written on apply (never stored in the rollback snapshot).
  migrated_translation_preferences: Vec<PreferenceSnapshotRow>,
  migrated_ocr_preferences: Vec<PreferenceSnapshotRow>,
  migrated_speech_preferences: Vec<PreferenceSnapshotRow>,
  expires_at: Instant,
}

#[derive(Debug, Clone)]
struct RollbackPreviewSession {
  preview_id: String,
  instance_id: Uuid,
  expected_updated_at: String,
  snapshot_id: Uuid,
  /// Bound at preview: each dependent row identity + owner + expected updated_at.
  translation_preferences: Vec<PreferenceSnapshotRow>,
  ocr_preferences: Vec<PreferenceSnapshotRow>,
  speech_preferences: Vec<PreferenceSnapshotRow>,
  expires_at: Instant,
}

/// Injected failure points for CAS apply failure-injection tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradeApplyFault {
  BeforeSnapshot,
  AfterSnapshotBeforeGrant,
  AfterGrantBeforePin,
  AfterPinBeforePreferences,
}

/// Runtime lifecycle service: preview, CAS apply, and rollback.
#[derive(Clone)]
pub struct RuntimeLifecycleService {
  db: Database,
  plugin_packages: PluginPackageService,
  registry: Arc<ServiceIntegrationRegistry>,
  wasm_runtime: Option<Arc<crate::services::wasm_runtime::WasmRuntime>>,
  token_grants: Option<Arc<crate::services::token_grant::TokenGrantService>>,
  vault: Option<Arc<dyn crate::credentials::CredentialVault>>,
  upgrade_previews: Arc<Mutex<std::collections::HashMap<String, UpgradePreviewSession>>>,
  rollback_previews: Arc<Mutex<std::collections::HashMap<String, RollbackPreviewSession>>>,
  apply_fault: Arc<Mutex<Option<UpgradeApplyFault>>>,
  /// Test-only hook fired after the initial vendor-root verify and before the final auto-pin
  /// re-verify/apply, so TOCTOU replacement of DB/content can be proven fail-closed.
  #[cfg(test)]
  auto_pin_between_verify_and_apply: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
  /// Test-only hook fired after the final store re-validation under the package-store generation
  /// lock and before DB grant/pin write. Raw archive/content replacement here must fail closed
  /// before commit (the earlier between-verify-and-apply hook is not sufficient for this window).
  #[cfg(test)]
  auto_pin_after_final_revalidate: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
}

impl RuntimeLifecycleService {
  pub fn new(db: Database, plugin_packages: PluginPackageService, registry: Arc<ServiceIntegrationRegistry>) -> Self {
    Self {
      db,
      plugin_packages,
      registry,
      wasm_runtime: None,
      token_grants: None,
      vault: None,
      upgrade_previews: Arc::new(Mutex::new(std::collections::HashMap::new())),
      rollback_previews: Arc::new(Mutex::new(std::collections::HashMap::new())),
      apply_fault: Arc::new(Mutex::new(None)),
      #[cfg(test)]
      auto_pin_between_verify_and_apply: Arc::new(Mutex::new(None)),
      #[cfg(test)]
      auto_pin_after_final_revalidate: Arc::new(Mutex::new(None)),
    }
  }

  pub fn with_runtime(
    mut self,
    wasm_runtime: Arc<crate::services::wasm_runtime::WasmRuntime>,
    token_grants: Arc<crate::services::token_grant::TokenGrantService>,
  ) -> Self {
    self.wasm_runtime = Some(wasm_runtime);
    self.token_grants = Some(token_grants);
    self
  }

  pub fn with_vault(mut self, vault: Arc<dyn crate::credentials::CredentialVault>) -> Self {
    self.vault = Some(vault);
    self
  }

  /// Test-only: inject a one-shot failure inside the apply transaction.
  pub fn set_apply_fault(&self, fault: Option<UpgradeApplyFault>) {
    *self.apply_fault.lock().unwrap_or_else(|e| e.into_inner()) = fault;
  }

  fn take_apply_fault(&self, expected: UpgradeApplyFault) -> bool {
    let mut guard = self.apply_fault.lock().unwrap_or_else(|e| e.into_inner());
    if *guard == Some(expected) {
      *guard = None;
      true
    } else {
      false
    }
  }

  /// Test-only: run a one-shot hook after the initial vendor-root verify and before final auto-pin
  /// re-verify/apply (TOCTOU injection).
  #[cfg(test)]
  pub fn set_auto_pin_between_verify_and_apply_hook(&self, hook: Option<Box<dyn FnOnce() + Send>>) {
    *self
      .auto_pin_between_verify_and_apply
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = hook;
  }

  #[cfg(test)]
  fn take_auto_pin_between_verify_and_apply_hook(&self) -> Option<Box<dyn FnOnce() + Send>> {
    self
      .auto_pin_between_verify_and_apply
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take()
  }

  /// Test-only: run a one-shot hook after final store re-validation (under the store generation
  /// lock) and before grant/pin DB write.
  #[cfg(test)]
  pub fn set_auto_pin_after_final_revalidate_hook(&self, hook: Option<Box<dyn FnOnce() + Send>>) {
    *self
      .auto_pin_after_final_revalidate
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = hook;
  }

  #[cfg(test)]
  fn take_auto_pin_after_final_revalidate_hook(&self) -> Option<Box<dyn FnOnce() + Send>> {
    self
      .auto_pin_after_final_revalidate
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take()
  }

  pub fn preview_upgrade(
    &self,
    instance_id: Uuid,
    target_package_digest: &str,
  ) -> Result<RuntimeUpgradePreviewDto, StorageError> {
    self.expire_previews();
    let package_digest = PackageDigest::parse(target_package_digest).map_err(StorageError::Validation)?;

    let (instance, target_version, source_grant) = self.db.read(|conn| {
      let instance = integration_instances::get(conn, instance_id)?;
      let target = installed_plugin_versions::get(conn, package_digest.as_str())?;
      let source_grant = match (&instance.package_digest, instance.execution_grant_set_revision) {
        (Some(digest), Some(rev)) => Some(plugin_permission_grants::get_bundle_for_subject_package_revision(
          conn,
          GrantSubjectKind::IntegrationInstance,
          instance_id,
          digest,
          rev,
        )?),
        _ => None,
      };
      Ok((instance, target, source_grant))
    })?;

    if !target_version.content_available {
      return Err(StorageError::PluginUnavailable(
        "target package content is unavailable".into(),
      ));
    }
    if target_version.plugin_id != instance.plugin_id {
      return Err(StorageError::Validation(
        "target package plugin id does not match the instance".into(),
      ));
    }

    let publisher = self
      .db
      .read(|conn| plugin_publishers::get(conn, &target_version.publisher_key_id))?;
    if publisher.revoked || !publisher.enabled {
      return Err(StorageError::Validation(
        "target package publisher is revoked or disabled".into(),
      ));
    }

    let target_manifest: PluginManifestV1 = serde_json::from_str(&target_version.manifest_json)
      .map_err(|e| StorageError::Validation(format!("invalid target manifest: {e}")))?;
    if target_manifest.runtime.kind != RuntimeKind::WasmComponent {
      return Err(StorageError::Validation(
        "Phase 4 upgrades target Wasm Component packages only".into(),
      ));
    }

    // Capability name+major compatibility: the target must declare every capability major the
    // instance currently exposes (bundled definition or source package). A drop or major change
    // would sever existing profile/dependency bindings, so fail closed at preview rather than
    // offering a migration that cannot preserve them. Schema compatibility is enforced below by
    // the migration component + signed-schema validation of the migrated config/preferences.
    let source_caps = self.source_capability_majors(&instance)?;
    let target_caps: HashSet<String> = target_manifest.capabilities.iter().map(|c| c.id.clone()).collect();
    for capability_id in &source_caps {
      if !target_caps.contains(capability_id) {
        return Err(StorageError::Validation(format!(
          "target package is missing a required capability major: {capability_id}"
        )));
      }
    }

    // Schema revisions come from signed manifest declaration / schema files — never package semver major.
    let source_schema = instance.config_schema_version;
    let target_schema = self.resolve_config_schema_version(package_digest.as_str(), &target_manifest, source_schema)?;
    let migration_bytes = self.load_verified_migration_component_bytes(package_digest.as_str(), &target_manifest)?;
    // Capture pre-migration rows first so snapshots remain byte-exact for rollback.
    let (source_translation, source_ocr, source_speech) =
      self.db.read(|conn| collect_preference_snapshots(conn, instance_id))?;
    let (migrated_config, migrated_translation, migrated_ocr, migrated_speech, schema_migrations) = self
      .run_target_migrations_from_rows(
        &instance.config_json,
        source_schema,
        target_schema,
        migration_bytes.as_deref(),
        source_translation.clone(),
        source_ocr.clone(),
        source_speech.clone(),
      )?;
    validate_json_object(&migrated_config, "migrated config")?;
    // Validate + normalize migrated payloads; prepared session stores normalized output only.
    let (migrated_config, migrated_translation, migrated_ocr, migrated_speech) =
      validate_and_normalize_migrated_payloads(
        &self.plugin_packages,
        package_digest.as_str(),
        &target_manifest,
        &migrated_config,
        migrated_translation,
        migrated_ocr,
        migrated_speech,
      )?;
    let migrated_config_digest = public_sha256_hex(migrated_config.as_bytes());
    for row in source_translation
      .iter()
      .chain(source_ocr.iter())
      .chain(source_speech.iter())
      .chain(migrated_translation.iter())
      .chain(migrated_ocr.iter())
      .chain(migrated_speech.iter())
    {
      validate_json_value(&row.preferences_json, &format!("{} preferences", row.kind))?;
    }

    let grant_bundle = build_grant_bundle_for_target(
      &self.db,
      &self.plugin_packages,
      &instance,
      &migrated_config,
      &target_version,
      &target_manifest,
      source_grant.as_ref(),
    )?;
    let source_permission_digest = source_grant
      .as_ref()
      .map(|g| g.header.permission_request_digest.clone())
      .unwrap_or_default();
    let target_permission_digest = if target_version.permission_request_digest.is_empty() {
      compute_permission_request_digest(&target_manifest)
    } else {
      target_version.permission_request_digest.clone()
    };
    let permission_differences = diff_permissions(
      source_grant.as_ref(),
      &target_manifest,
      &grant_bundle,
      &source_permission_digest,
      &target_permission_digest,
    );
    let requires_permission_approval = !permission_differences.is_empty();

    let source_publisher = instance.package_digest.as_ref().and_then(|digest| {
      self
        .db
        .read(|conn| installed_plugin_versions::get_optional(conn, digest))
        .ok()
        .flatten()
    });
    let requires_publisher_reapproval = match &source_publisher {
      Some(src) => src.publisher_key_id != target_version.publisher_key_id,
      None => false,
    };

    let capability_compatibility = capability_compatibility(source_grant.as_ref(), &target_manifest);
    let credential_slots = credential_slot_compatibility(&instance, &target_manifest, &self.db, self.vault.as_deref())?;
    // kind_mismatch is fail-closed at preview. required_missing is returned for UI binding and
    // rechecked on apply (no secrets in DTO).
    if credential_slots.iter().any(|s| s.status == "kind_mismatch") {
      return Err(StorageError::Validation(
        "credential slot kind is incompatible with the target package".into(),
      ));
    }
    let source_publisher_dto = source_publisher.as_ref().map(|src| PublisherIdentityDto {
      key_id: src.publisher_key_id.clone(),
      key_fingerprint: src.publisher_fingerprint.clone(),
    });
    let target_publisher_dto = PublisherIdentityDto {
      key_id: target_version.publisher_key_id.clone(),
      key_fingerprint: target_version.publisher_fingerprint.clone(),
    };
    let preview_id = format!("rup_{}", new_id().simple());
    let dto = RuntimeUpgradePreviewDto {
      preview_id: preview_id.clone(),
      instance_id,
      source: identity_dto_from_instance(&instance),
      target: RuntimeIdentityDto {
        runtime_kind: runtime_kind_as_str(RuntimeKind::WasmComponent).into(),
        package_digest: Some(package_digest.as_str().to_string()),
        execution_grant_set_revision: Some(grant_bundle.header.revision),
        runtime_state: InstanceRuntimeState::Active,
        runtime_error_code: None,
        runtime_error_message: None,
      },
      source_plugin_version: instance.plugin_version.clone(),
      target_plugin_version: target_version.version.clone(),
      source_publisher: source_publisher_dto,
      target_publisher: target_publisher_dto,
      requires_permission_approval,
      requires_publisher_reapproval,
      capability_compatibility,
      schema_migrations,
      credential_slots,
      permission_differences,
      expires_at: now_plus_secs(RUNTIME_PREVIEW_TTL_SECS),
    };

    let session = UpgradePreviewSession {
      preview_id: preview_id.clone(),
      instance_id,
      expected_updated_at: instance.updated_at.clone(),
      source_package_digest: instance.package_digest.clone(),
      source_grant_revision: instance.execution_grant_set_revision,
      target_package_digest: package_digest.as_str().to_string(),
      target_plugin_version: target_version.version.clone(),
      target_config_json: migrated_config,
      target_config_schema_version: target_schema,
      migrated_config_digest,
      grant_bundle,
      requires_permission_approval,
      requires_publisher_reapproval,
      source_translation_preferences: source_translation,
      source_ocr_preferences: source_ocr,
      source_speech_preferences: source_speech,
      migrated_translation_preferences: migrated_translation,
      migrated_ocr_preferences: migrated_ocr,
      migrated_speech_preferences: migrated_speech,
      expires_at: Instant::now() + Duration::from_secs(RUNTIME_PREVIEW_TTL_SECS),
    };
    self
      .upgrade_previews
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .insert(preview_id, session);
    Ok(dto)
  }

  /// Atomically seal a freshly acknowledged Edge TTS base URL into the active Wasm grant.
  /// The caller must already have updated the instance config and exact approval row inside the
  /// same SQLite transaction. Any grant-build, approval, or pin failure aborts that transaction.
  pub fn refresh_edge_tts_grant_for_instance_in_transaction(
    &self,
    conn: &rusqlite::Connection,
    instance_id: Uuid,
  ) -> Result<(), StorageError> {
    let instance = integration_instances::get(conn, instance_id)?;
    if instance.runtime_kind != runtime_kind_storage(RuntimeKind::WasmComponent)
      || instance.package_digest.is_none()
      || instance.execution_grant_set_revision.is_none()
    {
      return Ok(());
    }
    if instance.plugin_id != crate::domain::service_integration::EDGE_TTS_PLUGIN_ID {
      return Err(StorageError::Validation(
        "Edge TTS grant refresh received a non-Edge instance".into(),
      ));
    }
    let package_digest = instance
      .package_digest
      .as_deref()
      .ok_or_else(|| StorageError::Conflict("active Edge TTS package digest is missing".into()))?;
    let target_version = installed_plugin_versions::get(conn, package_digest)?;
    if target_version.plugin_id != instance.plugin_id || target_version.version != instance.plugin_version {
      return Err(StorageError::Conflict(
        "active Edge TTS package identity does not match the instance".into(),
      ));
    }
    let target_manifest: PluginManifestV1 = serde_json::from_str(&target_version.manifest_json)
      .map_err(|error| StorageError::Validation(format!("invalid active Edge TTS manifest: {error}")))?;
    let grant_bundle = build_grant_bundle_for_target_on_conn(
      conn,
      &self.plugin_packages,
      &instance,
      &instance.config_json,
      &target_version,
      &target_manifest,
      None,
    )?;
    let requirement = build_runtime_requirement(&target_version, &target_manifest, instance.config_schema_version)?;
    let requirement_json = serde_json::to_string(&requirement)?;
    plugin_permission_grants::insert_bundle(conn, &grant_bundle)?;
    integration_instances::compare_and_set_runtime_pin(
      conn,
      instance_id,
      &instance.updated_at,
      &target_version.version,
      &instance.config_json,
      instance.config_schema_version,
      runtime_kind_storage(RuntimeKind::WasmComponent),
      Some(package_digest),
      Some(grant_bundle.header.revision),
      InstanceRuntimeState::Active.as_str(),
      None,
      None,
      Some(&requirement_json),
      &now_rfc3339(),
    )?;
    Ok(())
  }

  pub fn refresh_active_grant_for_instance(
    &self,
    instance_id: Uuid,
    acknowledge_permissions: bool,
  ) -> Result<(), StorageError> {
    let package_digest = self.db.read(|conn| {
      let instance = integration_instances::get(conn, instance_id)?;
      if instance.runtime_kind != runtime_kind_storage(RuntimeKind::WasmComponent)
        || instance.package_digest.is_none()
        || instance.execution_grant_set_revision.is_none()
      {
        return Ok(None);
      }
      Ok(instance.package_digest)
    })?;
    let Some(package_digest) = package_digest else {
      return Ok(());
    };
    let preview = self.preview_upgrade(instance_id, &package_digest)?;
    if (preview.requires_permission_approval || preview.requires_publisher_reapproval) && !acknowledge_permissions {
      return Err(StorageError::Conflict(
        "active runtime grant refresh requires explicit permission acknowledgement".into(),
      ));
    }
    self.apply_upgrade(ApplyRuntimeUpgradeInput {
      preview_id: preview.preview_id,
      acknowledge_permissions,
    })?;
    Ok(())
  }

  pub fn apply_upgrade(&self, input: ApplyRuntimeUpgradeInput) -> Result<RuntimeLifecycleResultDto, StorageError> {
    self.expire_previews();
    let session = {
      let mut guard = self.upgrade_previews.lock().unwrap_or_else(|e| e.into_inner());
      guard
        .remove(&input.preview_id)
        .ok_or_else(|| StorageError::Conflict("upgrade preview is missing or expired".into()))?
    };
    if Instant::now() > session.expires_at {
      return Err(StorageError::Conflict("upgrade preview expired".into()));
    }
    if (session.requires_permission_approval || session.requires_publisher_reapproval) && !input.acknowledge_permissions
    {
      return Err(StorageError::Validation(
        "permission or publisher change requires acknowledgePermissions".into(),
      ));
    }
    if public_sha256_hex(session.target_config_json.as_bytes()) != session.migrated_config_digest {
      return Err(StorageError::Conflict("migrated config digest mismatch".into()));
    }

    let now = now_rfc3339();
    let result = self.db.transaction(|uow| {
      if self.take_apply_fault(UpgradeApplyFault::BeforeSnapshot) {
        return Err(StorageError::Internal("injected fault: before snapshot".into()));
      }
      // Re-validate target package/content/publisher/manifest/archive/artifact after preview.
      let target_manifest = revalidate_target_package_for_apply(uow.conn(), &session.target_package_digest)?;
      revalidate_package_store_artifacts(&self.plugin_packages, &session.target_package_digest, &target_manifest)?;
      if session.grant_bundle.header.package_digest != session.target_package_digest {
        return Err(StorageError::Conflict("grant bundle package digest mismatch".into()));
      }
      let expected_permission = compute_permission_request_digest(&target_manifest);
      if session.grant_bundle.header.permission_request_digest != expected_permission {
        return Err(StorageError::Conflict(
          "grant permission request digest diverged from target manifest; re-preview required".into(),
        ));
      }
      // Required credentials must be bound before apply (collected via vault/journal UI).
      let current = integration_instances::get(uow.conn(), session.instance_id)?;
      let slots = credential_slot_compatibility_conn(uow.conn(), &current, &target_manifest, self.vault.as_deref())?;
      if slots
        .iter()
        .any(|s| s.status == "required_missing" || s.status == "kind_mismatch")
      {
        return Err(StorageError::Validation(
          "credential slots are missing or incompatible for target package".into(),
        ));
      }
      if current.updated_at != session.expected_updated_at {
        return Err(StorageError::Conflict(
          "integration instance changed concurrently".into(),
        ));
      }
      if current.package_digest != session.source_package_digest
        || current.execution_grant_set_revision != session.source_grant_revision
      {
        return Err(StorageError::Conflict("runtime pin changed concurrently".into()));
      }

      // CAS against pre-migration dependency identity + owner + updated_at.
      verify_preference_cas(uow.conn(), &session.source_translation_preferences, session.instance_id)?;
      verify_preference_cas(uow.conn(), &session.source_ocr_preferences, session.instance_id)?;
      verify_preference_cas(uow.conn(), &session.source_speech_preferences, session.instance_id)?;
      // TOCTOU: re-collect full live ID+owner sets and compare bidirectionally with preview.
      let (live_translation, live_ocr, live_speech) = collect_preference_snapshots(uow.conn(), session.instance_id)?;
      assert_dependency_sets_bidirectional(&live_translation, &session.source_translation_preferences)?;
      assert_dependency_sets_bidirectional(&live_ocr, &session.source_ocr_preferences)?;
      assert_dependency_sets_bidirectional(&live_speech, &session.source_speech_preferences)?;

      let source_grant_json =
        if let (Some(digest), Some(rev)) = (&session.source_package_digest, session.source_grant_revision) {
          let bundle = plugin_permission_grants::get_bundle_for_subject_package_revision(
            uow.conn(),
            GrantSubjectKind::IntegrationInstance,
            session.instance_id,
            digest,
            rev,
          )?;
          Some(serde_json::to_string(&bundle)?)
        } else {
          None
        };
      let source_grant_set_id =
        if let (Some(digest), Some(rev)) = (&session.source_package_digest, session.source_grant_revision) {
          Some(
            plugin_permission_grants::get_for_subject_package_revision(
              uow.conn(),
              GrantSubjectKind::IntegrationInstance,
              session.instance_id,
              digest,
              rev,
            )?
            .id,
          )
        } else {
          None
        };

      // Snapshot holds pre-migration non-secret state only.
      let snapshot = PluginUpgradeSnapshot {
        id: new_id(),
        integration_instance_id: session.instance_id,
        created_at: now.clone(),
        discarded_at: None,
        runtime_kind: current.runtime_kind.clone(),
        package_digest: current.package_digest.clone(),
        execution_grant_set_id: source_grant_set_id,
        execution_grant_set_revision: current.execution_grant_set_revision,
        plugin_version: current.plugin_version.clone(),
        config_json: current.config_json.clone(),
        config_schema_version: current.config_schema_version,
        grant_snapshot_json: source_grant_json,
        translation_preferences: session.source_translation_preferences.clone(),
        ocr_preferences: session.source_ocr_preferences.clone(),
        speech_preferences: session.source_speech_preferences.clone(),
      };
      plugin_upgrade_snapshots::insert(uow.conn(), &snapshot)?;
      prune_snapshots(uow.conn(), session.instance_id, &now)?;
      if self.take_apply_fault(UpgradeApplyFault::AfterSnapshotBeforeGrant) {
        return Err(StorageError::Internal(
          "injected fault: after snapshot before grant".into(),
        ));
      }

      plugin_permission_grants::insert_bundle(uow.conn(), &session.grant_bundle)?;
      // Keep an endpoint approval only when the newly sealed grant carries the exact matching
      // user-approved provenance. This covers config migrations as well as package/runtime
      // identity changes: a changed target without a fresh exact approval revokes old rows.
      let target_has_endpoint_approval = session
        .grant_bundle
        .network
        .iter()
        .any(|entry| entry.origin_kind == NetworkOriginKind::UserApprovedInstance.as_str());
      if !target_has_endpoint_approval {
        integration_endpoint_trusts::delete_for_instance(uow.conn(), session.instance_id)?;
      }
      if self.take_apply_fault(UpgradeApplyFault::AfterGrantBeforePin) {
        return Err(StorageError::Internal("injected fault: after grant before pin".into()));
      }

      let requirement_json = {
        let target_version = installed_plugin_versions::get(uow.conn(), &session.target_package_digest)?;
        let target_manifest: PluginManifestV1 = serde_json::from_str(&target_version.manifest_json)
          .map_err(|e| StorageError::Validation(format!("invalid target manifest: {e}")))?;
        let requirement =
          build_runtime_requirement(&target_version, &target_manifest, session.target_config_schema_version)?;
        serde_json::to_string(&requirement)?
      };
      integration_instances::compare_and_set_runtime_pin(
        uow.conn(),
        session.instance_id,
        &session.expected_updated_at,
        &session.target_plugin_version,
        &session.target_config_json,
        session.target_config_schema_version,
        runtime_kind_storage(RuntimeKind::WasmComponent),
        Some(&session.target_package_digest),
        Some(session.grant_bundle.header.revision),
        InstanceRuntimeState::Active.as_str(),
        None,
        None,
        Some(&requirement_json),
        &now,
      )?;
      if self.take_apply_fault(UpgradeApplyFault::AfterPinBeforePreferences) {
        return Err(StorageError::Internal(
          "injected fault: after pin before preferences".into(),
        ));
      }

      // Write migrated preference rows (never the snapshot rows).
      write_preference_rows(
        uow.conn(),
        &session.migrated_translation_preferences,
        &session.migrated_ocr_preferences,
        &session.migrated_speech_preferences,
        &now,
        false,
        session.instance_id,
      )?;

      let updated = integration_instances::get(uow.conn(), session.instance_id)?;
      Ok(RuntimeLifecycleResultDto {
        instance_id: updated.id,
        runtime: identity_dto_from_instance(&updated),
        plugin_version: updated.plugin_version,
        updated_at: updated.updated_at,
      })
    })?;
    // Evict token + compiled Component caches only after successful commit.
    self.evict_runtime_caches(
      session.instance_id,
      session.source_package_digest.as_deref(),
      Some(session.target_package_digest.as_str()),
    );
    Ok(result)
  }

  pub fn preview_rollback(&self, instance_id: Uuid) -> Result<RuntimeRollbackPreviewDto, StorageError> {
    self.expire_previews();
    let (instance, snapshot) = self.db.read(|conn| {
      let instance = integration_instances::get(conn, instance_id)?;
      let snapshot = plugin_upgrade_snapshots::latest_for_instance(conn, instance_id)?
        .ok_or_else(|| StorageError::NotFound("no rollback snapshot for instance".into()))?;
      Ok((instance, snapshot))
    })?;

    if let Some(digest) = &snapshot.package_digest {
      let version = self
        .db
        .read(|conn| installed_plugin_versions::get_optional(conn, digest))?;
      match version {
        Some(v) if v.content_available => {}
        Some(_) => {
          return Err(StorageError::PluginUnavailable(
            "rollback target package content is unavailable".into(),
          ));
        }
        None if snapshot.runtime_kind == runtime_kind_storage(RuntimeKind::BundledRust) => {}
        None => {
          return Err(StorageError::PluginUnavailable(
            "rollback target package is not installed".into(),
          ));
        }
      }
    }
    // Live grant may be missing when we will restore from grant_snapshot_json on apply.
    if let (Some(digest), Some(rev)) = (&snapshot.package_digest, snapshot.execution_grant_set_revision) {
      let live = self.db.read(|conn| {
        plugin_permission_grants::get_for_subject_package_revision(
          conn,
          GrantSubjectKind::IntegrationInstance,
          instance_id,
          digest,
          rev,
        )
      });
      match live {
        Ok(_) => {}
        Err(StorageError::NotFound(_)) if snapshot.grant_snapshot_json.is_some() => {}
        Err(StorageError::NotFound(_)) => {
          return Err(StorageError::NotFound(
            "rollback target grant is missing and snapshot has no grant authority".into(),
          ));
        }
        Err(err) => return Err(err),
      }
    }

    let preview_id = format!("rrb_{}", new_id().simple());
    let dto = RuntimeRollbackPreviewDto {
      preview_id: preview_id.clone(),
      instance_id,
      snapshot_id: snapshot.id,
      current: identity_dto_from_instance(&instance),
      target: RuntimeIdentityDto {
        runtime_kind: snapshot.runtime_kind.clone(),
        package_digest: snapshot.package_digest.clone(),
        execution_grant_set_revision: snapshot.execution_grant_set_revision,
        runtime_state: InstanceRuntimeState::Active,
        runtime_error_code: None,
        runtime_error_message: None,
      },
      target_plugin_version: snapshot.plugin_version.clone(),
      expires_at: now_plus_secs(RUNTIME_PREVIEW_TTL_SECS),
    };
    // Bind dependency row identity + owner + live updated_at at preview time (CAS tokens).
    // Snapshot rows supply restore content; live rows supply CAS expected_updated_at.
    let (live_translation, live_ocr, live_speech) =
      self.db.read(|conn| collect_preference_snapshots(conn, instance_id))?;
    let translation_cas =
      bind_rollback_dependency_cas(&snapshot.translation_preferences, &live_translation, instance_id)?;
    let ocr_cas = bind_rollback_dependency_cas(&snapshot.ocr_preferences, &live_ocr, instance_id)?;
    let speech_cas = bind_rollback_dependency_cas(&snapshot.speech_preferences, &live_speech, instance_id)?;

    self.rollback_previews.lock().unwrap_or_else(|e| e.into_inner()).insert(
      preview_id,
      RollbackPreviewSession {
        preview_id: dto.preview_id.clone(),
        instance_id,
        expected_updated_at: instance.updated_at,
        snapshot_id: snapshot.id,
        translation_preferences: translation_cas,
        ocr_preferences: ocr_cas,
        speech_preferences: speech_cas,
        expires_at: Instant::now() + Duration::from_secs(RUNTIME_PREVIEW_TTL_SECS),
      },
    );
    Ok(dto)
  }

  pub fn apply_rollback(&self, input: ApplyRuntimeRollbackInput) -> Result<RuntimeLifecycleResultDto, StorageError> {
    self.expire_previews();
    let session = {
      let mut guard = self.rollback_previews.lock().unwrap_or_else(|e| e.into_inner());
      guard
        .remove(&input.preview_id)
        .ok_or_else(|| StorageError::Conflict("rollback preview is missing or expired".into()))?
    };
    if Instant::now() > session.expires_at {
      return Err(StorageError::Conflict("rollback preview expired".into()));
    }

    let now = now_rfc3339();
    let result = self.db.transaction(|uow| {
      let current = integration_instances::get(uow.conn(), session.instance_id)?;
      if current.updated_at != session.expected_updated_at {
        return Err(StorageError::Conflict(
          "integration instance changed concurrently".into(),
        ));
      }
      let snapshot = plugin_upgrade_snapshots::get(uow.conn(), session.snapshot_id)?;
      if snapshot.integration_instance_id != session.instance_id || snapshot.discarded_at.is_some() {
        return Err(StorageError::Conflict("rollback snapshot is unavailable".into()));
      }

      // Fail closed if dependent rows were rebound or edited since preview (live CAS tokens).
      verify_preference_cas(uow.conn(), &session.translation_preferences, session.instance_id)?;
      verify_preference_cas(uow.conn(), &session.ocr_preferences, session.instance_id)?;
      verify_preference_cas(uow.conn(), &session.speech_preferences, session.instance_id)?;
      // Snapshot content identity must still cover the same row ids/owners as the preview CAS set.
      assert_snapshot_dependency_ids_match(&session.translation_preferences, &snapshot.translation_preferences)?;
      assert_snapshot_dependency_ids_match(&session.ocr_preferences, &snapshot.ocr_preferences)?;
      assert_snapshot_dependency_ids_match(&session.speech_preferences, &snapshot.speech_preferences)?;

      // Rollback target package/content/publisher/grant must be available; never restore an active pin to a missing package.
      if let Some(digest) = snapshot.package_digest.as_deref() {
        let target_manifest = revalidate_target_package_for_apply(uow.conn(), digest)?;
        revalidate_package_store_artifacts(&self.plugin_packages, digest, &target_manifest)?;
        let slots = credential_slot_compatibility_conn(uow.conn(), &current, &target_manifest, self.vault.as_deref())?;
        if slots
          .iter()
          .any(|s| s.status == "kind_mismatch" || s.status == "required_missing")
        {
          return Err(StorageError::Validation(
            "rollback target credential slots are incompatible or unbound".into(),
          ));
        }
        // Package-backed rollback requires an exact grant revision and live/canonical grant authority.
        let rev = snapshot.execution_grant_set_revision.ok_or_else(|| {
          StorageError::Validation("package-backed rollback snapshot is missing grant revision".into())
        })?;
        let live_grant = plugin_permission_grants::get_for_subject_package_revision(
          uow.conn(),
          GrantSubjectKind::IntegrationInstance,
          session.instance_id,
          digest,
          rev,
        );
        match live_grant {
          Ok(_) => {}
          Err(StorageError::NotFound(_)) => {
            if snapshot.grant_snapshot_json.is_none() {
              return Err(StorageError::NotFound(
                "rollback target grant is missing and snapshot has no grant authority".into(),
              ));
            }
            // Canonical validation runs in restore_grant_from_snapshot before pin write.
          }
          Err(err) => return Err(err),
        }
      }
      // Bidirectional dependency set compare: live rows vs snapshot rows must match by id+owner.
      let (live_translation, live_ocr, live_speech) = collect_preference_snapshots(uow.conn(), session.instance_id)?;
      assert_dependency_sets_bidirectional(&live_translation, &snapshot.translation_preferences)?;
      assert_dependency_sets_bidirectional(&live_ocr, &snapshot.ocr_preferences)?;
      assert_dependency_sets_bidirectional(&live_speech, &snapshot.speech_preferences)?;

      // Restore exact grant authority from snapshot when the live grant is missing or diverged.
      restore_grant_from_snapshot(uow.conn(), &snapshot)?;
      // Rollback never restores endpoint approval. Any prior user acknowledgement is stale for
      // the restored runtime identity and requires a fresh review/save cycle.
      integration_endpoint_trusts::delete_for_instance(uow.conn(), session.instance_id)?;

      // Restore pre-migration preference JSON/schema only (byte-exact TEXT).
      write_preference_rows(
        uow.conn(),
        &snapshot.translation_preferences,
        &snapshot.ocr_preferences,
        &snapshot.speech_preferences,
        &now,
        false,
        session.instance_id,
      )?;

      let requirement_json = match snapshot.package_digest.as_deref() {
        Some(digest) => {
          let version = installed_plugin_versions::get_optional(uow.conn(), digest)?;
          match version {
            Some(version) => {
              let manifest: PluginManifestV1 = serde_json::from_str(&version.manifest_json)
                .map_err(|e| StorageError::Validation(format!("invalid rollback target manifest: {e}")))?;
              Some(serde_json::to_string(&build_runtime_requirement(
                &version,
                &manifest,
                snapshot.config_schema_version,
              )?)?)
            }
            None => current.runtime_requirement_json.clone(),
          }
        }
        None => None,
      };

      integration_instances::compare_and_set_runtime_pin(
        uow.conn(),
        session.instance_id,
        &session.expected_updated_at,
        &snapshot.plugin_version,
        &snapshot.config_json,
        snapshot.config_schema_version,
        &snapshot.runtime_kind,
        snapshot.package_digest.as_deref(),
        snapshot.execution_grant_set_revision,
        InstanceRuntimeState::Active.as_str(),
        None,
        None,
        requirement_json.as_deref(),
        &now,
      )?;

      let updated = integration_instances::get(uow.conn(), session.instance_id)?;
      Ok((
        RuntimeLifecycleResultDto {
          instance_id: updated.id,
          runtime: identity_dto_from_instance(&updated),
          plugin_version: updated.plugin_version,
          updated_at: updated.updated_at,
        },
        current.package_digest.clone(),
        snapshot.package_digest.clone(),
      ))
    })?;
    self.evict_runtime_caches(session.instance_id, result.1.as_deref(), result.2.as_deref());
    Ok(result.0)
  }

  fn evict_runtime_caches(
    &self,
    instance_id: Uuid,
    source_package_digest: Option<&str>,
    target_package_digest: Option<&str>,
  ) {
    if let Some(tokens) = &self.token_grants {
      tokens.evict_instance(instance_id);
    }
    if let Some(runtime) = &self.wasm_runtime {
      // Compiled cache is keyed by package+artifact digests; clear matching package identities.
      runtime.invalidate_package_digests(
        [source_package_digest, target_package_digest]
          .into_iter()
          .flatten()
          .collect::<Vec<_>>(),
      );
    }
  }

  pub fn discard_rollback_snapshot(&self, snapshot_id: Uuid) -> Result<(), StorageError> {
    let now = now_rfc3339();
    self
      .db
      .transaction(|uow| plugin_upgrade_snapshots::discard(uow.conn(), snapshot_id, &now))
  }

  /// Pin the default installed Wasm package for a freshly created integration instance.
  /// Used by [`crate::services::service_integrations::ServiceIntegrationService::create`] so new
  /// Google Web instances run on the vendor-default Wasm package instead of silently staying
  /// Bundled Rust. Safe-fail: when no default package exists, the external vendor root is missing,
  /// verification fails, the package is not a host-allowed vendor default, or the atomic apply
  /// fails, the instance is left Bundled Rust (still a valid executor). Auto-pin is restricted to
  /// the host-allowed vendor defaults: Google Web GTX (host-fixed origin) and Edge TTS
  /// (instance-configured origin resolved to the vendor-default base URL). All other packages,
  /// including those with a non-default instance-configured origin, require explicit migration
  /// with a consent warning.
  ///
  /// Security:
  /// - Trust root is only the external `vendor_roots` held by [`PluginPackageService`] (app
  ///   config), never `plugin_publishers.public_key_hex` from DB.
  /// - DB publisher/version/manifest rows are reverse-bound objects only.
  /// - The verified archive snapshot is retained and re-verified with the same external root
  ///   immediately before grant/pin write (no verify→preview/apply TOCTOU that discards
  ///   [`VerifiedPackage`]). Mutable DB/content between those steps fails closed.
  pub fn pin_default_package_for_new_instance(&self, instance_id: Uuid) -> Result<(), StorageError> {
    let (plugin_id, default_version, publisher) = self.db.read(|conn| {
      let instance = integration_instances::get(conn, instance_id)?;
      // Only auto-pin freshly created, still-bundled instances.
      if instance.package_digest.is_some() || instance.execution_grant_set_revision.is_some() {
        return Ok::<_, StorageError>((instance.plugin_id, None, None));
      }
      let default = installed_plugin_versions::get_default(conn, &instance.plugin_id)?;
      let version = match &default {
        Some(default) => installed_plugin_versions::get(conn, &default.package_digest).ok(),
        None => None,
      };
      let publisher = version.as_ref().and_then(|v| {
        plugin_publishers::get_optional(conn, &v.publisher_key_id)
          .ok()
          .flatten()
      });
      Ok::<_, StorageError>((instance.plugin_id, version, publisher))
    })?;
    let (default, publisher) = match (default_version, publisher) {
      (Some(version), Some(publisher)) if version.content_available => (version, publisher),
      _ => return Ok(()),
    };
    // Resolve the external vendor root by archive-declared key id/fingerprint, then fully verify
    // the retained archive+content with that root. DB publisher.public_key_hex is never the trust
    // root. Missing/mismatched roots fail closed (stay Bundled).
    let (verified, vendor_root) = match self
      .plugin_packages
      .verify_store_with_vendor_root(&default.package_digest)
    {
      Ok(pair) => pair,
      Err(err) => {
        log::warn!(
          "new_instance_default_pin_vendor_reverify_failed instance={instance_id} plugin={plugin_id} digest={} error={err}",
          default.package_digest
        );
        return Ok(());
      }
    };
    // Auto-acknowledgment is restricted to host-allowed vendor defaults (Google Web GTX 1.0.0 or
    // Edge TTS 1.0.0). Reverse-bind DB rows to the external-root-verified snapshot; any divergence
    // fails closed. Edge TTS uses an instance-configured origin resolved to the vendor-default
    // base URL from the migrated config, so auto-pin is safe.
    if !is_host_allowed_vendor_default(&default, &verified, &vendor_root, &publisher) {
      log::info!(
        "new_instance_default_pin_skipped_not_vendor_default instance={instance_id} plugin={plugin_id} version={}",
        default.version
      );
      return Ok(());
    }
    #[cfg(test)]
    if let Some(hook) = self.take_auto_pin_between_verify_and_apply_hook() {
      hook();
    }
    // Atomic auto-pin path: re-verify with the same external vendor root, consume the verified
    // snapshot for grant/pin, and fail closed if DB/content diverged after the initial verify.
    if let Err(err) = self.apply_verified_auto_pin(instance_id, &verified, &vendor_root) {
      log::warn!("new_instance_default_pin_apply_failed instance={instance_id} plugin={plugin_id} error={err}");
    }
    Ok(())
  }

  /// Final auto-pin authorization: re-verify the exact retained archive/content with the external
  /// vendor root, compare against the retained verification snapshot, reverse-bind live DB rows,
  /// then write grant + runtime pin in one CAS transaction. Does not go through the public
  /// preview/apply session path (which would discard [`VerifiedPackage`] and re-read untrusted
  /// catalog manifests).
  fn apply_verified_auto_pin(
    &self,
    instance_id: Uuid,
    verified_snapshot: &VerifiedPackage,
    vendor_root: &crate::services::vendor_trust::VendorPublicKey,
  ) -> Result<(), StorageError> {
    // Final external-root re-verify of exact retained archive/content immediately before pin.
    let (rechecked, rechecked_root) = self
      .plugin_packages
      .verify_store_with_vendor_root(&verified_snapshot.package_digest)?;
    if rechecked_root.public_key_hex != vendor_root.public_key_hex
      || rechecked_root.key_id != vendor_root.key_id
      || rechecked.package_digest != verified_snapshot.package_digest
      || rechecked.manifest_bytes != verified_snapshot.manifest_bytes
      || rechecked.publisher_public_key_hex != verified_snapshot.publisher_public_key_hex
      || rechecked.publisher_fingerprint != verified_snapshot.publisher_fingerprint
      || rechecked.manifest != verified_snapshot.manifest
    {
      return Err(StorageError::Conflict(
        "auto-pin verified snapshot diverged before apply; refusing pin".into(),
      ));
    }
    let package_digest = rechecked.package_digest.clone();
    let target_manifest = rechecked.manifest.clone();

    let (instance, target_version, publisher) = self.db.read(|conn| {
      let instance = integration_instances::get(conn, instance_id)?;
      let target_version = installed_plugin_versions::get(conn, &package_digest)?;
      let publisher = plugin_publishers::get_optional(conn, &target_version.publisher_key_id)?;
      Ok((instance, target_version, publisher))
    })?;
    let publisher =
      publisher.ok_or_else(|| StorageError::Validation("auto-pin publisher row missing after re-verify".into()))?;
    if instance.package_digest.is_some() || instance.execution_grant_set_revision.is_some() {
      return Err(StorageError::Conflict(
        "instance runtime pin changed before auto-pin apply".into(),
      ));
    }
    if !target_version.content_available {
      return Err(StorageError::PluginUnavailable(
        "auto-pin target content became unavailable".into(),
      ));
    }
    // Reverse-bind live catalog rows to the external-root-verified snapshot (DB is object only).
    if target_version.package_digest != package_digest
      || target_version.plugin_id != target_manifest.id
      || target_version.version != target_manifest.version
      || target_version.publisher_key_id != target_manifest.publisher.key_id
      || target_version.publisher_fingerprint != target_manifest.publisher.key_fingerprint
      || target_version.plugin_id != instance.plugin_id
    {
      return Err(StorageError::Validation(
        "auto-pin catalog row does not reverse-bind the verified snapshot".into(),
      ));
    }
    if !is_host_allowed_vendor_default(&target_version, &rechecked, vendor_root, &publisher) {
      return Err(StorageError::Validation(
        "auto-pin package no longer matches host-allowed vendor default policy".into(),
      ));
    }
    // Catalog manifest_json must still equal the verified signed manifest (object integrity).
    let catalog_manifest: PluginManifestV1 = serde_json::from_str(&target_version.manifest_json)
      .map_err(|e| StorageError::Validation(format!("invalid catalog manifest: {e}")))?;
    if catalog_manifest != target_manifest {
      return Err(StorageError::Validation(
        "auto-pin catalog manifest diverged from verified snapshot".into(),
      ));
    }
    let expected_permission = compute_permission_request_digest(&target_manifest);
    if target_version.permission_request_digest != expected_permission {
      return Err(StorageError::Validation(
        "auto-pin permission request digest diverged from verified manifest".into(),
      ));
    }

    let source_schema = instance.config_schema_version;
    let target_schema = self.resolve_config_schema_version(package_digest.as_str(), &target_manifest, source_schema)?;
    let migration_bytes = self.load_verified_migration_component_bytes(package_digest.as_str(), &target_manifest)?;
    let (source_translation, source_ocr, source_speech) =
      self.db.read(|conn| collect_preference_snapshots(conn, instance_id))?;
    let (migrated_config, migrated_translation, migrated_ocr, migrated_speech, _schema_migrations) = self
      .run_target_migrations_from_rows(
        &instance.config_json,
        source_schema,
        target_schema,
        migration_bytes.as_deref(),
        source_translation.clone(),
        source_ocr.clone(),
        source_speech.clone(),
      )?;
    validate_json_object(&migrated_config, "migrated config")?;
    let (migrated_config, migrated_translation, migrated_ocr, migrated_speech) =
      validate_and_normalize_migrated_payloads(
        &self.plugin_packages,
        package_digest.as_str(),
        &target_manifest,
        &migrated_config,
        migrated_translation,
        migrated_ocr,
        migrated_speech,
      )?;
    // Auto-pin consent gate: Edge TTS uses an instance-configured origin (`base-url`), so the
    // manifest-structural check alone is insufficient. Auto-pin is only safe when the EFFECTIVE
    // origin resolved from the migrated config equals the exact vendor default. Any custom
    // origin must go through explicit permission preview/approval and must not be host-auto-
    // approved. Google Web GTX uses a host-fixed origin (no instance config), so this gate only
    // applies to Edge TTS.
    if target_manifest.id == crate::domain::service_integration::EDGE_TTS_PLUGIN_ID
      && !edge_tts_effective_origin_is_vendor_default(&migrated_config)
    {
      return Err(StorageError::Conflict(
        "auto-pin requires Edge TTS effective origin to equal the vendor default; a custom base-url needs explicit migration consent".into(),
      ));
    }
    let migrated_config_digest = public_sha256_hex(migrated_config.as_bytes());
    let grant_bundle = build_grant_bundle_for_target(
      &self.db,
      &self.plugin_packages,
      &instance,
      &migrated_config,
      &target_version,
      &target_manifest,
      None,
    )?;
    if grant_bundle.header.package_digest != package_digest
      || grant_bundle.header.permission_request_digest != expected_permission
    {
      return Err(StorageError::Conflict(
        "auto-pin grant bundle does not bind the verified package".into(),
      ));
    }

    let expected_updated_at = instance.updated_at.clone();
    let target_plugin_version = target_version.version.clone();
    let now = now_rfc3339();
    // Hold the host package-store generation lock across final re-validation → grant/pin commit so
    // install/uninstall/recover cannot replace archive/content in this window (lock order: store → DB).
    let _store_guard = self.plugin_packages.lock_store()?;
    let generation_at_final_revalidate = self.plugin_packages.store_generation();
    self.db.transaction(|uow| {
      // Inside the final transaction: reverse-bind DB again and re-verify store with the external
      // vendor root so concurrent catalog/content replacement cannot race the pin write.
      let current = integration_instances::get(uow.conn(), instance_id)?;
      if current.updated_at != expected_updated_at {
        return Err(StorageError::Conflict(
          "integration instance changed concurrently during auto-pin".into(),
        ));
      }
      if current.package_digest.is_some() || current.execution_grant_set_revision.is_some() {
        return Err(StorageError::Conflict(
          "runtime pin changed concurrently during auto-pin".into(),
        ));
      }
      let live_version = installed_plugin_versions::get(uow.conn(), &package_digest)?;
      if !live_version.content_available
        || live_version.package_digest != package_digest
        || live_version.plugin_id != target_manifest.id
        || live_version.version != target_manifest.version
        || live_version.publisher_key_id != target_manifest.publisher.key_id
        || live_version.publisher_fingerprint != target_manifest.publisher.key_fingerprint
        || live_version.permission_request_digest != expected_permission
      {
        return Err(StorageError::Validation(
          "auto-pin target catalog diverged inside apply transaction".into(),
        ));
      }
      let live_manifest: PluginManifestV1 = serde_json::from_str(&live_version.manifest_json)
        .map_err(|e| StorageError::Validation(format!("invalid target manifest: {e}")))?;
      if live_manifest != target_manifest {
        return Err(StorageError::Validation(
          "auto-pin catalog manifest diverged inside apply transaction".into(),
        ));
      }
      let live_publisher = plugin_publishers::get(uow.conn(), &live_version.publisher_key_id)?;
      if live_publisher.public_key_hex != vendor_root.public_key_hex
        || live_publisher.key_id != vendor_root.key_id
        || live_publisher.fingerprint != target_manifest.publisher.key_fingerprint
        || live_publisher.source != crate::domain::plugin_package::PublisherSource::Vendor
        || live_publisher.revoked
        || !live_publisher.enabled
      {
        return Err(StorageError::Validation(
          "auto-pin publisher no longer reverse-binds the external vendor root".into(),
        ));
      }
      // Exact archive digest + content re-verify with external vendor root (not DB public key).
      let (final_verified, final_root) = self.plugin_packages.verify_store_with_vendor_root(&package_digest)?;
      if final_root.public_key_hex != vendor_root.public_key_hex
        || final_verified.package_digest != package_digest
        || final_verified.manifest_bytes != verified_snapshot.manifest_bytes
        || final_verified.manifest != target_manifest
      {
        return Err(StorageError::Conflict(
          "auto-pin store content diverged from verified snapshot at apply".into(),
        ));
      }
      revalidate_package_store_artifacts(&self.plugin_packages, &package_digest, &target_manifest)?;

      // After final re-validation and before grant/pin write: optional TOCTOU injection point.
      // Coordinated store mutations block on the held store lock; raw FS replacement fails the
      // post-hook re-verify / generation reverse-bind below (fail closed, no grant/pin).
      #[cfg(test)]
      if let Some(hook) = self.take_auto_pin_after_final_revalidate_hook() {
        hook();
      }

      // Fail closed if a coordinated mutation bumped generation while we held the lock incorrectly,
      // or if raw archive/content was replaced after the final re-validation above.
      if self.plugin_packages.store_generation() != generation_at_final_revalidate {
        return Err(StorageError::Conflict(
          "auto-pin package store generation changed after final re-validation; refusing pin".into(),
        ));
      }
      let (post_hook_verified, post_hook_root) = self.plugin_packages.verify_store_with_vendor_root(&package_digest)?;
      if post_hook_root.public_key_hex != vendor_root.public_key_hex
        || post_hook_verified.package_digest != package_digest
        || post_hook_verified.manifest_bytes != verified_snapshot.manifest_bytes
        || post_hook_verified.manifest != target_manifest
      {
        return Err(StorageError::Conflict(
          "auto-pin store content diverged after final re-validation before grant/pin".into(),
        ));
      }
      revalidate_package_store_artifacts(&self.plugin_packages, &package_digest, &target_manifest)?;

      if public_sha256_hex(migrated_config.as_bytes()) != migrated_config_digest {
        return Err(StorageError::Conflict("migrated config digest mismatch".into()));
      }

      verify_preference_cas(uow.conn(), &source_translation, instance_id)?;
      verify_preference_cas(uow.conn(), &source_ocr, instance_id)?;
      verify_preference_cas(uow.conn(), &source_speech, instance_id)?;
      let (live_translation, live_ocr, live_speech) = collect_preference_snapshots(uow.conn(), instance_id)?;
      assert_dependency_sets_bidirectional(&live_translation, &source_translation)?;
      assert_dependency_sets_bidirectional(&live_ocr, &source_ocr)?;
      assert_dependency_sets_bidirectional(&live_speech, &source_speech)?;

      // Snapshot holds pre-migration non-secret state only (bundled source has no grant).
      let snapshot = PluginUpgradeSnapshot {
        id: new_id(),
        integration_instance_id: instance_id,
        created_at: now.clone(),
        discarded_at: None,
        runtime_kind: current.runtime_kind.clone(),
        package_digest: current.package_digest.clone(),
        execution_grant_set_id: None,
        execution_grant_set_revision: current.execution_grant_set_revision,
        plugin_version: current.plugin_version.clone(),
        config_json: current.config_json.clone(),
        config_schema_version: current.config_schema_version,
        grant_snapshot_json: None,
        translation_preferences: source_translation.clone(),
        ocr_preferences: source_ocr.clone(),
        speech_preferences: source_speech.clone(),
      };
      plugin_upgrade_snapshots::insert(uow.conn(), &snapshot)?;
      prune_snapshots(uow.conn(), instance_id, &now)?;
      plugin_permission_grants::insert_bundle(uow.conn(), &grant_bundle)?;
      integration_endpoint_trusts::delete_for_instance(uow.conn(), instance_id)?;

      let requirement = build_runtime_requirement(&live_version, &target_manifest, target_schema)?;
      let requirement_json = serde_json::to_string(&requirement)?;
      integration_instances::compare_and_set_runtime_pin(
        uow.conn(),
        instance_id,
        &expected_updated_at,
        &target_plugin_version,
        &migrated_config,
        target_schema,
        runtime_kind_storage(RuntimeKind::WasmComponent),
        Some(&package_digest),
        Some(grant_bundle.header.revision),
        InstanceRuntimeState::Active.as_str(),
        None,
        None,
        Some(&requirement_json),
        &now,
      )?;
      write_preference_rows(
        uow.conn(),
        &migrated_translation,
        &migrated_ocr,
        &migrated_speech,
        &now,
        false,
        instance_id,
      )?;
      Ok(())
    })?;
    drop(_store_guard);
    self.evict_runtime_caches(instance_id, None, Some(package_digest.as_str()));
    Ok(())
  }

  fn source_capability_majors(&self, instance: &IntegrationInstance) -> Result<HashSet<String>, StorageError> {
    if let Some(digest) = instance.package_digest.as_deref() {
      // Source is pinned to a package: its installed version + manifest must be present so the
      // target can be proven to preserve every source capability major. A missing version row
      // means the pin cannot be audited - fail closed rather than offering a vacuous upgrade.
      return self.db.read(|conn| {
        let version = installed_plugin_versions::get_optional(conn, digest)?.ok_or_else(|| {
          StorageError::PluginUnavailable(
            "source package is pinned but its installed version is missing; cannot verify capability majors".into(),
          )
        })?;
        let manifest: PluginManifestV1 = serde_json::from_str(&version.manifest_json)
          .map_err(|e| StorageError::Validation(format!("invalid source manifest: {e}")))?;
        Ok(manifest.capabilities.into_iter().map(|c| c.id).collect::<HashSet<_>>())
      });
    }
    // Bundled-rust source: the host registry must define the plugin. A missing definition means
    // the bundled executor identity cannot be verified - fail closed rather than returning an
    // empty set that would let any target pass the capability-major check.
    let manifest = self.registry.get(&instance.plugin_id).ok_or_else(|| {
      StorageError::PluginUnavailable(
        "bundled plugin definition is missing from the registry; cannot verify capability majors".into(),
      )
    })?;
    Ok(manifest.capabilities.iter().map(|c| c.id.clone()).collect())
  }

  fn expire_previews(&self) {
    let now = Instant::now();
    self
      .upgrade_previews
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .retain(|_, session| session.expires_at > now);
    self
      .rollback_previews
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .retain(|_, session| session.expires_at > now);
  }

  /// Load migration artifact only after archive rehash + signed file-index path/role/length/SHA256 checks.
  fn load_verified_migration_component_bytes(
    &self,
    package_digest: &str,
    manifest: &PluginManifestV1,
  ) -> Result<Option<Vec<u8>>, StorageError> {
    const MIGRATION_PATH: &str = "artifacts/migration.wasm";
    let Some(file_entry) = manifest.files.iter().find(|f| f.path == MIGRATION_PATH) else {
      return Ok(None);
    };
    // Rehash retained package archive exact bytes (same helper path as RuntimeRouter).
    let package_path = self.plugin_packages.package_archive_path(package_digest);
    let archive_digest = crate::services::plugin_package::hash_file(&package_path)
      .map_err(|e| StorageError::PluginUnavailable(format!("failed to rehash package archive: {}", e.message)))?;
    if archive_digest != package_digest {
      return Err(StorageError::PluginUnavailable(
        "package archive digest mismatch before migration".into(),
      ));
    }
    let abs = self
      .plugin_packages
      .package_content_path(package_digest)
      .join(MIGRATION_PATH);
    if !abs.is_file() {
      return Err(StorageError::Validation(
        "migration component is listed in the signed index but missing on disk".into(),
      ));
    }
    let bytes = std::fs::read(&abs).map_err(|e| StorageError::Internal(e.to_string()))?;
    if bytes.len() as u64 != file_entry.bytes {
      return Err(StorageError::Validation(
        "migration component length does not match signed file index".into(),
      ));
    }
    let digest = public_sha256_hex(&bytes);
    if digest != file_entry.sha256 {
      return Err(StorageError::Validation(
        "migration component digest does not match signed file index".into(),
      ));
    }
    Ok(Some(bytes))
  }

  /// Resolve target config schema revision from the signed manifest declaration and validate schema files.
  /// Never forges revision from package semver major. Undeclared revision preserves `source_schema`.
  fn resolve_config_schema_version(
    &self,
    package_digest: &str,
    manifest: &PluginManifestV1,
    source_schema: u32,
  ) -> Result<u32, StorageError> {
    if let Some(rel) = manifest.configuration_schema.as_deref() {
      // Dialect validation only (PluginSchemaV1.version is always SCHEMA_VERSION_V1).
      let _ = load_and_validate_schema_file(&self.plugin_packages, package_digest, rel, manifest)?;
    }
    match manifest.config_schema_version {
      Some(v) if v >= 1 => Ok(v),
      Some(_) => Err(StorageError::Validation(
        "manifest config_schema_version must be >= 1".into(),
      )),
      // No declared revision: keep source so upgrades without schema metadata do not force v1.
      None => Ok(source_schema),
    }
  }

  fn run_target_migrations_from_rows(
    &self,
    source_config: &str,
    source_schema: u32,
    target_schema: u32,
    migration_bytes: Option<&[u8]>,
    translation: Vec<PreferenceSnapshotRow>,
    ocr: Vec<PreferenceSnapshotRow>,
    speech: Vec<PreferenceSnapshotRow>,
  ) -> Result<
    (
      String,
      Vec<PreferenceSnapshotRow>,
      Vec<PreferenceSnapshotRow>,
      Vec<PreferenceSnapshotRow>,
      Vec<SchemaMigrationDto>,
    ),
    StorageError,
  > {
    let mut schema_migrations = Vec::new();

    if source_schema == target_schema {
      schema_migrations.push(SchemaMigrationDto {
        kind: "config".into(),
        from_version: source_schema,
        to_version: target_schema,
        status: "unchanged".into(),
        detail: None,
      });
      return Ok((source_config.to_string(), translation, ocr, speech, schema_migrations));
    }

    let Some(bytes) = migration_bytes else {
      return Err(StorageError::Validation(format!(
        "config schema migration from {source_schema} to {target_schema} requires a migration component"
      )));
    };
    let runtime = self
      .wasm_runtime
      .as_ref()
      .ok_or_else(|| StorageError::Internal("wasm runtime is required for package migrations".into()))?;

    let migrated_config = block_on_migration(runtime.execute_migrate_config(
      bytes,
      source_schema,
      target_schema,
      source_config.as_bytes().to_vec(),
    ))?;
    let migrated_config = String::from_utf8(migrated_config)
      .map_err(|_| StorageError::Validation("migrated config is not utf-8".into()))?;
    schema_migrations.push(SchemaMigrationDto {
      kind: "config".into(),
      from_version: source_schema,
      to_version: target_schema,
      status: "migrated".into(),
      detail: None,
    });

    let translation = migrate_preference_rows(runtime, bytes, "translate.text@1", translation, target_schema)?;
    let ocr = migrate_preference_rows(runtime, bytes, "ocr.image@1", ocr, target_schema)?;
    let speech = migrate_preference_rows(runtime, bytes, "speech.synthesize@1", speech, target_schema)?;
    schema_migrations.push(SchemaMigrationDto {
      kind: "preferences".into(),
      from_version: source_schema,
      to_version: target_schema,
      status: "migrated".into(),
      detail: None,
    });
    Ok((migrated_config, translation, ocr, speech, schema_migrations))
  }
}

fn load_and_validate_schema_file(
  packages: &PluginPackageService,
  package_digest: &str,
  relative_path: &str,
  manifest: &PluginManifestV1,
) -> Result<crate::domain::plugin_schema::PluginSchemaV1, StorageError> {
  let file_entry = manifest.files.iter().find(|f| f.path == relative_path).ok_or_else(|| {
    StorageError::Validation(format!(
      "schema path {relative_path} is not present in the signed file index"
    ))
  })?;
  let abs = packages.package_content_path(package_digest).join(relative_path);
  let bytes = std::fs::read(&abs).map_err(|e| StorageError::Validation(format!("schema file missing: {e}")))?;
  if bytes.len() as u64 != file_entry.bytes {
    return Err(StorageError::Validation(
      "schema file length does not match signed file index".into(),
    ));
  }
  if public_sha256_hex(&bytes) != file_entry.sha256 {
    return Err(StorageError::Validation(
      "schema file digest does not match signed file index".into(),
    ));
  }
  let schema: crate::domain::plugin_schema::PluginSchemaV1 =
    serde_json::from_slice(&bytes).map_err(|e| StorageError::Validation(format!("invalid plugin schema JSON: {e}")))?;
  crate::services::plugin_schema::validate_schema(&schema)
    .map_err(|e| StorageError::Validation(format!("plugin schema validation failed: {e}")))?;
  Ok(schema)
}

fn revalidate_target_package_for_apply(
  conn: &rusqlite::Connection,
  package_digest: &str,
) -> Result<PluginManifestV1, StorageError> {
  let version = installed_plugin_versions::get(conn, package_digest)?;
  if !version.content_available {
    return Err(StorageError::PluginUnavailable(
      "target package content became unavailable after preview".into(),
    ));
  }
  let publisher = plugin_publishers::get(conn, &version.publisher_key_id)?;
  if publisher.revoked || !publisher.enabled {
    return Err(StorageError::Validation(
      "target package publisher is revoked or disabled".into(),
    ));
  }
  if publisher.fingerprint != version.publisher_fingerprint {
    return Err(StorageError::Validation(
      "target package publisher fingerprint mismatch".into(),
    ));
  }
  let manifest: PluginManifestV1 = serde_json::from_str(&version.manifest_json)
    .map_err(|e| StorageError::Validation(format!("invalid target manifest: {e}")))?;
  // Permission digest always recomputed and compared to catalog + must match for apply.
  let expected_permission = compute_permission_request_digest(&manifest);
  if version.permission_request_digest != expected_permission {
    return Err(StorageError::Validation(
      "target package permission request digest diverged from manifest; re-preview required".into(),
    ));
  }
  Ok(manifest)
}

fn revalidate_package_store_artifacts(
  packages: &PluginPackageService,
  package_digest: &str,
  manifest: &PluginManifestV1,
) -> Result<(), StorageError> {
  let archive = packages.package_archive_path(package_digest);
  let archive_digest = crate::services::plugin_package::hash_file(&archive)
    .map_err(|e| StorageError::PluginUnavailable(format!("failed to rehash package archive: {}", e.message)))?;
  if archive_digest != package_digest {
    return Err(StorageError::PluginUnavailable(
      "package archive digest mismatch at apply; re-preview required".into(),
    ));
  }
  if let Some(artifact_rel) = manifest.runtime.artifact.as_deref() {
    let entry = manifest
      .files
      .iter()
      .find(|f| f.path == artifact_rel && f.role == FileRole::RuntimeArtifact)
      .ok_or_else(|| StorageError::Validation("runtime artifact missing from signed index".into()))?;
    let abs = packages.package_content_path(package_digest).join(artifact_rel);
    let bytes = std::fs::read(&abs).map_err(|e| StorageError::PluginUnavailable(e.to_string()))?;
    if bytes.len() as u64 != entry.bytes || public_sha256_hex(&bytes) != entry.sha256 {
      return Err(StorageError::PluginUnavailable(
        "runtime artifact length/digest mismatch at apply; re-preview required".into(),
      ));
    }
  }
  Ok(())
}

/// Host-allowed vendor default policy for auto-pinning new instances. Only Google Web 1.0.0 GTX
/// (wasm-component runtime, vendor publisher, exactly GTX GET https://translate.google.com +
/// host.none.v1, no credential slots, no instance-configured origin) may be auto-acknowledged by
/// [`RuntimeLifecycleService::pin_default_package_for_new_instance`]. Any deviation fails closed
/// (returns false) so the instance stays Bundled Rust rather than auto-pinning an arbitrary
/// plugin, a higher/proxy version, or a static third-party origin.
///
/// The `verified` manifest comes from full package signature/index/artifact verification of the
/// exact retained archive against the external `vendor_root` (never DB `public_key_hex`, never the
/// catalog `manifest_json`). It is the source of truth and is reverse-bound with the installed
/// version row, publisher row, and the external vendor root: package digest, plugin id, version,
/// runtime kind, publisher key id, fingerprint, public key, source, enabled, and revoked must all
/// agree with the external root. Any catalog/manifest/publisher divergence fails closed.
fn is_google_web_gtx_vendor_default(
  version: &crate::domain::plugin_package::InstalledPluginVersion,
  verified: &VerifiedPackage,
  vendor_root: &crate::services::vendor_trust::VendorPublicKey,
  publisher: &crate::domain::plugin_package::PluginPublisher,
) -> bool {
  const GOOGLE_WEB_GTX_VERSION: &str = "1.0.0";
  const GTX_ENDPOINT_ID: &str = "gtx";
  const GTX_ORIGIN: &str = "https://translate.google.com";
  const HOST_NONE_AUTH_POLICY: &str = "host.none.v1";
  let manifest = &verified.manifest;
  // Cross-bind package digest: the verified archive digest must equal the catalog row digest.
  if verified.package_digest != version.package_digest {
    return false;
  }
  // Cross-bind plugin id: the verified manifest, installed version row, and host-allowed id must
  // all agree.
  if manifest.id != crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PLUGIN_ID
    || version.plugin_id != manifest.id
  {
    return false;
  }
  // Cross-bind version: the verified manifest version and the catalog version must agree and be
  // the host-allowed GTX version.
  if manifest.version != GOOGLE_WEB_GTX_VERSION || version.version != GOOGLE_WEB_GTX_VERSION {
    return false;
  }
  // Cross-bind runtime kind: the verified manifest runtime kind and the catalog runtime_kind
  // string must agree and be wasm-component.
  if manifest.runtime.kind != RuntimeKind::WasmComponent
    || version.runtime_kind != runtime_kind_storage(RuntimeKind::WasmComponent)
  {
    return false;
  }
  let vendor_key_id = crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
  // External trust root is authoritative. Verified snapshot, catalog version row, and DB
  // publisher row must reverse-bind that root (key id, fingerprint, public key). Matching a
  // forged DB public key alone is never sufficient. Any divergence fails closed.
  let vendor_fingerprint = manifest.publisher.key_fingerprint.as_str();
  if vendor_root.key_id != vendor_key_id
    || manifest.publisher.key_id != vendor_key_id
    || version.publisher_key_id != vendor_key_id
    || publisher.key_id != vendor_key_id
    || version.publisher_fingerprint != vendor_fingerprint
    || publisher.fingerprint != vendor_fingerprint
    || verified.publisher_fingerprint != vendor_fingerprint
    || verified.publisher_public_key_hex != vendor_root.public_key_hex
    || publisher.public_key_hex != vendor_root.public_key_hex
    || publisher.source != crate::domain::plugin_package::PublisherSource::Vendor
    || publisher.revoked
    || !publisher.enabled
  {
    return false;
  }
  if !manifest.credential_slots.is_empty() {
    return false;
  }
  if manifest.permissions.auth_policies != vec![HOST_NONE_AUTH_POLICY.to_string()] {
    return false;
  }
  if manifest.permissions.network.len() != 1 {
    return false;
  }
  let endpoint = &manifest.permissions.network[0];
  endpoint.id == GTX_ENDPOINT_ID
    && endpoint.origins == vec![GTX_ORIGIN.to_string()]
    && endpoint.methods == vec![crate::domain::runtime_plugin::HttpMethod::Get]
    && endpoint.instance_origin_config_field.is_none()
}

/// Verify a verified package matches the host-allowed Edge TTS vendor default. Mirrors
/// [`is_google_web_gtx_vendor_default`] but with Edge constraints: the `tts-api` endpoint uses an
/// instance-configured origin (`base-url` config field) instead of a host-fixed origin. Auto-pin is
/// safe because the migrated config resolves to the vendor-default origin
/// (`https://tts.wangwangit.com`); a non-default base URL requires explicit migration consent.
fn is_edge_tts_vendor_default(
  version: &crate::domain::plugin_package::InstalledPluginVersion,
  verified: &VerifiedPackage,
  vendor_root: &crate::services::vendor_trust::VendorPublicKey,
  publisher: &crate::domain::plugin_package::PluginPublisher,
) -> bool {
  const EDGE_TTS_VERSION: &str = "1.0.0";
  const TTS_ENDPOINT_ID: &str = "tts-api";
  const TTS_CONFIG_FIELD: &str = "base-url";
  const HOST_NONE_AUTH_POLICY: &str = "host.none.v1";
  let manifest = &verified.manifest;
  if verified.package_digest != version.package_digest {
    return false;
  }
  if manifest.id != crate::domain::service_integration::EDGE_TTS_PLUGIN_ID || version.plugin_id != manifest.id {
    return false;
  }
  if manifest.version != EDGE_TTS_VERSION || version.version != EDGE_TTS_VERSION {
    return false;
  }
  if manifest.runtime.kind != RuntimeKind::WasmComponent
    || version.runtime_kind != runtime_kind_storage(RuntimeKind::WasmComponent)
  {
    return false;
  }
  let vendor_key_id = crate::services::vendor_trust::VENDOR_PUBLISHER_KEY_ID;
  let vendor_fingerprint = manifest.publisher.key_fingerprint.as_str();
  if vendor_root.key_id != vendor_key_id
    || manifest.publisher.key_id != vendor_key_id
    || version.publisher_key_id != vendor_key_id
    || publisher.key_id != vendor_key_id
    || version.publisher_fingerprint != vendor_fingerprint
    || publisher.fingerprint != vendor_fingerprint
    || verified.publisher_fingerprint != vendor_fingerprint
    || verified.publisher_public_key_hex != vendor_root.public_key_hex
    || publisher.public_key_hex != vendor_root.public_key_hex
    || publisher.source != crate::domain::plugin_package::PublisherSource::Vendor
    || publisher.revoked
    || !publisher.enabled
  {
    return false;
  }
  if !manifest.credential_slots.is_empty() {
    return false;
  }
  if manifest.permissions.auth_policies != vec![HOST_NONE_AUTH_POLICY.to_string()] {
    return false;
  }
  if manifest.permissions.network.len() != 1 {
    return false;
  }
  let endpoint = &manifest.permissions.network[0];
  // Edge TTS uses an instance-configured origin (base-url), not a host-fixed origin. Static
  // origins must be empty; the effective origin is resolved from the config field at grant time.
  endpoint.id == TTS_ENDPOINT_ID
    && endpoint.origins.is_empty()
    && endpoint.methods == vec![crate::domain::runtime_plugin::HttpMethod::Post]
    && endpoint.instance_origin_config_field.as_deref() == Some(TTS_CONFIG_FIELD)
    && manifest
      .capabilities
      .iter()
      .any(|cap| cap.id == "speech.synthesize@1" && cap.preferences_schema.is_some())
}

/// Edge TTS vendor-default effective complete Base URL. Auto-pin is only safe when the
/// instance's migrated `base-url` resolves to exactly this canonical URL; a custom path or
/// origin requires explicit migration consent and must not be host-auto-approved.
const EDGE_TTS_VENDOR_DEFAULT_ORIGIN: &str = crate::domain::service_integration::EDGE_TTS_DEFAULT_BASE_URL;

/// True when the migrated Edge TTS config resolves to the vendor-default complete Base URL.
/// Extracts the `base-url` config field, normalizes it through the shared Edge TTS normalizer,
/// and compares the full canonical URL. A custom path/origin, missing field, or malformed/
/// non-HTTPS base URL returns false so auto-pin fails closed and the instance requires explicit
/// migration consent. This complements the manifest-structural [`is_edge_tts_vendor_default`]
/// check by validating the EFFECTIVE URL/config, not just the manifest endpoint shape.
fn edge_tts_effective_origin_is_vendor_default(migrated_config: &str) -> bool {
  let Ok(value) = serde_json::from_str::<serde_json::Value>(migrated_config) else {
    return false;
  };
  let Some(raw) = value.get("base-url").and_then(|v| v.as_str()) else {
    return false;
  };
  let Ok(normalized) = crate::services::edge_tts::normalize_edge_tts_base_url(raw) else {
    return false;
  };
  normalized.canonical_url == EDGE_TTS_VENDOR_DEFAULT_ORIGIN
}

/// True when the verified package matches either host-allowed vendor default (Google Web GTX or
/// Edge TTS). Auto-pin is restricted to these two vendor defaults; all other packages require
/// explicit migration with a consent warning.
fn is_host_allowed_vendor_default(
  version: &crate::domain::plugin_package::InstalledPluginVersion,
  verified: &VerifiedPackage,
  vendor_root: &crate::services::vendor_trust::VendorPublicKey,
  publisher: &crate::domain::plugin_package::PluginPublisher,
) -> bool {
  is_google_web_gtx_vendor_default(version, verified, vendor_root, publisher)
    || is_edge_tts_vendor_default(version, verified, vendor_root, publisher)
}

/// Validate migrated payloads against signed schemas and return normalized prepared payloads.
/// Always run real `normalize_config` for declared schemas (empty and non-empty fields).
/// Preference rows are validated against the exact bound capability id schema — never a prefix match.
fn validate_and_normalize_migrated_payloads(
  packages: &PluginPackageService,
  package_digest: &str,
  manifest: &PluginManifestV1,
  migrated_config: &str,
  translation: Vec<PreferenceSnapshotRow>,
  ocr: Vec<PreferenceSnapshotRow>,
  speech: Vec<PreferenceSnapshotRow>,
) -> Result<
  (
    String,
    Vec<PreferenceSnapshotRow>,
    Vec<PreferenceSnapshotRow>,
    Vec<PreferenceSnapshotRow>,
  ),
  StorageError,
> {
  use crate::domain::language_detection::supported_languages;
  use crate::services::plugin_schema::{HostOptionResolver, normalize_config};
  let host = HostOptionResolver::supported_languages(supported_languages().iter().map(|s| s.to_string()));

  let config_out = if let Some(rel) = manifest.configuration_schema.as_deref() {
    let schema = load_and_validate_schema_file(packages, package_digest, rel, manifest)?;
    let value: serde_json::Value = serde_json::from_str(migrated_config)
      .map_err(|e| StorageError::Validation(format!("migrated config is not valid JSON: {e}")))?;
    if !value.is_object() {
      return Err(StorageError::Validation("migrated config must be a JSON object".into()));
    }
    // Empty-field schemas still go through normalize_config (unknown keys fail closed).
    let normalized = normalize_config(&schema, &value, &host)
      .map_err(|e| StorageError::Validation(format!("migrated config failed schema validation: {e}")))?;
    serde_json::to_string(&normalized)
      .map_err(|e| StorageError::Validation(format!("failed to serialize normalized config: {e}")))?
  } else {
    migrated_config.to_string()
  };

  let normalize_rows = |rows: Vec<PreferenceSnapshotRow>| -> Result<Vec<PreferenceSnapshotRow>, StorageError> {
    let mut out = Vec::with_capacity(rows.len());
    for mut row in rows {
      if row.capability_id.trim().is_empty() {
        return Err(StorageError::Validation(format!(
          "{} preference row is missing bound capability id",
          row.kind
        )));
      }
      let cap = manifest
        .capabilities
        .iter()
        .find(|c| c.id == row.capability_id)
        .ok_or_else(|| {
          StorageError::Validation(format!(
            "{} preferences bound to unknown capability {}",
            row.kind, row.capability_id
          ))
        })?;
      let Some(rel) = cap.preferences_schema.as_deref() else {
        return Err(StorageError::Validation(format!(
          "capability {} has no preferences schema for {} preferences",
          cap.id, row.kind
        )));
      };
      let schema = load_and_validate_schema_file(packages, package_digest, rel, manifest)?;
      let value: serde_json::Value = serde_json::from_str(&row.preferences_json)
        .map_err(|e| StorageError::Validation(format!("{} preferences are not valid JSON: {e}", row.kind)))?;
      if !value.is_object() {
        return Err(StorageError::Validation(format!(
          "{} preferences must be a JSON object",
          row.kind
        )));
      }
      let normalized = normalize_config(&schema, &value, &host).map_err(|e| {
        StorageError::Validation(format!(
          "{} preferences failed schema validation for {}: {e}",
          row.kind, cap.id
        ))
      })?;
      row.preferences_json = serde_json::to_string(&normalized)
        .map_err(|e| StorageError::Validation(format!("failed to serialize normalized preferences: {e}")))?;
      out.push(row);
    }
    Ok(out)
  };

  let translation = normalize_rows(translation)?;
  let ocr = normalize_rows(ocr)?;
  let speech = normalize_rows(speech)?;
  Ok((config_out, translation, ocr, speech))
}

fn block_on_migration(
  fut: impl std::future::Future<Output = Result<Vec<u8>, crate::domain::service_capability::CapabilityError>>,
) -> Result<Vec<u8>, StorageError> {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .map_err(|e| StorageError::Internal(e.to_string()))?
    .block_on(fut)
    .map_err(|e| StorageError::Validation(format!("migration failed: {}", e.message)))
}

fn migrate_preference_rows(
  runtime: &crate::services::wasm_runtime::WasmRuntime,
  migration_bytes: &[u8],
  fallback_capability: &str,
  rows: Vec<PreferenceSnapshotRow>,
  target_schema: u32,
) -> Result<Vec<PreferenceSnapshotRow>, StorageError> {
  let mut out = Vec::with_capacity(rows.len());
  for row in rows {
    let capability = if row.capability_id.trim().is_empty() {
      fallback_capability
    } else {
      row.capability_id.as_str()
    };
    let migrated = block_on_migration(runtime.execute_migrate_preferences(
      migration_bytes,
      capability,
      row.schema_version as u32,
      target_schema,
      row.preferences_json.into_bytes(),
    ))?;
    let preferences_json =
      String::from_utf8(migrated).map_err(|_| StorageError::Validation("migrated preferences are not utf-8".into()))?;
    out.push(PreferenceSnapshotRow {
      kind: row.kind,
      id: row.id,
      integration_instance_id: row.integration_instance_id,
      capability_id: if row.capability_id.trim().is_empty() {
        fallback_capability.to_string()
      } else {
        row.capability_id
      },
      schema_version: target_schema as i32,
      preferences_json,
      updated_at: row.updated_at,
    });
  }
  Ok(out)
}

fn identity_dto_from_instance(instance: &IntegrationInstance) -> RuntimeIdentityDto {
  RuntimeIdentityDto {
    runtime_kind: instance.runtime_kind.clone(),
    package_digest: instance.package_digest.clone(),
    execution_grant_set_revision: instance.execution_grant_set_revision,
    runtime_state: InstanceRuntimeState::parse(&instance.runtime_state).unwrap_or(InstanceRuntimeState::Unavailable),
    runtime_error_code: instance.runtime_error_code.clone(),
    runtime_error_message: instance.runtime_error_message.clone(),
  }
}

fn collect_preference_snapshots(
  conn: &rusqlite::Connection,
  instance_id: Uuid,
) -> Result<
  (
    Vec<PreferenceSnapshotRow>,
    Vec<PreferenceSnapshotRow>,
    Vec<PreferenceSnapshotRow>,
  ),
  StorageError,
> {
  // Byte-exact: read SQLite TEXT payloads without Value parse/re-serialize.
  let mut translation = Vec::new();
  {
    let mut stmt = conn.prepare(
      "SELECT id, integration_instance_id, translate_capability_id, capability_preferences_version, capability_preferences_json, updated_at
       FROM translation_profiles
       WHERE integration_instance_id = ?1
         AND engine_kind = 'plugin_capability'
         AND capability_preferences_json IS NOT NULL
       ORDER BY id ASC",
    )?;
    let rows = stmt
      .query_map(rusqlite::params![instance_id.to_string()], |row| {
        let id: String = row.get(0)?;
        let owner: String = row.get(1)?;
        let capability_id: String = row.get(2)?;
        let version: i32 = row.get(3)?;
        let prefs: String = row.get(4)?;
        let updated_at: String = row.get(5)?;
        Ok((id, owner, capability_id, version, prefs, updated_at))
      })?
      .collect::<Result<Vec<_>, _>>()?;
    for (id, owner, capability_id, version, prefs, updated_at) in rows {
      translation.push(PreferenceSnapshotRow {
        kind: "translation_profile".into(),
        id: Uuid::parse_str(&id).map_err(|e| StorageError::Internal(e.to_string()))?,
        integration_instance_id: Uuid::parse_str(&owner).map_err(|e| StorageError::Internal(e.to_string()))?,
        capability_id,
        schema_version: version,
        preferences_json: prefs,
        updated_at,
      });
    }
  }
  let mut ocr = Vec::new();
  {
    let mut stmt = conn.prepare(
      "SELECT id, integration_instance_id, ocr_capability_id, capability_preferences_version, capability_preferences_json, updated_at
       FROM ocr_services
       WHERE integration_instance_id = ?1
         AND capability_preferences_json IS NOT NULL
         AND capability_preferences_version IS NOT NULL
       ORDER BY id ASC",
    )?;
    let rows = stmt
      .query_map(rusqlite::params![instance_id.to_string()], |row| {
        let id: String = row.get(0)?;
        let owner: String = row.get(1)?;
        let capability_id: Option<String> = row.get(2)?;
        let version: i32 = row.get(3)?;
        let prefs: String = row.get(4)?;
        let updated_at: String = row.get(5)?;
        Ok((id, owner, capability_id, version, prefs, updated_at))
      })?
      .collect::<Result<Vec<_>, _>>()?;
    for (id, owner, capability_id, version, prefs, updated_at) in rows {
      let capability_id = capability_id
        .ok_or_else(|| StorageError::Validation(format!("ocr service {id} is missing ocr_capability_id")))?;
      ocr.push(PreferenceSnapshotRow {
        kind: "ocr_service".into(),
        id: Uuid::parse_str(&id).map_err(|e| StorageError::Internal(e.to_string()))?,
        integration_instance_id: Uuid::parse_str(&owner).map_err(|e| StorageError::Internal(e.to_string()))?,
        capability_id,
        schema_version: version,
        preferences_json: prefs,
        updated_at,
      });
    }
  }
  let mut speech = Vec::new();
  {
    let mut stmt = conn.prepare(
      "SELECT id, integration_instance_id, capability_id, preferences_schema_version, preferences_json, updated_at
       FROM speech_services
       WHERE integration_instance_id = ?1
       ORDER BY id ASC",
    )?;
    let rows = stmt
      .query_map(rusqlite::params![instance_id.to_string()], |row| {
        let id: String = row.get(0)?;
        let owner: String = row.get(1)?;
        let capability_id: String = row.get(2)?;
        let version: i32 = row.get(3)?;
        let prefs: String = row.get(4)?;
        let updated_at: String = row.get(5)?;
        Ok((id, owner, capability_id, version, prefs, updated_at))
      })?
      .collect::<Result<Vec<_>, _>>()?;
    for (id, owner, capability_id, version, prefs, updated_at) in rows {
      speech.push(PreferenceSnapshotRow {
        kind: "speech_service".into(),
        id: Uuid::parse_str(&id).map_err(|e| StorageError::Internal(e.to_string()))?,
        integration_instance_id: Uuid::parse_str(&owner).map_err(|e| StorageError::Internal(e.to_string()))?,
        capability_id,
        schema_version: version,
        preferences_json: prefs,
        updated_at,
      });
    }
  }
  Ok((translation, ocr, speech))
}

fn verify_preference_cas(
  conn: &rusqlite::Connection,
  rows: &[PreferenceSnapshotRow],
  expected_instance_id: Uuid,
) -> Result<(), StorageError> {
  for row in rows {
    if row.integration_instance_id != expected_instance_id {
      return Err(StorageError::Conflict(format!(
        "{} {} is not owned by the target instance",
        row.kind, row.id
      )));
    }
    match row.kind.as_str() {
      "translation_profile" => {
        let (owner, updated_at): (String, String) = conn
          .query_row(
            "SELECT integration_instance_id, updated_at FROM translation_profiles WHERE id = ?1",
            rusqlite::params![row.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
          )
          .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
              StorageError::Conflict(format!("translation profile {} is missing at apply", row.id))
            }
            other => StorageError::from(other),
          })?;
        let owner = Uuid::parse_str(&owner).map_err(|e| StorageError::Internal(e.to_string()))?;
        if owner != expected_instance_id {
          return Err(StorageError::Conflict(format!(
            "translation profile {} ownership changed",
            row.id
          )));
        }
        if updated_at != row.updated_at {
          return Err(StorageError::Conflict(format!(
            "translation profile {} changed concurrently",
            row.id
          )));
        }
      }
      "ocr_service" => {
        let (owner, updated_at): (Option<String>, String) = conn
          .query_row(
            "SELECT integration_instance_id, updated_at FROM ocr_services WHERE id = ?1",
            rusqlite::params![row.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
          )
          .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
              StorageError::Conflict(format!("ocr service {} is missing at apply", row.id))
            }
            other => StorageError::from(other),
          })?;
        let owner = owner
          .as_deref()
          .map(Uuid::parse_str)
          .transpose()
          .map_err(|e| StorageError::Internal(e.to_string()))?;
        if owner != Some(expected_instance_id) {
          return Err(StorageError::Conflict(format!(
            "ocr service {} ownership changed",
            row.id
          )));
        }
        if updated_at != row.updated_at {
          return Err(StorageError::Conflict(format!(
            "ocr service {} changed concurrently",
            row.id
          )));
        }
      }
      "speech_service" => {
        let (owner, updated_at): (String, String) = conn
          .query_row(
            "SELECT integration_instance_id, updated_at FROM speech_services WHERE id = ?1",
            rusqlite::params![row.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
          )
          .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
              StorageError::Conflict(format!("speech service {} is missing at apply", row.id))
            }
            other => StorageError::from(other),
          })?;
        let owner = Uuid::parse_str(&owner).map_err(|e| StorageError::Internal(e.to_string()))?;
        if owner != expected_instance_id {
          return Err(StorageError::Conflict(format!(
            "speech service {} ownership changed",
            row.id
          )));
        }
        if updated_at != row.updated_at {
          return Err(StorageError::Conflict(format!(
            "speech service {} changed concurrently",
            row.id
          )));
        }
      }
      other => {
        return Err(StorageError::Validation(format!(
          "unknown preference snapshot kind: {other}"
        )));
      }
    }
  }
  Ok(())
}

/// Assign strict transport provenance from a verified package manifest. Only the host-maintained
/// Google Web GTX tuple can use OS/TUN DNS; every user/instance-configured endpoint stays strict.
pub(crate) fn origin_kind_for_verified_network_endpoint(
  manifest: &PluginManifestV1,
  endpoint: &NetworkEndpointRequest,
) -> NetworkOriginKind {
  origin_kind_for_verified_network_endpoint_with_approval(manifest, endpoint, false)
}

pub(crate) fn origin_kind_for_verified_network_endpoint_with_approval(
  manifest: &PluginManifestV1,
  endpoint: &NetworkEndpointRequest,
  current_approval: bool,
) -> NetworkOriginKind {
  const GOOGLE_WEB_GTX_ENDPOINT_ID: &str = "gtx";

  if current_approval
    && manifest.id == crate::domain::service_integration::EDGE_TTS_PLUGIN_ID
    && endpoint.id == EDGE_TTS_TRUST_ENDPOINT_ALIAS
    && endpoint.instance_origin_config_field.as_deref() == Some("base-url")
  {
    return NetworkOriginKind::UserApprovedInstance;
  }
  if endpoint.instance_origin_config_field.is_some() {
    return NetworkOriginKind::InstanceConfigured;
  }
  let is_google_web_gtx = manifest.id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID
    && endpoint.id == GOOGLE_WEB_GTX_ENDPOINT_ID
    && endpoint.origins.len() == 1
    && endpoint
      .origins
      .first()
      .is_some_and(|origin| origin == GOOGLE_TRANSLATE_WEB_GTX_ORIGIN);
  if is_google_web_gtx {
    NetworkOriginKind::HostFixed
  } else {
    NetworkOriginKind::InstanceConfigured
  }
}

fn build_grant_bundle_for_target(
  db: &Database,
  packages: &PluginPackageService,
  instance: &IntegrationInstance,
  target_config_json: &str,
  target_version: &crate::domain::plugin_package::InstalledPluginVersion,
  target_manifest: &PluginManifestV1,
  source_grant: Option<&ExecutionGrantSetBundle>,
) -> Result<ExecutionGrantSetBundle, StorageError> {
  db.read(|conn| {
    build_grant_bundle_for_target_on_conn(
      conn,
      packages,
      instance,
      target_config_json,
      target_version,
      target_manifest,
      source_grant,
    )
  })
}

fn build_grant_bundle_for_target_on_conn(
  conn: &rusqlite::Connection,
  packages: &PluginPackageService,
  instance: &IntegrationInstance,
  target_config_json: &str,
  target_version: &crate::domain::plugin_package::InstalledPluginVersion,
  target_manifest: &PluginManifestV1,
  source_grant: Option<&ExecutionGrantSetBundle>,
) -> Result<ExecutionGrantSetBundle, StorageError> {
  if let Some(source) = source_grant {
    if source.header.subject_id != instance.id {
      return Err(StorageError::Validation(
        "source grant set is bound to a different instance".into(),
      ));
    }
  }

  let revision = plugin_permission_grants::next_revision_for_subject_package(
    conn,
    GrantSubjectKind::IntegrationInstance,
    instance.id,
    &target_version.package_digest,
  )?;
  let _ = GrantSetRevision::new(revision).map_err(StorageError::Validation)?;
  let grant_id = new_id();
  let now = now_rfc3339();

  let mut capabilities = Vec::new();
  let mut domain_caps = Vec::new();
  for cap in &target_manifest.capabilities {
    let capability_id = CapabilityId::parse(&cap.id).map_err(|e| StorageError::Validation(format!("{e:?}")))?;
    domain_caps.push(capability_id.clone());
    capabilities.push(CapabilityGrantEntryRecord {
      id: new_id(),
      grant_set_id: grant_id,
      capability_id: capability_id.as_str().to_string(),
    });
  }

  let auth_policies = if target_manifest.permissions.auth_policies.is_empty() {
    vec!["host.none.v1".to_string()]
  } else {
    target_manifest.permissions.auth_policies.clone()
  };

  let mut network = Vec::new();
  let mut domain_net = Vec::new();
  // Resolve instance-configured endpoint origins from the normalized target config so signed
  // schema defaults participate in permission preview. A dynamic field hidden by its schema
  // visibility condition is inactive and receives no grant.
  let target_config_value: serde_json::Value = serde_json::from_str(target_config_json)
    .map_err(|e| StorageError::Validation(format!("target config is not valid JSON: {e}")))?;
  let target_configuration_fingerprint =
    configuration_fingerprint(target_config_json).map_err(StorageError::Validation)?;
  let target_runtime_identity_fingerprint = runtime_identity_fingerprint(RuntimeIdentityFingerprintInput {
    plugin_id: &target_version.plugin_id,
    plugin_version: &target_version.version,
    runtime_kind: runtime_kind_storage(RuntimeKind::WasmComponent),
    package_digest: Some(&target_version.package_digest),
  });
  let target_config_schema = if target_manifest
    .permissions
    .network
    .iter()
    .any(|endpoint| endpoint.instance_origin_config_field.is_some())
  {
    let schema_path = target_manifest.configuration_schema.as_deref().ok_or_else(|| {
      StorageError::Validation("instance-configured network origin requires a configuration schema".into())
    })?;
    Some(load_and_validate_schema_file(
      packages,
      &target_version.package_digest,
      schema_path,
      target_manifest,
    )?)
  } else {
    None
  };
  for cap in &target_manifest.capabilities {
    let capability_id = CapabilityId::parse(&cap.id).map_err(|e| StorageError::Validation(format!("{e:?}")))?;
    for endpoint in &target_manifest.permissions.network {
      let endpoint_id = EndpointId::parse(&endpoint.id).map_err(StorageError::Validation)?;
      // Effective origins: static declared origins, or the instance-configured complete base URL
      // resolved from the named config field and normalized by the shared host normalizer.
      let effective_origins: Vec<(String, String)> = if let Some(field) = &endpoint.instance_origin_config_field {
        let schema_field = target_config_schema
          .as_ref()
          .and_then(|schema| schema.fields.iter().find(|candidate| candidate.id == *field))
          .ok_or_else(|| {
            StorageError::Validation(format!(
              "network endpoint {} references unknown config field {field}",
              endpoint.id
            ))
          })?;
        if schema_field
          .visible_when
          .as_ref()
          .is_some_and(|condition| target_config_value.get(&condition.field) != Some(&condition.equals))
        {
          continue;
        }
        let raw = target_config_value
          .get(field)
          .and_then(serde_json::Value::as_str)
          .unwrap_or("");
        if raw.trim().is_empty() {
          return Err(StorageError::Validation(format!(
            "network endpoint {} requires config field {field}",
            endpoint.id
          )));
        }
        let (origin, base_url) = if field == "base-url" {
          let normalized =
            crate::services::edge_tts::normalize_edge_tts_base_url(raw).map_err(StorageError::Validation)?;
          let origin = url::Url::parse(&normalized.canonical_url)
            .map_err(|e| StorageError::Validation(format!("invalid edge tts base URL: {e}")))?
            .origin()
            .ascii_serialization();
          (origin, normalized.canonical_url)
        } else {
          let normalized =
            crate::services::google_translate_web::normalize_proxy_url(raw).map_err(StorageError::Validation)?;
          (normalized.origin.clone(), normalized.origin)
        };
        vec![(origin, base_url)]
      } else {
        endpoint
          .origins
          .iter()
          .cloned()
          .map(|origin| (origin.clone(), origin))
          .collect()
      };
      for (origin_value, base_url) in &effective_origins {
        let origin = HttpsOrigin::parse(origin_value).map_err(StorageError::Validation)?;
        let current_approval = if target_manifest.id == crate::domain::service_integration::EDGE_TTS_PLUGIN_ID
          && endpoint.id == EDGE_TTS_TRUST_ENDPOINT_ALIAS
          && endpoint.instance_origin_config_field.as_deref() == Some("base-url")
          && base_url.as_str() != crate::domain::service_integration::EDGE_TTS_DEFAULT_BASE_URL
        {
          integration_endpoint_trusts::get_exact(
            conn,
            instance.id,
            &target_version.plugin_id,
            &target_version.version,
            EDGE_TTS_TRUST_ENDPOINT_ALIAS,
            base_url,
            &target_configuration_fingerprint,
            &target_runtime_identity_fingerprint,
          )?
          .is_some()
        } else {
          false
        };
        let origin_kind =
          origin_kind_for_verified_network_endpoint_with_approval(target_manifest, endpoint, current_approval);
        for method in &endpoint.methods {
          for policy in &auth_policies {
            let auth = AuthPolicyId::parse(policy).map_err(StorageError::Validation)?;
            let (max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms, response_modes) =
              if capability_id.as_str() == "speech.synthesize@1" {
                (
                  RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
                  crate::domain::service_capability::SPEECH_AUDIO_MAX_BYTES as u64,
                  RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
                  60_000u64,
                  crate::domain::plugin_resource::NetworkResponseBodyModes::JSON_AND_BYTES,
                )
              } else {
                (
                  RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
                  RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
                  RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
                  RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
                  crate::domain::plugin_resource::NetworkResponseBodyModes::JSON_ONLY,
                )
              };
            let limits = ResourceLimits::new(max_request_bytes, max_response_bytes, max_stream_bytes, timeout_ms)
              .map_err(|e| StorageError::Validation(e.to_string()))?;
            domain_net.push(NetworkGrantEntry::with_mode_origin_and_response_modes_and_base_url(
              capability_id.clone(),
              endpoint_id.clone(),
              origin.clone(),
              origin_kind,
              base_url.clone(),
              *method,
              auth.clone(),
              NetworkResourceMode::Bounded,
              limits,
              response_modes,
            ));
            network.push(NetworkGrantEntryRecord {
              id: new_id(),
              grant_set_id: grant_id,
              capability_id: capability_id.as_str().to_string(),
              endpoint_id: endpoint_id.as_str().to_string(),
              origin: origin.as_str().to_string(),
              base_url: base_url.clone(),
              origin_kind: origin_kind.as_str().into(),
              method: http_method_as_str(*method).into(),
              auth_policy: auth.as_str().to_string(),
              resource_mode: NetworkResourceMode::Bounded.as_str().into(),
              max_request_bytes,
              max_response_bytes,
              max_stream_bytes,
              timeout_ms,
              // Persisted string only at the repository boundary; typed mode is the source of truth.
              response_body_modes: response_modes.as_canonical(),
            });
          }
        }
      }
    }
  }

  // Pages remain empty until Phase 9 explicit approval, but digest includes page delegation fields.
  let pages: Vec<PageGrantEntryRecord> = Vec::new();
  let domain_pages: Vec<PageGrantEntry> = Vec::new();

  let identity = RuntimeIdentity::Package(PackageIdentity {
    package_digest: PackageDigest::parse(&target_version.package_digest).map_err(StorageError::Validation)?,
  });
  let validated = if revision == 1 {
    ExecutionGrantSet::initial(
      instance.id,
      identity,
      PluginId::parse(&target_version.plugin_id).map_err(StorageError::Validation)?,
      SemVerVersion::parse(&target_version.version).map_err(StorageError::Validation)?,
      domain_caps.clone(),
      domain_net.clone(),
      domain_pages.clone(),
    )
    .map_err(|e| StorageError::Validation(e.to_string()))?
  } else {
    let base = ExecutionGrantSet::initial(
      instance.id,
      identity.clone(),
      PluginId::parse(&target_version.plugin_id).map_err(StorageError::Validation)?,
      SemVerVersion::parse(&target_version.version).map_err(StorageError::Validation)?,
      domain_caps.clone(),
      domain_net.clone(),
      domain_pages.clone(),
    )
    .map_err(|e| StorageError::Validation(e.to_string()))?;
    let authority = base.authority_digest().clone();
    ExecutionGrantSet::restore_validated(
      instance.id,
      identity,
      PluginId::parse(&target_version.plugin_id).map_err(StorageError::Validation)?,
      SemVerVersion::parse(&target_version.version).map_err(StorageError::Validation)?,
      GrantSetRevision::new(revision).map_err(StorageError::Validation)?,
      domain_caps.clone(),
      domain_net.clone(),
      domain_pages,
      authority,
    )
    .map_err(|e| StorageError::Validation(e.to_string()))?
  };
  let authority_digest = validated.authority_digest().as_str().to_string();
  let _ = parse_http_method;

  let permission_request_digest = if target_version.permission_request_digest.is_empty() {
    compute_permission_request_digest(target_manifest)
  } else {
    target_version.permission_request_digest.clone()
  };

  Ok(ExecutionGrantSetBundle {
    header: ExecutionGrantSetRecord {
      id: grant_id,
      revision,
      subject_kind: GrantSubjectKind::IntegrationInstance,
      subject_id: instance.id,
      plugin_id: target_version.plugin_id.clone(),
      plugin_version: target_version.version.clone(),
      package_digest: target_version.package_digest.clone(),
      permission_request_digest,
      authority_digest,
      approved_at: now,
    },
    capabilities,
    network,
    pages,
  })
}

fn diff_permissions(
  source: Option<&ExecutionGrantSetBundle>,
  target: &PluginManifestV1,
  target_grant: &ExecutionGrantSetBundle,
  source_digest: &str,
  target_digest: &str,
) -> Vec<PermissionDifferenceDto> {
  let mut diffs = Vec::new();
  if source_digest != target_digest {
    diffs.push(PermissionDifferenceDto {
      kind: "permission_request_digest".into(),
      summary: "requested permission set changed".into(),
      resource: None,
      origin: None,
      method: None,
      auth_policy: None,
    });
  }
  let source_caps: HashSet<String> = source
    .map(|g| g.capabilities.iter().map(|c| c.capability_id.clone()).collect())
    .unwrap_or_default();
  let target_caps: HashSet<String> = target.capabilities.iter().map(|c| c.id.clone()).collect();
  for added in target_caps.difference(&source_caps) {
    diffs.push(PermissionDifferenceDto {
      kind: "capability_added".into(),
      summary: format!("capability {added} added"),
      resource: Some(added.clone()),
      origin: None,
      method: None,
      auth_policy: None,
    });
  }
  for removed in source_caps.difference(&target_caps) {
    diffs.push(PermissionDifferenceDto {
      kind: "capability_removed".into(),
      summary: format!("capability {removed} removed"),
      resource: Some(removed.clone()),
      origin: None,
      method: None,
      auth_policy: None,
    });
  }
  let source_endpoints: HashSet<(String, String, String, String)> = source
    .map(|g| {
      g.network
        .iter()
        .map(|n| {
          (
            n.endpoint_id.clone(),
            if n.base_url.is_empty() {
              n.origin.clone()
            } else {
              n.base_url.clone()
            },
            n.method.clone(),
            n.auth_policy.clone(),
          )
        })
        .collect()
    })
    .unwrap_or_default();
  let target_endpoints: HashSet<(String, String, String, String)> = target_grant
    .network
    .iter()
    .map(|n| {
      (
        n.endpoint_id.clone(),
        if n.base_url.is_empty() {
          n.origin.clone()
        } else {
          n.base_url.clone()
        },
        n.method.clone(),
        n.auth_policy.clone(),
      )
    })
    .collect();
  for added in target_endpoints.difference(&source_endpoints) {
    diffs.push(PermissionDifferenceDto {
      kind: "network_endpoint_added".into(),
      summary: format!("network {} {} {} {}", added.0, added.1, added.2, added.3),
      resource: Some(added.0.clone()),
      origin: Some(added.1.clone()),
      method: Some(added.2.clone()),
      auth_policy: Some(added.3.clone()),
    });
  }
  for removed in source_endpoints.difference(&target_endpoints) {
    diffs.push(PermissionDifferenceDto {
      kind: "network_endpoint_removed".into(),
      summary: format!("network {} {} {} {}", removed.0, removed.1, removed.2, removed.3),
      resource: Some(removed.0.clone()),
      origin: Some(removed.1.clone()),
      method: Some(removed.2.clone()),
      auth_policy: Some(removed.3.clone()),
    });
  }
  diffs
}

fn capability_compatibility(
  source: Option<&ExecutionGrantSetBundle>,
  target: &PluginManifestV1,
) -> Vec<CapabilityCompatibilityDto> {
  let source_caps: HashSet<String> = source
    .map(|g| g.capabilities.iter().map(|c| c.capability_id.clone()).collect())
    .unwrap_or_default();
  target
    .capabilities
    .iter()
    .map(|cap| CapabilityCompatibilityDto {
      capability_id: cap.id.clone(),
      status: if source_caps.contains(&cap.id) {
        "unchanged".into()
      } else {
        "added".into()
      },
      detail: None,
    })
    .collect()
}

fn load_installed_manifest(
  conn: &rusqlite::Connection,
  package_digest: &str,
) -> Result<Option<PluginManifestV1>, StorageError> {
  let Some(version) = installed_plugin_versions::get_optional(conn, package_digest)? else {
    return Ok(None);
  };
  let manifest = serde_json::from_str(&version.manifest_json)
    .map_err(|e| StorageError::Validation(format!("invalid installed package manifest: {e}")))?;
  Ok(Some(manifest))
}

fn credential_slot_compatibility(
  instance: &IntegrationInstance,
  target: &PluginManifestV1,
  db: &Database,
  vault: Option<&dyn crate::credentials::CredentialVault>,
) -> Result<Vec<CredentialSlotCompatibilityDto>, StorageError> {
  db.read(|conn| credential_slot_compatibility_conn(conn, instance, target, vault))
}

fn credential_slot_compatibility_conn(
  conn: &rusqlite::Connection,
  instance: &IntegrationInstance,
  target: &PluginManifestV1,
  vault: Option<&dyn crate::credentials::CredentialVault>,
) -> Result<Vec<CredentialSlotCompatibilityDto>, StorageError> {
  let bindings = integration_credential_bindings::list_for_instance(conn, instance.id)?;
  // Presence = non-empty opaque credential_ref AND vault.exists (never expose the ref itself).
  let mut binding_presence: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
  for b in &bindings {
    let ref_present = b
      .credential_ref
      .as_deref()
      .map(str::trim)
      .filter(|v| !v.is_empty())
      .is_some();
    let present = if ref_present {
      match vault {
        Some(v) => {
          let account = b.credential_ref.as_deref().unwrap_or("");
          v.exists(account).map_err(|e| {
            StorageError::Validation(format!("credential vault preflight failed for slot {}: {e}", b.slot_id))
          })?
        }
        // No vault wired: fail closed for non-empty refs (cannot prove presence).
        None => false,
      }
    } else {
      false
    };
    binding_presence.insert(b.slot_id.clone(), present);
  }
  // Source kinds: Wasm/package pin → installed manifest; bundled → host registry definition.
  let source_kinds: std::collections::HashMap<String, String> = if let Some(digest) = instance.package_digest.as_deref()
  {
    match load_installed_manifest(conn, digest)? {
      Some(manifest) => manifest
        .credential_slots
        .iter()
        .map(|s| (s.id.clone(), credential_kind_as_str(s.kind).into()))
        .collect(),
      None => std::collections::HashMap::new(),
    }
  } else if let Ok(registry) = ServiceIntegrationRegistry::bundled() {
    registry
      .get(&instance.plugin_id)
      .map(|manifest| {
        manifest
          .credential_slots
          .iter()
          .map(|s| (s.id.clone(), s.kind.as_str().to_string()))
          .collect()
      })
      .unwrap_or_default()
  } else {
    std::collections::HashMap::new()
  };
  Ok(
    target
      .credential_slots
      .iter()
      .map(|slot| {
        let kind = credential_kind_as_str(slot.kind);
        let has_present_binding = binding_presence.get(&slot.id).copied().unwrap_or(false);
        let status = if has_present_binding {
          match source_kinds.get(&slot.id) {
            Some(source_kind) if source_kind != kind => "kind_mismatch",
            Some(_) => "compatible",
            None if slot.required => "kind_mismatch",
            None => "compatible",
          }
        } else if slot.required {
          // Missing row OR empty credential_ref both count as required_missing.
          "required_missing"
        } else if binding_presence.contains_key(&slot.id) {
          // Optional slot with empty binding is still unbound for UX.
          "optional_new"
        } else {
          "optional_new"
        };
        CredentialSlotCompatibilityDto {
          slot_id: slot.id.clone(),
          status: status.into(),
          required: slot.required,
          kind: kind.into(),
        }
      })
      .collect(),
  )
}

fn credential_kind_as_str(kind: crate::domain::runtime_plugin::CredentialSlotKindV1) -> &'static str {
  match kind {
    crate::domain::runtime_plugin::CredentialSlotKindV1::SecretText => "secret_text",
    crate::domain::runtime_plugin::CredentialSlotKindV1::SecretJson => "secret_json",
  }
}

fn write_preference_rows(
  conn: &rusqlite::Connection,
  translation: &[PreferenceSnapshotRow],
  ocr: &[PreferenceSnapshotRow],
  speech: &[PreferenceSnapshotRow],
  now: &str,
  cas: bool,
  expected_instance_id: Uuid,
) -> Result<(), StorageError> {
  if cas {
    verify_preference_cas(conn, translation, expected_instance_id)?;
    verify_preference_cas(conn, ocr, expected_instance_id)?;
    verify_preference_cas(conn, speech, expected_instance_id)?;
  }
  for row in translation {
    if row.integration_instance_id != expected_instance_id {
      return Err(StorageError::Conflict(format!(
        "translation profile {} foreign ownership",
        row.id
      )));
    }
    let changed = conn.execute(
      "UPDATE translation_profiles SET
            capability_preferences_version = ?2,
            capability_preferences_json = ?3,
            updated_at = ?4
         WHERE id = ?1
           AND integration_instance_id = ?5
           AND engine_kind = 'plugin_capability'",
      rusqlite::params![
        row.id.to_string(),
        row.schema_version,
        row.preferences_json,
        now,
        expected_instance_id.to_string()
      ],
    )?;
    if changed == 0 {
      return Err(StorageError::Conflict(format!(
        "translation profile {} missing or ownership mismatch",
        row.id
      )));
    }
  }
  for row in ocr {
    if row.integration_instance_id != expected_instance_id {
      return Err(StorageError::Conflict(format!(
        "ocr service {} foreign ownership",
        row.id
      )));
    }
    let changed = conn.execute(
      "UPDATE ocr_services SET
            capability_preferences_version = ?2,
            capability_preferences_json = ?3,
            updated_at = ?4
         WHERE id = ?1
           AND integration_instance_id = ?5",
      rusqlite::params![
        row.id.to_string(),
        row.schema_version,
        row.preferences_json,
        now,
        expected_instance_id.to_string()
      ],
    )?;
    if changed == 0 {
      return Err(StorageError::Conflict(format!(
        "ocr service {} missing or ownership mismatch",
        row.id
      )));
    }
  }
  for row in speech {
    if row.integration_instance_id != expected_instance_id {
      return Err(StorageError::Conflict(format!(
        "speech service {} foreign ownership",
        row.id
      )));
    }
    let changed = conn.execute(
      "UPDATE speech_services SET
            preferences_schema_version = ?2,
            preferences_json = ?3,
            updated_at = ?4
         WHERE id = ?1
           AND integration_instance_id = ?5",
      rusqlite::params![
        row.id.to_string(),
        row.schema_version,
        row.preferences_json,
        now,
        expected_instance_id.to_string()
      ],
    )?;
    if changed == 0 {
      return Err(StorageError::Conflict(format!(
        "speech service {} missing or ownership mismatch",
        row.id
      )));
    }
  }
  Ok(())
}

fn restore_grant_from_snapshot(
  conn: &rusqlite::Connection,
  snapshot: &PluginUpgradeSnapshot,
) -> Result<(), StorageError> {
  let Some(grant_json) = snapshot.grant_snapshot_json.as_deref() else {
    return Ok(());
  };
  let bundle: ExecutionGrantSetBundle =
    serde_json::from_str(grant_json).map_err(|e| StorageError::Validation(format!("invalid grant snapshot: {e}")))?;

  if bundle.header.subject_kind != GrantSubjectKind::IntegrationInstance {
    return Err(StorageError::Validation(
      "grant snapshot subject kind is not integration_instance".into(),
    ));
  }
  if bundle.header.subject_id != snapshot.integration_instance_id {
    return Err(StorageError::Validation(
      "grant snapshot subject does not match instance".into(),
    ));
  }
  if bundle.header.plugin_version != snapshot.plugin_version {
    return Err(StorageError::Validation(
      "grant snapshot plugin version does not match snapshot pin".into(),
    ));
  }
  if let Some(digest) = snapshot.package_digest.as_deref() {
    if bundle.header.package_digest != digest {
      return Err(StorageError::Validation(
        "grant snapshot package digest does not match snapshot pin".into(),
      ));
    }
  } else {
    return Err(StorageError::Validation(
      "grant snapshot present without package pin".into(),
    ));
  }
  if let Some(rev) = snapshot.execution_grant_set_revision {
    if bundle.header.revision != rev {
      return Err(StorageError::Validation(
        "grant snapshot revision does not match snapshot pin".into(),
      ));
    }
  } else {
    return Err(StorageError::Validation(
      "grant snapshot present without grant revision pin".into(),
    ));
  }

  let domain = crate::services::runtime_router::bundle_to_execution_grant_set(&bundle)
    .map_err(|e| StorageError::Validation(format!("grant snapshot canonical rebuild failed: {e}")))?;
  if domain.authority_digest().as_str() != bundle.header.authority_digest {
    return Err(StorageError::Validation(
      "grant snapshot authority digest does not match recomputed canonical digest".into(),
    ));
  }
  for cap in &bundle.capabilities {
    if cap.grant_set_id != bundle.header.id {
      return Err(StorageError::Validation(
        "grant snapshot capability entry grant_set_id mismatch".into(),
      ));
    }
  }
  for net in &bundle.network {
    if net.grant_set_id != bundle.header.id {
      return Err(StorageError::Validation(
        "grant snapshot network entry grant_set_id mismatch".into(),
      ));
    }
  }
  for page in &bundle.pages {
    if page.grant_set_id != bundle.header.id {
      return Err(StorageError::Validation(
        "grant snapshot page entry grant_set_id mismatch".into(),
      ));
    }
  }

  if let Some(manifest) = load_installed_manifest(conn, &bundle.header.package_digest)? {
    if manifest.id != bundle.header.plugin_id {
      return Err(StorageError::Validation(
        "grant snapshot plugin id does not match installed package".into(),
      ));
    }
    if manifest.version != bundle.header.plugin_version {
      return Err(StorageError::Validation(
        "grant snapshot plugin version does not match installed package".into(),
      ));
    }
    let expected_permission = compute_permission_request_digest(&manifest);
    let installed = installed_plugin_versions::get(conn, &bundle.header.package_digest)?;
    if !bundle.header.permission_request_digest.is_empty()
      && bundle.header.permission_request_digest != expected_permission
      && bundle.header.permission_request_digest != installed.permission_request_digest
    {
      return Err(StorageError::Validation(
        "grant snapshot permission request digest does not match package".into(),
      ));
    }
  }

  match plugin_permission_grants::get_bundle_for_subject_package_revision(
    conn,
    bundle.header.subject_kind,
    bundle.header.subject_id,
    &bundle.header.package_digest,
    bundle.header.revision,
  ) {
    Ok(existing) => {
      if !canonical_bundles_equal(&existing, &bundle) {
        return Err(StorageError::Conflict(
          "live grant authority diverged from snapshot".into(),
        ));
      }
      Ok(())
    }
    Err(StorageError::NotFound(_)) => {
      plugin_permission_grants::insert_bundle(conn, &bundle)?;
      Ok(())
    }
    Err(err) => Err(err),
  }
}

fn canonical_bundles_equal(a: &ExecutionGrantSetBundle, b: &ExecutionGrantSetBundle) -> bool {
  if a.header.subject_kind != b.header.subject_kind
    || a.header.subject_id != b.header.subject_id
    || a.header.plugin_id != b.header.plugin_id
    || a.header.plugin_version != b.header.plugin_version
    || a.header.package_digest != b.header.package_digest
    || a.header.permission_request_digest != b.header.permission_request_digest
    || a.header.authority_digest != b.header.authority_digest
    || a.header.revision != b.header.revision
  {
    return false;
  }
  let mut a_caps: Vec<_> = a.capabilities.iter().map(|c| c.capability_id.as_str()).collect();
  let mut b_caps: Vec<_> = b.capabilities.iter().map(|c| c.capability_id.as_str()).collect();
  a_caps.sort_unstable();
  b_caps.sort_unstable();
  if a_caps != b_caps {
    return false;
  }
  let mut a_net: Vec<_> = a
    .network
    .iter()
    .map(|n| {
      (
        n.capability_id.as_str(),
        n.endpoint_id.as_str(),
        n.origin.as_str(),
        n.method.as_str(),
        n.auth_policy.as_str(),
        n.resource_mode.as_str(),
        n.max_request_bytes,
        n.max_response_bytes,
        n.max_stream_bytes,
        n.timeout_ms,
        n.response_body_modes.as_str(),
      )
    })
    .collect();
  let mut b_net: Vec<_> = b
    .network
    .iter()
    .map(|n| {
      (
        n.capability_id.as_str(),
        n.endpoint_id.as_str(),
        n.origin.as_str(),
        n.method.as_str(),
        n.auth_policy.as_str(),
        n.resource_mode.as_str(),
        n.max_request_bytes,
        n.max_response_bytes,
        n.max_stream_bytes,
        n.timeout_ms,
        n.response_body_modes.as_str(),
      )
    })
    .collect();
  a_net.sort_unstable();
  b_net.sort_unstable();
  if a_net != b_net {
    return false;
  }
  let mut a_pages: Vec<_> = a
    .pages
    .iter()
    .map(|p| {
      (
        p.page_id.clone(),
        p.allowed_actions.clone(),
        p.delegated_capability_majors.clone(),
        p.delegated_endpoint_aliases.clone(),
      )
    })
    .collect();
  let mut b_pages: Vec<_> = b
    .pages
    .iter()
    .map(|p| {
      (
        p.page_id.clone(),
        p.allowed_actions.clone(),
        p.delegated_capability_majors.clone(),
        p.delegated_endpoint_aliases.clone(),
      )
    })
    .collect();
  a_pages.sort_by(|x, y| x.0.cmp(&y.0));
  b_pages.sort_by(|x, y| x.0.cmp(&y.0));
  a_pages == b_pages
}

fn build_runtime_requirement(
  version: &crate::domain::plugin_package::InstalledPluginVersion,
  manifest: &PluginManifestV1,
  config_schema_version: u32,
) -> Result<RuntimeRequirementExport, StorageError> {
  if version.publisher_key_id.trim().is_empty() || version.publisher_fingerprint.trim().is_empty() {
    return Err(StorageError::Validation(
      "installed package is missing publisher identity required for export".into(),
    ));
  }
  if version.package_digest.trim().is_empty() {
    return Err(StorageError::Validation(
      "installed package is missing package digest required for export".into(),
    ));
  }
  let majors: Vec<String> = manifest.capabilities.iter().map(|c| c.id.clone()).collect();
  Ok(RuntimeRequirementExport {
    plugin_id: version.plugin_id.clone(),
    plugin_version: version.version.clone(),
    runtime_kind: runtime_kind_storage(RuntimeKind::WasmComponent).into(),
    package_digest: Some(version.package_digest.clone()),
    publisher_key_id: Some(version.publisher_key_id.clone()),
    publisher_key_fingerprint: Some(version.publisher_fingerprint.clone()),
    plugin_api_version: Some(manifest.plugin_api_version.clone()),
    config_schema_version,
    required_capability_majors: majors,
    provider_runtime_kind: None,
    provider_package_digest: None,
  })
}

fn bind_rollback_dependency_cas(
  snapshot_rows: &[PreferenceSnapshotRow],
  live_rows: &[PreferenceSnapshotRow],
  instance_id: Uuid,
) -> Result<Vec<PreferenceSnapshotRow>, StorageError> {
  let live_by_id: std::collections::HashMap<Uuid, &PreferenceSnapshotRow> =
    live_rows.iter().map(|r| (r.id, r)).collect();
  let mut out = Vec::with_capacity(snapshot_rows.len());
  for snap in snapshot_rows {
    if snap.integration_instance_id != instance_id {
      return Err(StorageError::Conflict(
        "rollback snapshot dependency row belongs to a different instance".into(),
      ));
    }
    let live = live_by_id.get(&snap.id).ok_or_else(|| {
      StorageError::Conflict(format!(
        "rollback dependency {} {} is missing at preview",
        snap.kind, snap.id
      ))
    })?;
    if live.integration_instance_id != instance_id {
      return Err(StorageError::Conflict(format!(
        "rollback dependency {} {} is owned by another instance",
        snap.kind, snap.id
      )));
    }
    // CAS token uses live updated_at; restore content remains in the snapshot row.
    out.push(PreferenceSnapshotRow {
      kind: snap.kind.clone(),
      id: snap.id,
      integration_instance_id: instance_id,
      capability_id: snap.capability_id.clone(),
      schema_version: live.schema_version,
      preferences_json: live.preferences_json.clone(),
      updated_at: live.updated_at.clone(),
    });
  }
  // Fail closed if live has extra rows that moved under this instance since snapshot? Not required.
  Ok(out)
}

fn assert_dependency_sets_bidirectional(
  live_rows: &[PreferenceSnapshotRow],
  snapshot_rows: &[PreferenceSnapshotRow],
) -> Result<(), StorageError> {
  let mut live_keys: Vec<_> = live_rows.iter().map(|r| (r.id, r.integration_instance_id)).collect();
  let mut snap_keys: Vec<_> = snapshot_rows
    .iter()
    .map(|r| (r.id, r.integration_instance_id))
    .collect();
  live_keys.sort_unstable();
  snap_keys.sort_unstable();
  if live_keys != snap_keys {
    return Err(StorageError::Conflict(
      "dependency set diverged (extra, missing, or rebound rows)".into(),
    ));
  }
  Ok(())
}

fn assert_snapshot_dependency_ids_match(
  cas_rows: &[PreferenceSnapshotRow],
  snapshot_rows: &[PreferenceSnapshotRow],
) -> Result<(), StorageError> {
  let mut cas_ids: Vec<_> = cas_rows.iter().map(|r| r.id).collect();
  let mut snap_ids: Vec<_> = snapshot_rows.iter().map(|r| r.id).collect();
  cas_ids.sort_unstable();
  snap_ids.sort_unstable();
  if cas_ids != snap_ids {
    return Err(StorageError::Conflict(
      "rollback snapshot dependency row set diverged from preview".into(),
    ));
  }
  let snap_by_id: std::collections::HashMap<Uuid, &PreferenceSnapshotRow> =
    snapshot_rows.iter().map(|r| (r.id, r)).collect();
  for cas in cas_rows {
    let snap = snap_by_id
      .get(&cas.id)
      .ok_or_else(|| StorageError::Conflict("rollback snapshot dependency row missing at apply".into()))?;
    if cas.integration_instance_id != snap.integration_instance_id {
      return Err(StorageError::Conflict(
        "rollback snapshot dependency ownership diverged from preview".into(),
      ));
    }
  }
  Ok(())
}

fn prune_snapshots(conn: &rusqlite::Connection, instance_id: Uuid, now: &str) -> Result<(), StorageError> {
  let active = plugin_upgrade_snapshots::list_active_for_instance(conn, instance_id)?;
  if active.len() <= MAX_ROLLBACK_SNAPSHOTS_PER_INSTANCE {
    return Ok(());
  }
  for snapshot in active.into_iter().skip(MAX_ROLLBACK_SNAPSHOTS_PER_INSTANCE) {
    plugin_upgrade_snapshots::discard(conn, snapshot.id, now)?;
  }
  Ok(())
}

fn validate_json_object(value: &str, field: &str) -> Result<(), StorageError> {
  let parsed: serde_json::Value =
    serde_json::from_str(value).map_err(|e| StorageError::Validation(format!("{field} is not valid JSON: {e}")))?;
  if !parsed.is_object() {
    return Err(StorageError::Validation(format!("{field} must be a JSON object")));
  }
  Ok(())
}

fn validate_json_value(value: &str, field: &str) -> Result<(), StorageError> {
  let _: serde_json::Value =
    serde_json::from_str(value).map_err(|e| StorageError::Validation(format!("{field} is not valid JSON: {e}")))?;
  Ok(())
}

fn now_plus_secs(secs: u64) -> String {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
    .saturating_add(secs);
  let days = ts / 86_400;
  let rem = ts % 86_400;
  let hours = rem / 3_600;
  let mins = (rem % 3_600) / 60;
  let secs = rem % 60;
  let (year, month, day) = civil_from_days(days as i64);
  format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{secs:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
  let z = days + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = (z - era * 146_097) as u64;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
  let y = yoe as i64 + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = if m <= 2 { y + 1 } else { y };
  (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_integration::{IntegrationHealthStatus, IntegrationInstance};
  use crate::domain::time::now_rfc3339;
  use crate::storage::Database;

  fn seed_bundled_instance(db: &Database) -> Uuid {
    let id = new_id();
    let now = now_rfc3339();
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: "langnext.conformance".into(),
          plugin_version: "0.1.0".into(),
          display_name: "Conformance".into(),
          enabled: true,
          config_json: "{}".into(),
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

  #[test]
  fn runtime_upgrade_preview_missing_package_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_bundled_instance(&db);
    let service = RuntimeLifecycleService::new(
      db.clone(),
      PluginPackageService::new(db, dir.path().to_path_buf()),
      Arc::new(ServiceIntegrationRegistry::bundled().unwrap()),
    );
    let err = service.preview_upgrade(id, &"a".repeat(64)).unwrap_err();
    assert!(matches!(err, StorageError::NotFound(_)));
  }

  #[test]
  fn runtime_upgrade_apply_unknown_preview_is_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let service = RuntimeLifecycleService::new(
      db.clone(),
      PluginPackageService::new(db, dir.path().to_path_buf()),
      Arc::new(ServiceIntegrationRegistry::bundled().unwrap()),
    );
    let err = service
      .apply_upgrade(ApplyRuntimeUpgradeInput {
        preview_id: "rup_missing".into(),
        acknowledge_permissions: true,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Conflict(_)));
  }

  #[test]
  fn runtime_rollback_without_snapshot_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_bundled_instance(&db);
    let service = RuntimeLifecycleService::new(
      db.clone(),
      PluginPackageService::new(db, dir.path().to_path_buf()),
      Arc::new(ServiceIntegrationRegistry::bundled().unwrap()),
    );
    let err = service.preview_rollback(id).unwrap_err();
    assert!(matches!(err, StorageError::NotFound(_)));
  }
}
