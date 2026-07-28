// ABOUTME: Prepare/approve CAS upgrade and rollback for integration runtime pins.
// ABOUTME: Migrations run on copied non-secret JSON only; secrets never enter snapshots.
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
  NetworkGrantEntry, NetworkResourceMode, PackageDigest, PackageIdentity, PageGrantEntry, PluginId, PluginManifestV1,
  RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES, RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
  RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES, RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS, ResourceLimits, RuntimeIdentity,
  RuntimeKind, SemVerVersion,
};
use crate::domain::service_integration::IntegrationInstance;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{
  installed_plugin_versions, integration_credential_bindings, integration_instances, plugin_permission_grants,
  plugin_publishers, plugin_upgrade_snapshots,
};
use crate::services::plugin_package::public_sha256_hex;
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
  #[allow(dead_code)]
  registry: Arc<ServiceIntegrationRegistry>,
  wasm_runtime: Option<Arc<crate::services::wasm_runtime::WasmRuntime>>,
  token_grants: Option<Arc<crate::services::token_grant::TokenGrantService>>,
  vault: Option<Arc<dyn crate::credentials::CredentialVault>>,
  upgrade_previews: Arc<Mutex<std::collections::HashMap<String, UpgradePreviewSession>>>,
  rollback_previews: Arc<Mutex<std::collections::HashMap<String, RollbackPreviewSession>>>,
  apply_fault: Arc<Mutex<Option<UpgradeApplyFault>>>,
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
      &source_permission_digest,
      &target_permission_digest,
    );
    let requires_permission_approval =
      !permission_differences.is_empty() && source_permission_digest != target_permission_digest;

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
    let grant_bundle = build_grant_bundle_for_target(
      &self.db,
      &instance,
      &target_version,
      &target_manifest,
      source_grant.as_ref(),
    )?;

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

fn build_grant_bundle_for_target(
  db: &Database,
  instance: &IntegrationInstance,
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

  let revision = db.read(|conn| {
    plugin_permission_grants::next_revision_for_subject_package(
      conn,
      GrantSubjectKind::IntegrationInstance,
      instance.id,
      &target_version.package_digest,
    )
  })?;
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
  for cap in &target_manifest.capabilities {
    let capability_id = CapabilityId::parse(&cap.id).map_err(|e| StorageError::Validation(format!("{e:?}")))?;
    for endpoint in &target_manifest.permissions.network {
      let endpoint_id = EndpointId::parse(&endpoint.id).map_err(StorageError::Validation)?;
      for origin in &endpoint.origins {
        let origin = HttpsOrigin::parse(origin).map_err(StorageError::Validation)?;
        for method in &endpoint.methods {
          for policy in &auth_policies {
            let auth = AuthPolicyId::parse(policy).map_err(StorageError::Validation)?;
            let limits = ResourceLimits::default();
            domain_net.push(NetworkGrantEntry::with_mode(
              capability_id.clone(),
              endpoint_id.clone(),
              origin.clone(),
              *method,
              auth.clone(),
              NetworkResourceMode::Bounded,
              limits,
            ));
            network.push(NetworkGrantEntryRecord {
              id: new_id(),
              grant_set_id: grant_id,
              capability_id: capability_id.as_str().to_string(),
              endpoint_id: endpoint_id.as_str().to_string(),
              origin: origin.as_str().to_string(),
              method: http_method_as_str(*method).into(),
              auth_policy: auth.as_str().to_string(),
              resource_mode: NetworkResourceMode::Bounded.as_str().into(),
              max_request_bytes: RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
              max_response_bytes: RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
              max_stream_bytes: RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
              timeout_ms: RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
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
            n.origin.clone(),
            n.method.clone(),
            n.auth_policy.clone(),
          )
        })
        .collect()
    })
    .unwrap_or_default();
  let mut target_endpoints: HashSet<(String, String, String, String)> = HashSet::new();
  let auth_policies = if target.permissions.auth_policies.is_empty() {
    vec!["host.none.v1".to_string()]
  } else {
    target.permissions.auth_policies.clone()
  };
  for endpoint in &target.permissions.network {
    for origin in &endpoint.origins {
      for method in &endpoint.methods {
        for policy in &auth_policies {
          target_endpoints.insert((
            endpoint.id.clone(),
            origin.clone(),
            http_method_as_str(*method).into(),
            policy.clone(),
          ));
        }
      }
    }
  }
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
