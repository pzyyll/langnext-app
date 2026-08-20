// ABOUTME: Default package authorization, package-first preparation, and activation orchestration.
// ABOUTME: Policies are future-instance templates; grants remain instance-scoped after re-verification.
use crate::domain::default_package_activation::{
  AuthorizeDefaultPluginPackageInput, ConfirmDefaultRuntimeAuthorityInput, DefaultActivationPolicySource,
  DefaultAuthorityNetworkEntryDto, DefaultAuthorityResourceLimitsDto, DefaultPackageActivationPolicy,
  DefaultPackageActivationPreviewDto, DefaultPackageAuthorizationStatus, DefaultRuntimeActivationIntent,
  DefaultRuntimeActivationSource, DefaultRuntimeActivationState, DefaultRuntimeAuthorityPreviewDto,
  PreviewDefaultRuntimeAuthorityInput, RetryDefaultRuntimeActivationInput,
};
use crate::domain::plugin_package::{
  PluginDefaultVersion, compute_permission_request_digest, runtime_kind_storage, sha256_hex,
};
// runtime_kind_storage maps RuntimeKind to the kebab-case SQLite/storage token.
use crate::domain::runtime_lifecycle::GrantSubjectKind;
use crate::domain::runtime_plugin::{
  HttpMethod, PluginManifestV1, RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES, RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
  RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES, RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS, ResourceLimits,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{default_package_activation_policies, installed_plugin_versions, plugin_publishers};
use crate::services::plugin_store::PluginPackageService;
use crate::services::runtime_authority::authority_covered_by_policy_or_approval;
use crate::storage::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Recovery worker lease duration. Longer than one normal verification interval.
pub const RECOVERY_CLAIM_LEASE_SECS: u64 = 5 * 60;
/// Maximum intents claimed per recovery batch.
pub const RECOVERY_CLAIM_BATCH_LIMIT: usize = 32;

/// Preview session lifetime before the opaque default-activation preview ID expires.
pub const DEFAULT_ACTIVATION_PREVIEW_TTL_SECS: u64 = 10 * 60;
/// Subject authority preview lifetime before the opaque preview ID expires.
pub const DEFAULT_RUNTIME_AUTHORITY_PREVIEW_TTL_SECS: u64 = 10 * 60;

/// Canonical authority-constraint document sealed into a default activation policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedAuthorityConstraints {
  pub fixed_network: Vec<ApprovedFixedNetworkConstraint>,
  pub auth_policies: Vec<String>,
  pub dynamic_origin_endpoint_ids: Vec<String>,
  pub resource_limits: Option<ApprovedResourceLimits>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedFixedNetworkConstraint {
  pub endpoint_id: String,
  pub origin: String,
  pub method: String,
  pub capability_ids: Vec<String>,
  /// Exact effective resource limits bound for this authority entry.
  pub resource_limits: ApprovedResourceLimits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedResourceLimits {
  pub max_request_bytes: u64,
  pub max_response_bytes: u64,
  pub max_stream_bytes: u64,
  pub timeout_ms: u64,
}

/// One host-shipped vendor bootstrap policy entry (exact identities only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorBootstrapPolicyEntry {
  pub plugin_id: String,
  pub package_digest: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub permission_request_digest: String,
  pub approved_authority_constraints: ApprovedAuthorityConstraints,
}

struct DefaultActivationPreviewSession {
  preview_id: Uuid,
  package_digest: String,
  plugin_id: String,
  version: String,
  publisher_key_id: String,
  publisher_fingerprint: String,
  permission_request_digest: String,
  runtime_kind: String,
  constraints: ApprovedAuthorityConstraints,
  constraints_digest: String,
  expires_at_unix: u64,
}

struct RuntimeAuthorityPreviewSession {
  preview_id: Uuid,
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: String,
  policy_constraints_digest: String,
  config_digest: String,
  expected_update_token: String,
  additional_network_authority: Vec<DefaultAuthorityNetworkEntryDto>,
  auth_policies: Vec<String>,
  resource_limits: Option<ApprovedResourceLimits>,
  approved_authority_json: String,
  approved_authority_digest: String,
  expires_at_unix: u64,
}

/// Current subject/config/package/policy authority used by preview and confirmation CAS.
struct SubjectAuthorityPreviewState {
  package_digest: String,
  config_digest: String,
  expected_update_token: String,
  policy_constraints_digest: String,
  policy_constraints: ApprovedAuthorityConstraints,
  effective: crate::services::runtime_authority::CanonicalSubjectAuthority,
}

/// Runtime identity prepared for package-first create when an authorized default exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedPackageFirstRuntime {
  pub package_digest: String,
  pub runtime_kind: String,
  pub plugin_version: String,
  pub runtime_requirement_json: String,
}

/// Normalized reason a catalog default cannot activate package-first create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageFirstBlockReason {
  Unauthorized,
  Stale,
}

impl PackageFirstBlockReason {
  pub fn as_error_code(&self) -> &'static str {
    match self {
      Self::Unauthorized => "default_authorization_required",
      Self::Stale => DEFAULT_AUTHORIZATION_STALE_CODE,
    }
  }

  pub fn as_message(&self) -> &'static str {
    match self {
      Self::Unauthorized => "default package exists without authorization",
      Self::Stale => "default package authorization is stale",
    }
  }
}

/// Exact inactive package-first requirement retained when create cannot activate yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedPackageFirstRuntime {
  pub package_digest: String,
  pub runtime_kind: String,
  pub plugin_version: String,
  pub runtime_requirement_json: String,
  pub reason: PackageFirstBlockReason,
}

/// Package-first create resolution: absence vs ready vs blocked default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageFirstCreateResolution {
  /// No catalog default exists; dual-stack legacy creation remains allowed.
  NoDefault,
  /// Exact authorized default is ready for pending activation.
  Ready(PreparedPackageFirstRuntime),
  /// Catalog default exists but is unauthorized or stale; retain exact inactive requirement.
  Blocked(BlockedPackageFirstRuntime),
}

/// Normalized activation failure code for stale default authorization/publisher trust.
pub const DEFAULT_AUTHORIZATION_STALE_CODE: &str = "default_authorization_stale";
/// Normalized activation failure code when resolved authority exceeds the default policy.
pub const RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE: &str = "runtime_authority_confirmation_required";

/// Immutable policy-bound package verification result shared before subject work.
#[derive(Debug, Clone)]
pub struct VerifiedActivationSnapshot {
  pub package_digest: String,
  pub verified: crate::services::plugin_package::VerifiedPackage,
  pub policy_constraints_digest: String,
  pub publisher_key_id: String,
  pub publisher_fingerprint: String,
  pub publisher_public_key_hex: String,
  pub publisher_source: crate::domain::plugin_package::PublisherSource,
  pub store_generation: u64,
}

/// Shared in-flight package verification keyed by digest with generation-safe cleanup.
///
/// The independent worker owns verification. Callers only wait on `completed` and may cancel
/// their own wait without cancelling the worker or other waiters.
struct InFlightVerification {
  generation: u64,
  completed: Mutex<Option<Result<Arc<VerifiedActivationSnapshot>, String>>>,
  waiters: Condvar,
}

/// Optional recovery claim ownership required for claim-bound subject activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryActivationContext {
  pub intent_id: Uuid,
  pub claim_token: String,
}

/// Common subject state prepared by a package-first activation adapter. The coordinator owns
/// policy comparison, constraint decoding, exact approval lookup, authority coverage, and
/// normalized failure mapping; the adapter owns subject loading, authority resolution, and
/// grant application.
#[derive(Debug, Clone)]
pub(super) struct PreparedPackageFirstActivation {
  pub subject_kind: GrantSubjectKind,
  pub subject_id: Uuid,
  pub package_digest: String,
  /// Subject CAS update token (instance/binding `updated_at`) used for exact approval lookup.
  pub expected_update_token: String,
  pub config_digest: String,
  pub effective_authority: crate::services::runtime_authority::CanonicalSubjectAuthority,
  pub policy: DefaultPackageActivationPolicy,
  /// Integration: verified publisher row required by the grant apply step.
  pub publisher: Option<crate::domain::plugin_package::PluginPublisher>,
  /// Provider: original binding snapshot used for CAS comparisons and failure marking.
  pub binding: Option<crate::domain::runtime_provider::ProviderRuntimeBinding>,
  /// Provider: catalog version row required by the grant apply step.
  pub version: Option<crate::domain::plugin_package::InstalledPluginVersion>,
  /// Provider: config identity snapshot used for the final CAS compare.
  pub subject_config_base_url: String,
  pub subject_config_auth_scheme: Option<crate::domain::provider::AuthSchemeV1>,
  /// Subject activation intent retained by the apply/failure steps.
  pub intent: Option<DefaultRuntimeActivationIntent>,
}

/// Subject-specific package-first activation pieces consumed by the shared coordinator.
///
/// `prepare` loads subject state and resolves the subject's effective authority; it marks its
/// own subject-specific failures (missing trust rows, authority resolution errors) and returns
/// `Ok(None)` so the coordinator returns promptly. `apply` performs the store-lock reverify and
/// CAS grant in the subject's own transaction. The coordinator owns all policy/approval/coverage
/// decisions and normalized failure mapping so both subject kinds produce identical outcomes.
pub(super) trait PackageFirstSubjectActivation {
  fn prepare(
    &self,
    snapshot: &VerifiedActivationSnapshot,
  ) -> Result<Option<PreparedPackageFirstActivation>, StorageError>;

  fn apply(
    &self,
    prepared: &PreparedPackageFirstActivation,
    snapshot: &VerifiedActivationSnapshot,
  ) -> Result<(), StorageError>;

  fn mark_failed(
    &self,
    prepared: &PreparedPackageFirstActivation,
    error_code: &str,
    error_message: &str,
  ) -> Result<(), StorageError>;

  fn mark_confirmation_required(
    &self,
    prepared: &PreparedPackageFirstActivation,
    error_code: &str,
    error_message: &str,
  ) -> Result<(), StorageError>;
}

/// Coordinates default package authorization and subject activation.
#[derive(Clone)]
pub struct DefaultPackageActivationService {
  db: Database,
  packages: PluginPackageService,
  previews: Arc<Mutex<HashMap<Uuid, DefaultActivationPreviewSession>>>,
  /// Independent map for subject authority confirmation previews.
  authority_previews: Arc<Mutex<HashMap<Uuid, RuntimeAuthorityPreviewSession>>>,
  /// Per-digest shared package verification flights (independent from preview maps).
  in_flight_verifications: Arc<Mutex<HashMap<String, Arc<InFlightVerification>>>>,
  flight_generation: Arc<Mutex<u64>>,
  /// Resource path used only by the vendor-bootstrap internal path.
  vendor_bootstrap_path: PathBuf,
  integration_lifecycle: Option<crate::services::runtime_lifecycle::RuntimeLifecycleService>,
  provider_runtime: Option<crate::services::runtime_providers::ProviderRuntimeService>,
  /// Test-only observation of genuine verification calls for single-flight assertions.
  #[cfg(test)]
  verification_call_count: Arc<Mutex<u64>>,
  /// Test-only barrier held by the independent verification worker before it publishes.
  #[cfg(test)]
  verification_block: Arc<Mutex<Option<Arc<std::sync::Barrier>>>>,
  /// Test-only one-shot panic trigger inside the genuine policy-bound verifier.
  #[cfg(test)]
  verification_panic_once: Arc<Mutex<bool>>,
}

mod authority_confirmation;
mod policy_authorization;
mod recovery;
mod single_flight;
mod vendor_bootstrap;

#[cfg(test)]
mod tests;

impl DefaultPackageActivationService {
  pub fn create(db: Database, packages: PluginPackageService, app_data_dir: impl Into<PathBuf>) -> Self {
    let app_data_dir = app_data_dir.into();
    Self {
      db,
      packages,
      previews: Arc::new(Mutex::new(HashMap::new())),
      authority_previews: Arc::new(Mutex::new(HashMap::new())),
      in_flight_verifications: Arc::new(Mutex::new(HashMap::new())),
      flight_generation: Arc::new(Mutex::new(0)),
      // Production bootstrap entries are loaded from the packaged resource path when present.
      vendor_bootstrap_path: app_data_dir
        .join("resources")
        .join("plugins")
        .join("default-activation-policies.json"),
      integration_lifecycle: None,
      provider_runtime: None,
      #[cfg(test)]
      verification_call_count: Arc::new(Mutex::new(0)),
      #[cfg(test)]
      verification_block: Arc::new(Mutex::new(None)),
      #[cfg(test)]
      verification_panic_once: Arc::new(Mutex::new(false)),
    }
  }

  /// Arm a one-shot panic inside the next genuine policy-bound verification (tests only).
  #[cfg(test)]
  pub(crate) fn arm_verification_panic_once(&self) {
    *self.verification_panic_once.lock().unwrap_or_else(|e| e.into_inner()) = true;
  }

  /// Override the vendor bootstrap resource path (tests and packaged resource injection).
  pub fn with_vendor_bootstrap_path(mut self, path: impl Into<PathBuf>) -> Self {
    self.vendor_bootstrap_path = path.into();
    self
  }

  /// Wire integration subject activation after lifecycle construction.
  pub fn with_integration_lifecycle(
    mut self,
    lifecycle: crate::services::runtime_lifecycle::RuntimeLifecycleService,
  ) -> Self {
    self.integration_lifecycle = Some(lifecycle);
    self
  }

  /// Wire provider subject activation after provider runtime construction.
  pub fn with_provider_runtime(
    mut self,
    provider_runtime: crate::services::runtime_providers::ProviderRuntimeService,
  ) -> Self {
    self.provider_runtime = Some(provider_runtime);
    self
  }

  pub fn packages(&self) -> &PluginPackageService {
    &self.packages
  }

  /// Activate one pending subject.
  ///
  /// Resolves only the subject intent and retained digest, shares one policy-bound package
  /// verification per digest, then dispatches the immutable snapshot to the runtime activator.
  /// Subject grant/CAS work remains isolated. Returns promptly when the subject is no longer pending.
  pub fn activate_pending_subject(&self, subject_kind: GrantSubjectKind, subject_id: Uuid) -> Result<(), StorageError> {
    self.activate_pending_subject_with_recovery(subject_kind, subject_id, None)
  }

  /// Activate one pending subject, optionally binding final grant CAS to a live recovery claim.
  pub fn activate_pending_subject_with_recovery(
    &self,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    recovery: Option<RecoveryActivationContext>,
  ) -> Result<(), StorageError> {
    let Some((intent, retained_digest)) = self.load_pending_subject_intent_and_digest(subject_kind, subject_id)? else {
      return Ok(());
    };
    if intent.package_digest != retained_digest {
      log::warn!(
        "default_package_activation_intent_digest_mismatch subject={subject_id} kind={} intent={} retained={retained_digest}",
        subject_kind.as_str(),
        intent.package_digest
      );
      self.mark_subject_activation_failed(
        subject_kind,
        subject_id,
        intent.id,
        "activation_intent_digest_conflict",
        "activation intent package digest no longer matches the retained subject requirement",
      )?;
      return Ok(());
    }
    if let Some(ref recovery_ctx) = recovery {
      if recovery_ctx.intent_id != intent.id {
        return Err(StorageError::Conflict(
          "recovery claim intent no longer matches the subject activation intent".into(),
        ));
      }
    }

    let snapshot = match self.verify_shared_package_snapshot(&retained_digest) {
      Ok(snapshot) => snapshot,
      Err(err) => {
        let (code, message) = normalized_activation_failure(&err);
        log::warn!(
          "default_package_activation_shared_verify_failed subject={subject_id} kind={} digest={retained_digest} code={code} error={message}",
          subject_kind.as_str()
        );
        self.mark_subject_activation_failed(subject_kind, subject_id, intent.id, code, &message)?;
        return Ok(());
      }
    };

    // Final claim ownership recheck immediately before subject mutation for recovery workers.
    if let Some(ref recovery_ctx) = recovery {
      let owns_claim = self.db.read(|conn| {
        default_package_activation_policies::assert_recovery_claim_owner(
          conn,
          recovery_ctx.intent_id,
          &recovery_ctx.claim_token,
          &now_rfc3339(),
        )
      })?;
      if !owns_claim {
        return Err(StorageError::Conflict(
          "recovery claim expired or replaced before subject activation".into(),
        ));
      }
    }

    match subject_kind {
      GrantSubjectKind::IntegrationInstance => {
        let Some(lifecycle) = &self.integration_lifecycle else {
          return Err(StorageError::Internal(
            "integration lifecycle activator is not configured".into(),
          ));
        };
        self.run_package_first_activation(
          &crate::services::runtime_lifecycle::IntegrationActivationAdapter { lifecycle, subject_id },
          snapshot.as_ref(),
        )
      }
      GrantSubjectKind::ProviderInstance => {
        let Some(provider_runtime) = &self.provider_runtime else {
          return Err(StorageError::Internal(
            "provider runtime activator is not configured".into(),
          ));
        };
        self.run_package_first_activation(
          &crate::services::runtime_providers::ProviderActivationAdapter {
            runtime: provider_runtime,
            subject_id,
          },
          snapshot.as_ref(),
        )
      }
    }
  }

  /// Shared post-verification activation orchestration for both subject kinds.
  ///
  /// Owns policy comparison, constraint decoding, exact approval lookup, authority coverage
  /// checks, and normalized failure mapping. Subject-specific loading, authority resolution,
  /// and grant application stay in the adapter so integration and provider activations produce
  /// identical normalized outcomes.
  pub(super) fn run_package_first_activation(
    &self,
    subject: &dyn PackageFirstSubjectActivation,
    snapshot: &VerifiedActivationSnapshot,
  ) -> Result<(), StorageError> {
    let Some(prepared) = subject.prepare(snapshot)? else {
      return Ok(());
    };
    let policy = &prepared.policy;
    if policy.package_digest != prepared.package_digest
      || policy.approved_authority_constraints_digest != snapshot.policy_constraints_digest
    {
      log::warn!(
        "package_first_activation_policy_diverged subject={} kind={} digest={}",
        prepared.subject_id,
        prepared.subject_kind.as_str(),
        prepared.package_digest
      );
      let _ = subject.mark_failed(
        &prepared,
        DEFAULT_AUTHORIZATION_STALE_CODE,
        "default authorization policy no longer matches the retained package",
      );
      return Ok(());
    }

    let policy_constraints: ApprovedAuthorityConstraints =
      match serde_json::from_str(&policy.approved_authority_constraints_json) {
        Ok(constraints) => constraints,
        Err(err) => {
          let _ = subject.mark_failed(
            &prepared,
            "activation_failed",
            &format!("invalid policy constraints: {err}"),
          );
          return Ok(());
        }
      };
    let approval = self
      .db
      .read(|conn| {
        default_package_activation_policies::get_authority_approval_exact(
          conn,
          prepared.subject_kind,
          prepared.subject_id,
          &prepared.package_digest,
          &prepared.config_digest,
          &prepared.expected_update_token,
          &policy.approved_authority_constraints_digest,
        )
      })?
      .and_then(|row| {
        serde_json::from_str::<crate::services::runtime_authority::CanonicalSubjectAuthority>(
          &row.approved_authority_json,
        )
        .ok()
      });
    if !authority_covered_by_policy_or_approval(&prepared.effective_authority, &policy_constraints, approval.as_ref()) {
      let _ = subject.mark_confirmation_required(
        &prepared,
        RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE,
        "instance authority exceeds the default activation policy",
      );
      return Ok(());
    }

    if let Err(err) = subject.apply(&prepared, snapshot) {
      log::warn!(
        "package_first_activation_apply_failed subject={} kind={} error={err}",
        prepared.subject_id,
        prepared.subject_kind.as_str()
      );
      let message = err.to_string();
      if message.contains("default_authorization_stale") {
        let _ = subject.mark_failed(&prepared, DEFAULT_AUTHORIZATION_STALE_CODE, &message);
      } else {
        let _ = subject.mark_failed(&prepared, "activation_failed", &message);
      }
    }
    Ok(())
  }

  /// Load the pending intent and retained subject package digest without package verification.
  pub(super) fn load_pending_subject_intent_and_digest(
    &self,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
  ) -> Result<Option<(DefaultRuntimeActivationIntent, String)>, StorageError> {
    self.db.read(|conn| match subject_kind {
      GrantSubjectKind::IntegrationInstance => {
        use crate::repositories::integration_instances;
        let instance = integration_instances::get(conn, subject_id)?;
        if instance.runtime_state != "pending_activation" || instance.execution_grant_set_revision.is_some() {
          return Ok(None);
        }
        let Some(retained_digest) = instance.package_digest.clone() else {
          return Ok(None);
        };
        let Some(intent) = default_package_activation_policies::get_intent(conn, subject_kind, subject_id)? else {
          return Ok(None);
        };
        Ok(Some((intent, retained_digest)))
      }
      GrantSubjectKind::ProviderInstance => {
        use crate::domain::runtime_provider::ProviderRuntimeState;
        use crate::repositories::{provider_instances, provider_runtime_bindings};
        let provider = provider_instances::get(conn, subject_id)?;
        let binding = provider_runtime_bindings::get(conn, subject_id, &provider.adapter_id)?;
        if binding.state != ProviderRuntimeState::PendingActivation || binding.grant_set_revision.is_some() {
          return Ok(None);
        }
        let Some(retained_digest) = binding.package_digest.clone() else {
          return Ok(None);
        };
        let Some(intent) = default_package_activation_policies::get_intent(conn, subject_kind, subject_id)? else {
          return Ok(None);
        };
        Ok(Some((intent, retained_digest)))
      }
    })
  }

  /// Mark a subject unavailable and the intent failed while retaining the exact package digest.
  ///
  /// Subject CAS and intent token binding share one transition timestamp so retry can re-check the
  /// post-failure subject without manual digest entry.
  pub(super) fn mark_subject_activation_failed(
    &self,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    intent_id: Uuid,
    error_code: &str,
    error_message: &str,
  ) -> Result<(), StorageError> {
    self.db.transaction(|uow| {
      let transition_at = now_rfc3339();
      let bound_token = match subject_kind {
        GrantSubjectKind::IntegrationInstance => {
          use crate::repositories::integration_instances;
          let current = integration_instances::get(uow.conn(), subject_id)?;
          if current.runtime_state == "pending_activation" && current.execution_grant_set_revision.is_none() {
            integration_instances::mark_runtime_unavailable(
              uow.conn(),
              subject_id,
              &current.updated_at,
              error_code,
              error_message,
              &transition_at,
            )?;
            transition_at.clone()
          } else {
            current.updated_at
          }
        }
        GrantSubjectKind::ProviderInstance => {
          use crate::domain::runtime_provider::{ProviderRuntimeBinding, ProviderRuntimeState};
          use crate::repositories::{provider_instances, provider_runtime_bindings};
          let provider = provider_instances::get(uow.conn(), subject_id)?;
          let current = provider_runtime_bindings::get(uow.conn(), subject_id, &provider.adapter_id)?;
          if current.state == ProviderRuntimeState::PendingActivation && current.grant_set_revision.is_none() {
            let failed = ProviderRuntimeBinding {
              provider_id: current.provider_id,
              adapter_id: current.adapter_id,
              runtime_kind: current.runtime_kind,
              package_digest: current.package_digest,
              grant_set_revision: None,
              state: ProviderRuntimeState::Unavailable,
              error_code: Some(error_code.into()),
              error_message: Some(error_message.into()),
              runtime_requirement_json: current.runtime_requirement_json,
              created_at: current.created_at,
              updated_at: transition_at.clone(),
            };
            provider_runtime_bindings::update(uow.conn(), &failed)?;
            transition_at.clone()
          } else {
            current.updated_at
          }
        }
      };
      default_package_activation_policies::fail_intent_with_update_token(
        uow.conn(),
        intent_id,
        error_code,
        error_message,
        &bound_token,
      )?;
      Ok(())
    })
  }
}

/// One normalized activation intent constructor for local creation and import provenance.
pub(super) fn build_activation_intent(
  subject_kind: GrantSubjectKind,
  subject_id: Uuid,
  package_digest: &str,
  source: DefaultRuntimeActivationSource,
  state: DefaultRuntimeActivationState,
  expected_config_digest: Option<String>,
  expected_update_token: Option<String>,
) -> DefaultRuntimeActivationIntent {
  let now = now_rfc3339();
  DefaultRuntimeActivationIntent {
    id: new_id(),
    subject_kind,
    subject_id,
    package_digest: package_digest.to_string(),
    source,
    state,
    expected_config_digest,
    expected_update_token,
    error_code: None,
    error_message: None,
    created_at: now.clone(),
    updated_at: now,
    claim_token: None,
    claim_expires_at: None,
  }
}

/// Build approved authority constraints from a re-verified signed manifest only.
pub(super) fn build_authority_constraints(manifest: &PluginManifestV1) -> ApprovedAuthorityConstraints {
  let capability_ids: Vec<String> = manifest.capabilities.iter().map(|c| c.id.clone()).collect();
  let mut fixed_network = Vec::new();
  let mut dynamic_origin_endpoint_ids = Vec::new();
  for endpoint in &manifest.permissions.network {
    if endpoint.instance_origin_config_field.is_some() || endpoint.origins.is_empty() {
      dynamic_origin_endpoint_ids.push(endpoint.id.clone());
      continue;
    }
    // Effective limits match grant builders: derive from ResourceLimits / capability defaults.
    let entry_limits = effective_resource_limits_for_capabilities(&capability_ids);
    for origin in &endpoint.origins {
      for method in &endpoint.methods {
        fixed_network.push(ApprovedFixedNetworkConstraint {
          endpoint_id: endpoint.id.clone(),
          origin: origin.clone(),
          method: http_method_token(method),
          capability_ids: capability_ids.clone(),
          resource_limits: approved_limits_from_resource_limits(&entry_limits),
        });
      }
    }
  }
  fixed_network.sort_by(|a, b| {
    (a.endpoint_id.as_str(), a.origin.as_str(), a.method.as_str()).cmp(&(
      b.endpoint_id.as_str(),
      b.origin.as_str(),
      b.method.as_str(),
    ))
  });
  dynamic_origin_endpoint_ids.sort();
  dynamic_origin_endpoint_ids.dedup();
  let mut auth_policies = manifest.permissions.auth_policies.clone();
  auth_policies.sort();
  auth_policies.dedup();
  // Top-level summary is a display projection only; per-entry limits are the policy truth.
  let resource_limits = if fixed_network.is_empty() {
    None
  } else {
    Some(summary_resource_limits(&fixed_network))
  };
  ApprovedAuthorityConstraints {
    fixed_network,
    auth_policies,
    dynamic_origin_endpoint_ids,
    resource_limits,
  }
}

/// Effective limits used by runtime grant builders for the listed capabilities.
pub(super) fn effective_resource_limits_for_capabilities(capability_ids: &[String]) -> ResourceLimits {
  let mut max_request = RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES;
  let mut max_response = RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES;
  let mut max_stream = RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES;
  let mut timeout_ms = RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS;
  for capability_id in capability_ids {
    let limits = effective_resource_limits_for_capability(capability_id);
    max_request = max_request.max(limits.max_request_bytes());
    max_response = max_response.max(limits.max_response_bytes());
    max_stream = max_stream.max(limits.max_stream_bytes());
    timeout_ms = timeout_ms.max(limits.timeout_ms());
  }
  ResourceLimits::new(max_request, max_response, max_stream, timeout_ms)
    .expect("aggregated effective resource limits are valid")
}

/// Capability-specific limits mirror runtime grant builders; values come from named domain constants.
pub(super) fn effective_resource_limits_for_capability(capability_id: &str) -> ResourceLimits {
  // Matches runtime_lifecycle grant builder speech synthesize timeout.
  const SPEECH_SYNTHESIZE_TIMEOUT_MS: u64 = 60_000;
  if capability_id == "speech.synthesize@1" {
    return ResourceLimits::new(
      RESOURCE_LIMIT_DEFAULT_MAX_REQUEST_BYTES,
      crate::domain::service_capability::SPEECH_PROVIDER_RESPONSE_MAX_BYTES as u64,
      RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
      SPEECH_SYNTHESIZE_TIMEOUT_MS,
    )
    .expect("speech synthesize resource limits are valid");
  }
  if capability_id == crate::domain::service_capability::OCR_IMAGE_CAPABILITY_ID {
    return ResourceLimits::new(
      crate::services::network_broker::BROKER_OCR_REQUEST_BODY_MAX_BYTES as u64,
      RESOURCE_LIMIT_DEFAULT_MAX_RESPONSE_BYTES,
      RESOURCE_LIMIT_DEFAULT_MAX_STREAM_BYTES,
      RESOURCE_LIMIT_DEFAULT_TIMEOUT_MS,
    )
    .expect("ocr resource limits are valid");
  }
  // Standard path: NetworkGrantEntry defaults are ResourceLimits::default().
  ResourceLimits::default()
}

pub(super) fn approved_limits_from_resource_limits(limits: &ResourceLimits) -> ApprovedResourceLimits {
  ApprovedResourceLimits {
    max_request_bytes: limits.max_request_bytes(),
    max_response_bytes: limits.max_response_bytes(),
    max_stream_bytes: limits.max_stream_bytes(),
    timeout_ms: limits.timeout_ms(),
  }
}

pub(super) fn summary_resource_limits(fixed_network: &[ApprovedFixedNetworkConstraint]) -> ApprovedResourceLimits {
  let first = fixed_network
    .first()
    .expect("summary_resource_limits requires at least one fixed network entry");
  let mut summary = first.resource_limits.clone();
  for entry in fixed_network.iter().skip(1) {
    summary.max_request_bytes = summary.max_request_bytes.max(entry.resource_limits.max_request_bytes);
    summary.max_response_bytes = summary.max_response_bytes.max(entry.resource_limits.max_response_bytes);
    summary.max_stream_bytes = summary.max_stream_bytes.max(entry.resource_limits.max_stream_bytes);
    summary.timeout_ms = summary.timeout_ms.max(entry.resource_limits.timeout_ms);
  }
  summary
}

pub(super) fn http_method_token(method: &HttpMethod) -> String {
  serde_json::to_string(method)
    .unwrap_or_else(|_| "\"?\"".into())
    .trim_matches('"')
    .to_string()
}

/// True when `actual` fixed network/auth/limits is a subset of the host-shipped ceiling.
pub(super) fn constraints_within_ceiling(
  actual: &ApprovedAuthorityConstraints,
  ceiling: &ApprovedAuthorityConstraints,
) -> bool {
  for policy in &actual.auth_policies {
    if !ceiling.auth_policies.contains(policy) {
      return false;
    }
  }
  for entry in &actual.fixed_network {
    let allowed = ceiling.fixed_network.iter().any(|ceiling_entry| {
      ceiling_entry.endpoint_id == entry.endpoint_id
        && ceiling_entry.origin == entry.origin
        && ceiling_entry.method == entry.method
        && resource_limits_within_ceiling(&entry.resource_limits, &ceiling_entry.resource_limits)
    });
    if !allowed {
      return false;
    }
  }
  match (&actual.resource_limits, &ceiling.resource_limits) {
    (Some(actual_limits), Some(ceiling_limits)) => {
      if !resource_limits_within_ceiling(actual_limits, ceiling_limits) {
        return false;
      }
    }
    (Some(_), None) => return false,
    _ => {}
  }
  true
}

pub(super) fn resource_limits_within_ceiling(
  actual: &ApprovedResourceLimits,
  ceiling: &ApprovedResourceLimits,
) -> bool {
  actual.max_request_bytes <= ceiling.max_request_bytes
    && actual.max_response_bytes <= ceiling.max_response_bytes
    && actual.max_stream_bytes <= ceiling.max_stream_bytes
    && actual.timeout_ms <= ceiling.timeout_ms
}

/// Map shared verification failures to stable, non-secret activation error codes.
pub(super) fn normalized_activation_failure(err: &StorageError) -> (&'static str, String) {
  let message = err.to_string();
  if message.contains(DEFAULT_AUTHORIZATION_STALE_CODE) {
    return (
      DEFAULT_AUTHORIZATION_STALE_CODE,
      "default authorization or publisher trust is stale".into(),
    );
  }
  if message.contains(RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE) {
    return (
      RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE,
      "instance authority exceeds the default activation policy".into(),
    );
  }
  ("package_verification_failed", message)
}

pub(super) fn now_unix() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

pub(super) fn unix_to_rfc3339(secs: u64) -> String {
  use time::OffsetDateTime;
  let dt = OffsetDateTime::from_unix_timestamp(secs as i64).unwrap_or(OffsetDateTime::UNIX_EPOCH);
  crate::domain::time::format_rfc3339(dt).unwrap_or_else(|_| now_rfc3339())
}
