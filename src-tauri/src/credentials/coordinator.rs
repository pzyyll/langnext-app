// ABOUTME: Shared credential journal finalization and per-owner recovery rules.
// ABOUTME: Journals are deleted only after idempotent vault cleanup succeeds.
use crate::credentials::vault::CredentialVault;
use crate::error::StorageError;
use crate::repositories::credential_operations::{
  self, CredentialOperation, OperationState, OwnerKind, PRIMARY_SLOT_ID,
};
use crate::repositories::{app_credentials, integration_credential_bindings, ocr_services, provider_instances};
use crate::storage::Database;
use uuid::Uuid;

/// Result of attempting to finalize one credential operation.
#[derive(Debug)]
pub enum FinalizeResult {
  /// Vault cleanup succeeded (or was a no-op) and the journal row was deleted.
  Completed,
  /// Vault cleanup could not finish; the journal row was retained unchanged.
  Deferred { error: StorageError },
}

impl PartialEq for FinalizeResult {
  fn eq(&self, other: &Self) -> bool {
    matches!(
      (self, other),
      (Self::Completed, Self::Completed) | (Self::Deferred { .. }, Self::Deferred { .. })
    )
  }
}

/// Aggregated recovery outcome for startup or preflight.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryReport {
  pub completed: u32,
  pub deferred: u32,
  pub deferred_owners: Vec<(OwnerKind, String)>,
}

impl RecoveryReport {
  pub fn all_clear(&self) -> bool {
    self.deferred == 0
  }
}

/// Resolve the current credential reference for an operation owner + slot.
pub fn current_binding(
  db: &Database,
  owner_kind: OwnerKind,
  owner_id: &str,
  slot_id: &str,
) -> Result<Option<String>, StorageError> {
  match owner_kind {
    OwnerKind::Provider => {
      let id = Uuid::parse_str(owner_id)
        .map_err(|_| StorageError::Internal(format!("invalid provider owner_id: {owner_id}")))?;
      match db.read(|conn| provider_instances::get(conn, id)) {
        Ok(provider) => Ok(provider.credential_ref),
        Err(StorageError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
      }
    }
    OwnerKind::GlobalProxy => db.read(app_credentials::get_global_proxy_ref),
    OwnerKind::OcrApiKey => {
      let id =
        Uuid::parse_str(owner_id).map_err(|_| StorageError::Internal(format!("invalid ocr owner_id: {owner_id}")))?;
      match db.read(|conn| ocr_services::get(conn, id)) {
        Ok(service) => Ok(service.api_key_ref),
        Err(StorageError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
      }
    }
    OwnerKind::OcrSecretKey => {
      let id =
        Uuid::parse_str(owner_id).map_err(|_| StorageError::Internal(format!("invalid ocr owner_id: {owner_id}")))?;
      match db.read(|conn| ocr_services::get(conn, id)) {
        Ok(service) => Ok(service.secret_key_ref),
        Err(StorageError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
      }
    }
    OwnerKind::Integration => {
      let id = Uuid::parse_str(owner_id)
        .map_err(|_| StorageError::Internal(format!("invalid integration owner_id: {owner_id}")))?;
      match db.read(|conn| integration_credential_bindings::get_optional(conn, id, slot_id)) {
        Ok(Some(binding)) => Ok(binding.credential_ref),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
      }
    }
  }
}

/// Determine which vault reference, if any, must be deleted for this operation.
///
/// Returns `Ok(None)` for journal-only completion, `Ok(Some(ref))` when a vault
/// delete must succeed before the journal may be removed, and `Err` when the
/// local owner row is missing in a way that still needs vault cleanup of `new_ref`.
pub fn cleanup_target(op: &CredentialOperation, current: Option<&str>) -> Option<String> {
  match op.state {
    OperationState::Prepared => {
      if op.new_ref.is_some() {
        if current == op.new_ref.as_deref() {
          // Database change is committed; finish by deleting the old secret.
          op.expected_old_ref.clone()
        } else {
          // New secret was never bound; delete it.
          op.new_ref.clone()
        }
      } else {
        // Clear journal without a new secret.
        if current == op.expected_old_ref.as_deref() {
          // Clear never reached the database; drop the uncommitted journal only.
          None
        } else if current.is_none() {
          // Clear was applied; delete the old secret when present.
          op.expected_old_ref.clone()
        } else {
          // Unexpected binding; retain journal only if we cannot act safely.
          // Prefer deleting expected_old when current is already something else —
          // the clear is not applied, so do not touch vault secrets.
          None
        }
      }
    }
    OperationState::DbCommitted => op.expected_old_ref.clone(),
  }
}

/// Finalize one complete operation: vault cleanup then journal delete.
///
/// On vault failure the journal is left unchanged so recovery can retry.
pub fn finalize_operation(
  db: &Database,
  vault: &dyn CredentialVault,
  op: &CredentialOperation,
) -> Result<FinalizeResult, StorageError> {
  let current = current_binding(db, op.owner_kind, &op.owner_id, &op.slot_id)?;
  let target = cleanup_target(op, current.as_deref());

  if let Some(account) = target {
    if let Err(e) = vault.delete(&account) {
      // owner_id is a stable UUID, not a secret; never log vault payloads or tokens.
      log::warn!(
        "cleanup_deferred op={} owner_kind={} owner_id={} error_code={}",
        op.id,
        op.owner_kind.as_str(),
        op.owner_id,
        error_code(&e)
      );
      return Ok(FinalizeResult::Deferred { error: e });
    }
  }

  db.transaction(|uow| {
    credential_operations::delete(uow.conn(), op.id)?;
    Ok(())
  })?;
  Ok(FinalizeResult::Completed)
}

/// Recover every unfinished operation for one owner + slot.
pub fn recover_owner_slot(
  db: &Database,
  vault: &dyn CredentialVault,
  owner_kind: OwnerKind,
  owner_id: &str,
  slot_id: &str,
) -> Result<RecoveryReport, StorageError> {
  let op = db.read(|conn| credential_operations::get_for_owner_slot(conn, owner_kind, owner_id, slot_id))?;
  let mut report = RecoveryReport::default();
  if let Some(op) = op {
    match finalize_operation(db, vault, &op)? {
      FinalizeResult::Completed => report.completed += 1,
      FinalizeResult::Deferred { .. } => {
        report.deferred += 1;
        report.deferred_owners.push((owner_kind, owner_id.to_string()));
      }
    }
  }
  Ok(report)
}

/// Recover unfinished primary-slot operation for legacy owners.
pub fn recover_owner(
  db: &Database,
  vault: &dyn CredentialVault,
  owner_kind: OwnerKind,
  owner_id: &str,
) -> Result<RecoveryReport, StorageError> {
  recover_owner_slot(db, vault, owner_kind, owner_id, PRIMARY_SLOT_ID)
}

/// Recover all unfinished credential operations (startup path).
pub fn recover_all(db: &Database, vault: &dyn CredentialVault) -> RecoveryReport {
  let ops = match db.read(credential_operations::list_unfinished) {
    Ok(ops) => ops,
    Err(e) => {
      log::error!("recovery_list_failed error_code={}", error_code(&e));
      return RecoveryReport::default();
    }
  };

  let mut report = RecoveryReport::default();
  for op in ops {
    match finalize_operation(db, vault, &op) {
      Ok(FinalizeResult::Completed) => report.completed += 1,
      Ok(FinalizeResult::Deferred { .. }) => {
        report.deferred += 1;
        report.deferred_owners.push((op.owner_kind, op.owner_id.clone()));
      }
      Err(e) => {
        log::error!("recovery_finalize_failed op={} error_code={}", op.id, error_code(&e));
        report.deferred += 1;
        report.deferred_owners.push((op.owner_kind, op.owner_id.clone()));
      }
    }
  }
  report
}

/// Preflight for a credential mutation on an explicit slot: recover first.
///
/// Returns `CredentialBusy` when an unfinished journal remains after recovery,
/// or `CredentialUnavailable` when the vault could not complete cleanup.
pub fn preflight_owner_slot(
  db: &Database,
  vault: &dyn CredentialVault,
  owner_kind: OwnerKind,
  owner_id: &str,
  slot_id: &str,
) -> Result<(), StorageError> {
  let report = recover_owner_slot(db, vault, owner_kind, owner_id, slot_id)?;
  if report.deferred > 0 {
    // Distinguishing busy vs unavailable: if a journal remains, check whether
    // the last finalize deferred due to vault reachability by re-probing.
    let remaining = db.read(|conn| credential_operations::get_for_owner_slot(conn, owner_kind, owner_id, slot_id))?;
    if remaining.is_some() {
      // Attempt a no-op exists probe to distinguish vault outage.
      // Use a synthetic probe that never exists so we only test availability.
      match vault.exists("__langnext_probe_unavailable__") {
        Ok(_) => return Err(StorageError::CredentialBusy),
        Err(StorageError::CredentialUnavailable) | Err(StorageError::CredentialAccess) => {
          return Err(StorageError::CredentialUnavailable);
        }
        Err(e) => return Err(e),
      }
    }
  }
  Ok(())
}

/// Primary-slot preflight for legacy owners.
pub fn preflight_owner(
  db: &Database,
  vault: &dyn CredentialVault,
  owner_kind: OwnerKind,
  owner_id: &str,
) -> Result<(), StorageError> {
  preflight_owner_slot(db, vault, owner_kind, owner_id, PRIMARY_SLOT_ID)
}

fn error_code(err: &StorageError) -> &'static str {
  match err {
    StorageError::CredentialUnavailable => "credential_unavailable",
    StorageError::CredentialAccess => "credential_access",
    StorageError::CredentialBusy => "credential_busy",
    StorageError::NotFound(_) => "not_found",
    StorageError::Validation(_) => "validation_failed",
    StorageError::Conflict(_) => "conflict",
    StorageError::ImportPreviewConflict { .. } => "conflict",
    StorageError::EndpointTrustRequired(_) => "endpoint_trust_required",
    StorageError::EndpointTrustStale(_) => "endpoint_trust_stale",
    StorageError::InUse(_) => "in_use",
    StorageError::PluginUnavailable(_) => "plugin_unavailable",
    StorageError::StorageUnavailable(_) => "storage_unavailable",
    StorageError::StorageVersionUnsupported(_) => "storage_version_unsupported",
    StorageError::Io(_) => "io",
    StorageError::Sqlite(_) => "sqlite",
    StorageError::Serialization(_) => "serialization",
    StorageError::Migration(_) => "migration",
    StorageError::Capability { .. } => "capability_error",
    StorageError::Internal(_) => "internal_error",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::credentials::provider_ref;
  use crate::credentials::vault::MemoryCredentialVault;
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::provider_instances;
  use std::sync::Arc;

  fn setup() -> (tempfile::TempDir, Database, Arc<MemoryCredentialVault>) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    (dir, db, vault)
  }

  fn insert_provider(db: &Database, id: Uuid, credential_ref: Option<String>) {
    let now = now_rfc3339();
    db.transaction(|uow| {
      provider_instances::insert(
        uow.conn(),
        &ProviderInstance {
          id,
          adapter_id: "openai-compatible".into(),
          display_name: "P".into(),
          base_url: "https://api.openai.com/v1".into(),
          base_url_source: BaseUrlSource::PluginDefault,
          auth_scheme: AuthSchemeV1::bearer(),
          credential_kind: CredentialKind::ApiKey,
          credential_ref,
          enabled: true,
          proxy_mode: ProxyMode::Inherit,
          insecure_http_confirmed_at: None,
          models_synced_at: None,
          models_sync_status: ModelsSyncStatus::Never,
          models_sync_error_code: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
  }

  #[test]
  fn prepared_unused_new_ref_deletes_secret() {
    let (_d, db, vault) = setup();
    let provider_id = new_id();
    let op_id = new_id();
    let new_ref = provider_ref(provider_id, op_id);
    insert_provider(&db, provider_id, None);
    vault.set(&new_ref, "secret").unwrap();
    let op = db
      .transaction(|uow| {
        credential_operations::insert_prepared(
          uow.conn(),
          op_id,
          OwnerKind::Provider,
          &provider_id.to_string(),
          None,
          Some(&new_ref),
        )
      })
      .unwrap();
    assert_eq!(
      finalize_operation(&db, vault.as_ref(), &op).unwrap(),
      FinalizeResult::Completed
    );
    assert!(!vault.exists(&new_ref).unwrap());
    assert!(db.read(credential_operations::list_unfinished).unwrap().is_empty());
  }

  #[test]
  fn prepared_committed_new_ref_deletes_old() {
    let (_d, db, vault) = setup();
    let provider_id = new_id();
    let op_id = new_id();
    let old_ref = provider_ref(provider_id, new_id());
    let new_ref = provider_ref(provider_id, op_id);
    insert_provider(&db, provider_id, Some(new_ref.clone()));
    vault.set(&old_ref, "old").unwrap();
    vault.set(&new_ref, "new").unwrap();
    let op = db
      .transaction(|uow| {
        credential_operations::insert_prepared(
          uow.conn(),
          op_id,
          OwnerKind::Provider,
          &provider_id.to_string(),
          Some(&old_ref),
          Some(&new_ref),
        )
      })
      .unwrap();
    // Promote to prepared-but-bound (same cleanup as committed path for old).
    assert_eq!(
      finalize_operation(&db, vault.as_ref(), &op).unwrap(),
      FinalizeResult::Completed
    );
    assert!(!vault.exists(&old_ref).unwrap());
    assert!(vault.exists(&new_ref).unwrap());
  }

  #[test]
  fn db_committed_deletes_old_only() {
    let (_d, db, vault) = setup();
    let provider_id = new_id();
    let op_id = new_id();
    let old_ref = provider_ref(provider_id, new_id());
    let new_ref = provider_ref(provider_id, op_id);
    insert_provider(&db, provider_id, Some(new_ref.clone()));
    vault.set(&old_ref, "old").unwrap();
    vault.set(&new_ref, "new").unwrap();
    let op = db
      .transaction(|uow| {
        credential_operations::insert_db_committed(
          uow.conn(),
          op_id,
          OwnerKind::Provider,
          &provider_id.to_string(),
          Some(&old_ref),
          Some(&new_ref),
        )
      })
      .unwrap();
    assert_eq!(
      finalize_operation(&db, vault.as_ref(), &op).unwrap(),
      FinalizeResult::Completed
    );
    assert!(!vault.exists(&old_ref).unwrap());
    assert!(vault.exists(&new_ref).unwrap());
  }

  #[test]
  fn prepared_clear_uncommitted_drops_journal_only() {
    let (_d, db, vault) = setup();
    let provider_id = new_id();
    let op_id = new_id();
    let old_ref = provider_ref(provider_id, new_id());
    insert_provider(&db, provider_id, Some(old_ref.clone()));
    vault.set(&old_ref, "old").unwrap();
    let op = db
      .transaction(|uow| {
        credential_operations::insert_prepared(
          uow.conn(),
          op_id,
          OwnerKind::Provider,
          &provider_id.to_string(),
          Some(&old_ref),
          None,
        )
      })
      .unwrap();
    assert_eq!(
      finalize_operation(&db, vault.as_ref(), &op).unwrap(),
      FinalizeResult::Completed
    );
    // Secret retained because clear never applied.
    assert!(vault.exists(&old_ref).unwrap());
    assert!(db.read(credential_operations::list_unfinished).unwrap().is_empty());
  }
}
