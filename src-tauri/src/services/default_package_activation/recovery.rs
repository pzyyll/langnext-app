// ABOUTME: Recovery claims, intent journaling, and retained-digest retry.
// ABOUTME: Only local_creation intents are recovery-eligible; imports stay inactive.
use super::*;

/// Outcome of reconciling a recoverable intent against an already-active subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlreadyActiveReconciliation {
  /// Subject is not active; recovery may claim and dispatch.
  NotActive,
  /// Exact package/grant identity matches; intent can complete without dispatch.
  Completed,
  /// Active subject identity does not match the intent; fail closed.
  IdentityMismatch,
}

impl DefaultPackageActivationService {
  /// Persist a local-creation intent inside an open unit-of-work connection.
  pub fn insert_local_creation_intent_on_conn(
    conn: &rusqlite::Connection,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    package_digest: &str,
    expected_config_digest: Option<&str>,
    expected_update_token: Option<&str>,
  ) -> Result<DefaultRuntimeActivationIntent, StorageError> {
    let intent = build_activation_intent(
      subject_kind,
      subject_id,
      package_digest,
      DefaultRuntimeActivationSource::LocalCreation,
      DefaultRuntimeActivationState::Pending,
      expected_config_digest.map(str::to_string),
      expected_update_token.map(str::to_string),
    );
    default_package_activation_policies::insert_intent(conn, &intent)?;
    Ok(intent)
  }

  /// Persist a local-creation activation intent for a subject (package-first create path).
  pub fn record_local_creation_intent(
    &self,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    package_digest: &str,
    expected_config_digest: Option<String>,
    expected_update_token: Option<String>,
  ) -> Result<DefaultRuntimeActivationIntent, StorageError> {
    let intent = build_activation_intent(
      subject_kind,
      subject_id,
      package_digest,
      DefaultRuntimeActivationSource::LocalCreation,
      DefaultRuntimeActivationState::Pending,
      expected_config_digest,
      expected_update_token,
    );
    self.db.transaction(|uow| {
      default_package_activation_policies::insert_intent(uow.conn(), &intent)?;
      Ok(intent)
    })
  }

  /// Persist an import-boundary activation intent that never auto-recovers.
  pub fn record_import_requires_confirmation_intent(
    &self,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    package_digest: &str,
    expected_config_digest: Option<String>,
    expected_update_token: Option<String>,
  ) -> Result<DefaultRuntimeActivationIntent, StorageError> {
    let intent = build_activation_intent(
      subject_kind,
      subject_id,
      package_digest,
      DefaultRuntimeActivationSource::ImportRequiresConfirmation,
      DefaultRuntimeActivationState::ConfirmationRequired,
      expected_config_digest,
      expected_update_token,
    );
    self.db.transaction(|uow| {
      default_package_activation_policies::insert_intent(uow.conn(), &intent)?;
      Ok(intent)
    })
  }

  /// Persist an import-boundary intent on an open connection (configuration import apply).
  pub fn insert_import_requires_confirmation_intent_on_conn(
    conn: &rusqlite::Connection,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    package_digest: &str,
    expected_config_digest: Option<&str>,
    expected_update_token: Option<&str>,
  ) -> Result<DefaultRuntimeActivationIntent, StorageError> {
    let intent = build_activation_intent(
      subject_kind,
      subject_id,
      package_digest,
      DefaultRuntimeActivationSource::ImportRequiresConfirmation,
      DefaultRuntimeActivationState::ConfirmationRequired,
      expected_config_digest.map(str::to_string),
      expected_update_token.map(str::to_string),
    );
    // Import merge replaces any local recovery provenance for the same subject.
    default_package_activation_policies::delete_intent(conn, subject_kind, subject_id)?;
    default_package_activation_policies::insert_intent(conn, &intent)?;
    Ok(intent)
  }

  /// Recover eligible local-creation intents by claiming a lease then activating each subject once.
  ///
  /// Concurrent workers claim distinct intents. On process failure the lease remains until expiry.
  /// Claim ownership is CAS-transitioned to `activating` and rechecked before subject mutation.
  pub fn recover_pending_default_runtime_activations(&self) -> Result<usize, StorageError> {
    let claim_token = new_id().to_string();
    let now = now_rfc3339();
    let lease_expires_at = unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS);
    let intents = self.db.transaction_immediate(|uow| {
      default_package_activation_policies::claim_recovery_eligible_intents(
        uow.conn(),
        &claim_token,
        &now,
        &lease_expires_at,
        RECOVERY_CLAIM_BATCH_LIMIT,
      )
    })?;
    let mut activated = 0usize;
    for intent in intents {
      if !intent.source.is_recovery_eligible() || !intent.state.is_recoverable() {
        continue;
      }
      // Exact already-active subjects reconcile without another grant or runtime dispatch.
      match self.reconcile_already_active_recovery_intent(&intent)? {
        AlreadyActiveReconciliation::Completed => {
          activated += 1;
          continue;
        }
        AlreadyActiveReconciliation::IdentityMismatch => {
          let _ = self.mark_intent_failed(
            intent.id,
            "activation_intent_active_identity_mismatch",
            "active subject package or grant identity does not match the recovery intent",
          );
          continue;
        }
        AlreadyActiveReconciliation::NotActive => {}
      }
      // Renew and CAS-transition to activating only while this worker still owns the claim.
      let transitioned = self.db.transaction(|uow| {
        default_package_activation_policies::transition_claimed_intent_to_activating(
          uow.conn(),
          intent.id,
          &claim_token,
          &now_rfc3339(),
          &unix_to_rfc3339(now_unix() + RECOVERY_CLAIM_LEASE_SECS),
        )
      })?;
      if transitioned.is_none() {
        continue;
      }
      let recovery = RecoveryActivationContext {
        intent_id: intent.id,
        claim_token: claim_token.clone(),
      };
      if let Err(err) =
        self.activate_pending_subject_with_recovery(intent.subject_kind, intent.subject_id, Some(recovery))
      {
        log::warn!(
          "default_package_activation_recovery_failed subject={} kind={} error={err}",
          intent.subject_id,
          intent.subject_kind.as_str()
        );
      } else {
        activated += 1;
      }
    }
    Ok(activated)
  }

  /// Reconcile a recoverable local intent when the subject is already active on the exact package.
  fn reconcile_already_active_recovery_intent(
    &self,
    intent: &DefaultRuntimeActivationIntent,
  ) -> Result<AlreadyActiveReconciliation, StorageError> {
    use crate::domain::runtime_provider::ProviderRuntimeState;
    use crate::repositories::{integration_instances, provider_instances, provider_runtime_bindings};

    let outcome = self.db.read(|conn| match intent.subject_kind {
      GrantSubjectKind::IntegrationInstance => {
        let instance = match integration_instances::get(conn, intent.subject_id) {
          Ok(instance) => instance,
          Err(StorageError::NotFound(_)) => return Ok(AlreadyActiveReconciliation::NotActive),
          Err(err) => return Err(err),
        };
        if instance.runtime_state != "active" || instance.execution_grant_set_revision.is_none() {
          return Ok(AlreadyActiveReconciliation::NotActive);
        }
        if instance.package_digest.as_deref() == Some(intent.package_digest.as_str()) {
          Ok(AlreadyActiveReconciliation::Completed)
        } else {
          Ok(AlreadyActiveReconciliation::IdentityMismatch)
        }
      }
      GrantSubjectKind::ProviderInstance => {
        let provider = match provider_instances::get(conn, intent.subject_id) {
          Ok(provider) => provider,
          Err(StorageError::NotFound(_)) => return Ok(AlreadyActiveReconciliation::NotActive),
          Err(err) => return Err(err),
        };
        let binding = match provider_runtime_bindings::get(conn, intent.subject_id, &provider.adapter_id) {
          Ok(binding) => binding,
          Err(StorageError::NotFound(_)) => return Ok(AlreadyActiveReconciliation::NotActive),
          Err(err) => return Err(err),
        };
        if binding.state != ProviderRuntimeState::Active || binding.grant_set_revision.is_none() {
          return Ok(AlreadyActiveReconciliation::NotActive);
        }
        if binding.package_digest.as_deref() == Some(intent.package_digest.as_str()) {
          Ok(AlreadyActiveReconciliation::Completed)
        } else {
          Ok(AlreadyActiveReconciliation::IdentityMismatch)
        }
      }
    })?;

    if outcome == AlreadyActiveReconciliation::Completed {
      self.db.transaction(|uow| {
        default_package_activation_policies::update_intent_state(
          uow.conn(),
          intent.id,
          DefaultRuntimeActivationState::Completed,
          None,
          None,
        )?;
        Ok(())
      })?;
    }
    Ok(outcome)
  }

  /// List only recovery-eligible local creation intents.
  pub fn list_recovery_eligible_intents(&self) -> Result<Vec<DefaultRuntimeActivationIntent>, StorageError> {
    self
      .db
      .read(default_package_activation_policies::list_recovery_eligible_intents)
  }

  /// Mark an intent failed with a normalized error while retaining the exact package requirement.
  pub fn mark_intent_failed(
    &self,
    intent_id: Uuid,
    error_code: &str,
    error_message: &str,
  ) -> Result<DefaultRuntimeActivationIntent, StorageError> {
    self.db.transaction(|uow| {
      default_package_activation_policies::update_intent_state(
        uow.conn(),
        intent_id,
        DefaultRuntimeActivationState::Failed,
        Some(error_code),
        Some(error_message),
      )
    })
  }

  /// Retry activation for a retained subject requirement (no digest entry, no legacy fallback).
  ///
  /// Rechecks current trust/store/policy, CAS-resets the exact subject and intent to pending, and
  /// returns the pending intent. Callers schedule `activate_pending_subject` after durable reset.
  pub fn retry_default_runtime_activation(
    &self,
    input: RetryDefaultRuntimeActivationInput,
  ) -> Result<DefaultRuntimeActivationIntent, StorageError> {
    use crate::domain::runtime_provider::{ProviderRuntimeKind, ProviderRuntimeState};
    use crate::repositories::{integration_instances, provider_instances, provider_runtime_bindings};

    self.db.transaction(|uow| {
      let intent =
        default_package_activation_policies::get_intent(uow.conn(), input.subject_kind, input.subject_id)?
          .ok_or_else(|| StorageError::NotFound(format!("activation intent for subject {}", input.subject_id)))?;
      // Retry never retargets to a different default; it uses the retained digest only.
      let version = installed_plugin_versions::get(uow.conn(), &intent.package_digest)?;
      if !version.content_available {
        return Err(StorageError::PluginUnavailable(format!(
          "package {} content is unavailable",
          intent.package_digest
        )));
      }
      let publisher = plugin_publishers::get_optional(uow.conn(), &version.publisher_key_id)?.ok_or_else(|| {
        StorageError::Validation(format!(
          "publisher {} is missing for package {}",
          version.publisher_key_id, intent.package_digest
        ))
      })?;
      if publisher.revoked || !publisher.enabled {
        return Err(StorageError::Validation(
          "cannot retry activation: publisher trust is disabled or revoked".into(),
        ));
      }
      let status = default_package_activation_policies::resolve_authorization_status(uow.conn(), &version.plugin_id)?;
      if status != DefaultPackageAuthorizationStatus::Authorized {
        return Err(StorageError::Validation(format!(
          "cannot retry activation: default package authorization is {}",
          status.as_str()
        )));
      }
      let policy = default_package_activation_policies::get_policy(uow.conn(), &version.plugin_id)?
        .ok_or_else(|| StorageError::Validation("authorized default policy missing".into()))?;
      if policy.package_digest != intent.package_digest {
        return Err(StorageError::Conflict(
          "activation intent digest no longer matches the authorized default policy".into(),
        ));
      }

      let now = now_rfc3339();
      let (expected_config_digest, expected_update_token) = match input.subject_kind {
        GrantSubjectKind::IntegrationInstance => {
          let instance = integration_instances::get(uow.conn(), input.subject_id)?;
          if instance.package_digest.as_deref() != Some(intent.package_digest.as_str()) {
            return Err(StorageError::Conflict(
              "integration package requirement no longer matches the activation intent".into(),
            ));
          }
          if let Some(expected) = intent.expected_update_token.as_deref() {
            if instance.updated_at != expected {
              return Err(StorageError::Conflict(
                "integration changed since the activation intent was recorded".into(),
              ));
            }
          }
          integration_instances::compare_and_set_runtime_pin(
            uow.conn(),
            input.subject_id,
            &instance.updated_at,
            &instance.plugin_version,
            &instance.config_json,
            instance.config_schema_version,
            &instance.runtime_kind,
            instance.package_digest.as_deref(),
            None,
            "pending_activation",
            None,
            None,
            instance.runtime_requirement_json.as_deref(),
            &now,
          )?;
          (intent.expected_config_digest.clone(), now)
        }
        GrantSubjectKind::ProviderInstance => {
          let provider = provider_instances::get(uow.conn(), input.subject_id)?;
          let binding = provider_runtime_bindings::get(uow.conn(), input.subject_id, &provider.adapter_id)?;
          if binding.package_digest.as_deref() != Some(intent.package_digest.as_str()) {
            return Err(StorageError::Conflict(
              "provider package requirement no longer matches the activation intent".into(),
            ));
          }
          if let Some(expected) = intent.expected_update_token.as_deref() {
            if binding.updated_at != expected && provider.updated_at != expected {
              return Err(StorageError::Conflict(
                "provider binding changed since the activation intent was recorded".into(),
              ));
            }
          }
          let pending = crate::domain::runtime_provider::ProviderRuntimeBinding {
            provider_id: input.subject_id,
            adapter_id: provider.adapter_id.clone(),
            runtime_kind: ProviderRuntimeKind::WasmComponent,
            package_digest: Some(intent.package_digest.clone()),
            grant_set_revision: None,
            state: ProviderRuntimeState::PendingActivation,
            error_code: None,
            error_message: None,
            runtime_requirement_json: binding.runtime_requirement_json.clone(),
            created_at: binding.created_at.clone(),
            updated_at: now.clone(),
          };
          provider_runtime_bindings::update(uow.conn(), &pending)?;
          (intent.expected_config_digest.clone(), now)
        }
      };

      // Bind the pending intent to the post-reset subject token so a later failure/retry CAS stays valid.
      default_package_activation_policies::reset_intent_pending_with_binding(
        uow.conn(),
        intent.id,
        expected_config_digest.as_deref(),
        Some(expected_update_token.as_str()),
      )
    })
  }
}
