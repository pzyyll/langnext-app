// ABOUTME: Host-shipped vendor bootstrap default activation policies.
// ABOUTME: Exact digest/publisher/permission/ceiling binding from audited resources only.
use super::*;
use crate::services::plugin_package::VerifiedPackage;
use std::collections::HashSet;

/// Derive one vendor bootstrap policy entry from an already verified signed package.
///
/// The caller supplies the external public-root verification result. This helper never reads
/// private keys and never consults catalog or resource state.
pub fn generate_vendor_bootstrap_policy_from_verified(verified: &VerifiedPackage) -> VendorBootstrapPolicyEntry {
  VendorBootstrapPolicyEntry {
    plugin_id: verified.manifest.id.clone(),
    package_digest: verified.package_digest.clone(),
    publisher_key_id: verified.manifest.publisher.key_id.clone(),
    publisher_fingerprint: verified.publisher_fingerprint.clone(),
    permission_request_digest: compute_permission_request_digest(&verified.manifest),
    approved_authority_constraints: build_authority_constraints(&verified.manifest),
  }
}

impl DefaultPackageActivationService {
  /// Apply host-shipped vendor bootstrap policies from the audited resource file.
  ///
  /// Vendor signature alone never grants bootstrap-default eligibility. Each entry must exact-match
  /// the installed package digest, publisher identity, and permission-request digest after
  /// external-root re-verification.
  ///
  /// Two modes:
  /// - Service-level use without `with_official_resource_bundle`: apply exactly the entries in
  ///   the configured policy path (absent file stays an empty apply).
  /// - AppState-wired official bundle (`official_plugins_dir` set): the startup readiness
  ///   invariant is active. A present official bundle must authorize every exact policy or
  ///   startup fails; missing, empty, incomplete, or partially rejected policies are readiness
  ///   errors, never a silent zero-default success. Applied exact identities must match the
  ///   discovered official archive identities. Callers that opted out of official resources
  ///   (`None`) keep the permissive service-level behavior.
  pub fn apply_vendor_bootstrap_policies(&self) -> Result<Vec<PluginDefaultVersion>, StorageError> {
    let Some(plugins_dir) = self.official_plugins_dir.as_ref() else {
      return self.apply_vendor_bootstrap_policies_configured();
    };
    let path = &self.vendor_bootstrap_path;
    if !path.is_file() {
      return Err(StorageError::Validation(format!(
        "official resource bundle is present at {} but vendor bootstrap policies are missing: {}",
        plugins_dir.display(),
        path.display()
      )));
    }
    let bytes = std::fs::read(path)
      .map_err(|e| StorageError::Internal(format!("read vendor bootstrap policies {}: {e}", path.display())))?;
    let entries: Vec<VendorBootstrapPolicyEntry> = serde_json::from_slice(&bytes)
      .map_err(|e| StorageError::Validation(format!("invalid vendor bootstrap policies {}: {e}", path.display())))?;
    // Completeness: every official package requires exactly one policy entry; unknown entries fail
    // closed so a partial or stale resource cannot silently leave built-ins unauthorized.
    let required: HashSet<&str> = crate::services::plugin_release_bundle::REQUIRED_OFFICIAL_RELEASE_PACKAGES
      .iter()
      .map(|spec| spec.plugin_id)
      .collect();
    let covered: HashSet<&str> = entries.iter().map(|entry| entry.plugin_id.as_str()).collect();
    if !required.is_subset(&covered) {
      let mut missing: Vec<&str> = required.difference(&covered).copied().collect();
      missing.sort_unstable();
      return Err(StorageError::Validation(format!(
        "official vendor bootstrap policies are incomplete; missing policy entries for {}",
        missing.join(", ")
      )));
    }
    if !covered.is_subset(&required) {
      let mut extra: Vec<&str> = covered.difference(&required).copied().collect();
      extra.sort_unstable();
      return Err(StorageError::Validation(format!(
        "official vendor bootstrap policies contain unknown plugin entries: {}",
        extra.join(", ")
      )));
    }
    let mut applied = Vec::new();
    let mut rejected: Vec<String> = Vec::new();
    for entry in entries {
      match self.apply_one_vendor_bootstrap_entry(&entry) {
        Ok(default) => applied.push(default),
        Err(err) => {
          log::warn!(
            "official vendor bootstrap policy rejected plugin {}: {err}",
            entry.plugin_id
          );
          rejected.push(entry.plugin_id);
        }
      }
    }
    if !rejected.is_empty() {
      rejected.sort_unstable();
      rejected.dedup();
      return Err(StorageError::Validation(format!(
        "official vendor bootstrap rejected {} policy entries: {}",
        rejected.len(),
        rejected.join(", ")
      )));
    }
    // Applied exact identities must match the discovered official archive identities.
    let applied_by_id: HashMap<&str, &PluginDefaultVersion> = applied
      .iter()
      .map(|default| (default.plugin_id.as_str(), default))
      .collect();
    for identity in &self.official_bundle_identities {
      let matches = applied_by_id
        .get(identity.plugin_id.as_str())
        .is_some_and(|default| default.package_digest == identity.package_digest);
      if !matches {
        return Err(StorageError::Validation(format!(
          "official vendor bootstrap applied identities do not match the discovered official bundle for {}",
          identity.plugin_id
        )));
      }
    }
    log::info!(
      "official_vendor_bootstrap_defaults_count={} plugin_ids={}",
      applied.len(),
      applied
        .iter()
        .map(|default| default.plugin_id.as_str())
        .collect::<Vec<_>>()
        .join(",")
    );
    Ok(applied)
  }

  /// Permissive service-level apply: exactly the entries in the configured policy path.
  fn apply_vendor_bootstrap_policies_configured(&self) -> Result<Vec<PluginDefaultVersion>, StorageError> {
    let path = &self.vendor_bootstrap_path;
    if !path.exists() {
      return Ok(Vec::new());
    }
    let bytes = std::fs::read(path)
      .map_err(|e| StorageError::Internal(format!("read vendor bootstrap policies {}: {e}", path.display())))?;
    let entries: Vec<VendorBootstrapPolicyEntry> = serde_json::from_slice(&bytes)
      .map_err(|e| StorageError::Validation(format!("invalid vendor bootstrap policies {}: {e}", path.display())))?;
    let mut applied = Vec::new();
    for entry in entries {
      match self.apply_one_vendor_bootstrap_entry(&entry) {
        Ok(default) => applied.push(default),
        Err(err) => {
          log::warn!("vendor bootstrap policy rejected for plugin {}: {err}", entry.plugin_id);
        }
      }
    }
    Ok(applied)
  }

  pub(super) fn apply_one_vendor_bootstrap_entry(
    &self,
    entry: &VendorBootstrapPolicyEntry,
  ) -> Result<PluginDefaultVersion, StorageError> {
    let version = self
      .db
      .read(|conn| installed_plugin_versions::get(conn, &entry.package_digest))?;
    if version.plugin_id != entry.plugin_id {
      return Err(StorageError::Validation(
        "vendor bootstrap plugin id does not match installed package".into(),
      ));
    }
    if version.signature_status != crate::domain::plugin_package::PackageSignatureStatus::Signed {
      return Err(StorageError::Validation(
        "vendor bootstrap rejects unsigned packages".into(),
      ));
    }
    if version.publisher_key_id != entry.publisher_key_id
      || version.publisher_fingerprint != entry.publisher_fingerprint
      || version.permission_request_digest != entry.permission_request_digest
    {
      return Err(StorageError::Validation(
        "vendor bootstrap identity does not match installed package".into(),
      ));
    }
    let publisher = self
      .db
      .read(|conn| plugin_publishers::get(conn, &entry.publisher_key_id))?;
    if publisher.source != crate::domain::plugin_package::PublisherSource::Vendor
      || publisher.revoked
      || !publisher.enabled
    {
      return Err(StorageError::Validation(
        "vendor bootstrap requires an enabled non-revoked vendor publisher".into(),
      ));
    }
    let verified = self.packages.verify_runtime_store_snapshot(
      &entry.package_digest,
      &publisher.key_id,
      &publisher.fingerprint,
      &publisher.public_key_hex,
      publisher.source,
    )?;
    if verified.package_digest != entry.package_digest
      || verified.manifest.id != entry.plugin_id
      || compute_permission_request_digest(&verified.manifest) != entry.permission_request_digest
      || verified.manifest.publisher.key_id != entry.publisher_key_id
      || verified.publisher_fingerprint != entry.publisher_fingerprint
    {
      return Err(StorageError::Validation(
        "vendor bootstrap package failed external-root re-verification".into(),
      ));
    }
    // Host-shipped resource is the ceiling; computed constraints must not expand beyond it.
    let computed = build_authority_constraints(&verified.manifest);
    if !constraints_within_ceiling(&computed, &entry.approved_authority_constraints) {
      return Err(StorageError::Validation(
        "verified package authority expands beyond the host-shipped vendor bootstrap ceiling".into(),
      ));
    }
    let constraints_json = serde_json::to_string(&entry.approved_authority_constraints)
      .map_err(|e| StorageError::Internal(format!("serialize vendor bootstrap constraints: {e}")))?;
    let constraints_digest = sha256_hex(constraints_json.as_bytes());
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      let default = installed_plugin_versions::set_default(uow.conn(), &entry.plugin_id, &entry.package_digest)?;
      default_package_activation_policies::upsert_policy(
        uow.conn(),
        &DefaultPackageActivationPolicy {
          plugin_id: entry.plugin_id.clone(),
          package_digest: entry.package_digest.clone(),
          publisher_key_id: entry.publisher_key_id.clone(),
          publisher_fingerprint: entry.publisher_fingerprint.clone(),
          signature_status: crate::domain::plugin_package::PackageSignatureStatus::Signed,
          unsigned_default_risk_acknowledgement_version: None,
          permission_request_digest: entry.permission_request_digest.clone(),
          approved_authority_constraints_json: constraints_json,
          approved_authority_constraints_digest: constraints_digest,
          policy_source: DefaultActivationPolicySource::VendorBootstrap,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(default)
    })
  }
}
