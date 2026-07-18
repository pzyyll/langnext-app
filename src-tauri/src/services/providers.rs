// ABOUTME: Provider validation, CRUD, and credential orchestration with crash recovery.
// ABOUTME: Vault writes never share a transaction with SQLite; journal coordinates both.
use crate::adapters::catalog;
use crate::credentials::coordinator;
use crate::credentials::{provider_ref, CredentialVault};
use crate::domain::provider::{
  CredentialKind, CredentialUpdate, ModelsSyncStatus, ProviderInstance, ProviderInstanceDto, ProviderInstanceWrite,
  ProxyMode,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{provider_instances, provider_models, translation_profiles};
use crate::storage::Database;
use std::sync::Arc;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub struct ProviderService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
}

/// Credential plan for create: optional ref name, secret material, and journal op id.
type PlannedCreateCredential = (Option<String>, Option<String>, Option<Uuid>);

impl ProviderService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self { db, vault }
  }

  pub fn list(&self) -> Result<Vec<ProviderInstanceDto>, StorageError> {
    self.db.read(|conn| {
      Ok(
        provider_instances::list(conn)?
          .iter()
          .map(ProviderInstanceDto::from)
          .collect(),
      )
    })
  }

  pub fn get(&self, id: Uuid) -> Result<ProviderInstanceDto, StorageError> {
    self
      .db
      .read(|conn| Ok(ProviderInstanceDto::from(&provider_instances::get(conn, id)?)))
  }

  pub fn save(&self, input: ProviderInstanceWrite) -> Result<ProviderInstanceDto, StorageError> {
    validate_provider_write(&input)?;
    catalog::get(&input.adapter_id)?;

    match input.id {
      None => self.create(input),
      Some(id) => self.update(id, input),
    }
  }

  fn create(&self, input: ProviderInstanceWrite) -> Result<ProviderInstanceDto, StorageError> {
    let id = new_id();
    let now = now_rfc3339();
    let (credential_ref, secret_to_store, op_id) = self.plan_create_credential(id, &input)?;

    if let (Some(ref_name), Some(secret)) = (&credential_ref, &secret_to_store) {
      // Journal prepared → vault write → SQLite commit → mark committed → finalize.
      let operation_id = op_id.expect("op id when storing secret");
      let prepared = self.db.transaction(|uow| {
        credential_operations::insert_prepared(
          uow.conn(),
          operation_id,
          OwnerKind::Provider,
          &id.to_string(),
          None,
          Some(ref_name.as_str()),
        )
      })?;

      if let Err(e) = self.vault.set(ref_name, secret) {
        // Vault never received the secret; drop the uncommitted journal.
        let _ = self.db.transaction(|uow| {
          credential_operations::delete(uow.conn(), operation_id)?;
          Ok(())
        });
        return Err(e);
      }

      let provider = build_provider(id, &input, credential_ref.clone(), &now, &now);
      let commit = self.db.transaction(|uow| {
        provider_instances::insert(uow.conn(), &provider)?;
        let op = credential_operations::mark_db_committed(uow.conn(), operation_id)?;
        Ok((provider, op))
      });

      match commit {
        Ok((provider, op)) => {
          // Create has no old secret; finalize removes the journal only.
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
          Ok(ProviderInstanceDto::from(&provider))
        }
        Err(e) => {
          // Compensate: delete unused new secret if possible; retain prepared on failure.
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &prepared);
          Err(e)
        }
      }
    } else {
      // no vault write
      let provider = build_provider(id, &input, None, &now, &now);
      self.db.transaction(|uow| {
        provider_instances::insert(uow.conn(), &provider)?;
        Ok(ProviderInstanceDto::from(&provider))
      })
    }
  }

  fn plan_create_credential(
    &self,
    id: Uuid,
    input: &ProviderInstanceWrite,
  ) -> Result<PlannedCreateCredential, StorageError> {
    match (&input.credential_kind, &input.credential) {
      (CredentialKind::None, CredentialUpdate::Keep) => Ok((None, None, None)),
      (CredentialKind::None, CredentialUpdate::Clear) => Ok((None, None, None)),
      (CredentialKind::None, CredentialUpdate::Replace(_)) => {
        Err(StorageError::Validation("credential_kind none rejects Replace".into()))
      }
      (CredentialKind::ApiKey | CredentialKind::Bearer, CredentialUpdate::Keep) => {
        // needs authentication
        Ok((None, None, None))
      }
      (CredentialKind::ApiKey | CredentialKind::Bearer, CredentialUpdate::Clear) => Ok((None, None, None)),
      (CredentialKind::ApiKey | CredentialKind::Bearer, CredentialUpdate::Replace(secret)) => {
        if secret.is_empty() {
          return Err(StorageError::Validation("credential secret must not be empty".into()));
        }
        let op = new_id();
        Ok((Some(provider_ref(id, op)), Some(secret.clone()), Some(op)))
      }
    }
  }

  fn update(&self, id: Uuid, input: ProviderInstanceWrite) -> Result<ProviderInstanceDto, StorageError> {
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::Provider, &id.to_string())?;

    let expected_updated_at = require_expected_updated_at(&input)?;
    let credential = input.credential.clone();
    match credential {
      CredentialUpdate::Keep => self.update_keep(id, input, &expected_updated_at),
      CredentialUpdate::Replace(secret) => {
        if secret.is_empty() {
          return Err(StorageError::Validation("credential secret must not be empty".into()));
        }
        let existing = self.db.read(|conn| provider_instances::get(conn, id))?;
        ensure_expected_version(&existing, &expected_updated_at)?;
        validate_credential_transition(&existing, &input)?;
        self.replace_credential(existing, input, &secret, &expected_updated_at)
      }
      CredentialUpdate::Clear => {
        let existing = self.db.read(|conn| provider_instances::get(conn, id))?;
        ensure_expected_version(&existing, &expected_updated_at)?;
        validate_credential_transition(&existing, &input)?;
        self.clear_credential(existing, input, &expected_updated_at)
      }
    }
  }

  /// Keep path: re-read, validate unfinished ops, and write config without rewriting credential_ref.
  fn update_keep(
    &self,
    id: Uuid,
    input: ProviderInstanceWrite,
    expected_updated_at: &str,
  ) -> Result<ProviderInstanceDto, StorageError> {
    self.db.transaction(|uow| {
      let conn = uow.conn();
      if credential_operations::get_for_owner(conn, OwnerKind::Provider, &id.to_string())?.is_some() {
        return Err(StorageError::CredentialBusy);
      }
      let existing = provider_instances::get(conn, id)?;
      ensure_expected_version(&existing, expected_updated_at)?;
      validate_credential_transition(&existing, &input)?;

      // Keep path never rewrites credential_ref. Adapter and Base URL changes may retain the stored token.
      let connection_changed = connection_identity_changed(
        &existing,
        &input.adapter_id,
        input.base_url_override.as_deref(),
        input.credential_kind,
        existing.credential_ref.as_deref(),
        input.proxy_mode,
      );

      let now = now_rfc3339();
      provider_instances::update_configuration_keep_credential(
        conn,
        id,
        &input.adapter_id,
        &input.display_name,
        input.base_url_override.as_deref(),
        input.credential_kind,
        input.enabled,
        input.proxy_mode,
        input.insecure_http_confirmed_at.as_deref(),
        &now,
      )?;
      // Same transaction as config write: new connection must not inherit prior sync status.
      if connection_changed {
        provider_instances::update_sync_status(conn, id, None, ModelsSyncStatus::Never, None, &now)?;
      }
      Ok(ProviderInstanceDto::from(&provider_instances::get(conn, id)?))
    })
  }

  fn replace_credential(
    &self,
    existing: ProviderInstance,
    input: ProviderInstanceWrite,
    secret: &str,
    expected_updated_at: &str,
  ) -> Result<ProviderInstanceDto, StorageError> {
    let op_id = new_id();
    let new_ref = provider_ref(existing.id, op_id);
    let old_ref = existing.credential_ref.clone();
    let expected_updated_at = expected_updated_at.to_string();

    let prepared = self.db.transaction(|uow| {
      credential_operations::insert_prepared(
        uow.conn(),
        op_id,
        OwnerKind::Provider,
        &existing.id.to_string(),
        old_ref.as_deref(),
        Some(&new_ref),
      )
    })?;

    if let Err(e) = self.vault.set(&new_ref, secret) {
      let _ = self.db.transaction(|uow| {
        credential_operations::delete(uow.conn(), op_id)?;
        Ok(())
      });
      return Err(e);
    }

    let now = now_rfc3339();
    // build_provider defaults sync metadata to Never; only preserve when identity is unchanged.
    // Replace always allocates a new credential_ref, so identity changes and status resets.
    let mut provider = build_provider(existing.id, &input, Some(new_ref.clone()), &existing.created_at, &now);
    if !connection_identity_changed(
      &existing,
      &input.adapter_id,
      input.base_url_override.as_deref(),
      input.credential_kind,
      Some(new_ref.as_str()),
      input.proxy_mode,
    ) {
      provider.models_synced_at = existing.models_synced_at;
      provider.models_sync_status = existing.models_sync_status;
      provider.models_sync_error_code = existing.models_sync_error_code;
    }

    let commit = self.db.transaction(|uow| {
      let conn = uow.conn();
      // Re-check version in the write transaction so concurrent saves cannot race past the pre-read.
      let latest = provider_instances::get(conn, existing.id)?;
      ensure_expected_version(&latest, &expected_updated_at)?;
      provider_instances::compare_and_set_credential_ref(conn, existing.id, old_ref.as_deref(), Some(&new_ref), &now)?;
      // Single SQLite transaction after vault write: config + credential_ref + sync reset.
      provider_instances::update_configuration(conn, &provider)?;
      let op = credential_operations::mark_db_committed(conn, op_id)?;
      Ok((provider, op))
    });

    match commit {
      Ok((provider, op)) => {
        // Business write committed; deferred cleanup retains db_committed journal.
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        Ok(ProviderInstanceDto::from(&provider))
      }
      Err(e) => {
        // Compensation: delete unused new secret; retain prepared on vault failure.
        // Sync status is unchanged when this path fails (SQLite never committed).
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &prepared);
        Err(e)
      }
    }
  }

  fn clear_credential(
    &self,
    existing: ProviderInstance,
    input: ProviderInstanceWrite,
    expected_updated_at: &str,
  ) -> Result<ProviderInstanceDto, StorageError> {
    let op_id = new_id();
    let old_ref = existing.credential_ref.clone();
    let expected_updated_at = expected_updated_at.to_string();

    self.db.transaction(|uow| {
      credential_operations::insert_prepared(
        uow.conn(),
        op_id,
        OwnerKind::Provider,
        &existing.id.to_string(),
        old_ref.as_deref(),
        None,
      )?;
      Ok(())
    })?;

    // Optional test hook between journal and final SQLite write (cfg(test) only).
    #[cfg(test)]
    if let Some(hook) = clear_credential_between_txns_take() {
      hook();
    }

    let now = now_rfc3339();
    // Final transaction re-reads the latest provider row. Concurrent sync may have committed
    // between the pre-journal snapshot and this write; never rebuild sync fields from the
    // stale `existing` snapshot alone.
    let commit = self.db.transaction(|uow| {
      let conn = uow.conn();
      let latest = provider_instances::get(conn, existing.id)?;
      ensure_expected_version(&latest, &expected_updated_at)?;
      provider_instances::compare_and_set_credential_ref(conn, existing.id, old_ref.as_deref(), None, &now)?;

      // build_provider defaults sync metadata to Never/None.
      let mut provider = build_provider(existing.id, &input, None, &latest.created_at, &now);
      if !connection_identity_changed(
        &latest,
        &input.adapter_id,
        input.base_url_override.as_deref(),
        input.credential_kind,
        None,
        input.proxy_mode,
      ) {
        // Identity unchanged: keep whatever concurrent work wrote on the latest row.
        provider.models_synced_at = latest.models_synced_at;
        provider.models_sync_status = latest.models_sync_status;
        provider.models_sync_error_code = latest.models_sync_error_code;
      }
      // Identity changed: leave Never/None so the new connection does not inherit prior status.

      provider_instances::update_configuration(conn, &provider)?;
      let op = credential_operations::mark_db_committed(conn, op_id)?;
      Ok((provider, op))
    });

    match commit {
      Ok((provider, op)) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        Ok(ProviderInstanceDto::from(&provider))
      }
      Err(e) => {
        // Clear never applied; drop prepared journal only (no vault delete).
        if let Ok(Some(op)) = self.db.read(|conn| credential_operations::get_by_id(conn, op_id)) {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        Err(e)
      }
    }
  }

  pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<ProviderInstanceDto, StorageError> {
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      provider_instances::set_enabled(uow.conn(), id, enabled, &now)?;
      Ok(ProviderInstanceDto::from(&provider_instances::get(uow.conn(), id)?))
    })
  }

  /// Persist sidebar channel order. `ordered_ids` is the full desired sequence.
  pub fn reorder(&self, ordered_ids: Vec<Uuid>) -> Result<(), StorageError> {
    self.db.transaction(|uow| {
      provider_instances::reorder(uow.conn(), &ordered_ids)?;
      Ok(())
    })
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::Provider, &id.to_string())?;

    let existing = self.db.read(|conn| provider_instances::get(conn, id))?;
    let old_ref = existing.credential_ref.clone();
    let op_id = new_id();

    let cleanup_op: Option<CredentialOperation> = self.db.transaction(|uow| {
      let now = now_rfc3339();
      translation_profiles::clear_detection_models_by_provider(uow.conn(), id, &now)?;
      translation_profiles::delete_targets_by_provider(uow.conn(), id)?;
      provider_models::delete_by_provider(uow.conn(), id)?;
      provider_instances::delete(uow.conn(), id)?;
      if old_ref.is_some() {
        let op = credential_operations::insert_db_committed(
          uow.conn(),
          op_id,
          OwnerKind::Provider,
          &id.to_string(),
          old_ref.as_deref(),
          None,
        )?;
        Ok(Some(op))
      } else {
        Ok(None)
      }
    })?;

    if let Some(op) = cleanup_op {
      let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
    }
    Ok(())
  }

  /// Startup recovery for unfinished credential operations.
  pub fn recover_credential_operations(db: &Database, vault: &dyn CredentialVault) -> coordinator::RecoveryReport {
    coordinator::recover_all(db, vault)
  }
}

fn build_provider(
  id: Uuid,
  input: &ProviderInstanceWrite,
  credential_ref: Option<String>,
  created_at: &str,
  updated_at: &str,
) -> ProviderInstance {
  ProviderInstance {
    id,
    adapter_id: input.adapter_id.clone(),
    display_name: input.display_name.clone(),
    base_url_override: input.base_url_override.clone(),
    credential_kind: input.credential_kind,
    credential_ref,
    enabled: input.enabled,
    proxy_mode: input.proxy_mode,
    insecure_http_confirmed_at: input.insecure_http_confirmed_at.clone(),
    models_synced_at: None,
    models_sync_status: ModelsSyncStatus::Never,
    models_sync_error_code: None,
    created_at: created_at.to_string(),
    updated_at: updated_at.to_string(),
  }
}

/// Connection fields that determine which remote endpoint/auth a provider uses.
/// When any of these change on save, models sync status must reset so the new
/// connection does not inherit the previous endpoint's Ok/Error state.
fn connection_identity_changed(
  existing: &ProviderInstance,
  adapter_id: &str,
  base_url_override: Option<&str>,
  credential_kind: CredentialKind,
  credential_ref: Option<&str>,
  proxy_mode: ProxyMode,
) -> bool {
  existing.adapter_id != adapter_id
    || existing.base_url_override.as_deref() != base_url_override
    || existing.credential_kind != credential_kind
    || existing.credential_ref.as_deref() != credential_ref
    || existing.proxy_mode != proxy_mode
}

fn validate_provider_write(input: &ProviderInstanceWrite) -> Result<(), StorageError> {
  if input.display_name.trim().is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  if input.display_name.len() > 200 {
    return Err(StorageError::Validation(
      "display_name must be at most 200 characters".into(),
    ));
  }
  if let Some(url) = &input.base_url_override {
    validate_provider_url(url, input.insecure_http_confirmed_at.as_deref())?;
  }
  match input.proxy_mode {
    ProxyMode::Inherit | ProxyMode::Direct => {}
  }
  Ok(())
}

/// Updates must carry the form's baseline `updated_at` for optimistic concurrency.
fn require_expected_updated_at(input: &ProviderInstanceWrite) -> Result<String, StorageError> {
  let Some(expected) = input
    .expected_updated_at
    .as_ref()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
  else {
    return Err(StorageError::Validation(
      "expected_updated_at is required when updating a provider".into(),
    ));
  };
  Ok(expected.to_string())
}

/// Fail closed when the stored row no longer matches the editor baseline.
fn ensure_expected_version(existing: &ProviderInstance, expected_updated_at: &str) -> Result<(), StorageError> {
  if existing.updated_at != expected_updated_at {
    return Err(StorageError::Conflict(
      "provider was modified; reload before saving".into(),
    ));
  }
  Ok(())
}

pub fn validate_provider_url(raw: &str, insecure_confirmed_at: Option<&str>) -> Result<(), StorageError> {
  let url = Url::parse(raw).map_err(|e| StorageError::Validation(format!("invalid URL: {e}")))?;
  if !url.username().is_empty() || url.password().is_some() {
    return Err(StorageError::Validation("URL must not contain userinfo".into()));
  }
  if url.query().is_some() {
    return Err(StorageError::Validation("URL must not contain a query string".into()));
  }
  if url.fragment().is_some() {
    return Err(StorageError::Validation("URL must not contain a fragment".into()));
  }
  match url.scheme() {
    "https" => Ok(()),
    "http" => {
      let host = url.host_str().unwrap_or("");
      if is_loopback_host(host) {
        return Ok(());
      }
      if insecure_confirmed_at.is_none() {
        return Err(StorageError::Validation(
          "non-loopback HTTP requires insecure_http_confirmed_at".into(),
        ));
      }
      // Ensure confirmation timestamp is parseable RFC 3339 when present.
      if let Some(ts) = insecure_confirmed_at {
        if time::OffsetDateTime::parse(ts, &time::format_description::well_known::Rfc3339).is_err() {
          return Err(StorageError::Validation(
            "insecure_http_confirmed_at must be RFC 3339".into(),
          ));
        }
      }
      Ok(())
    }
    other => Err(StorageError::Validation(format!("unsupported URL scheme: {other}"))),
  }
}

fn is_loopback_host(host: &str) -> bool {
  host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

fn validate_credential_transition(
  existing: &ProviderInstance,
  input: &ProviderInstanceWrite,
) -> Result<(), StorageError> {
  match input.credential_kind {
    CredentialKind::None => match &input.credential {
      CredentialUpdate::Replace(_) => Err(StorageError::Validation("credential_kind none rejects Replace".into())),
      CredentialUpdate::Keep => {
        if existing.credential_kind != CredentialKind::None || existing.credential_ref.is_some() {
          return Err(StorageError::Validation(
            "changing to none requires Clear when authenticated".into(),
          ));
        }
        Ok(())
      }
      CredentialUpdate::Clear => Ok(()),
    },
    CredentialKind::ApiKey | CredentialKind::Bearer => Ok(()),
  }
}

/// Test-only hook run after clear_credential's prepared journal and before its final write.
/// Lets tests commit a concurrent sync in the real multi-transaction gap.
#[cfg(test)]
static CLEAR_CREDENTIAL_BETWEEN_TXNS: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_clear_credential_between_txns_hook(hook: impl FnOnce() + Send + 'static) {
  *CLEAR_CREDENTIAL_BETWEEN_TXNS.lock().expect("clear gap hook") = Some(Box::new(hook));
}

#[cfg(test)]
fn clear_credential_between_txns_take() -> Option<Box<dyn FnOnce() + Send>> {
  CLEAR_CREDENTIAL_BETWEEN_TXNS.lock().expect("clear gap hook").take()
}
