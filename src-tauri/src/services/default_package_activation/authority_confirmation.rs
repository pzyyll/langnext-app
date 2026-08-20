// ABOUTME: Subject/config-bound runtime authority preview and confirmation.
// ABOUTME: Confirmation binds approval and activates without widening the default policy.
use super::*;

impl DefaultPackageActivationService {
  /// Preview additional subject authority beyond the exact default policy.
  pub fn preview_default_runtime_authority(
    &self,
    input: PreviewDefaultRuntimeAuthorityInput,
  ) -> Result<DefaultRuntimeAuthorityPreviewDto, StorageError> {
    self.purge_expired_authority_previews();
    let resolved = self.resolve_subject_authority_preview_state(input.subject_kind, input.subject_id)?;
    let additional = crate::services::runtime_authority::additional_authority_beyond_policy(
      &resolved.effective,
      &resolved.policy_constraints,
    );
    if additional.network.is_empty() && additional.auth_policies.is_empty() {
      return Err(StorageError::Validation(
        "no additional authority beyond the default policy".into(),
      ));
    }
    let additional_network_authority = additional.to_preview_entries();
    let resource_limits = additional.summary_resource_limits();
    let preview_id = new_id();
    let expires_at_unix = now_unix() + DEFAULT_RUNTIME_AUTHORITY_PREVIEW_TTL_SECS;
    let expires_at = unix_to_rfc3339(expires_at_unix);
    let authority_digest = additional.digest()?;
    {
      let mut guard = self
        .authority_previews
        .lock()
        .map_err(|_| StorageError::Internal("authority preview lock poisoned".into()))?;
      guard.insert(
        preview_id,
        RuntimeAuthorityPreviewSession {
          preview_id,
          subject_kind: input.subject_kind,
          subject_id: input.subject_id,
          package_digest: resolved.package_digest.clone(),
          policy_constraints_digest: resolved.policy_constraints_digest.clone(),
          config_digest: resolved.config_digest.clone(),
          expected_update_token: resolved.expected_update_token.clone(),
          additional_network_authority: additional_network_authority.clone(),
          auth_policies: additional.auth_policies.clone(),
          resource_limits: resource_limits.clone(),
          approved_authority_json: serde_json::to_string(&additional)
            .map_err(|e| StorageError::Internal(format!("serialize additional authority: {e}")))?,
          approved_authority_digest: authority_digest,
          expires_at_unix,
        },
      );
    }
    Ok(DefaultRuntimeAuthorityPreviewDto {
      preview_id: preview_id.to_string(),
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      package_digest: resolved.package_digest,
      expected_update_token: resolved.expected_update_token,
      config_digest: resolved.config_digest,
      additional_network_authority,
      auth_policies: additional.auth_policies,
      resource_limits: resource_limits.map(|limits| DefaultAuthorityResourceLimitsDto {
        max_request_bytes: limits.max_request_bytes,
        max_response_bytes: limits.max_response_bytes,
        max_stream_bytes: limits.max_stream_bytes,
        timeout_ms: limits.timeout_ms,
      }),
      expires_at,
    })
  }

  /// Confirm only the exact additional authority from a subject-bound preview.
  ///
  /// Persists one exact additive approval, resets the retained intent to pending with the current
  /// config binding, then activates. Never widens the default policy.
  ///
  /// Returns the confirmed subject kind so IPC can emit only that subject channel plus packages.
  pub fn confirm_default_runtime_authority(
    &self,
    input: ConfirmDefaultRuntimeAuthorityInput,
  ) -> Result<GrantSubjectKind, StorageError> {
    if !input.acknowledge_additional_authority {
      return Err(StorageError::Validation(
        "acknowledgement of additional runtime authority is required".into(),
      ));
    }
    self.purge_expired_authority_previews();
    let preview_id = Uuid::parse_str(&input.preview_id)
      .map_err(|_| StorageError::Validation("invalid authority preview id".into()))?;
    let session = {
      let mut guard = self
        .authority_previews
        .lock()
        .map_err(|_| StorageError::Internal("authority preview lock poisoned".into()))?;
      guard
        .remove(&preview_id)
        .ok_or_else(|| StorageError::NotFound(format!("authority preview {preview_id}")))?
    };
    if session.expires_at_unix <= now_unix() {
      return Err(StorageError::Validation("authority preview expired".into()));
    }

    // Hold the package-store lock across final package re-verification and the DB transaction so
    // package identity cannot drift between the reviewed preview and durable write. Drop before
    // activate_pending_subject: grant apply re-acquires the store lock and must not deadlock.
    let package_snapshot = {
      let _package_guard = self.packages.lock_store()?;
      // Re-verify the exact package under the store lock before opening the DB transaction.
      let package_snapshot = self.verify_policy_bound_package_snapshot(&session.package_digest)?;

      let now = now_rfc3339();
      let approval_id = new_id();
      self.db.transaction(|uow| {
        // Final subject/config/policy re-resolution inside the transaction.
        let current = self.resolve_subject_authority_preview_state_on_conn(
          uow.conn(),
          session.subject_kind,
          session.subject_id,
          &package_snapshot,
        )?;
        let additional = crate::services::runtime_authority::additional_authority_beyond_policy(
          &current.effective,
          &current.policy_constraints,
        );
        let current_digest = additional.digest()?;
        if current.package_digest != session.package_digest
          || current.config_digest != session.config_digest
          || current.expected_update_token != session.expected_update_token
          || current.policy_constraints_digest != session.policy_constraints_digest
          || current_digest != session.approved_authority_digest
          || additional.to_preview_entries() != session.additional_network_authority
        {
          return Err(StorageError::Conflict(
            "authority preview is stale relative to current subject or package state".into(),
          ));
        }

        let intent =
          default_package_activation_policies::get_intent(uow.conn(), session.subject_kind, session.subject_id)?
            .ok_or_else(|| StorageError::NotFound(format!("activation intent for subject {}", session.subject_id)))?;
        if intent.package_digest != session.package_digest {
          return Err(StorageError::Conflict(
            "activation intent package digest no longer matches the confirmed authority".into(),
          ));
        }

        // CAS the subject to pending_activation first so the durable approval binds the post-CAS
        // update token that activate_pending_subject will re-read.
        let durable_update_token = match session.subject_kind {
          GrantSubjectKind::IntegrationInstance => {
            use crate::repositories::integration_instances;
            let current = integration_instances::get(uow.conn(), session.subject_id)?;
            if current.execution_grant_set_revision.is_some() {
              return Err(StorageError::Conflict("subject already has an execution grant".into()));
            }
            if current.updated_at != session.expected_update_token {
              return Err(StorageError::Conflict(
                "authority preview is stale relative to current subject or package state".into(),
              ));
            }
            if current.runtime_state != "pending_activation" {
              let pin_now = now_rfc3339();
              integration_instances::compare_and_set_runtime_pin(
                uow.conn(),
                session.subject_id,
                &current.updated_at,
                &current.plugin_version,
                &current.config_json,
                current.config_schema_version,
                &current.runtime_kind,
                current.package_digest.as_deref(),
                None,
                "pending_activation",
                None,
                None,
                current.runtime_requirement_json.as_deref(),
                &pin_now,
              )?;
              pin_now
            } else {
              current.updated_at
            }
          }
          GrantSubjectKind::ProviderInstance => {
            use crate::domain::runtime_provider::{ProviderRuntimeBinding, ProviderRuntimeState};
            use crate::repositories::{provider_instances, provider_runtime_bindings};
            let provider = provider_instances::get(uow.conn(), session.subject_id)?;
            let current = provider_runtime_bindings::get(uow.conn(), session.subject_id, &provider.adapter_id)?;
            if current.grant_set_revision.is_some() {
              return Err(StorageError::Conflict(
                "provider binding already has an execution grant".into(),
              ));
            }
            let expected_digest = current.package_digest.clone().ok_or_else(|| {
              StorageError::Conflict("provider binding has no package digest for authority confirmation".into())
            })?;
            if expected_digest != session.package_digest {
              return Err(StorageError::Conflict(
                "provider binding package digest no longer matches the confirmed authority".into(),
              ));
            }
            if current.updated_at != session.expected_update_token {
              return Err(StorageError::Conflict(
                "authority preview is stale relative to current subject or package state".into(),
              ));
            }
            if current.state != ProviderRuntimeState::PendingActivation {
              let pin_now = now_rfc3339();
              let pending = ProviderRuntimeBinding {
                provider_id: current.provider_id,
                adapter_id: current.adapter_id.clone(),
                runtime_kind: current.runtime_kind,
                package_digest: current.package_digest.clone(),
                grant_set_revision: None,
                state: ProviderRuntimeState::PendingActivation,
                error_code: None,
                error_message: None,
                runtime_requirement_json: current.runtime_requirement_json.clone(),
                created_at: current.created_at.clone(),
                updated_at: pin_now.clone(),
              };
              provider_runtime_bindings::compare_and_set_pending_activation(
                uow.conn(),
                session.subject_id,
                &provider.adapter_id,
                &expected_digest,
                current.state,
                &current.updated_at,
                &pending,
              )?;
              pin_now
            } else {
              current.updated_at
            }
          }
        };

        // Replace any prior approval for this subject; one live exact binding only.
        // Bind the post-CAS update token so the subsequent grant path can exact-match.
        default_package_activation_policies::delete_authority_approvals_for_subject(
          uow.conn(),
          session.subject_kind,
          session.subject_id,
        )?;
        default_package_activation_policies::insert_authority_approval(
          uow.conn(),
          &crate::domain::default_package_activation::DefaultRuntimeAuthorityApproval {
            id: approval_id,
            subject_kind: session.subject_kind,
            subject_id: session.subject_id,
            package_digest: session.package_digest.clone(),
            config_digest: session.config_digest.clone(),
            subject_update_token: durable_update_token.clone(),
            policy_constraints_digest: session.policy_constraints_digest.clone(),
            approved_authority_json: session.approved_authority_json.clone(),
            approved_authority_digest: session.approved_authority_digest.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
          },
        )?;
        // Move retained intent to pending with the post-confirm config binding; never call generic retry.
        default_package_activation_policies::reset_intent_pending_with_binding(
          uow.conn(),
          intent.id,
          Some(&session.config_digest),
          Some(&durable_update_token),
        )?;
        Ok(())
      })?;
      package_snapshot
    };
    let _ = package_snapshot;

    let subject_kind = session.subject_kind;
    self.activate_pending_subject(subject_kind, session.subject_id)?;
    Ok(subject_kind)
  }

  /// Resolve current subject/config/package/policy authority for preview or confirmation CAS.
  pub(super) fn resolve_subject_authority_preview_state(
    &self,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
  ) -> Result<SubjectAuthorityPreviewState, StorageError> {
    let package_digest = self.db.read(|conn| {
      let intent = default_package_activation_policies::get_intent(conn, subject_kind, subject_id)?
        .ok_or_else(|| StorageError::NotFound(format!("activation intent for subject {subject_id}")))?;
      Ok(intent.package_digest)
    })?;
    let snapshot = self.verify_shared_package_snapshot(&package_digest)?;
    self.db.read(|conn| {
      self.resolve_subject_authority_preview_state_on_conn(conn, subject_kind, subject_id, snapshot.as_ref())
    })
  }

  /// Connection-scoped authority resolution used by preview and final confirmation CAS.
  pub(super) fn resolve_subject_authority_preview_state_on_conn(
    &self,
    conn: &rusqlite::Connection,
    subject_kind: GrantSubjectKind,
    subject_id: Uuid,
    snapshot: &VerifiedActivationSnapshot,
  ) -> Result<SubjectAuthorityPreviewState, StorageError> {
    let intent = default_package_activation_policies::get_intent(conn, subject_kind, subject_id)?
      .ok_or_else(|| StorageError::NotFound(format!("activation intent for subject {subject_id}")))?;
    if intent.state != DefaultRuntimeActivationState::ConfirmationRequired
      && intent.state != DefaultRuntimeActivationState::Failed
      && intent.state != DefaultRuntimeActivationState::Pending
    {
      return Err(StorageError::Validation(
        "subject is not awaiting runtime authority confirmation".into(),
      ));
    }
    let (package_digest, config_digest, expected_update_token, config_json, provider_base_url) = match subject_kind {
      GrantSubjectKind::IntegrationInstance => {
        use crate::repositories::integration_instances;
        let instance = integration_instances::get(conn, subject_id)?;
        let config_digest = sha256_hex(instance.config_json.as_bytes());
        (
          instance.package_digest.unwrap_or_default(),
          config_digest,
          instance.updated_at,
          Some(instance.config_json),
          None,
        )
      }
      GrantSubjectKind::ProviderInstance => {
        use crate::repositories::{provider_instances, provider_runtime_bindings};
        let provider = provider_instances::get(conn, subject_id)?;
        let binding = provider_runtime_bindings::get(conn, subject_id, &provider.adapter_id)?;
        let auth_scheme_json = serde_json::to_string(&provider.auth_scheme)
          .map_err(|e| StorageError::Internal(format!("serialize provider auth scheme: {e}")))?;
        let config_digest = sha256_hex(format!("{}|{auth_scheme_json}", provider.base_url).as_bytes());
        (
          binding.package_digest.unwrap_or_default(),
          config_digest,
          binding.updated_at,
          None,
          Some(provider.base_url),
        )
      }
    };
    if package_digest.is_empty() || package_digest != intent.package_digest {
      return Err(StorageError::Conflict(
        "subject package requirement no longer matches the activation intent".into(),
      ));
    }
    if package_digest != snapshot.package_digest {
      return Err(StorageError::Conflict(
        "subject package digest no longer matches the verified snapshot".into(),
      ));
    }
    let policy = default_package_activation_policies::get_policy(conn, &snapshot.verified.manifest.id)?
      .ok_or_else(|| StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()))?;
    if policy.package_digest != package_digest {
      return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
    }
    let status =
      default_package_activation_policies::resolve_authorization_status(conn, &snapshot.verified.manifest.id)?;
    if status != DefaultPackageAuthorizationStatus::Authorized {
      return Err(StorageError::Validation(DEFAULT_AUTHORIZATION_STALE_CODE.into()));
    }
    let policy_constraints: ApprovedAuthorityConstraints =
      serde_json::from_str(&policy.approved_authority_constraints_json)
        .map_err(|e| StorageError::Internal(format!("deserialize policy constraints: {e}")))?;
    let effective = match subject_kind {
      GrantSubjectKind::IntegrationInstance => {
        let config_json = config_json
          .ok_or_else(|| StorageError::Internal("integration authority preview missing config payload".into()))?;
        crate::services::runtime_authority::resolve_integration_effective_authority(
          &self.packages,
          &package_digest,
          &snapshot.verified.manifest,
          &config_json,
        )?
      }
      GrantSubjectKind::ProviderInstance => {
        let base_url = provider_base_url
          .ok_or_else(|| StorageError::Internal("provider authority preview missing base URL".into()))?;
        let capability_ids = snapshot
          .verified
          .manifest
          .provider_runtime
          .as_ref()
          .map(|declaration| declaration.capabilities.keys().cloned().collect::<Vec<_>>())
          .unwrap_or_default();
        crate::services::runtime_authority::resolve_provider_effective_authority(&base_url, &capability_ids)?
      }
    };
    Ok(SubjectAuthorityPreviewState {
      package_digest,
      config_digest,
      expected_update_token,
      policy_constraints_digest: policy.approved_authority_constraints_digest,
      policy_constraints,
      effective,
    })
  }

  pub(super) fn purge_expired_authority_previews(&self) {
    let now = now_unix();
    if let Ok(mut guard) = self.authority_previews.lock() {
      guard.retain(|_, session| session.expires_at_unix > now);
    }
  }
}
