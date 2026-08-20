// ABOUTME: Host-shipped vendor bootstrap default activation policies.
// ABOUTME: Exact digest/publisher/permission/ceiling binding from audited resources only.
use super::*;

impl DefaultPackageActivationService {
  /// Apply host-shipped vendor bootstrap policies from the audited resource file only.
  ///
  /// Vendor signature alone never grants bootstrap-default eligibility. Each entry must exact-match
  /// the installed package digest, publisher identity, and permission-request digest after
  /// external-root re-verification.
  pub fn apply_vendor_bootstrap_policies(&self) -> Result<Vec<PluginDefaultVersion>, StorageError> {
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
