// ABOUTME: Default package preview, authorization, and package-first preparation.
// ABOUTME: Exact policy resolution for future-instance create without legacy allowlists.
use super::*;

impl DefaultPackageActivationService {
  /// Preview exact future-instance authority for an installed package without mutating state.
  pub fn preview_default_package_activation(
    &self,
    package_digest: &str,
  ) -> Result<DefaultPackageActivationPreviewDto, StorageError> {
    self.purge_expired_previews();
    let version = self
      .db
      .read(|conn| installed_plugin_versions::get(conn, package_digest))?;
    if !version.content_available {
      return Err(StorageError::PluginUnavailable(format!(
        "package {package_digest} content is unavailable"
      )));
    }
    let unsigned = version.signature_status == crate::domain::plugin_package::PackageSignatureStatus::Unsigned;
    let (publisher_key_id, publisher_fingerprint) = if unsigned {
      (String::new(), String::new())
    } else {
      let publisher = self
        .db
        .read(|conn| plugin_publishers::get(conn, &version.publisher_key_id))?;
      if publisher.revoked {
        return Err(StorageError::Validation(
          "cannot authorize default: publisher is revoked".into(),
        ));
      }
      if !publisher.enabled {
        return Err(StorageError::Validation(
          "cannot authorize default: publisher is disabled".into(),
        ));
      }
      (publisher.key_id, publisher.fingerprint)
    };

    let verified = self.packages.verify_installed_package_snapshot(package_digest)?;
    if verified.package_digest != package_digest {
      return Err(StorageError::Validation(
        "re-verified package digest does not match the requested package".into(),
      ));
    }
    if verified.manifest.id != version.plugin_id {
      return Err(StorageError::Validation(
        "re-verified plugin id does not match the installed catalog row".into(),
      ));
    }
    let permission_digest = compute_permission_request_digest(&verified.manifest);
    if permission_digest != version.permission_request_digest {
      return Err(StorageError::Validation(
        "permission request digest changed after re-verification".into(),
      ));
    }

    let constraints = build_authority_constraints(&verified.manifest);
    let constraints_json = serde_json::to_string(&constraints)
      .map_err(|e| StorageError::Internal(format!("serialize authority constraints: {e}")))?;
    let constraints_digest = sha256_hex(constraints_json.as_bytes());
    let preview_id = new_id();
    let expires_at_unix = now_unix() + DEFAULT_ACTIVATION_PREVIEW_TTL_SECS;
    let expires_at = unix_to_rfc3339(expires_at_unix);

    let fixed_network_authority =
      crate::services::runtime_authority::policy_fixed_network_to_preview_entries(&constraints);

    let dynamic_authority_warnings = constraints
      .dynamic_origin_endpoint_ids
      .iter()
      .map(|endpoint_id| {
        format!(
          "Endpoint {endpoint_id} uses instance-configured origins; future instances require confirmation for those origins"
        )
      })
      .collect::<Vec<_>>();

    {
      let mut guard = self
        .previews
        .lock()
        .map_err(|_| StorageError::Internal("default activation preview lock poisoned".into()))?;
      guard.insert(
        preview_id,
        DefaultActivationPreviewSession {
          preview_id,
          package_digest: package_digest.to_string(),
          plugin_id: version.plugin_id.clone(),
          version: version.version.clone(),
          publisher_key_id: publisher_key_id.clone(),
          publisher_fingerprint: publisher_fingerprint.clone(),
          permission_request_digest: permission_digest.clone(),
          runtime_kind: runtime_kind_storage(verified.manifest.runtime.kind).to_string(),
          constraints: constraints.clone(),
          constraints_digest: constraints_digest.clone(),
          expires_at_unix,
          signature_status: version.signature_status,
        },
      );
    }

    Ok(DefaultPackageActivationPreviewDto {
      preview_id: preview_id.to_string(),
      plugin_id: version.plugin_id,
      package_digest: package_digest.to_string(),
      version: version.version,
      publisher_key_id,
      publisher_fingerprint,
      runtime_kind: runtime_kind_storage(verified.manifest.runtime.kind).to_string(),
      permission_request_digest: permission_digest,
      capabilities: verified.manifest.capabilities.iter().map(|c| c.id.clone()).collect(),
      fixed_network_authority,
      dynamic_authority_warnings,
      auth_policies: constraints.auth_policies,
      resource_limits: constraints
        .resource_limits
        .map(|limits| DefaultAuthorityResourceLimitsDto {
          max_request_bytes: limits.max_request_bytes,
          max_response_bytes: limits.max_response_bytes,
          max_stream_bytes: limits.max_stream_bytes,
          timeout_ms: limits.timeout_ms,
        }),
      requires_instance_confirmation_for_dynamic_origins: !constraints.dynamic_origin_endpoint_ids.is_empty(),
      signature_status: version.signature_status,
      requires_unsigned_default_risk_acknowledgement: unsigned,
      expires_at,
    })
  }

  /// Atomically set the catalog default and persist an exact future-instance authorization policy.
  pub fn authorize_default_plugin_package(
    &self,
    input: AuthorizeDefaultPluginPackageInput,
  ) -> Result<PluginDefaultVersion, StorageError> {
    self.purge_expired_previews();
    if !input.acknowledge_future_instance_authority {
      return Err(StorageError::Validation(
        "future-instance authority acknowledgement is required".into(),
      ));
    }
    let preview_id = Uuid::parse_str(&input.preview_id)
      .map_err(|_| StorageError::Validation("invalid default activation preview id".into()))?;
    let session = {
      let mut guard = self
        .previews
        .lock()
        .map_err(|_| StorageError::Internal("default activation preview lock poisoned".into()))?;
      guard
        .remove(&preview_id)
        .ok_or_else(|| StorageError::NotFound(format!("default activation preview {preview_id}")))?
    };
    if session.expires_at_unix < now_unix() {
      return Err(StorageError::Validation("default activation preview expired".into()));
    }
    let unsigned = session.signature_status == crate::domain::plugin_package::PackageSignatureStatus::Unsigned;
    if unsigned && !input.acknowledge_unsigned_default_risk {
      return Err(StorageError::Validation(
        "unsigned default packages require acknowledge_unsigned_default_risk".into(),
      ));
    }
    if !unsigned && input.acknowledge_unsigned_default_risk {
      return Err(StorageError::Validation(
        "unsigned default risk acknowledgement is invalid for signed packages".into(),
      ));
    }

    if !unsigned {
      let publisher = self
        .db
        .read(|conn| plugin_publishers::get(conn, &session.publisher_key_id))?;
      if publisher.revoked || !publisher.enabled {
        return Err(StorageError::Validation(
          "cannot authorize default: publisher is revoked or disabled".into(),
        ));
      }
      if publisher.fingerprint != session.publisher_fingerprint {
        return Err(StorageError::Validation(
          "publisher fingerprint changed after preview".into(),
        ));
      }
    }

    let verified = self
      .packages
      .verify_installed_package_snapshot(&session.package_digest)?;
    if verified.package_digest != session.package_digest
      || verified.manifest.id != session.plugin_id
      || compute_permission_request_digest(&verified.manifest) != session.permission_request_digest
      || verified.signature_status != session.signature_status
      || (!unsigned
        && (verified.manifest.publisher.key_id != session.publisher_key_id
          || verified.publisher_fingerprint != session.publisher_fingerprint))
    {
      return Err(StorageError::Validation(
        "package identity changed after default activation preview".into(),
      ));
    }
    let constraints = build_authority_constraints(&verified.manifest);
    let constraints_json = serde_json::to_string(&constraints)
      .map_err(|e| StorageError::Internal(format!("serialize authority constraints: {e}")))?;
    let constraints_digest = sha256_hex(constraints_json.as_bytes());
    if constraints_digest != session.constraints_digest {
      return Err(StorageError::Validation(
        "authority constraints changed after default activation preview".into(),
      ));
    }

    let now = now_rfc3339();
    self.db.transaction(|uow| {
      let default = installed_plugin_versions::set_default(uow.conn(), &session.plugin_id, &session.package_digest)?;
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: session.plugin_id.clone(),
          package_digest: session.package_digest.clone(),
          publisher_key_id: session.publisher_key_id.clone(),
          publisher_fingerprint: session.publisher_fingerprint.clone(),
          signature_status: session.signature_status,
          unsigned_default_risk_acknowledgement_version: if unsigned {
            Some(crate::domain::plugin_package::UNSIGNED_DEFAULT_RISK_ACK_V1.to_string())
          } else {
            None
          },
          permission_request_digest: session.permission_request_digest.clone(),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest,
          policy_source: DefaultActivationPolicySource::UserConfirmed,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(default)
    })
  }

  /// Resolve authorization status for a plugin's catalog default.
  pub fn authorization_status(&self, plugin_id: &str) -> Result<DefaultPackageAuthorizationStatus, StorageError> {
    self
      .db
      .read(|conn| default_package_activation_policies::resolve_authorization_status(conn, plugin_id))
  }

  /// Load an exact authorized policy when present and still matching the installed package.
  pub fn get_authorized_policy(&self, plugin_id: &str) -> Result<Option<DefaultPackageActivationPolicy>, StorageError> {
    self.db.read(|conn| {
      let status = default_package_activation_policies::resolve_authorization_status(conn, plugin_id)?;
      if status != DefaultPackageAuthorizationStatus::Authorized {
        return Ok(None);
      }
      default_package_activation_policies::get_policy(conn, plugin_id)
    })
  }

  /// Resolve package-first create fields for a plugin default.
  ///
  /// Distinguishes true absence (`NoDefault`, legacy dual-stack allowed) from unauthorized or
  /// stale defaults (`Blocked`, exact inactive requirement retained).
  pub fn prepare_package_first_create(&self, plugin_id: &str) -> Result<PackageFirstCreateResolution, StorageError> {
    let (status, default_digest, policy) = self.db.read(|conn| {
      let status = default_package_activation_policies::resolve_authorization_status(conn, plugin_id)?;
      let default = installed_plugin_versions::get_default(conn, plugin_id)?;
      let policy = default_package_activation_policies::get_policy(conn, plugin_id)?;
      Ok((status, default.map(|row| row.package_digest), policy))
    })?;

    match status {
      DefaultPackageAuthorizationStatus::Absent => Ok(PackageFirstCreateResolution::NoDefault),
      DefaultPackageAuthorizationStatus::Authorized => {
        let Some(policy) = policy else {
          return Ok(PackageFirstCreateResolution::NoDefault);
        };
        let version = self
          .db
          .read(|conn| installed_plugin_versions::get(conn, &policy.package_digest))?;
        if version.plugin_id != plugin_id || !version.content_available {
          return self.blocked_package_first_from_digest(
            plugin_id,
            &policy.package_digest,
            PackageFirstBlockReason::Stale,
          );
        }
        let verified = match self.packages.verify_installed_package_snapshot(&policy.package_digest) {
          Ok(verified) => verified,
          Err(_) => {
            return self.blocked_package_first_from_digest(
              plugin_id,
              &policy.package_digest,
              PackageFirstBlockReason::Stale,
            );
          }
        };
        if verified.package_digest != policy.package_digest
          || verified.manifest.id != plugin_id
          || verified.signature_status != policy.signature_status
          || compute_permission_request_digest(&verified.manifest) != policy.permission_request_digest
        {
          return self.blocked_package_first_from_digest(
            plugin_id,
            &policy.package_digest,
            PackageFirstBlockReason::Stale,
          );
        }
        let requirement_json = self.runtime_requirement_json(
          plugin_id,
          &version,
          Some(&policy.package_digest),
          Some(&policy.publisher_key_id),
          Some(&policy.publisher_fingerprint),
        )?;
        Ok(PackageFirstCreateResolution::Ready(PreparedPackageFirstRuntime {
          package_digest: policy.package_digest,
          runtime_kind: version.runtime_kind,
          plugin_version: version.version,
          runtime_requirement_json: requirement_json,
        }))
      }
      DefaultPackageAuthorizationStatus::Unauthorized => {
        let Some(digest) = default_digest else {
          return Ok(PackageFirstCreateResolution::NoDefault);
        };
        self.blocked_package_first_from_digest(plugin_id, &digest, PackageFirstBlockReason::Unauthorized)
      }
      DefaultPackageAuthorizationStatus::Stale | DefaultPackageAuthorizationStatus::ConfirmationRequired => {
        let digest = default_digest
          .or_else(|| policy.map(|row| row.package_digest))
          .ok_or_else(|| StorageError::Internal("stale default missing package digest".into()))?;
        self.blocked_package_first_from_digest(plugin_id, &digest, PackageFirstBlockReason::Stale)
      }
    }
  }

  pub(super) fn blocked_package_first_from_digest(
    &self,
    plugin_id: &str,
    package_digest: &str,
    reason: PackageFirstBlockReason,
  ) -> Result<PackageFirstCreateResolution, StorageError> {
    let version = self
      .db
      .read(|conn| installed_plugin_versions::get_optional(conn, package_digest))?;
    let (runtime_kind, plugin_version, publisher_key_id, publisher_fingerprint) = match version {
      Some(version) if version.plugin_id == plugin_id => (
        version.runtime_kind,
        version.version,
        Some(version.publisher_key_id),
        Some(version.publisher_fingerprint),
      ),
      _ => ("wasm-component".into(), "0.0.0".into(), None, None),
    };
    let requirement = crate::domain::runtime_lifecycle::RuntimeRequirementExport {
      plugin_id: plugin_id.to_string(),
      plugin_version: plugin_version.clone(),
      runtime_kind: runtime_kind.clone(),
      package_digest: Some(package_digest.to_string()),
      publisher_key_id: publisher_key_id.clone(),
      publisher_key_fingerprint: publisher_fingerprint.clone(),
      plugin_api_version: None,
      config_schema_version: 1,
      required_capability_majors: Vec::new(),
      provider_runtime_kind: None,
      provider_package_digest: None,
    };
    let requirement_json = serde_json::to_string(&requirement)
      .map_err(|e| StorageError::Internal(format!("serialize runtime requirement: {e}")))?;
    Ok(PackageFirstCreateResolution::Blocked(BlockedPackageFirstRuntime {
      package_digest: package_digest.to_string(),
      runtime_kind,
      plugin_version,
      runtime_requirement_json: requirement_json,
      reason,
    }))
  }

  pub(super) fn runtime_requirement_json(
    &self,
    plugin_id: &str,
    version: &crate::domain::plugin_package::InstalledPluginVersion,
    package_digest: Option<&str>,
    publisher_key_id: Option<&str>,
    publisher_fingerprint: Option<&str>,
  ) -> Result<String, StorageError> {
    let requirement = crate::domain::runtime_lifecycle::RuntimeRequirementExport {
      plugin_id: plugin_id.to_string(),
      plugin_version: version.version.clone(),
      runtime_kind: version.runtime_kind.clone(),
      package_digest: package_digest.map(str::to_string),
      publisher_key_id: publisher_key_id.map(str::to_string),
      publisher_key_fingerprint: publisher_fingerprint.map(str::to_string),
      plugin_api_version: None,
      config_schema_version: 1,
      required_capability_majors: Vec::new(),
      provider_runtime_kind: None,
      provider_package_digest: None,
    };
    serde_json::to_string(&requirement)
      .map_err(|e| StorageError::Internal(format!("serialize runtime requirement: {e}")))
  }

  pub(super) fn purge_expired_previews(&self) {
    let now = now_unix();
    if let Ok(mut guard) = self.previews.lock() {
      guard.retain(|_, session| session.expires_at_unix >= now);
    }
  }
}
