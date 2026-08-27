// ABOUTME: Service integration CRUD, credential slots, and remote auth validation.
// ABOUTME: Token success means authentication health only — not Translate/Vision IAM access.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, integration_ref};
use crate::domain::cancel::CancelToken;
use crate::domain::endpoint_trust::{EndpointTrustPreviewDto, EndpointTrustPreviewInput, EndpointTrustStatus};
use crate::domain::provider::CredentialUpdate;
use crate::domain::service_capability::{CAPABILITY_DEFAULT_TIMEOUT, CapabilityErrorCode};
use crate::domain::service_integration::{
  CredentialSlotStatusDto, INTEGRATION_CONFIG_JSON_MAX_LEN, INTEGRATION_DISPLAY_NAME_MAX_LEN, IntegrationDependencyDto,
  IntegrationHealthStatus, IntegrationInstance, IntegrationInstanceDto, IntegrationInstanceWrite,
  IntegrationValidationResult, SERVICE_ACCOUNT_JSON_MAX_LEN, ServiceIntegrationDefinitionDto,
  ServiceIntegrationManifest, derive_effective_status, validate_plugin_id, validate_slot_id,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{
  integration_capability_health, integration_credential_bindings, integration_endpoint_trusts, integration_instances,
};
use crate::services::endpoint_trust::EndpointTrustService;
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::token_grant::{TokenGrant, TokenGrantService};
use crate::storage::Database;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// Bounded timeout for remote credential validation (token grant only).
const INTEGRATION_VALIDATION_TIMEOUT: Duration = CAPABILITY_DEFAULT_TIMEOUT;
/// Re-read `updated_at` and retry health CAS a few times after remote validation.
/// Concurrent display_name/enable saves only advance instance revision; they must not
/// false-fail validation. Credential replace/clear is handled separately by identity checks.
const VALIDATION_HEALTH_WRITE_MAX_ATTEMPTS: u32 = 3;
/// Message when credentials changed while a remote validation was in flight.
const VALIDATION_CREDENTIALS_CHANGED_MESSAGE: &str = "credentials changed during validation; re-run validation";

/// Required credential binding identity captured before remote token acquisition.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RequiredCredentialSnapshot {
  slot_id: String,
  credential_ref: Option<String>,
  credential_revision: i64,
}

/// Outcome of attempting to persist a remote validation health write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteValidationPersist {
  /// Remote health applied to the current credential identity.
  Applied,
  /// Current local config/credentials are incomplete; Unconfigured was written.
  Unconfigured,
  /// Required credential identity changed; stale remote health was discarded.
  CredentialsChanged,
}

#[derive(Clone)]
pub struct ServiceIntegrationService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  registry: Arc<ServiceIntegrationRegistry>,
  tokens: Arc<TokenGrantService>,
  validation_timeout: Duration,
  runtime_lifecycle: Option<crate::services::runtime_lifecycle::RuntimeLifecycleService>,
  endpoint_trust: Arc<EndpointTrustService>,
  /// When set, PaddleOCR first-model health uses the same vendor-root re-verify seam as RuntimeRouter.
  plugin_packages: Option<crate::services::plugin_store::PluginPackageService>,
  /// Authorized default package policy for package-first creation (Phase 11.5).
  default_package_activation: Option<crate::services::default_package_activation::DefaultPackageActivationService>,
}

impl ServiceIntegrationService {
  pub fn new(
    db: Database,
    vault: Arc<dyn CredentialVault>,
    registry: Arc<ServiceIntegrationRegistry>,
    tokens: Arc<TokenGrantService>,
  ) -> Self {
    Self {
      db: db.clone(),
      vault,
      registry: registry.clone(),
      tokens,
      validation_timeout: INTEGRATION_VALIDATION_TIMEOUT,
      runtime_lifecycle: None,
      endpoint_trust: Arc::new(EndpointTrustService::new(db.clone(), registry.clone())),
      plugin_packages: None,
      default_package_activation: None,
    }
  }

  /// Override the remote validation timeout (tests and specialized hosts).
  pub fn with_validation_timeout(mut self, timeout: Duration) -> Self {
    self.validation_timeout = timeout;
    self
  }

  /// Wire the runtime lifecycle service so new instances can pin the default installed Wasm
  /// package (safe-fail: leaves the instance Bundled Rust when no/invalid default exists).
  pub fn with_runtime_lifecycle(
    mut self,
    runtime_lifecycle: crate::services::runtime_lifecycle::RuntimeLifecycleService,
  ) -> Self {
    self.runtime_lifecycle = Some(runtime_lifecycle);
    self
  }

  /// Wire plugin package re-verification so native health uses the signed archive (not mutable DB JSON).
  pub fn with_plugin_packages(mut self, plugin_packages: crate::services::plugin_store::PluginPackageService) -> Self {
    self.plugin_packages = Some(plugin_packages);
    self
  }

  /// Wire default package authorization for package-first create of new instances.
  pub fn with_default_package_activation(
    mut self,
    default_package_activation: crate::services::default_package_activation::DefaultPackageActivationService,
  ) -> Self {
    self.default_package_activation = Some(default_package_activation);
    self
  }

  pub fn with_endpoint_trust(mut self, endpoint_trust: Arc<EndpointTrustService>) -> Self {
    self.endpoint_trust = endpoint_trust;
    self
  }

  pub fn preview_endpoint_trust(
    &self,
    input: EndpointTrustPreviewInput,
  ) -> Result<EndpointTrustPreviewDto, StorageError> {
    let creation_runtime = if input.instance_id.is_none() {
      self.package_first_creation_runtime(input.plugin_id.trim())?
    } else {
      None
    };
    self.endpoint_trust.preview(input, creation_runtime.as_ref())
  }

  /// The runtime identity a package-first create will pin for this plugin, so an endpoint
  /// review binds to the same runtime fingerprint the created instance will carry.
  fn package_first_creation_runtime(
    &self,
    plugin_id: &str,
  ) -> Result<Option<crate::services::endpoint_trust::CreationRuntimeIdentity>, StorageError> {
    use crate::services::default_package_activation::PackageFirstCreateResolution;
    let Some(activation) = &self.default_package_activation else {
      return Ok(None);
    };
    match activation.prepare_package_first_create(plugin_id)? {
      PackageFirstCreateResolution::Ready(prepared) => {
        Ok(Some(crate::services::endpoint_trust::CreationRuntimeIdentity {
          plugin_version: prepared.plugin_version,
          runtime_kind: prepared.runtime_kind,
          package_digest: Some(prepared.package_digest),
        }))
      }
      PackageFirstCreateResolution::Blocked(blocked) => {
        Ok(Some(crate::services::endpoint_trust::CreationRuntimeIdentity {
          plugin_version: blocked.plugin_version,
          runtime_kind: blocked.runtime_kind,
          package_digest: Some(blocked.package_digest),
        }))
      }
      PackageFirstCreateResolution::NoDefault => Ok(None),
    }
  }

  pub fn list_definitions(&self) -> Vec<ServiceIntegrationDefinitionDto> {
    self.registry.list_definitions()
  }

  pub fn list_instances(&self) -> Result<Vec<IntegrationInstanceDto>, StorageError> {
    self.db.read(|conn| {
      let instances = integration_instances::list(conn)?;
      let mut dtos = Vec::with_capacity(instances.len());
      for instance in instances {
        let bindings = integration_credential_bindings::list_for_instance(conn, instance.id)?;
        dtos.push(self.to_dto(conn, &instance, &bindings));
      }
      Ok(dtos)
    })
  }

  pub fn get_instance(&self, id: Uuid) -> Result<IntegrationInstanceDto, StorageError> {
    self.db.read(|conn| {
      let instance = integration_instances::get(conn, id)?;
      let bindings = integration_credential_bindings::list_for_instance(conn, id)?;
      Ok(self.to_dto(conn, &instance, &bindings))
    })
  }

  pub fn save(&self, input: IntegrationInstanceWrite) -> Result<IntegrationInstanceDto, StorageError> {
    match input.id {
      None => self.create(input),
      Some(id) => self.update(id, input),
    }
  }

  pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<IntegrationInstanceDto, StorageError> {
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      integration_instances::get(uow.conn(), id)?;
      integration_instances::set_enabled(uow.conn(), id, enabled, &now)?;
      Ok(())
    })?;
    if !enabled {
      self.tokens.evict_instance(id);
    }
    self.get_instance(id)
  }

  /// Phase 1A dependency query: repository hook returns empty until domain FKs exist.
  pub fn list_dependencies(&self, id: Uuid) -> Result<Vec<IntegrationDependencyDto>, StorageError> {
    self.db.read(|conn| integration_instances::list_dependencies(conn, id))
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    let deps = self.list_dependencies(id)?;
    if !deps.is_empty() {
      return Err(StorageError::InUse(format!(
        "integration instance {id} is referenced by {} resource(s)",
        deps.len()
      )));
    }

    let bindings = self
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, id))?;
    for binding in &bindings {
      coordinator::preflight_owner_slot(
        &self.db,
        self.vault.as_ref(),
        OwnerKind::Integration,
        &id.to_string(),
        &binding.slot_id,
      )?;
    }

    let cleanup_ops: Vec<CredentialOperation> = self.db.transaction(|uow| {
      let mut ops = Vec::new();
      for binding in &bindings {
        if binding.credential_ref.is_some() {
          ops.push(credential_operations::insert_db_committed_slot(
            uow.conn(),
            new_id(),
            OwnerKind::Integration,
            &id.to_string(),
            &binding.slot_id,
            binding.credential_ref.as_deref(),
            None,
          )?);
        }
      }
      // Cascade removes bindings; delete instance row explicitly for clear errors.
      integration_credential_bindings::delete_for_instance(uow.conn(), id)?;
      integration_instances::delete(uow.conn(), id)?;
      Ok(ops)
    })?;

    for op in cleanup_ops {
      let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
    }
    self.tokens.evict_instance(id);
    Ok(())
  }

  /// Local config check + remote token grant acquisition (auth health only).
  /// Token success does not imply Translate/Vision IAM access.
  pub async fn validate_instance(&self, id: Uuid) -> Result<IntegrationValidationResult, StorageError> {
    let (instance, bindings) = self.db.read(|conn| {
      let instance = integration_instances::get(conn, id)?;
      let bindings = integration_credential_bindings::list_for_instance(conn, id)?;
      Ok((instance, bindings))
    })?;

    let plugin_present = self.registry.contains(&instance.plugin_id);
    if !plugin_present {
      let effective = derive_effective_status(instance.enabled, false, instance.health_status);
      return Ok(IntegrationValidationResult {
        instance_id: id,
        health_status: instance.health_status,
        effective_status: effective,
        remote_checked: false,
        message: Some("plugin definition is missing from the host registry".into()),
      });
    }

    let registration = self
      .registry
      .get_registration(&instance.plugin_id)
      .ok_or_else(|| StorageError::PluginUnavailable(instance.plugin_id.clone()))?;
    let manifest = &registration.manifest;

    let has_required_credentials = required_slots_satisfied(manifest, &bindings);
    let config_ok = registration
      .config_adapter
      .normalize_config(&instance.config_json)
      .is_ok()
      && registration.config_adapter.config_ready(&instance.config_json);

    if !config_ok || !has_required_credentials {
      self.persist_validation_health(id, IntegrationHealthStatus::Unconfigured, Some("invalid_configuration"))?;
      let refreshed = self.get_instance(id)?;
      return Ok(IntegrationValidationResult {
        instance_id: id,
        health_status: refreshed.health_status,
        effective_status: refreshed.effective_status,
        remote_checked: false,
        message: Some("configuration or required credentials are incomplete".into()),
      });
    }

    // Credential-free integrations are ready from local config alone - no token grant.
    // PaddleOCR / trusted-native-worker requires an activated vendor package + ready model.
    if !registration.requires_remote_auth() {
      if is_paddleocr_native_health_gate(&instance) {
        let package_digest = instance.package_digest.as_deref().filter(|d| !d.is_empty());
        let activated_native = instance.runtime_kind == "trusted-native-worker" && package_digest.is_some();
        if !activated_native {
          self.persist_validation_health(
            id,
            IntegrationHealthStatus::Degraded,
            Some(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str()),
          )?;
          let refreshed = self.get_instance(id)?;
          return Ok(IntegrationValidationResult {
            instance_id: id,
            health_status: refreshed.health_status,
            effective_status: refreshed.effective_status,
            remote_checked: false,
            message: Some("PaddleOCR requires an activated vendor package and a ready model before it can run.".into()),
          });
        }
        // Authoritative readiness matches RuntimeRouter: first model resource from the
        // vendor-root re-verified archive (not mutable DB manifest_json) must be Ready.
        let digest = package_digest.expect("activated native has package digest");
        let model_ready = self.paddleocr_first_model_ready(digest)?;
        if !model_ready {
          self.persist_validation_health(
            id,
            IntegrationHealthStatus::Degraded,
            Some(crate::domain::plugin_model::PluginModelErrorCode::ModelMissing.as_str()),
          )?;
          let refreshed = self.get_instance(id)?;
          return Ok(IntegrationValidationResult {
            instance_id: id,
            health_status: refreshed.health_status,
            effective_status: refreshed.effective_status,
            remote_checked: false,
            message: Some("Required model is missing. Download it from the configuration page.".into()),
          });
        }
      }
      self.persist_validation_health(id, IntegrationHealthStatus::Ready, None)?;
      let refreshed = self.get_instance(id)?;
      return Ok(IntegrationValidationResult {
        instance_id: id,
        health_status: refreshed.health_status,
        effective_status: refreshed.effective_status,
        remote_checked: false,
        message: Some("Configuration is ready. No credentials are used by this integration.".into()),
      });
    }

    // Snapshot required credential identity before remote work so a concurrent replace/clear
    // cannot be stamped Ready from a grant exchanged against a previous secret.
    let credential_snapshot = snapshot_required_credentials(manifest, &bindings);

    // Remote validation: acquire a token only (no user text, no Translate/Detect call).
    // Auth driver/policy/scope come from the registration's host-owned auth-policy binding.
    let auth = registration
      .auth_policy
      .as_ref()
      .ok_or_else(|| StorageError::Validation("remote validation requested for a credential-free plugin".into()))?;
    let cancel = CancelToken::new();
    // Capability-scoped token request: dr/scope validation passes only the scopes the
    // validation capability declares, never the flattened binding union.
    let capability_id = remote_validation_capability_id(manifest);
    let request =
      crate::services::auth_policies::token_grant_request_for_capability(id, &auth.auth_policy_id, &capability_id)
        .map_err(|error| StorageError::Internal(error.message))?;
    // biased + acquire-first: when acquire and timeout are both ready, prefer the real result.
    let grant_result = tokio::select! {
      biased;
      result = self.tokens.acquire(request, Some(&cancel)) => Ok(result),
      _ = tokio::time::sleep(self.validation_timeout) => {
        // Explicitly cancel in-flight exchange/network work on validation timeout.
        cancel.cancel();
        Err(())
      }
    };

    // Re-read instance + bindings after the remote attempt. Concurrent credential mutations must
    // discard the stale remote result; display_name/enabled-only saves may still receive it.
    let (current, current_bindings) = self.db.read(|conn| {
      let current = integration_instances::get(conn, id)?;
      let current_bindings = integration_credential_bindings::list_for_instance(conn, id)?;
      Ok((current, current_bindings))
    })?;

    let current_has_required = required_slots_satisfied(manifest, &current_bindings);
    let current_config_ok = registration
      .config_adapter
      .normalize_config(&current.config_json)
      .is_ok()
      && registration.config_adapter.config_ready(&current.config_json);

    if !current_config_ok || !current_has_required {
      self.persist_validation_health(id, IntegrationHealthStatus::Unconfigured, Some("invalid_configuration"))?;
      let refreshed = self.get_instance(id)?;
      return Ok(IntegrationValidationResult {
        instance_id: id,
        health_status: refreshed.health_status,
        effective_status: refreshed.effective_status,
        remote_checked: true,
        message: Some("configuration or required credentials are incomplete".into()),
      });
    }

    let current_snapshot = snapshot_required_credentials(manifest, &current_bindings);
    if current_snapshot != credential_snapshot {
      // New secret / cleared-then-restored identity: never apply health from the old grant.
      // Persist via transactional recheck so a concurrent Clear cannot be stamped Unvalidated.
      return self.finish_stale_remote_validation(id, registration, &credential_snapshot);
    }

    let (health, error_code, message) = match grant_result {
      Ok(Ok(grant)) => {
        // Exchange must report the same revision that was snapshotted / still current.
        if !grant_matches_credential_snapshot(&grant, &credential_snapshot) {
          return self.finish_stale_remote_validation(id, registration, &credential_snapshot);
        }
        (
          IntegrationHealthStatus::Ready,
          None,
          Some("Credentials validated. Translation permission is not verified by this check.".into()),
        )
      }
      Ok(Err(err)) => {
        let code = err.code.as_str().to_string();
        let health = match err.code {
          CapabilityErrorCode::InvalidConfiguration => IntegrationHealthStatus::Unconfigured,
          _ => IntegrationHealthStatus::Degraded,
        };
        (health, Some(code), Some(err.message))
      }
      Err(()) => (
        IntegrationHealthStatus::Degraded,
        Some("timeout".into()),
        Some("credential validation timed out".into()),
      ),
    };

    // Write remote health only while required credential identity still matches the snapshot.
    // Concurrent rename/enable retries CAS; concurrent replace/clear discards this result.
    match self.persist_remote_validation_health(
      id,
      registration,
      &credential_snapshot,
      health,
      error_code.as_deref(),
    )? {
      RemoteValidationPersist::Applied => {}
      RemoteValidationPersist::Unconfigured => {
        let refreshed = self.get_instance(id)?;
        return Ok(IntegrationValidationResult {
          instance_id: id,
          health_status: refreshed.health_status,
          effective_status: refreshed.effective_status,
          remote_checked: true,
          message: Some("configuration or required credentials are incomplete".into()),
        });
      }
      RemoteValidationPersist::CredentialsChanged => {
        let refreshed = self.get_instance(id)?;
        return Ok(IntegrationValidationResult {
          instance_id: id,
          health_status: refreshed.health_status,
          effective_status: refreshed.effective_status,
          remote_checked: true,
          message: Some(VALIDATION_CREDENTIALS_CHANGED_MESSAGE.into()),
        });
      }
    }

    let refreshed = self.get_instance(id)?;
    Ok(IntegrationValidationResult {
      instance_id: id,
      health_status: refreshed.health_status,
      effective_status: refreshed.effective_status,
      remote_checked: true,
      message,
    })
  }

  /// Discard a stale remote validation after credential identity or grant revision mismatch.
  /// Re-checks required credential identity and local completeness inside the write transaction
  /// so a concurrent Clear stays Unconfigured and a Replace stays Unvalidated/credentials_changed.
  fn finish_stale_remote_validation(
    &self,
    id: Uuid,
    registration: &crate::services::bundled_plugins::BundledPluginRegistration,
    expected: &[RequiredCredentialSnapshot],
  ) -> Result<IntegrationValidationResult, StorageError> {
    let decision = self.persist_remote_validation_health(
      id,
      registration,
      expected,
      IntegrationHealthStatus::Unvalidated,
      Some("credentials_changed"),
    )?;
    let refreshed = self.get_instance(id)?;
    let message = match decision {
      RemoteValidationPersist::Unconfigured => Some("configuration or required credentials are incomplete".into()),
      RemoteValidationPersist::Applied | RemoteValidationPersist::CredentialsChanged => {
        Some(VALIDATION_CREDENTIALS_CHANGED_MESSAGE.into())
      }
    };
    Ok(IntegrationValidationResult {
      instance_id: id,
      health_status: refreshed.health_status,
      effective_status: refreshed.effective_status,
      remote_checked: true,
      message,
    })
  }

  /// Persist validation health using the latest row revision, with limited Conflict retries.
  /// Only health metadata is written — concurrent config/display_name/enabled saves are not
  /// overwritten. Callers must already discard remote results when credential identity changed.
  fn persist_validation_health(
    &self,
    id: Uuid,
    health: IntegrationHealthStatus,
    error_code: Option<&str>,
  ) -> Result<(), StorageError> {
    let mut attempt = 0u32;
    loop {
      attempt += 1;
      let expected_updated_at = self.db.read(|conn| {
        let current = integration_instances::get(conn, id)?;
        Ok(current.updated_at)
      })?;
      let now = now_rfc3339();
      match self.db.transaction(|uow| {
        integration_instances::update_health(
          uow.conn(),
          id,
          &expected_updated_at,
          health,
          Some(&now),
          error_code,
          &now,
        )
      }) {
        Ok(()) => return Ok(()),
        Err(StorageError::Conflict(_)) if attempt < VALIDATION_HEALTH_WRITE_MAX_ATTEMPTS => continue,
        Err(err) => return Err(err),
      }
    }
  }

  /// Apply a remote validation result only if required credentials still match `expected`.
  /// Identity is re-checked inside the same write transaction on every CAS retry so a
  /// replace/clear between attempts cannot be stamped Ready from a stale grant.
  fn persist_remote_validation_health(
    &self,
    id: Uuid,
    registration: &crate::services::bundled_plugins::BundledPluginRegistration,
    expected: &[RequiredCredentialSnapshot],
    health: IntegrationHealthStatus,
    error_code: Option<&str>,
  ) -> Result<RemoteValidationPersist, StorageError> {
    let manifest = &registration.manifest;
    let mut attempt = 0u32;
    loop {
      attempt += 1;
      let now = now_rfc3339();
      let outcome = self.db.transaction(|uow| {
        let current = integration_instances::get(uow.conn(), id)?;
        let bindings = integration_credential_bindings::list_for_instance(uow.conn(), id)?;
        let has_required = required_slots_satisfied(manifest, &bindings);
        let config_ok = registration
          .config_adapter
          .normalize_config(&current.config_json)
          .is_ok()
          && registration.config_adapter.config_ready(&current.config_json);

        let (decision, write_health, write_code) = if !config_ok || !has_required {
          (
            RemoteValidationPersist::Unconfigured,
            IntegrationHealthStatus::Unconfigured,
            Some("invalid_configuration"),
          )
        } else if snapshot_required_credentials(manifest, &bindings) != expected {
          (
            RemoteValidationPersist::CredentialsChanged,
            IntegrationHealthStatus::Unvalidated,
            Some("credentials_changed"),
          )
        } else {
          (RemoteValidationPersist::Applied, health, error_code)
        };

        integration_instances::update_health(
          uow.conn(),
          id,
          &current.updated_at,
          write_health,
          Some(&now),
          write_code,
          &now,
        )?;
        Ok(decision)
      });

      match outcome {
        Ok(decision) => return Ok(decision),
        Err(StorageError::Conflict(_)) if attempt < VALIDATION_HEALTH_WRITE_MAX_ATTEMPTS => continue,
        Err(err) => return Err(err),
      }
    }
  }

  fn create(&self, input: IntegrationInstanceWrite) -> Result<IntegrationInstanceDto, StorageError> {
    let plugin_id = input.plugin_id.trim().to_string();
    validate_plugin_id(&plugin_id).map_err(StorageError::Validation)?;
    let registration = self
      .registry
      .get_registration(&plugin_id)
      .ok_or_else(|| StorageError::PluginUnavailable(plugin_id.clone()))?
      .clone();
    let manifest = &registration.manifest;

    let display_name = validate_display_name(&input.display_name)?;
    let config_json = normalize_and_validate_config(&registration, &input.config_json)?;
    let credential_map = collect_credential_updates(&input, manifest)?;

    // Pre-validate replace payloads before any vault write.
    for slot in &manifest.credential_slots {
      if let Some(CredentialUpdate::Replace(secret)) = credential_map.get(&slot.id) {
        validate_slot_secret(&registration, &slot.id, secret)?;
      } else if slot.required {
        // Create without required secret → unconfigured (allowed).
      }
    }

    let id = self
      .endpoint_trust
      .reserved_create_instance_id(input.endpoint_trust_preview_id.as_deref())?
      .unwrap_or_else(new_id);
    let now = now_rfc3339();
    let mut prepared_ops: Vec<CredentialOperation> = Vec::new();
    let mut slot_refs: HashMap<String, Option<String>> = HashMap::new();

    for slot in &manifest.credential_slots {
      let update = credential_map.get(&slot.id).cloned().unwrap_or(CredentialUpdate::Keep);
      match update {
        CredentialUpdate::Replace(secret) => {
          let op_id = new_id();
          let new_ref = integration_ref(id, &slot.id, op_id)?;
          match self.prepare_vault_write(op_id, &id.to_string(), &slot.id, None, &new_ref, &secret) {
            Ok(op) => {
              prepared_ops.push(op);
              slot_refs.insert(slot.id.clone(), Some(new_ref));
            }
            Err(e) => {
              for op in &prepared_ops {
                let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
              }
              return Err(e);
            }
          }
        }
        CredentialUpdate::Keep | CredentialUpdate::Clear => {
          slot_refs.insert(slot.id.clone(), None);
        }
      }
    }

    let health = compute_local_health(&registration, &config_json, &slot_refs);
    // Package-only create: every new integration requires an eligible authorized default
    // package. Genuine absence and blocked defaults fail closed without writing any row;
    // an unsupported runtime instance is never created.
    use crate::services::default_package_activation::PackageFirstCreateResolution;
    let package_first = match &self.default_package_activation {
      Some(svc) => match svc.prepare_package_first_create(&manifest.id)? {
        PackageFirstCreateResolution::NoDefault => {
          return Err(StorageError::Validation(
            "integration create requires an authorized default package; install and authorize it first".into(),
          ));
        }
        other => other,
      },
      None => {
        return Err(StorageError::Validation(
          "integration create requires an authorized default package".into(),
        ));
      }
    };
    let (
      runtime_kind,
      package_digest,
      runtime_state,
      runtime_requirement_json,
      plugin_version,
      runtime_error_code,
      runtime_error_message,
      package_first_digest,
      record_failed_intent,
    ) = match &package_first {
      PackageFirstCreateResolution::Ready(prepared) => (
        prepared.runtime_kind.clone(),
        Some(prepared.package_digest.clone()),
        "pending_activation".to_string(),
        Some(prepared.runtime_requirement_json.clone()),
        prepared.plugin_version.clone(),
        None,
        None,
        Some(prepared.package_digest.clone()),
        None,
      ),
      PackageFirstCreateResolution::Blocked(blocked) => (
        blocked.runtime_kind.clone(),
        Some(blocked.package_digest.clone()),
        "unavailable".to_string(),
        Some(blocked.runtime_requirement_json.clone()),
        blocked.plugin_version.clone(),
        Some(blocked.reason.as_error_code().to_string()),
        Some(blocked.reason.as_message().to_string()),
        Some(blocked.package_digest.clone()),
        Some((blocked.reason.as_error_code(), blocked.reason.as_message())),
      ),
      PackageFirstCreateResolution::NoDefault => {
        unreachable!("NoDefault is rejected before this match")
      }
    };
    let instance = IntegrationInstance {
      id,
      plugin_id: manifest.id.clone(),
      plugin_version,
      display_name,
      enabled: input.enabled,
      config_json,
      config_schema_version: manifest.config_schema_version,
      health_status: health,
      last_validated_at: None,
      last_error_code: None,
      runtime_kind: runtime_kind.clone(),
      package_digest: package_digest.clone(),
      execution_grant_set_revision: None,
      runtime_state,
      runtime_error_code,
      runtime_error_message,
      runtime_requirement_json,
      created_at: now.clone(),
      updated_at: now.clone(),
    };

    let endpoint_trust = match self.endpoint_trust.consume_for_save(
      id,
      &manifest.id,
      &manifest.version,
      &runtime_kind,
      package_digest.as_deref(),
      &instance.config_json,
      None,
      input.endpoint_trust_preview_id.as_deref(),
      input.acknowledge_endpoint_trust,
    ) {
      Ok(trust) => trust,
      Err(error) => {
        for op in &prepared_ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
        }
        return Err(error);
      }
    };

    let commit = self.db.transaction(|uow| {
      integration_instances::insert(uow.conn(), &instance)?;
      if let Some(trust) = &endpoint_trust {
        integration_endpoint_trusts::upsert(uow.conn(), trust)?;
      }
      if let Some(digest) = &package_first_digest {
        let intent = crate::services::default_package_activation::DefaultPackageActivationService::insert_local_creation_intent_on_conn(
          uow.conn(),
          crate::domain::runtime_lifecycle::GrantSubjectKind::IntegrationInstance,
          id,
          digest,
          Some(&crate::domain::plugin_package::sha256_hex(instance.config_json.as_bytes())),
          Some(&instance.updated_at),
        )?;
        if let Some((error_code, error_message)) = record_failed_intent {
          crate::repositories::default_package_activation_policies::update_intent_state(
            uow.conn(),
            intent.id,
            crate::domain::default_package_activation::DefaultRuntimeActivationState::Failed,
            Some(error_code),
            Some(error_message),
          )?;
        }
      }
      for slot in &manifest.credential_slots {
        let binding = crate::domain::service_integration::IntegrationCredentialBinding {
          id: new_id(),
          integration_instance_id: id,
          slot_id: slot.id.clone(),
          credential_ref: slot_refs.get(&slot.id).cloned().flatten(),
          credential_revision: 0,
          created_at: now.clone(),
          updated_at: now.clone(),
        };
        integration_credential_bindings::insert(uow.conn(), &binding)?;
      }
      let mut committed = Vec::new();
      for op in &prepared_ops {
        committed.push(credential_operations::mark_db_committed(uow.conn(), op.id)?);
      }
      Ok(committed)
    });

    match commit {
      Ok(ops) => {
        self
          .endpoint_trust
          .commit_preview_consumption(input.endpoint_trust_preview_id.as_deref());
        for op in ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        // Durable create returns pending package-first state immediately. Host command schedules
        // background activation after the first change event so the response stays prompt.
        let _ = package_first_digest;
        self.get_instance(id)
      }
      Err(e) => {
        for op in &prepared_ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
        }
        self
          .endpoint_trust
          .rollback_preview_consumption(input.endpoint_trust_preview_id.as_deref());
        Err(e)
      }
    }
  }

  fn update(&self, id: Uuid, input: IntegrationInstanceWrite) -> Result<IntegrationInstanceDto, StorageError> {
    let expected_updated_at = input
      .expected_updated_at
      .as_deref()
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .ok_or_else(|| StorageError::Validation("expected_updated_at is required on update".into()))?
      .to_string();

    let existing = self.db.read(|conn| integration_instances::get(conn, id))?;
    if existing.updated_at != expected_updated_at {
      return Err(StorageError::Conflict(
        "integration instance changed concurrently".into(),
      ));
    }
    if existing.plugin_id != input.plugin_id.trim() {
      return Err(StorageError::Validation("plugin_id is immutable after create".into()));
    }

    // Missing plugin: retain instance and block execution. set_enabled remains available for
    // metadata disable without a manifest. Full save requires the definition for schema/slots.
    let registration = match self.registry.get_registration(&existing.plugin_id) {
      Some(r) => r.clone(),
      None => {
        return Err(StorageError::PluginUnavailable(existing.plugin_id.clone()));
      }
    };
    let manifest = &registration.manifest;

    let display_name = validate_display_name(&input.display_name)?;
    let config_json = normalize_and_validate_config(&registration, &input.config_json)?;
    let retain_existing_endpoint_trust = input.endpoint_trust_preview_id.is_none()
      && !input.acknowledge_endpoint_trust
      && existing.config_json == config_json;
    let retained_endpoint_trust = if retain_existing_endpoint_trust {
      self.db.read(|conn| {
        self.endpoint_trust.current_approval_for_config(
          conn,
          id,
          &existing.plugin_id,
          &existing.plugin_version,
          &existing.runtime_kind,
          existing.package_digest.as_deref(),
          &config_json,
        )
      })?
    } else {
      None
    };
    let credential_map = collect_credential_updates(&input, manifest)?;

    let existing_bindings = self
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, id))?;
    let binding_by_slot: HashMap<String, _> = existing_bindings.into_iter().map(|b| (b.slot_id.clone(), b)).collect();

    // Validate replace secrets before any vault or journal work.
    for slot in &manifest.credential_slots {
      if let Some(CredentialUpdate::Replace(secret)) = credential_map.get(&slot.id) {
        validate_slot_secret(&registration, &slot.id, secret)?;
      }
    }

    // Preflight only slots that actually mutate credentials. Config-only Keep saves must not
    // require the OS vault (and must not be blocked by an unrelated stuck journal on a slot
    // that is not being changed).
    for slot in &manifest.credential_slots {
      let update = credential_map.get(&slot.id).cloned().unwrap_or(CredentialUpdate::Keep);
      let current_ref = binding_by_slot.get(&slot.id).and_then(|b| b.credential_ref.clone());
      let mutates = match update {
        CredentialUpdate::Keep => false,
        CredentialUpdate::Replace(_) => true,
        CredentialUpdate::Clear => current_ref.is_some(),
      };
      if mutates {
        coordinator::preflight_owner_slot(
          &self.db,
          self.vault.as_ref(),
          OwnerKind::Integration,
          &id.to_string(),
          &slot.id,
        )?;
      }
    }

    let mut prepared_ops: Vec<CredentialOperation> = Vec::new();
    // slot_id -> (expected_old_ref, new_ref) for CAS; None entry means keep.
    let mut slot_mutations: HashMap<String, Option<(Option<String>, Option<String>)>> = HashMap::new();

    for slot in &manifest.credential_slots {
      let update = credential_map.get(&slot.id).cloned().unwrap_or(CredentialUpdate::Keep);
      let current_ref = binding_by_slot.get(&slot.id).and_then(|b| b.credential_ref.clone());
      match update {
        CredentialUpdate::Keep => {
          slot_mutations.insert(slot.id.clone(), None);
        }
        CredentialUpdate::Replace(secret) => {
          let op_id = new_id();
          let new_ref = integration_ref(id, &slot.id, op_id)?;
          match self.prepare_vault_write(
            op_id,
            &id.to_string(),
            &slot.id,
            current_ref.as_deref(),
            &new_ref,
            &secret,
          ) {
            Ok(op) => {
              prepared_ops.push(op);
              slot_mutations.insert(slot.id.clone(), Some((current_ref, Some(new_ref))));
            }
            Err(e) => {
              for op in &prepared_ops {
                let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
              }
              return Err(e);
            }
          }
        }
        CredentialUpdate::Clear => {
          if current_ref.is_none() {
            slot_mutations.insert(slot.id.clone(), None);
            continue;
          }
          let op_id = new_id();
          match self.prepare_vault_clear(op_id, &id.to_string(), &slot.id, current_ref.as_deref()) {
            Ok(op) => {
              prepared_ops.push(op);
              slot_mutations.insert(slot.id.clone(), Some((current_ref, None)));
            }
            Err(e) => {
              for op in &prepared_ops {
                let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
              }
              return Err(e);
            }
          }
        }
      }
    }

    // Final slot ref map for health computation.
    let mut final_refs: HashMap<String, Option<String>> = HashMap::new();
    for slot in &manifest.credential_slots {
      let current_ref = binding_by_slot.get(&slot.id).and_then(|b| b.credential_ref.clone());
      match slot_mutations.get(&slot.id) {
        Some(Some((_, new_ref))) => {
          final_refs.insert(slot.id.clone(), new_ref.clone());
        }
        _ => {
          final_refs.insert(slot.id.clone(), current_ref);
        }
      }
    }
    let health = compute_local_health(&registration, &config_json, &final_refs);
    let endpoint_trust = if retain_existing_endpoint_trust {
      retained_endpoint_trust
    } else {
      match self.endpoint_trust.consume_for_save(
        id,
        &existing.plugin_id,
        &existing.plugin_version,
        &existing.runtime_kind,
        existing.package_digest.as_deref(),
        &config_json,
        Some(&expected_updated_at),
        input.endpoint_trust_preview_id.as_deref(),
        input.acknowledge_endpoint_trust,
      ) {
        Ok(trust) => trust,
        Err(error) => {
          for op in &prepared_ops {
            let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
          }
          return Err(error);
        }
      }
    };
    let remote_relevant_mutation = !config_values_equal(&existing.config_json, &config_json)
      || slot_mutations.values().any(|mutation| mutation.is_some());
    let refresh_edge_runtime_grant = existing.plugin_id == crate::domain::service_integration::EDGE_TTS_PLUGIN_ID
      && existing.runtime_kind
        == crate::domain::runtime_lifecycle::runtime_kind_as_str(
          crate::domain::runtime_plugin::RuntimeKind::WasmComponent,
        )
      && existing.package_digest.is_some()
      && existing.execution_grant_set_revision.is_some()
      && (existing.config_json != config_json
        || (input.endpoint_trust_preview_id.is_some() && input.acknowledge_endpoint_trust));
    let now = now_rfc3339();

    let commit = self.db.transaction(|uow| {
      integration_instances::compare_and_set(
        uow.conn(),
        id,
        &expected_updated_at,
        &display_name,
        input.enabled,
        &config_json,
        manifest.config_schema_version,
        health,
        existing.last_validated_at.as_deref(),
        existing.last_error_code.as_deref(),
        &now,
      )?;
      if remote_relevant_mutation {
        integration_capability_health::delete_for_instance(uow.conn(), id)?;
      }
      // Approval rows are exact to this saved config/runtime tuple. Replace the instance's
      // previous row set so changing origin, path, or runtime identity revokes stale approvals.
      self.endpoint_trust.revoke_for_instance(uow.conn(), id)?;
      if let Some(trust) = &endpoint_trust {
        integration_endpoint_trusts::upsert(uow.conn(), trust)?;
      }
      for (slot_id, mutation) in &slot_mutations {
        if let Some((expected_old, new_ref)) = mutation {
          integration_credential_bindings::compare_and_set_ref(
            uow.conn(),
            id,
            slot_id,
            expected_old.as_deref(),
            new_ref.as_deref(),
            &now,
          )?;
        }
      }
      let mut committed = Vec::new();
      for op in &prepared_ops {
        committed.push(credential_operations::mark_db_committed(uow.conn(), op.id)?);
      }
      if refresh_edge_runtime_grant {
        let lifecycle = self
          .runtime_lifecycle
          .as_ref()
          .ok_or_else(|| StorageError::Internal("active Edge TTS runtime cannot be refreshed by this host".into()))?;
        lifecycle.refresh_edge_tts_grant_for_instance_in_transaction(uow.conn(), id)?;
      }
      Ok(committed)
    });

    match commit {
      Ok(ops) => {
        self
          .endpoint_trust
          .commit_preview_consumption(input.endpoint_trust_preview_id.as_deref());
        let mutated_credentials = !ops.is_empty();
        for op in ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        if mutated_credentials {
          self.tokens.evict_instance(id);
        }
        self.get_instance(id)
      }
      Err(e) => {
        self
          .endpoint_trust
          .rollback_preview_consumption(input.endpoint_trust_preview_id.as_deref());
        for op in &prepared_ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
        }
        Err(e)
      }
    }
  }

  fn prepare_vault_write(
    &self,
    op_id: Uuid,
    owner_id: &str,
    slot_id: &str,
    expected_old_ref: Option<&str>,
    new_ref: &str,
    secret: &str,
  ) -> Result<CredentialOperation, StorageError> {
    let op = self.db.transaction(|uow| {
      credential_operations::insert_prepared_slot(
        uow.conn(),
        op_id,
        OwnerKind::Integration,
        owner_id,
        slot_id,
        expected_old_ref,
        Some(new_ref),
      )
    })?;
    if let Err(e) = self.vault.set(new_ref, secret) {
      // Vault never received the secret; drop the uncommitted journal without vault I/O.
      // finalize_operation would try vault.delete and can leave a stuck journal when the
      // OS credential store is unavailable (same pattern as providers/OCR).
      let _ = self.db.transaction(|uow| {
        credential_operations::delete(uow.conn(), op_id)?;
        Ok(())
      });
      return Err(e);
    }
    Ok(op)
  }

  fn prepare_vault_clear(
    &self,
    op_id: Uuid,
    owner_id: &str,
    slot_id: &str,
    expected_old_ref: Option<&str>,
  ) -> Result<CredentialOperation, StorageError> {
    self.db.transaction(|uow| {
      credential_operations::insert_prepared_slot(
        uow.conn(),
        op_id,
        OwnerKind::Integration,
        owner_id,
        slot_id,
        expected_old_ref,
        None,
      )
    })
  }

  fn to_dto(
    &self,
    conn: &rusqlite::Connection,
    instance: &IntegrationInstance,
    bindings: &[crate::domain::service_integration::IntegrationCredentialBinding],
  ) -> IntegrationInstanceDto {
    let registry_present = self.registry.contains(&instance.plugin_id);
    let credential_slots = if let Some(manifest) = self.registry.get(&instance.plugin_id) {
      let binding_map: HashMap<&str, _> = bindings.iter().map(|b| (b.slot_id.as_str(), b)).collect();
      manifest
        .credential_slots
        .iter()
        .map(|slot| {
          let binding = binding_map.get(slot.id.as_str());
          CredentialSlotStatusDto {
            slot_id: slot.id.clone(),
            has_credential: binding.and_then(|b| b.credential_ref.as_ref()).is_some(),
            credential_revision: binding.map(|b| b.credential_revision).unwrap_or(0),
          }
        })
        .collect()
    } else {
      bindings
        .iter()
        .map(|b| CredentialSlotStatusDto {
          slot_id: b.slot_id.clone(),
          has_credential: b.credential_ref.is_some(),
          credential_revision: b.credential_revision,
        })
        .collect()
    };

    let runtime_requirement = instance
      .runtime_requirement_json
      .as_deref()
      .and_then(|raw| serde_json::from_str(raw).ok());
    // Derive plugin_missing from missing package pin / unresolved runtime as well as registry miss.
    let plugin_present =
      if instance.runtime_kind == "wasm-component" || instance.runtime_kind == "trusted-native-worker" {
        match instance.package_digest.as_deref() {
          Some(digest) if instance.runtime_state == "active" && instance.execution_grant_set_revision.is_some() => self
            .db
            .read(|conn| crate::repositories::installed_plugin_versions::get_optional(conn, digest))
            .ok()
            .flatten()
            .map(|v| v.content_available)
            .unwrap_or(false),
          _ => false,
        }
      } else {
        registry_present
      };
    let effective = derive_effective_status(instance.enabled, plugin_present, instance.health_status);
    let endpoint_trust_status = self.endpoint_trust.status_for_instance(conn, instance).unwrap_or(
      if instance.plugin_id == crate::domain::service_integration::EDGE_TTS_PLUGIN_ID {
        EndpointTrustStatus::ReviewRequired
      } else {
        EndpointTrustStatus::NotApplicable
      },
    );
    let capability_health = integration_capability_health::list_for_instance(conn, instance.id)
      .unwrap_or_default()
      .into_iter()
      .map(|record| record.dto())
      .collect();

    IntegrationInstanceDto {
      id: instance.id,
      plugin_id: instance.plugin_id.clone(),
      plugin_version: instance.plugin_version.clone(),
      display_name: instance.display_name.clone(),
      enabled: instance.enabled,
      config_json: instance.config_json.clone(),
      config_schema_version: instance.config_schema_version,
      health_status: instance.health_status,
      effective_status: effective,
      endpoint_trust_status,
      last_validated_at: instance.last_validated_at.clone(),
      last_error_code: instance.last_error_code.clone(),
      runtime_kind: instance.runtime_kind.clone(),
      package_digest: instance.package_digest.clone(),
      execution_grant_set_revision: instance.execution_grant_set_revision,
      runtime_state: instance.runtime_state.clone(),
      runtime_error_code: instance.runtime_error_code.clone(),
      runtime_error_message: instance.runtime_error_message.clone(),
      runtime_requirement,
      capability_health,
      credential_slots,
      created_at: instance.created_at.clone(),
      updated_at: instance.updated_at.clone(),
    }
  }
}

fn validate_display_name(name: &str) -> Result<String, StorageError> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err(StorageError::Validation("display_name is required".into()));
  }
  if trimmed.len() > INTEGRATION_DISPLAY_NAME_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "display_name exceeds {INTEGRATION_DISPLAY_NAME_MAX_LEN} characters"
    )));
  }
  Ok(trimmed.to_string())
}

fn collect_credential_updates(
  input: &IntegrationInstanceWrite,
  manifest: &ServiceIntegrationManifest,
) -> Result<HashMap<String, CredentialUpdate>, StorageError> {
  let declared: HashMap<&str, _> = manifest.credential_slots.iter().map(|s| (s.id.as_str(), s)).collect();
  let mut map = HashMap::new();
  for entry in &input.credentials {
    validate_slot_id(&entry.slot_id).map_err(StorageError::Validation)?;
    if !declared.contains_key(entry.slot_id.as_str()) {
      return Err(StorageError::Validation(format!(
        "unknown credential slot: {}",
        entry.slot_id
      )));
    }
    if map.contains_key(&entry.slot_id) {
      return Err(StorageError::Validation(format!(
        "duplicate credential slot write: {}",
        entry.slot_id
      )));
    }
    map.insert(entry.slot_id.clone(), entry.credential.clone());
  }
  Ok(map)
}

fn config_values_equal(left: &str, right: &str) -> bool {
  match (
    serde_json::from_str::<serde_json::Value>(left),
    serde_json::from_str::<serde_json::Value>(right),
  ) {
    (Ok(left), Ok(right)) => left == right,
    _ => left == right,
  }
}

fn normalize_and_validate_config(
  registration: &crate::services::bundled_plugins::BundledPluginRegistration,
  config_json: &str,
) -> Result<String, StorageError> {
  if config_json.len() > INTEGRATION_CONFIG_JSON_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "config_json exceeds {INTEGRATION_CONFIG_JSON_MAX_LEN} bytes"
    )));
  }
  registration.config_adapter.normalize_config(config_json)
}

fn validate_slot_secret(
  registration: &crate::services::bundled_plugins::BundledPluginRegistration,
  slot_id: &str,
  secret: &str,
) -> Result<(), StorageError> {
  if secret.len() > SERVICE_ACCOUNT_JSON_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "credential exceeds {SERVICE_ACCOUNT_JSON_MAX_LEN} bytes"
    )));
  }
  if secret.trim().is_empty() {
    return Err(StorageError::Validation("credential value is required".into()));
  }
  match registration.credential_validators.get(slot_id) {
    Some(validator) => validator.validate(secret),
    None => Ok(()),
  }
}

fn required_slots_satisfied(
  manifest: &ServiceIntegrationManifest,
  bindings: &[crate::domain::service_integration::IntegrationCredentialBinding],
) -> bool {
  let binding_map: HashMap<&str, _> = bindings.iter().map(|b| (b.slot_id.as_str(), b)).collect();
  manifest.credential_slots.iter().all(|slot| {
    if !slot.required {
      return true;
    }
    binding_map
      .get(slot.id.as_str())
      .and_then(|b| b.credential_ref.as_ref())
      .is_some()
  })
}

/// Capture required slot ref + revision before remote validation.
fn snapshot_required_credentials(
  manifest: &ServiceIntegrationManifest,
  bindings: &[crate::domain::service_integration::IntegrationCredentialBinding],
) -> Vec<RequiredCredentialSnapshot> {
  let binding_map: HashMap<&str, _> = bindings.iter().map(|b| (b.slot_id.as_str(), b)).collect();
  let mut snapshot: Vec<RequiredCredentialSnapshot> = manifest
    .credential_slots
    .iter()
    .filter(|slot| slot.required)
    .map(|slot| {
      let binding = binding_map.get(slot.id.as_str());
      RequiredCredentialSnapshot {
        slot_id: slot.id.clone(),
        credential_ref: binding.and_then(|b| b.credential_ref.clone()),
        credential_revision: binding.map(|b| b.credential_revision).unwrap_or(0),
      }
    })
    .collect();
  snapshot.sort_by(|a, b| a.slot_id.cmp(&b.slot_id));
  snapshot
}

/// True when the grant's revision matches every required binding revision in the snapshot.
/// Multi-slot manifests share one grant revision only when all required slots agree.
fn grant_matches_credential_snapshot(grant: &TokenGrant, snapshot: &[RequiredCredentialSnapshot]) -> bool {
  if snapshot.is_empty() {
    return true;
  }
  let grant_revision = grant.credential_revision();
  snapshot.iter().all(|entry| entry.credential_revision == grant_revision)
}

/// PaddleOCR health stays Degraded until a vendor package is activated and the model is ready.
fn is_paddleocr_native_health_gate(instance: &crate::domain::service_integration::IntegrationInstance) -> bool {
  instance.plugin_id == crate::domain::service_integration::PADDLEOCR_PLUGIN_ID
    || instance.runtime_kind == "trusted-native-worker"
}

impl ServiceIntegrationService {
  /// Ready only when the **signed** package's first model resource is Ready at the exact
  /// id/version/model_api_version — same vendor-root re-verify seam as RuntimeRouter.
  fn paddleocr_first_model_ready(&self, package_digest: &str) -> Result<bool, StorageError> {
    use crate::domain::plugin_model::PluginModelResourceStatus;
    use crate::domain::runtime_plugin::PluginManifestV1;

    let version = self
      .db
      .read(|conn| crate::repositories::installed_plugin_versions::get_optional(conn, package_digest))?;
    let Some(version) = version else {
      return Ok(false);
    };
    if !version.content_available {
      return Ok(false);
    }

    // Production path: first model identity comes from installed-package verification mode.
    // Mutable DB `manifest_json` is never the trust root when packages are wired (matches RuntimeRouter).
    let manifest: PluginManifestV1 = if let Some(packages) = &self.plugin_packages {
      let verified = match packages.verify_installed_package_snapshot(package_digest) {
        Ok(verified) => verified,
        Err(_) => return Ok(false),
      };
      if verified.package_digest != package_digest {
        return Ok(false);
      }
      verified.manifest
    } else {
      // Unit-test path without a package service: preserve the same publisher/native-risk
      // eligibility checks before parsing mutable catalog JSON. Production always injects
      // plugin_packages and additionally verifies the retained archive/content snapshot.
      if version.signature_status == crate::domain::plugin_package::PackageSignatureStatus::Signed {
        let publisher = self
          .db
          .read(|conn| crate::repositories::plugin_publishers::get(conn, &version.publisher_key_id))?;
        if publisher.revoked || !publisher.enabled {
          return Ok(false);
        }
        if version.runtime_kind == "trusted-native-worker"
          && publisher.source != crate::domain::plugin_package::PublisherSource::Vendor
          && !self.db.read(|conn| {
            crate::repositories::plugin_package_approvals::native_risk_acknowledged_for_digest(conn, package_digest)
          })?
        {
          return Ok(false);
        }
      }
      match serde_json::from_str(&version.manifest_json) {
        Ok(m) => m,
        Err(_) => return Ok(false),
      }
    };

    let Some(first) = manifest.model_resources.as_ref().and_then(|list| list.first()) else {
      return Ok(false);
    };
    let row = self.db.read(|conn| {
      crate::repositories::plugin_model_resources::get_by_package_and_model(conn, package_digest, &first.id)
    })?;
    let Some(row) = row else {
      return Ok(false);
    };
    Ok(
      row.status == PluginModelResourceStatus::Ready
        && row.model_version == first.version
        && row.model_api_version == first.model_api_version,
    )
  }
}

fn compute_local_health(
  registration: &crate::services::bundled_plugins::BundledPluginRegistration,
  config_json: &str,
  slot_refs: &HashMap<String, Option<String>>,
) -> IntegrationHealthStatus {
  let config_ok = registration.config_adapter.config_ready(config_json);
  let credentials_ok = registration.manifest.credential_slots.iter().all(|slot| {
    if !slot.required {
      return true;
    }
    slot_refs.get(&slot.id).and_then(|r| r.as_ref()).is_some()
  });
  if !config_ok || !credentials_ok {
    IntegrationHealthStatus::Unconfigured
  } else if registration.manifest.id == crate::domain::service_integration::PADDLEOCR_PLUGIN_ID {
    // PaddleOCR is credential-free but still requires vendor package pin + model download.
    // Keep create-time health out of Ready until validate_instance confirms readiness.
    IntegrationHealthStatus::Unvalidated
  } else if !registration.requires_remote_auth() {
    // Credential-free integrations become Ready from local config alone.
    IntegrationHealthStatus::Ready
  } else {
    // Credential-bearing integrations stay Unvalidated until remote token grant succeeds.
    IntegrationHealthStatus::Unvalidated
  }
}

fn remote_validation_capability_id(manifest: &ServiceIntegrationManifest) -> String {
  let ids: Vec<&str> = manifest
    .capabilities
    .iter()
    .map(|capability| capability.id.as_str())
    .collect();
  if ids.contains(&crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID)
    && !ids.iter().any(|id| id.starts_with("translate."))
  {
    return crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID.to_string();
  }
  if ids.contains(&"translate.text@1") {
    return "translate.text@1".into();
  }
  ids.first().copied().unwrap_or("translate.text@1").to_string()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::credentials::{FailingCredentialVault, MemoryCredentialVault};
  use crate::domain::endpoint_trust::EndpointTrustPreviewInput;
  use crate::domain::provider::ProxyMode;
  use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
  use crate::domain::service_integration::{
    EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
    GOOGLE_OAUTH_TOKEN_URI, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, GoogleCloudConfigV1, GoogleTranslateWebChannel,
    GoogleTranslateWebConfigV1, IntegrationEffectiveStatus, IntegrationSlotCredentialWrite, PADDLEOCR_PLUGIN_ID,
  };
  use crate::services::google_cloud::GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID;

  use crate::services::service_capabilities::ServiceCapabilityService;
  use crate::services::token_grant::{
    ExchangedToken, GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID, TokenExchanger, TokenInjectionKind,
  };
  use std::future::Future;
  use std::path::Path;
  use std::pin::Pin;

  #[test]
  fn ocr_only_remote_integration_validation_uses_declared_capability() {
    let manifest = ServiceIntegrationManifest {
      manifest_version: 1,
      plugin_api_version: "1.0".into(),
      id: crate::domain::service_integration::BAIDU_OCR_PLUGIN_ID.into(),
      version: "1.0.0".into(),
      display_name_key: "baidu-ocr".into(),
      min_host_version: "0.1.0".into(),
      config_schema_version: 1,
      credential_slots: vec![],
      endpoints: vec![],
      capabilities: vec![crate::domain::service_integration::IntegrationCapabilityDescriptor {
        id: crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID.into(),
        preferences_schema_version: 1,
        endpoint_aliases: vec!["baidu-accurate".into()],
      }],
    };
    assert_eq!(
      remote_validation_capability_id(&manifest),
      crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID
    );
  }

  struct StubTokenExchanger {
    fail: bool,
  }

  impl TokenExchanger for StubTokenExchanger {
    fn driver_id(&self) -> &'static str {
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID
    }

    fn injection_kind(&self) -> TokenInjectionKind {
      TokenInjectionKind::BearerHeader
    }

    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      _cancel: Option<CancelToken>,
    ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      let fail = self.fail;
      Box::pin(async move {
        if fail {
          return Err(CapabilityError::new(CapabilityErrorCode::Auth, "oauth denied"));
        }
        Ok(ExchangedToken {
          access_token: "ya29.test".into(),
          expires_in: 3600,
          // Matches create-with-secret binding revision (starts at 0).
          credential_revision: 0,
        })
      })
    }
  }

  /// Hangs the exchange future while a detached watcher records cancel-token trips.
  struct HangUntilCancelExchanger {
    cancelled: Arc<std::sync::atomic::AtomicBool>,
  }

  impl TokenExchanger for HangUntilCancelExchanger {
    fn driver_id(&self) -> &'static str {
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID
    }

    fn injection_kind(&self) -> TokenInjectionKind {
      TokenInjectionKind::BearerHeader
    }

    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      cancel: Option<CancelToken>,
    ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      let cancelled = self.cancelled.clone();
      Box::pin(async move {
        if let Some(token) = cancel {
          // Detached so observation survives select! dropping the acquire future.
          let flag = cancelled.clone();
          tokio::spawn(async move {
            token.cancelled().await;
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
          });
        }
        std::future::pending::<()>().await;
        unreachable!()
      })
    }
  }

  /// Blocks until `release` is notified, then returns a successful token.
  struct GateExchanger {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    /// Revision reported by the in-flight exchange (must match the secret it used).
    credential_revision: i64,
  }

  impl TokenExchanger for GateExchanger {
    fn driver_id(&self) -> &'static str {
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID
    }

    fn injection_kind(&self) -> TokenInjectionKind {
      TokenInjectionKind::BearerHeader
    }

    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      _cancel: Option<CancelToken>,
    ) -> Pin<Box<dyn Future<Output = Result<ExchangedToken, CapabilityError>> + Send + '_>> {
      let started = self.started.clone();
      let release = self.release.clone();
      let credential_revision = self.credential_revision;
      Box::pin(async move {
        started.notify_one();
        release.notified().await;
        Ok(ExchangedToken {
          access_token: "ya29.gated".into(),
          expires_in: 3600,
          credential_revision,
        })
      })
    }
  }

  fn setup_gated_validation() -> (
    tempfile::TempDir,
    ServiceIntegrationService,
    Arc<tokio::sync::Notify>,
    Arc<tokio::sync::Notify>,
  ) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let tokens = Arc::new(
      TokenGrantService::new(vec![Arc::new(GateExchanger {
        started: started.clone(),
        release: release.clone(),
        credential_revision: 0,
      })])
      .unwrap(),
    );
    let service =
      package_first_service(db, vault, registry, tokens, dir.path()).with_validation_timeout(Duration::from_secs(5));
    (dir, service, started, release)
  }

  fn capability_service_at(path: &Path) -> ServiceCapabilityService {
    let db = Database::new(path).unwrap();
    let defs = Arc::new(ServiceIntegrationRegistry::empty());
    ServiceCapabilityService::new(db, defs)
  }

  fn assert_capability_rejects_unconfigured(path: &Path, instance_id: Uuid) {
    // Registry-less resolver: either the (unconfigured) health gate rejects with
    // InvalidConfiguration once definitions are wired, or the absent router fails closed with
    // PluginUnavailable. Dispatch must never succeed.
    let caps = capability_service_at(path);
    let err = match caps.resolve_translate(instance_id, GOOGLE_TRANSLATE_TEXT_CAPABILITY_ID, b"{}".to_vec()) {
      Ok(_) => panic!("unconfigured instance must fail capability resolve"),
      Err(e) => e,
    };
    assert!(
      matches!(
        err.code,
        CapabilityErrorCode::InvalidConfiguration | CapabilityErrorCode::PluginUnavailable
      ),
      "got {:?}",
      err.code
    );
  }

  fn setup() -> (tempfile::TempDir, ServiceIntegrationService, Arc<MemoryCredentialVault>) {
    setup_with_exchanger(false)
  }

  fn tokens_stub(fail_exchange: bool) -> Arc<TokenGrantService> {
    Arc::new(TokenGrantService::new(vec![Arc::new(StubTokenExchanger { fail: fail_exchange })]).unwrap())
  }

  /// Install and authorize the google-cloud + edge-tts default packages, returning a
  /// package-first service. Package-only: create requires an authorized default.
  fn package_first_service(
    db: Database,
    vault: Arc<dyn CredentialVault>,
    registry: Arc<ServiceIntegrationRegistry>,
    tokens: Arc<TokenGrantService>,
    dir: &std::path::Path,
  ) -> ServiceIntegrationService {
    use crate::services::default_package_activation::DefaultPackageActivationService;
    use crate::services::plugin_store::PluginPackageService;
    use crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key;

    let packages =
      PluginPackageService::with_vendor_roots(db.clone(), dir.to_path_buf(), vec![fixture_vendor_public_key()]);
    let activation = DefaultPackageActivationService::create(db.clone(), packages.clone(), dir);
    {
      let bytes: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/google-cloud/fixtures/com.langnext.google-cloud-1.2.0.lnplugin"
      ));
      authorize_default(&packages, &activation, bytes);
      let bytes: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/edge-tts/fixtures/com.langnext.edge-tts-1.0.0.lnplugin"
      ));
      authorize_default(&packages, &activation, bytes);
      let bytes: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../runtime-plugins/paddleocr/fixtures/packages/com.langnext.paddleocr-1.0.0.lnplugin"
      ));
      authorize_default(&packages, &activation, bytes);
      // The production google-translate-web archive is not committed as a fixture; install
      // the synthetic package built from the committed guest artifacts and schemas.
      let (gtw, _) = crate::services::test_support::google_translate_web_package();
      authorize_default(&packages, &activation, &gtw);
    }
    // Project installed package definitions into the registry exactly like production bootstrap.
    let mut registry = (*registry).clone();
    for definition in packages
      .project_installed_service_definitions()
      .expect("project installed definitions")
    {
      registry
        .upsert_package_definition(definition)
        .expect("upsert package definition");
    }
    ServiceIntegrationService::new(db, vault, Arc::new(registry), tokens).with_default_package_activation(activation)
  }

  fn authorize_default(
    packages: &crate::services::plugin_store::PluginPackageService,
    activation: &crate::services::default_package_activation::DefaultPackageActivationService,
    bytes: &[u8],
  ) {
    use crate::domain::default_package_activation::AuthorizeDefaultPluginPackageInput;
    let import = packages
      .bootstrap_bundled_package(bytes, false)
      .expect("vendor package bootstraps");
    let digest = import.package_digest().to_string();
    let preview = activation
      .preview_default_package_activation(&digest)
      .expect("preview default activation");
    activation
      .authorize_default_plugin_package(AuthorizeDefaultPluginPackageInput {
        preview_id: preview.preview_id,
        acknowledge_future_instance_authority: true,
        acknowledge_unsigned_default_risk: false,
      })
      .expect("authorize default package");
  }

  fn setup_with_exchanger(
    fail_exchange: bool,
  ) -> (tempfile::TempDir, ServiceIntegrationService, Arc<MemoryCredentialVault>) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let service = package_first_service(
      db,
      vault.clone() as Arc<dyn CredentialVault>,
      registry,
      tokens_stub(fail_exchange),
      dir.path(),
    );
    (dir, service, vault)
  }

  fn valid_sa_json() -> String {
    serde_json::json!({
      "type": "service_account",
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
      "token_uri": GOOGLE_OAUTH_TOKEN_URI,
    })
    .to_string()
  }

  fn google_config(project_id: &str) -> String {
    serde_json::to_string(&GoogleCloudConfigV1 {
      project_id: project_id.into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: ProxyMode::Inherit,
    })
    .unwrap()
  }

  fn write_create(with_secret: bool) -> IntegrationInstanceWrite {
    let mut credentials = Vec::new();
    if with_secret {
      credentials.push(IntegrationSlotCredentialWrite {
        slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
        credential: CredentialUpdate::Replace(valid_sa_json()),
      });
    }
    IntegrationInstanceWrite {
      id: None,
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      display_name: "GCP Main".into(),
      enabled: true,
      config_json: google_config("my-project"),
      credentials,
      expected_updated_at: None,
      endpoint_trust_preview_id: None,
      acknowledge_endpoint_trust: false,
    }
  }

  #[test]
  fn service_integrations_create_unvalidated_with_secret() {
    let (_d, service, vault) = setup();
    let dto = service.save(write_create(true)).unwrap();
    assert_eq!(dto.plugin_id, GOOGLE_CLOUD_PLUGIN_ID);
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unvalidated);
    // The package-first pin awaits background activation; until then the instance derives
    // PluginMissing (no executable runtime) exactly like a missing package.
    assert_eq!(dto.effective_status, IntegrationEffectiveStatus::PluginMissing);
    assert_eq!(dto.runtime_kind, "wasm-component");
    assert!(dto.package_digest.is_some());
    assert_eq!(dto.runtime_state, "pending_activation");
    assert_eq!(dto.credential_slots.len(), 1);
    assert!(dto.credential_slots[0].has_credential);
    // DTO never echoes secret or ref.
    let serialized = serde_json::to_string(&dto).unwrap();
    assert!(!serialized.contains("private_key"));
    assert!(!serialized.contains("BEGIN PRIVATE KEY"));
    assert!(!serialized.contains("integration/"));
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_create_unconfigured_without_secret() {
    let (_d, service, _vault) = setup();
    let dto = service.save(write_create(false)).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unconfigured);
    assert!(!dto.credential_slots[0].has_credential);
  }

  #[test]
  fn service_integrations_rejects_bad_service_account() {
    let (_d, service, vault) = setup();
    let mut input = write_create(true);
    input.credentials[0].credential = CredentialUpdate::Replace(r#"{"client_email":"x"}"#.into());
    // Structurally valid JSON slot stores on create; the malformed service account fails
    // closed at credential exchange time (validate_instance), never Ready.
    let created = service.save(input).unwrap();
    assert_eq!(created.health_status, IntegrationHealthStatus::Unvalidated);
    assert_ne!(created.effective_status, IntegrationEffectiveStatus::Ready);
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_rejects_custom_base_url() {
    let (_d, service, _vault) = setup();
    let mut input = write_create(false);
    input.config_json =
      r#"{"projectId":"p","location":"global","proxyMode":"inherit","baseUrl":"https://evil"}"#.into();
    let err = service.save(input).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("baseUrl")));
  }

  #[test]
  fn custom_edge_endpoint_requires_preview_acknowledgement_and_revokes_on_default_save() {
    let (directory, service, _vault) = setup();
    let custom_config = r#"{"base-url":"https://custom.example/api/"}"#;
    let create = IntegrationInstanceWrite {
      id: None,
      plugin_id: EDGE_TTS_PLUGIN_ID.into(),
      display_name: "Edge TTS".into(),
      enabled: true,
      config_json: custom_config.into(),
      credentials: vec![],
      expected_updated_at: None,
      endpoint_trust_preview_id: None,
      acknowledge_endpoint_trust: false,
    };
    let error = service.save(create.clone()).unwrap_err();
    assert!(matches!(error, StorageError::EndpointTrustRequired(_)));

    let preview = service
      .preview_endpoint_trust(EndpointTrustPreviewInput {
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        instance_id: None,
        config_json: custom_config.into(),
        expected_updated_at: None,
      })
      .unwrap();
    let created = service
      .save(IntegrationInstanceWrite {
        endpoint_trust_preview_id: Some(preview.preview_id),
        acknowledge_endpoint_trust: true,
        ..create
      })
      .unwrap();
    assert_eq!(created.endpoint_trust_status, EndpointTrustStatus::TrustedCustom);
    let database = Database::new(directory.path()).unwrap();
    assert_eq!(
      database
        .read(|conn| integration_endpoint_trusts::count_for_instance(conn, created.id))
        .unwrap(),
      1
    );

    let renamed = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        display_name: "Edge TTS renamed".into(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![],
        expected_updated_at: Some(created.updated_at.clone()),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(renamed.endpoint_trust_status, EndpointTrustStatus::TrustedCustom);
    assert_eq!(
      database
        .read(|conn| integration_endpoint_trusts::count_for_instance(conn, renamed.id))
        .unwrap(),
      1
    );

    let default = service
      .save(IntegrationInstanceWrite {
        id: Some(renamed.id),
        plugin_id: EDGE_TTS_PLUGIN_ID.into(),
        display_name: renamed.display_name,
        enabled: true,
        config_json: r#"{"base-url":"https://tts.wangwangit.com"}"#.into(),
        credentials: vec![],
        expected_updated_at: Some(renamed.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(default.endpoint_trust_status, EndpointTrustStatus::Official);
    assert_eq!(
      database
        .read(|conn| integration_endpoint_trusts::count_for_instance(conn, default.id))
        .unwrap(),
      0
    );
  }

  #[test]
  fn service_integrations_update_clear_and_conflict() {
    let (_d, service, vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    assert_eq!(vault.len(), 1);

    let cleared = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Clear,
        }],
        expected_updated_at: Some(created.updated_at.clone()),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert!(!cleared.credential_slots[0].has_credential);
    assert_eq!(cleared.health_status, IntegrationHealthStatus::Unconfigured);
    assert_eq!(cleared.credential_slots[0].credential_revision, 1);
    assert_eq!(vault.len(), 0);

    let err = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "x".into(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![],
        expected_updated_at: Some(created.updated_at), // stale
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Conflict(_)));
  }

  #[test]
  fn service_integrations_disable_preserves_health() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    assert_eq!(created.health_status, IntegrationHealthStatus::Unvalidated);
    let disabled = service.set_enabled(created.id, false).unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.health_status, IntegrationHealthStatus::Unvalidated);
    // Health is preserved; the pending package pin still derives PluginMissing (the runtime
    // exists only after activation, independent of the enabled toggle).
    assert_eq!(disabled.effective_status, IntegrationEffectiveStatus::PluginMissing);
    let enabled = service.set_enabled(created.id, true).unwrap();
    assert_eq!(enabled.effective_status, IntegrationEffectiveStatus::PluginMissing);
  }

  #[tokio::test]
  async fn service_integration_validation_ready_on_token_success() {
    let (_d, service, _vault) = setup_with_exchanger(false);
    let created = service.save(write_create(true)).unwrap();
    let result = service.validate_instance(created.id).await.unwrap();
    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Ready);
    assert!(
      result
        .message
        .as_deref()
        .unwrap_or("")
        .contains("Credentials validated")
    );
    assert!(result.message.as_deref().unwrap_or("").contains("not verified"));
  }

  #[tokio::test]
  async fn service_integration_validation_degraded_on_auth_failure() {
    let (_d, service, _vault) = setup_with_exchanger(true);
    let created = service.save(write_create(true)).unwrap();
    let result = service.validate_instance(created.id).await.unwrap();
    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Degraded);
    assert_eq!(result.message.as_deref(), Some("oauth denied"));
    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.last_error_code.as_deref(), Some("auth"));
  }

  #[tokio::test]
  async fn service_integration_validation_unconfigured_without_secret() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(false)).unwrap();
    let result = service.validate_instance(created.id).await.unwrap();
    assert!(!result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Unconfigured);
  }

  #[tokio::test]
  async fn service_integration_validation_timeout_cancels_in_flight_exchange() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let tokens = Arc::new(
      TokenGrantService::new(vec![Arc::new(HangUntilCancelExchanger {
        cancelled: cancelled.clone(),
      })])
      .unwrap(),
    );
    // Short wall-clock timeout (no tokio test-util feature in this crate).
    let service =
      package_first_service(db, vault, registry, tokens, dir.path()).with_validation_timeout(Duration::from_millis(50));

    let created = service.save(write_create(true)).unwrap();
    let result = service.validate_instance(created.id).await.unwrap();

    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Degraded);
    assert_eq!(result.message.as_deref(), Some("credential validation timed out"));
    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.last_error_code.as_deref(), Some("timeout"));

    // Detached cancel watcher may need a brief yield after select completes.
    for _ in 0..20 {
      if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        break;
      }
      tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
      cancelled.load(std::sync::atomic::Ordering::SeqCst),
      "timeout branch must cancel the in-flight token exchange"
    );
  }

  #[tokio::test]
  async fn service_integration_validation_prefers_acquire_when_timeout_also_ready() {
    // Duration::ZERO makes the timeout branch immediately ready. Stub acquire is also ready.
    // biased + acquire-first must prefer the token result over a synthetic timeout.
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let service = package_first_service(db, vault, registry, tokens_stub(false), dir.path())
      .with_validation_timeout(Duration::ZERO);

    let created = service.save(write_create(true)).unwrap();
    let result = service.validate_instance(created.id).await.unwrap();

    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Ready);
    assert_ne!(result.message.as_deref(), Some("credential validation timed out"));
    let dto = service.get_instance(created.id).unwrap();
    assert_ne!(dto.last_error_code.as_deref(), Some("timeout"));
  }

  #[tokio::test]
  async fn service_integration_validation_survives_concurrent_save() {
    let (_dir, service, started, release) = setup_gated_validation();

    let created = service.save(write_create(true)).unwrap();
    let original_updated_at = created.updated_at.clone();
    let instance_id = created.id;

    let validate_service = service.clone();
    let validate_task = tokio::spawn(async move { validate_service.validate_instance(instance_id).await });

    // Wait until remote exchange is in flight (simulates long-running validation).
    tokio::time::timeout(Duration::from_secs(2), started.notified())
      .await
      .expect("exchange should start");

    // Concurrent rename advances `updated_at` without changing credential identity.
    let renamed = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "Renamed During Validate".into(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![],
        expected_updated_at: Some(original_updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_ne!(renamed.updated_at, created.updated_at);
    assert_eq!(renamed.display_name, "Renamed During Validate");

    release.notify_one();
    let result = validate_task
      .await
      .unwrap()
      .expect("validation must not surface concurrent save as failure");

    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Ready);

    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.display_name, "Renamed During Validate");
    assert_eq!(dto.config_json, created.config_json);
    assert_eq!(dto.health_status, IntegrationHealthStatus::Ready);
    assert!(dto.last_validated_at.is_some());
  }

  #[tokio::test]
  async fn service_integration_validation_discards_stale_ready_after_concurrent_replace() {
    let (_dir, service, started, release) = setup_gated_validation();

    let created = service.save(write_create(true)).unwrap();
    assert_eq!(created.credential_slots[0].credential_revision, 0);
    let original_updated_at = created.updated_at.clone();
    let instance_id = created.id;

    let validate_service = service.clone();
    let validate_task = tokio::spawn(async move { validate_service.validate_instance(instance_id).await });

    tokio::time::timeout(Duration::from_secs(2), started.notified())
      .await
      .expect("exchange should start");

    // Replace secret while the old grant is still in flight.
    let replaced = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(original_updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(replaced.credential_slots[0].credential_revision, 1);
    assert_eq!(replaced.health_status, IntegrationHealthStatus::Unvalidated);

    release.notify_one();
    let result = validate_task
      .await
      .unwrap()
      .expect("credential race must not surface as Storage Conflict");

    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(result.message.as_deref(), Some(VALIDATION_CREDENTIALS_CHANGED_MESSAGE));

    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(dto.last_error_code.as_deref(), Some("credentials_changed"));
    assert_eq!(dto.credential_slots[0].credential_revision, 1);
  }

  #[tokio::test]
  async fn service_integration_validation_keeps_unconfigured_after_concurrent_clear() {
    let (dir, service, started, release) = setup_gated_validation();

    let created = service.save(write_create(true)).unwrap();
    let original_updated_at = created.updated_at.clone();
    let instance_id = created.id;

    let validate_service = service.clone();
    let validate_task = tokio::spawn(async move { validate_service.validate_instance(instance_id).await });

    tokio::time::timeout(Duration::from_secs(2), started.notified())
      .await
      .expect("exchange should start");

    // Clear secret while the old grant is still in flight.
    let cleared = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Clear,
        }],
        expected_updated_at: Some(original_updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert!(!cleared.credential_slots[0].has_credential);
    assert_eq!(cleared.health_status, IntegrationHealthStatus::Unconfigured);

    release.notify_one();
    let result = validate_task
      .await
      .unwrap()
      .expect("credential race must not surface as Storage Conflict");

    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Unconfigured);
    assert_ne!(result.health_status, IntegrationHealthStatus::Ready);

    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unconfigured);
    assert_eq!(dto.last_error_code.as_deref(), Some("invalid_configuration"));
    assert!(!dto.credential_slots[0].has_credential);
    assert_ne!(dto.effective_status, IntegrationEffectiveStatus::Ready);
    assert_capability_rejects_unconfigured(dir.path(), created.id);
  }

  #[tokio::test]
  async fn service_integration_validation_keeps_unconfigured_after_replace_then_clear() {
    let (dir, service, started, release) = setup_gated_validation();

    let created = service.save(write_create(true)).unwrap();
    let original_updated_at = created.updated_at.clone();
    let instance_id = created.id;

    let validate_service = service.clone();
    let validate_task = tokio::spawn(async move { validate_service.validate_instance(instance_id).await });

    tokio::time::timeout(Duration::from_secs(2), started.notified())
      .await
      .expect("exchange should start");

    // Replace then Clear while the old grant is still in flight — final Clear must win.
    let replaced = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(original_updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(replaced.credential_slots[0].credential_revision, 1);
    assert_eq!(replaced.health_status, IntegrationHealthStatus::Unvalidated);

    let cleared = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Clear,
        }],
        expected_updated_at: Some(replaced.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert!(!cleared.credential_slots[0].has_credential);
    assert_eq!(cleared.health_status, IntegrationHealthStatus::Unconfigured);

    release.notify_one();
    let result = validate_task
      .await
      .unwrap()
      .expect("replace-then-clear race must not surface as Storage Conflict");

    assert!(result.remote_checked);
    assert_eq!(result.health_status, IntegrationHealthStatus::Unconfigured);

    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unconfigured);
    assert_eq!(dto.last_error_code.as_deref(), Some("invalid_configuration"));
    assert!(!dto.credential_slots[0].has_credential);
    assert_capability_rejects_unconfigured(dir.path(), created.id);
  }

  #[test]
  fn service_integration_stale_discard_keeps_unconfigured_after_clear() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    let registration = service
      .registry
      .get_registration(GOOGLE_CLOUD_PLUGIN_ID)
      .unwrap()
      .clone();
    let manifest = &registration.manifest;
    let bindings = service
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, created.id))
      .unwrap();
    let snapshot = snapshot_required_credentials(manifest, &bindings);

    let cleared = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Clear,
        }],
        expected_updated_at: Some(created.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(cleared.health_status, IntegrationHealthStatus::Unconfigured);

    // Simulate credentials_changed / grant-revision early discard after a concurrent Clear.
    let result = service
      .finish_stale_remote_validation(created.id, &registration, &snapshot)
      .unwrap();
    assert_eq!(result.health_status, IntegrationHealthStatus::Unconfigured);
    assert_eq!(
      result.message.as_deref(),
      Some("configuration or required credentials are incomplete")
    );

    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unconfigured);
    assert_eq!(dto.last_error_code.as_deref(), Some("invalid_configuration"));
  }

  #[test]
  fn service_integration_stale_discard_keeps_unvalidated_after_replace() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    let registration = service
      .registry
      .get_registration(GOOGLE_CLOUD_PLUGIN_ID)
      .unwrap()
      .clone();
    let manifest = &registration.manifest;
    let bindings = service
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, created.id))
      .unwrap();
    let snapshot = snapshot_required_credentials(manifest, &bindings);

    let replaced = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(created.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(replaced.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(replaced.credential_slots[0].credential_revision, 1);

    let result = service
      .finish_stale_remote_validation(created.id, &registration, &snapshot)
      .unwrap();
    assert_eq!(result.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(result.message.as_deref(), Some(VALIDATION_CREDENTIALS_CHANGED_MESSAGE));

    let dto = service.get_instance(created.id).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(dto.last_error_code.as_deref(), Some("credentials_changed"));
    assert_eq!(dto.credential_slots[0].credential_revision, 1);
  }

  #[test]
  fn service_integrations_delete_and_dependencies() {
    let (_d, service, vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    assert!(service.list_dependencies(created.id).unwrap().is_empty());
    service.delete(created.id).unwrap();
    assert!(matches!(
      service.get_instance(created.id),
      Err(StorageError::NotFound(_))
    ));
    assert_eq!(vault.len(), 0);
  }

  #[test]
  fn service_integrations_plugin_id_immutable() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(false)).unwrap();
    let err = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: "com.langnext.other".into(),
        display_name: created.display_name,
        enabled: true,
        config_json: created.config_json,
        credentials: vec![],
        expected_updated_at: Some(created.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("immutable")));
  }

  #[test]
  fn service_integrations_list_definitions() {
    let (_d, service, _vault) = setup();
    let defs = service.list_definitions();
    assert_eq!(defs.len(), 4);
    let ids: Vec<&str> = defs.iter().map(|definition| definition.manifest.id.as_str()).collect();
    for expected in [
      GOOGLE_CLOUD_PLUGIN_ID,
      GOOGLE_TRANSLATE_WEB_PLUGIN_ID,
      EDGE_TTS_PLUGIN_ID,
      PADDLEOCR_PLUGIN_ID,
    ] {
      assert!(ids.contains(&expected), "missing {expected} in {ids:?}");
    }
    let web = defs
      .iter()
      .find(|definition| definition.manifest.id == GOOGLE_TRANSLATE_WEB_PLUGIN_ID)
      .unwrap();
    assert!(web.manifest.credential_slots.is_empty());
    assert!(web.config_schema.fields.iter().any(|field| field.id == "channel"));
    let edge = defs
      .iter()
      .find(|definition| definition.manifest.id == EDGE_TTS_PLUGIN_ID)
      .unwrap();
    assert!(edge.manifest.credential_slots.is_empty());
    assert!(
      edge
        .manifest
        .capabilities
        .iter()
        .any(|capability| capability.id == "speech.synthesize@1")
    );
    assert!(edge.capability_schemas.iter().any(|schema| {
      schema.capability_id == "speech.synthesize@1"
        && schema.preference_schema.fields.iter().any(|field| field.id == "voice")
    }));
    assert_eq!(edge.presentation.display_name_fallback, "Edge TTS");
    let serialized = serde_json::to_value(edge).unwrap();
    assert!(serialized.get("configSchema").is_some());
    assert!(serialized.get("capabilitySchemas").is_some());
    assert!(serialized.get("authPolicy").is_none());
    assert!(serialized.get("credentialValidators").is_none());
  }

  #[test]
  fn service_integrations_web_create_ready_without_credentials() {
    let (_d, service, _vault) = setup();
    let config = GoogleTranslateWebConfigV1 {
      channel: GoogleTranslateWebChannel::Gtx,
      proxy_url: None,
    };
    let created = service
      .save(IntegrationInstanceWrite {
        id: None,
        plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
        display_name: "Web GTX".into(),
        enabled: true,
        config_json: serde_json::to_string(&config).unwrap(),
        credentials: vec![],
        expected_updated_at: None,
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(created.plugin_id, GOOGLE_TRANSLATE_WEB_PLUGIN_ID);
    // Credential-free plugin: local config validates immediately; the package pin still
    // derives PluginMissing until background activation completes.
    assert_eq!(created.health_status, IntegrationHealthStatus::Ready);
    assert_eq!(created.effective_status, IntegrationEffectiveStatus::PluginMissing);
    assert_eq!(created.runtime_kind, "wasm-component");
    assert!(created.package_digest.is_some());
    assert_eq!(created.runtime_state, "pending_activation");
    assert!(created.credential_slots.is_empty());
  }

  #[test]
  fn service_integrations_rejects_wrong_token_uri() {
    let (_d, service, vault) = setup();
    let mut input = write_create(true);
    let bad_sa = serde_json::json!({
      "type": "service_account",
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
      "token_uri": "https://evil.example/token",
    })
    .to_string();
    input.credentials[0].credential = CredentialUpdate::Replace(bad_sa);

    // Package-only create stores the secret structurally (valid JSON slot); deep service
    // account validation is deferred to the credential exchange during validate_instance.
    let created = service.save(input).unwrap();
    assert_eq!(created.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(vault.len(), 1);
    assert_eq!(service.list_instances().unwrap().len(), 1);
  }

  #[test]
  fn service_integrations_retains_plugin_missing_on_list_get() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let full_registry = Arc::new(ServiceIntegrationRegistry::empty());
    let create_service = package_first_service(
      db.clone(),
      vault.clone() as Arc<dyn CredentialVault>,
      full_registry,
      tokens_stub(false),
      dir.path(),
    );
    let created = create_service.save(write_create(true)).unwrap();
    // A pending package pin derives PluginMissing until activation; the registry-miss read
    // below proves list/get still resolve the row and preserve health/vault material.
    assert_eq!(created.effective_status, IntegrationEffectiveStatus::PluginMissing);

    // Simulate host without the bundled definition (registry miss).
    let empty_registry = Arc::new(ServiceIntegrationRegistry::empty());
    let missing_service = ServiceIntegrationService::new(db, vault.clone(), empty_registry, tokens_stub(false));

    let listed = missing_service.list_instances().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);
    assert_eq!(listed[0].effective_status, IntegrationEffectiveStatus::PluginMissing);
    // Persisted health is unchanged; plugin_missing is derived only.
    assert_eq!(listed[0].health_status, IntegrationHealthStatus::Unvalidated);

    let got = missing_service.get_instance(created.id).unwrap();
    assert_eq!(got.effective_status, IntegrationEffectiveStatus::PluginMissing);
    assert_eq!(got.id, created.id);
    // Secret still held; missing plugin must not delete vault material.
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_plugin_missing_allows_disable_blocks_save() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let full_registry = Arc::new(ServiceIntegrationRegistry::empty());
    let create_service = package_first_service(
      db.clone(),
      vault.clone() as Arc<dyn CredentialVault>,
      full_registry,
      tokens_stub(false),
      dir.path(),
    );
    let created = create_service.save(write_create(true)).unwrap();

    let empty_registry = Arc::new(ServiceIntegrationRegistry::empty());
    let missing_service = ServiceIntegrationService::new(db, vault.clone(), empty_registry, tokens_stub(false));

    // Metadata disable does not need the manifest.
    let disabled = missing_service.set_enabled(created.id, false).unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.effective_status, IntegrationEffectiveStatus::PluginMissing);
    assert_eq!(disabled.health_status, IntegrationHealthStatus::Unvalidated);

    // Full save (config/credential path) stays blocked without the definition.
    let err = missing_service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: false,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(disabled.updated_at.clone()),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::PluginUnavailable(_)));

    // Keep/no-op credential payload is still a full save and requires the manifest.
    let err_keep = missing_service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "renamed".into(),
        enabled: false,
        config_json: created.config_json.clone(),
        credentials: vec![],
        expected_updated_at: Some(disabled.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap_err();
    assert!(matches!(err_keep, StorageError::PluginUnavailable(_)));

    // Instance retained; secret untouched.
    let still = missing_service.get_instance(created.id).unwrap();
    assert_eq!(still.display_name, created.display_name);
    assert!(!still.enabled);
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn integration_credential_recovery_after_prepared() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let service = package_first_service(
      db.clone(),
      vault.clone() as Arc<dyn CredentialVault>,
      registry,
      tokens_stub(false),
      dir.path(),
    );
    let created = service.save(write_create(true)).unwrap();

    // Simulate unfinished prepared op for the slot after a crash-like leftover.
    let op_id = new_id();
    let orphan_ref = integration_ref(created.id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, op_id).unwrap();
    vault.set(&orphan_ref, "orphan").unwrap();
    db.transaction(|uow| {
      credential_operations::insert_prepared_slot(
        uow.conn(),
        op_id,
        OwnerKind::Integration,
        &created.id.to_string(),
        GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        None,
        Some(&orphan_ref),
      )?;
      Ok(())
    })
    .unwrap();

    coordinator::preflight_owner_slot(
      &db,
      vault.as_ref(),
      OwnerKind::Integration,
      &created.id.to_string(),
      GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
    )
    .unwrap();
    assert!(!vault.exists(&orphan_ref).unwrap());
    // Original credential still present.
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_keep_only_update_skips_unavailable_vault() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(FailingCredentialVault::new());
    vault.set_fail_set(true);
    vault.set_fail_exists(true);
    vault.set_fail_delete(true);
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let service = package_first_service(
      db,
      vault.clone() as Arc<dyn CredentialVault>,
      registry,
      tokens_stub(false),
      dir.path(),
    );

    // Create without secret does not touch the vault.
    let created = service.save(write_create(false)).unwrap();

    // Config-only Keep update must succeed even when the OS vault is down.
    let updated = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "Google Cloud (2)".into(),
        enabled: true,
        config_json: google_config("my-project"),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Keep,
        }],
        expected_updated_at: Some(created.updated_at.clone()),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(updated.display_name, "Google Cloud (2)");
    assert!(updated.config_json.contains("my-project"));
    assert!(!updated.credential_slots[0].has_credential);
  }

  #[test]
  fn service_integrations_failed_replace_does_not_block_later_keep() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(FailingCredentialVault::new());
    vault.set_fail_set(true);
    vault.set_fail_exists(true);
    vault.set_fail_delete(true);
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let service = package_first_service(
      db.clone(),
      vault.clone() as Arc<dyn CredentialVault>,
      registry,
      tokens_stub(false),
      dir.path(),
    );

    let created = service.save(write_create(false)).unwrap();

    // Replace fails because the vault is unavailable; journal must not stick.
    let err = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(created.updated_at.clone()),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap_err();
    assert!(matches!(
      err,
      StorageError::CredentialUnavailable | StorageError::CredentialAccess
    ));
    let leftover = db
      .read(|conn| {
        credential_operations::get_for_owner_slot(
          conn,
          OwnerKind::Integration,
          &created.id.to_string(),
          GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        )
      })
      .unwrap();
    assert!(leftover.is_none(), "failed replace must drop prepared journal");

    // Subsequent Keep-only config save still works.
    let updated = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "Renamed after vault failure".into(),
        enabled: true,
        config_json: google_config("proj-after-fail"),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Keep,
        }],
        expected_updated_at: Some(created.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(updated.display_name, "Renamed after vault failure");
    assert!(updated.config_json.contains("proj-after-fail"));
  }

  fn empty_schema_json() -> &'static [u8] {
    br#"{"version":1,"fields":[],"groups":[]}"#
  }

  fn synthetic_service_archive_bytes() -> Vec<u8> {
    use crate::domain::runtime_plugin::{
      CapabilityPathAuthorityDecl, DeclaredPathAuthority, FileRole, HttpMethod, NetworkEndpointRequest,
      PermissionRequests, PluginFileEntry,
    };
    use crate::services::plugin_package::test_support::{
      build_signed_package_with_key, sample_manifest, test_signing_key,
    };
    let wasm = b" asm   ";
    let schema = empty_schema_json();
    let mut manifest = sample_manifest(wasm);
    manifest.id = "com.example.synthetic-service".into();
    manifest.configuration_schema = Some("schemas/config.json".into());
    manifest.config_schema_version = Some(1);
    manifest.files.push(PluginFileEntry {
      path: "schemas/config.json".into(),
      role: FileRole::ConfigSchema,
      bytes: schema.len() as u64,
      sha256: crate::domain::plugin_package::sha256_hex(schema),
    });
    manifest.permissions = PermissionRequests {
      network: vec![NetworkEndpointRequest {
        id: "api".into(),
        origins: vec!["https://api.example.com".into()],
        methods: vec![HttpMethod::Get],
        instance_origin_config_field: None,
      }],
      auth_policies: vec!["host.none.v1".into()],
    };
    manifest.path_authority = vec![CapabilityPathAuthorityDecl {
      capability_id: "translate.text@1".into(),
      endpoint_id: "api".into(),
      method: HttpMethod::Get,
      path: DeclaredPathAuthority::Exact {
        value: "v1/translate".into(),
      },
      allowed_query_names: vec!["q".into()],
      allowed_header_names: vec![],
      auth_policy_id: Some("host.none.v1".into()),
    }];
    build_signed_package_with_key(
      &manifest,
      &[
        ("artifacts/plugin.wasm", wasm.as_slice()),
        ("schemas/config.json", schema),
      ],
      &test_signing_key(),
    )
  }

  fn synthetic_service_package() -> crate::services::plugin_package::VerifiedPackage {
    use crate::services::plugin_package::{
      hash_archive_bytes, test_support::test_public_key_hex, verify_package_bytes,
    };
    let bytes = synthetic_service_archive_bytes();
    let _digest = hash_archive_bytes(&bytes);
    verify_package_bytes(&bytes, &test_public_key_hex()).unwrap()
  }

  #[test]
  fn installed_synthetic_package_projects_definition_without_static_registration() {
    let verified = synthetic_service_package();
    let projected = crate::services::package_definition::project_verified_package(&verified).unwrap();
    assert_eq!(projected.manifest.id, "com.example.synthetic-service");
    assert_eq!(projected.manifest.version, "1.0.0");
    assert_eq!(projected.config_schema.version, 1);
    assert!(
      projected
        .manifest
        .endpoints
        .iter()
        .any(|endpoint| endpoint.alias == "api")
    );
    assert!(projected.manifest.credential_slots.is_empty());
    assert!(projected.auth_policy.is_none());
    let capability = projected.capability("translate.text@1").unwrap();
    assert_eq!(capability.descriptor.endpoint_aliases, vec!["api".to_string()]);
    assert_eq!(capability.endpoint_authorities.len(), 1);
    assert!(capability.endpoint_authorities[0].path.matches_static("v1/translate"));
    assert!(!capability.endpoint_authorities[0].path.matches_static("v1/other"));

    let mut registry = ServiceIntegrationRegistry::empty();
    registry.upsert_package_definition(projected).unwrap();
    let defs = registry.list_definitions();
    assert!(
      defs
        .iter()
        .any(|definition| definition.manifest.id == "com.example.synthetic-service")
    );
    assert!(registry.get_registration("com.example.synthetic-service").is_some());
  }

  #[test]
  fn synthetic_package_first_create_needs_no_plugin_id_branch() {
    use crate::domain::plugin_package::ApproveUserPublisherInput;
    use crate::services::default_package_activation::DefaultPackageActivationService;
    use crate::services::plugin_package::test_support::{test_fingerprint, test_public_key_hex};

    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault: Arc<dyn CredentialVault> = Arc::new(MemoryCredentialVault::new());
    let packages = crate::services::test_support::vendor_packages(db.clone(), dir.path());
    // The synthetic package is user-signed; approve its publisher through the genuine seam,
    // then install + authorize it as the default so create is package-first for ANY plugin.
    packages
      .approve_user_publisher(ApproveUserPublisherInput {
        key_id: "com.example.keys.1".into(),
        fingerprint: test_fingerprint(),
        public_key_hex: test_public_key_hex(),
      })
      .unwrap();
    let src = dir.path().join("synthetic.lnplugin");
    std::fs::write(&src, synthetic_service_archive_bytes()).unwrap();
    let preview = packages.preview_package(&src).unwrap();
    packages
      .approve_package(crate::domain::plugin_package::ApprovePluginPackageInput {
        preview_id: preview.preview_id,
        approve_publisher: false,
        publisher_public_key_hex: None,
        acknowledge_permissions: true,
        acknowledge_unsigned_package_risk: false,
        acknowledge_native_execution_risk: false,
      })
      .unwrap();
    let activation = DefaultPackageActivationService::create(db.clone(), packages.clone(), dir.path());
    let digest = packages
      .list_versions()
      .unwrap()
      .into_iter()
      .find(|version| version.plugin_id == "com.example.synthetic-service")
      .map(|version| version.package_digest)
      .unwrap();
    let preview = activation.preview_default_package_activation(&digest).unwrap();
    activation
      .authorize_default_plugin_package(
        crate::domain::default_package_activation::AuthorizeDefaultPluginPackageInput {
          preview_id: preview.preview_id,
          acknowledge_future_instance_authority: true,
          acknowledge_unsigned_default_risk: false,
        },
      )
      .unwrap();
    let mut registry = ServiceIntegrationRegistry::empty();
    let projected =
      crate::services::package_definition::project_verified_package(&synthetic_service_package()).unwrap();
    registry.upsert_package_definition(projected).unwrap();
    let registry = Arc::new(registry);
    let service = ServiceIntegrationService::new(db, vault, registry, tokens_stub(false))
      .with_default_package_activation(activation);

    // No plugin-id branch: any authorized default package pins the created row as a wasm
    // package-first instance.
    let created = service
      .save(IntegrationInstanceWrite {
        id: None,
        plugin_id: "com.example.synthetic-service".into(),
        display_name: "Synthetic".into(),
        enabled: true,
        config_json: "{}".into(),
        credentials: vec![],
        expected_updated_at: None,
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(created.plugin_id, "com.example.synthetic-service");
    assert_eq!(created.runtime_kind, "wasm-component");
    assert_eq!(created.runtime_state, "pending_activation");
    assert!(created.package_digest.is_some());

    let updated = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: "com.example.synthetic-service".into(),
        display_name: "Synthetic 2".into(),
        enabled: true,
        config_json: "{}".into(),
        credentials: vec![],
        expected_updated_at: Some(created.updated_at),
        endpoint_trust_preview_id: None,
        acknowledge_endpoint_trust: false,
      })
      .unwrap();
    assert_eq!(updated.display_name, "Synthetic 2");
  }

  #[test]
  fn installed_package_path_authority_matches_current_service_constraints() {
    use crate::domain::runtime_plugin::DeclaredPathAuthority;
    use crate::services::bundled_plugins::CapabilityPathAuthority;
    let cases = [
      (
        DeclaredPathAuthority::Exact {
          value: "translate_a/single".into(),
        },
        "translate_a/single",
        true,
      ),
      (
        DeclaredPathAuthority::Exact {
          value: "v1/audio/speech".into(),
        },
        "v1/audio/speech",
        true,
      ),
      (
        DeclaredPathAuthority::Exact {
          value: "v1/images:annotate".into(),
        },
        "v1/images:annotate",
        true,
      ),
      (
        DeclaredPathAuthority::BoundedPrefixSuffix {
          prefix: "v3beta1/projects/".into(),
          suffix: ":translateText".into(),
        },
        "v3beta1/projects/demo-project/locations/global:translateText",
        true,
      ),
      (
        DeclaredPathAuthority::BoundedPrefixSuffix {
          prefix: "v3beta1/projects/".into(),
          suffix: ":detectLanguage".into(),
        },
        "v3beta1/projects/demo-project/locations/global:detectLanguage",
        true,
      ),
      (
        DeclaredPathAuthority::BoundedPrefixSuffix {
          prefix: "v3beta1/projects/".into(),
          suffix: ":translateText".into(),
        },
        "v3beta1/projects/../secret:translateText",
        false,
      ),
    ];
    for (declared, path, allowed) in cases {
      let authority = CapabilityPathAuthority::from_declared(&declared);
      assert_eq!(authority.matches_static(path), allowed, "path {path} for {declared:?}");
    }
    let instance = CapabilityPathAuthority::from_declared(&DeclaredPathAuthority::InstanceConfiguredRelativePath {
      config_field: "proxy-url".into(),
    });
    assert!(!instance.matches_static("translate"));
  }
}
