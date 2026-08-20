// ABOUTME: Provider validation, CRUD, and credential orchestration with crash recovery.
// ABOUTME: Vault writes never share a transaction with SQLite; journal coordinates both.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, provider_ref};
use crate::domain::provider::{
  AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ModelsSyncStatus, ProviderInstance,
  ProviderInstanceDto, ProviderInstanceWrite, ProxyMode, validate_adapter_id,
};
use crate::domain::runtime_provider::{ProviderRuntimeKind, legacy_frontend_binding};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::provider_runtime_bindings;
use crate::repositories::{provider_instances, provider_models, translation_profiles};
use crate::services::runtime_providers::{
  PreparedProviderDefault, ProviderDefaultResolution, ProviderRuntimeService, apply_package_first_pending_binding,
};
use crate::storage::Database;
use std::sync::Arc;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub struct ProviderService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  /// Reviewed vendor default wiring (Task 12): new matching Providers receive the default
  /// package/grant in their create transaction; every other provider stays legacy.
  runtime_defaults: Option<Arc<ProviderRuntimeService>>,
  /// Explicit retirement gate; production defaults to empty until Phase 12 enables a slice.
  retirement_gate: crate::services::legacy_runtime_retirement::LegacyRuntimeRetirementGate,
}

/// Credential plan for create: optional ref name, secret material, and journal op id.
type PlannedCreateCredential = (Option<String>, Option<String>, Option<Uuid>);

impl ProviderService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self {
      db,
      vault,
      runtime_defaults: None,
      retirement_gate: crate::services::legacy_runtime_retirement::LegacyRuntimeRetirementGate::disabled(),
    }
  }

  /// Attach the provider runtime service so newly created matching Providers receive the
  /// reviewed vendor default package/grant (Task 12). Resolution failures leave the provider
  /// legacy and never fail the CRUD operation.
  pub fn with_runtime_defaults(mut self, runtime: Arc<ProviderRuntimeService>) -> Self {
    self.runtime_defaults = Some(runtime);
    self
  }

  /// Override the provider-legacy retirement gate (tests and Phase 12 enablement).
  pub fn with_retirement_gate(
    mut self,
    retirement_gate: crate::services::legacy_runtime_retirement::LegacyRuntimeRetirementGate,
  ) -> Self {
    self.retirement_gate = retirement_gate;
    self
  }

  pub fn list(&self) -> Result<Vec<ProviderInstanceDto>, StorageError> {
    self.db.read(|conn| {
      Ok(
        provider_instances::list_with_runtime(conn)?
          .iter()
          .map(|(provider, binding)| ProviderInstanceDto::from_provider_and_runtime(provider, binding))
          .collect(),
      )
    })
  }

  pub fn get(&self, id: Uuid) -> Result<ProviderInstanceDto, StorageError> {
    self.db.read(|conn| {
      let (provider, binding) = provider_instances::get_with_runtime(conn, id)?;
      Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &binding))
    })
  }

  pub fn save(&self, input: ProviderInstanceWrite) -> Result<ProviderInstanceDto, StorageError> {
    validate_provider_write(&input)?;

    match input.id {
      None => self.create(input),
      Some(id) => self.update(id, input),
    }
  }

  fn create(&self, input: ProviderInstanceWrite) -> Result<ProviderInstanceDto, StorageError> {
    let id = new_id();
    let now = now_rfc3339();
    let (credential_ref, secret_to_store, op_id) = self.plan_create_credential(id, &input)?;

    // Applicable catalog default for THIS new provider (adapter alias + connection requirements).
    // Blocked aborts create with no provider/binding/intent. Only NoApplicableDefault permits legacy.
    let default: Option<PreparedProviderDefault> = match &self.runtime_defaults {
      Some(runtime) => match runtime.resolve_applicable_provider_default(&input)? {
        ProviderDefaultResolution::Applicable(prepared) => Some(prepared),
        ProviderDefaultResolution::NoApplicableDefault => {
          // When this adapter's provider-legacy gate is enabled, reject create without a
          // package-first path.
          if self.retirement_gate.is_provider_legacy_retired(&input.adapter_id) {
            return Err(StorageError::Validation(
              "provider legacy create is retired; install and authorize a default package first".into(),
            ));
          }
          None
        }
        ProviderDefaultResolution::Blocked(block) => {
          if self.retirement_gate.is_provider_legacy_retired(&input.adapter_id) {
            return Err(StorageError::Validation(format!(
              "provider legacy create is retired; package-first create is blocked: {}",
              block.code
            )));
          }
          return Err(StorageError::Validation(format!("{}: {}", block.code, block.message)));
        }
      },
      None => {
        if self.retirement_gate.is_provider_legacy_retired(&input.adapter_id) {
          return Err(StorageError::Validation(
            "provider legacy create is retired; install and authorize a default package first".into(),
          ));
        }
        None
      }
    };

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
        // Exactly one selected binding: package-first pending when applicable, else legacy.
        let binding = insert_selected_runtime_binding(uow.conn(), &provider, &input, &default, &now)?;
        let op = credential_operations::mark_db_committed(uow.conn(), operation_id)?;
        Ok((provider, binding, op))
      });

      match commit {
        Ok((provider, binding, op)) => {
          // Create has no old secret; finalize removes the journal only.
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
          Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &[binding]))
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
        // Exactly one selected binding: package-first pending when applicable, else legacy.
        let binding = insert_selected_runtime_binding(uow.conn(), &provider, &input, &default, &now)?;
        Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &[binding]))
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
        &input.base_url,
        input.base_url_source,
        &input.auth_scheme,
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
        &input.base_url,
        input.base_url_source,
        &input.auth_scheme,
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
      // The default API type may have changed: guarantee a binding row for the new adapter
      // while keeping any interface binding that was keyed to the old adapter.
      ensure_default_binding(conn, id, &input.adapter_id, &now)?;
      let (provider, bindings) = provider_instances::get_with_runtime(conn, id)?;
      Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings))
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
      &input.base_url,
      input.base_url_source,
      &input.auth_scheme,
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
      ensure_default_binding(conn, existing.id, &input.adapter_id, &now)?;
      Ok((provider, op))
    });

    match commit {
      Ok((provider, op)) => {
        // Business write committed; deferred cleanup retains db_committed journal.
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        let (provider, bindings) = self
          .db
          .read(|conn| provider_instances::get_with_runtime(conn, provider.id))?;
        Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings))
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
        &input.base_url,
        input.base_url_source,
        &input.auth_scheme,
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
      ensure_default_binding(conn, existing.id, &input.adapter_id, &now)?;
      Ok((provider, op))
    });

    match commit {
      Ok((provider, op)) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        let (provider, bindings) = self
          .db
          .read(|conn| provider_instances::get_with_runtime(conn, provider.id))?;
        Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings))
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
      let (provider, binding) = provider_instances::get_with_runtime(uow.conn(), id)?;
      Ok(ProviderInstanceDto::from_provider_and_runtime(&provider, &binding))
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

  /// Retirement-only provider deletion: removes a provider only when it is disabled, has no
  /// models or profile references, and owns exactly the one target legacy binding (CAS by the
  /// inventory update token). Never calls the cascading `delete` path, so unrelated package
  /// bindings, models, profiles, and credentials stay untouched. Fail-closed on any violation.
  pub fn delete_retired_legacy_binding(
    &self,
    input: crate::domain::legacy_runtime_inventory::RetirementDeleteProviderInput,
  ) -> Result<(), StorageError> {
    let provider_id =
      Uuid::parse_str(&input.provider_id).map_err(|_| StorageError::Validation("invalid provider id".into()))?;
    coordinator::preflight_owner(
      &self.db,
      self.vault.as_ref(),
      OwnerKind::Provider,
      &provider_id.to_string(),
    )?;

    let existing = self.db.read(|conn| provider_instances::get(conn, provider_id))?;
    if existing.enabled {
      return Err(StorageError::Conflict(
        "provider is enabled; disable it before retirement deletion".into(),
      ));
    }
    let old_ref = existing.credential_ref.clone();
    let op_id = new_id();

    let cleanup_op: Option<CredentialOperation> = self.db.transaction(|uow| {
      let binding = provider_runtime_bindings::get(uow.conn(), provider_id, &input.adapter_id)?;
      if binding.runtime_kind != ProviderRuntimeKind::LegacyFrontendProvider {
        return Err(StorageError::Conflict(format!(
          "binding for adapter {} is not a legacy frontend binding",
          input.adapter_id
        )));
      }
      if binding.updated_at != input.update_token {
        return Err(StorageError::Conflict(
          "legacy binding changed since inventory; refresh and retry".into(),
        ));
      }
      let model_count = provider_models::list_by_provider(uow.conn(), provider_id)?.len() as u64;
      if model_count > 0 {
        return Err(StorageError::Conflict(format!(
          "provider has {model_count} models; retirement deletion refused"
        )));
      }
      // Zero models implies zero profile targets and detection references. Only the target
      // legacy binding may exist; the provider row delete cascades that binding.
      let bindings = provider_runtime_bindings::list_by_provider(uow.conn(), provider_id)?;
      if bindings.len() != 1 {
        return Err(StorageError::Conflict(format!(
          "provider has {} runtime bindings; retirement deletion refused",
          bindings.len()
        )));
      }
      if bindings[0].adapter_id != input.adapter_id {
        return Err(StorageError::Conflict(
          "provider owns unrelated runtime bindings; retirement deletion refused".into(),
        ));
      }
      provider_instances::delete(uow.conn(), provider_id)?;
      if old_ref.is_some() {
        let op = credential_operations::insert_db_committed(
          uow.conn(),
          op_id,
          OwnerKind::Provider,
          &provider_id.to_string(),
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

/// Insert exactly one selected runtime binding for a new provider: the exact package-first
/// pending binding when an applicable default is prepared, otherwise the dual-stack legacy
/// frontend binding. Callers must not write a provisional row before calling this helper.
fn insert_selected_runtime_binding(
  conn: &rusqlite::Connection,
  provider: &ProviderInstance,
  input: &ProviderInstanceWrite,
  prepared_default: &Option<PreparedProviderDefault>,
  now: &str,
) -> Result<crate::domain::runtime_provider::ProviderRuntimeBinding, StorageError> {
  match prepared_default {
    Some(prepared) => apply_package_first_pending_binding(conn, provider, prepared, now),
    None => {
      let legacy = legacy_frontend_binding(provider.id, &input.adapter_id, now);
      crate::repositories::provider_runtime_bindings::insert(conn, &legacy)?;
      Ok(legacy)
    }
  }
}

/// Guarantee the Provider default API type owns a binding row after the persisted adapter
/// changes. A missing row (e.g. after switching to a never-attached API type) receives an
/// active legacy binding; existing interface bindings are never removed.
fn ensure_default_binding(
  conn: &rusqlite::Connection,
  provider_id: Uuid,
  adapter_id: &str,
  now: &str,
) -> Result<(), StorageError> {
  if provider_runtime_bindings::get_optional(conn, provider_id, adapter_id)?.is_none() {
    let legacy = legacy_frontend_binding(provider_id, adapter_id, now);
    provider_runtime_bindings::insert(conn, &legacy)?;
  }
  Ok(())
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
    base_url: input.base_url.clone(),
    base_url_source: input.base_url_source,
    auth_scheme: input.auth_scheme.clone(),
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
  base_url: &str,
  base_url_source: BaseUrlSource,
  auth_scheme: &AuthSchemeV1,
  credential_kind: CredentialKind,
  credential_ref: Option<&str>,
  proxy_mode: ProxyMode,
) -> bool {
  existing.adapter_id != adapter_id
    || existing.base_url != base_url
    || existing.base_url_source != base_url_source
    || existing.auth_scheme != *auth_scheme
    || existing.credential_kind != credential_kind
    || existing.credential_ref.as_deref() != credential_ref
    || existing.proxy_mode != proxy_mode
}

fn validate_provider_write(input: &ProviderInstanceWrite) -> Result<(), StorageError> {
  validate_adapter_id(&input.adapter_id).map_err(StorageError::Validation)?;
  if input.display_name.trim().is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  if input.display_name.len() > 200 {
    return Err(StorageError::Validation(
      "display_name must be at most 200 characters".into(),
    ));
  }
  if input.base_url.trim().is_empty() {
    return Err(StorageError::Validation("base_url must not be empty".into()));
  }
  validate_provider_url(&input.base_url, input.insecure_http_confirmed_at.as_deref())?;
  input.auth_scheme.validate().map_err(StorageError::Validation)?;
  if !input.auth_scheme.compatible_with(input.credential_kind) {
    return Err(StorageError::Validation(
      "auth_scheme is incompatible with credential_kind".into(),
    ));
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

#[cfg(test)]
mod tests {
  use super::*;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ProviderInstanceWrite, ProxyMode,
  };
  use crate::domain::runtime_provider::{ProviderRuntimeKind, ProviderRuntimeState};
  use crate::services::plugin_store::PluginPackageService;
  use crate::services::runtime_providers::ProviderRuntimeService;
  use crate::services::wasm_runtime::WasmRuntime;

  /// Committed dev-signed OpenAI Compatible provider runtime package fixture.
  const OPENAI_COMPATIBLE_PACKAGE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-plugins/openai-compatible/fixtures/packages/com.langnext.provider.openai-compatible-1.0.0.lnplugin"
  ));

  fn provider_write(credential_secret: Option<&str>) -> ProviderInstanceWrite {
    ProviderInstanceWrite {
      id: None,
      adapter_id: "openai-compatible".into(),
      display_name: "Table provider".into(),
      base_url: "https://api.openai.com/v1".into(),
      base_url_source: BaseUrlSource::PluginDefault,
      auth_scheme: AuthSchemeV1::bearer(),
      credential_kind: CredentialKind::ApiKey,
      credential: match credential_secret {
        Some(secret) => CredentialUpdate::Replace(secret.into()),
        None => CredentialUpdate::Keep,
      },
      enabled: true,
      proxy_mode: ProxyMode::Inherit,
      insecure_http_confirmed_at: None,
      expected_updated_at: None,
    }
  }

  fn setup() -> (
    tempfile::TempDir,
    Database,
    PluginPackageService,
    ProviderService,
    crate::services::default_package_activation::DefaultPackageActivationService,
  ) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let packages = PluginPackageService::with_vendor_roots(
      db.clone(),
      dir.path().to_path_buf(),
      vec![crate::services::vendor_trust::test_vendor_fixture::fixture_vendor_public_key()],
    );
    let activation = crate::services::default_package_activation::DefaultPackageActivationService::create(
      db.clone(),
      packages.clone(),
      dir.path(),
    );
    let runtime = ProviderRuntimeService::new(db.clone(), packages.clone(), Arc::new(WasmRuntime::new().unwrap()));
    let providers =
      ProviderService::new(db.clone(), Arc::new(MemoryCredentialVault::new())).with_runtime_defaults(Arc::new(runtime));
    (dir, db, packages, providers, activation)
  }

  /// Both create branches (vault write and vault-free) must insert exactly one selected binding:
  /// package-first pending when an authorized default applies, else the legacy frontend binding.
  #[test]
  fn create_inserts_exactly_one_selected_runtime_binding() {
    let (_dir, db, packages, providers, activation) = setup();

    let legacy_cases: &[(&str, Option<&str>)] = &[("legacy-vault", Some("secret-legacy")), ("legacy-novault", None)];
    for (case, secret) in legacy_cases {
      let saved = providers.save(provider_write(*secret)).expect("legacy provider create");
      assert_eq!(
        saved.runtime_bindings.len(),
        1,
        "{case}: create must return exactly one selected binding"
      );
      let binding = &saved.runtime_bindings[0];
      assert_eq!(
        binding.runtime_kind,
        ProviderRuntimeKind::LegacyFrontendProvider,
        "{case}"
      );
      assert!(binding.package_digest.is_none(), "{case}");
      assert_eq!(binding.state, ProviderRuntimeState::Active, "{case}");
      let rows = db
        .read(|conn| crate::repositories::provider_runtime_bindings::list_by_provider(conn, saved.id))
        .unwrap();
      assert_eq!(rows.len(), 1, "{case}: exactly one binding row persisted");
      assert_eq!(
        rows[0].runtime_kind,
        ProviderRuntimeKind::LegacyFrontendProvider,
        "{case}"
      );
    }

    // Install and authorize the default package for the package-first cases.
    let import = packages
      .bootstrap_bundled_package(OPENAI_COMPATIBLE_PACKAGE, false)
      .expect("vendor package bootstraps");
    let digest = import.package_digest().to_string();
    let preview = activation
      .preview_default_package_activation(&digest)
      .expect("preview default activation");
    activation
      .authorize_default_plugin_package(
        crate::domain::default_package_activation::AuthorizeDefaultPluginPackageInput {
          preview_id: preview.preview_id,
          acknowledge_future_instance_authority: true,
        },
      )
      .expect("authorize default package");

    let package_cases: &[(&str, Option<&str>)] =
      &[("package-vault", Some("secret-package")), ("package-novault", None)];
    for (case, secret) in package_cases {
      let saved = providers
        .save(provider_write(*secret))
        .expect("package-first provider create");
      assert_eq!(
        saved.runtime_bindings.len(),
        1,
        "{case}: create must return exactly one selected binding"
      );
      let binding = &saved.runtime_bindings[0];
      assert_eq!(binding.runtime_kind, ProviderRuntimeKind::WasmComponent, "{case}");
      assert_eq!(binding.state, ProviderRuntimeState::PendingActivation, "{case}");
      assert_eq!(binding.package_digest.as_deref(), Some(digest.as_str()), "{case}");
      assert!(binding.grant_set_revision.is_none(), "{case}");
      let rows = db
        .read(|conn| crate::repositories::provider_runtime_bindings::list_by_provider(conn, saved.id))
        .unwrap();
      assert_eq!(rows.len(), 1, "{case}: exactly one binding row persisted");
      assert_eq!(rows[0].runtime_kind, ProviderRuntimeKind::WasmComponent, "{case}");
    }
  }
  /// Retirement deletion is fail-closed: enabled providers and providers with models are
  /// refused without any state change.
  #[test]
  fn retirement_delete_provider_refuses_enabled_or_dependent_provider() {
    let (_dir, db, _packages, providers, _activation) = setup();
    let saved = providers.save(provider_write(Some("secret"))).expect("create provider");
    let token = saved.runtime_bindings[0].updated_at.clone();
    let input = |token: &str| crate::domain::legacy_runtime_inventory::RetirementDeleteProviderInput {
      provider_id: saved.id.to_string(),
      adapter_id: "openai-compatible".into(),
      update_token: token.into(),
    };

    // Enabled provider: refused before any check.
    let err = providers.delete_retired_legacy_binding(input(&token)).unwrap_err();
    assert!(err.to_string().contains("enabled"), "got {err}");
    assert_eq!(providers.list().unwrap().len(), 1, "provider untouched");

    providers.set_enabled(saved.id, false).unwrap();
    // A model makes the provider dependent: refused, model and provider untouched.
    let now = crate::domain::time::now_rfc3339();
    db.transaction(|uow| {
      use crate::domain::model::{Availability, ModelSource, ProviderModel};
      crate::repositories::provider_models::insert(
        uow.conn(),
        &ProviderModel {
          id: Uuid::now_v7(),
          provider_instance_id: saved.id,
          model_key: "gpt-4o".into(),
          source: ModelSource::Remote,
          remote_display_name: Some("GPT-4o".into()),
          display_name_override: None,
          enabled: true,
          availability: Availability::Available,
          remote_metadata_json: None,
          capability_overrides_json: None,
          adapter_id: None,
          source_adapter_id: "openai-compatible".into(),
          last_seen_at: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .unwrap();
    let err = providers.delete_retired_legacy_binding(input(&token)).unwrap_err();
    assert!(err.to_string().contains("models"), "got {err}");
    assert_eq!(providers.list().unwrap().len(), 1, "provider untouched");
    assert_eq!(
      db.read(|conn| crate::repositories::provider_models::list_by_provider(conn, saved.id))
        .unwrap()
        .len(),
      1,
      "model untouched"
    );
  }

  /// A stale inventory token aborts before any credential or database change.
  #[test]
  fn retirement_delete_provider_stale_token_refuses_without_changes() {
    let (_dir, db, _packages, providers, _activation) = setup();
    let saved = providers.save(provider_write(None)).expect("create provider");
    providers.set_enabled(saved.id, false).unwrap();
    let err = providers
      .delete_retired_legacy_binding(crate::domain::legacy_runtime_inventory::RetirementDeleteProviderInput {
        provider_id: saved.id.to_string(),
        adapter_id: "openai-compatible".into(),
        update_token: "stale-token".into(),
      })
      .unwrap_err();
    assert!(err.to_string().contains("changed"), "got {err}");
    assert_eq!(providers.list().unwrap().len(), 1, "provider untouched");
    assert_eq!(
      db.read(|conn| crate::repositories::provider_runtime_bindings::list_by_provider(conn, saved.id))
        .unwrap()
        .len(),
      1,
      "binding untouched"
    );
  }

  /// An unrelated package-backed binding keeps the whole provider undeletable.
  #[test]
  fn retirement_delete_provider_refuses_unrelated_runtime_binding() {
    use crate::domain::runtime_provider::ProviderRuntimeBinding;
    let (_dir, db, _packages, providers, _activation) = setup();
    let saved = providers.save(provider_write(None)).expect("create provider");
    providers.set_enabled(saved.id, false).unwrap();
    let token = saved.runtime_bindings[0].updated_at.clone();
    // Attach an unrelated package binding for another adapter.
    let now = crate::domain::time::now_rfc3339();
    db.transaction(|uow| {
      crate::repositories::provider_runtime_bindings::insert(
        uow.conn(),
        &ProviderRuntimeBinding {
          provider_id: saved.id,
          adapter_id: "anthropic".into(),
          runtime_kind: ProviderRuntimeKind::WasmComponent,
          package_digest: Some("digest-wasm".into()),
          grant_set_revision: Some(1),
          state: ProviderRuntimeState::Active,
          error_code: None,
          error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      Ok::<_, crate::error::StorageError>(())
    })
    .unwrap();

    let err = providers
      .delete_retired_legacy_binding(crate::domain::legacy_runtime_inventory::RetirementDeleteProviderInput {
        provider_id: saved.id.to_string(),
        adapter_id: "openai-compatible".into(),
        update_token: token,
      })
      .unwrap_err();
    assert!(err.to_string().contains("bindings"), "got {err}");
    assert_eq!(providers.list().unwrap().len(), 1, "provider untouched");
    assert_eq!(
      db.read(|conn| crate::repositories::provider_runtime_bindings::list_by_provider(conn, saved.id))
        .unwrap()
        .len(),
      2,
      "both bindings untouched"
    );
  }

  /// A disabled, unused provider with exactly the one legacy binding is deleted with its
  /// credential; nothing else changes.
  #[test]
  fn retirement_delete_provider_success_removes_isolated_disabled_provider() {
    let (_dir, db, _packages, providers, _activation) = setup();
    let saved = providers.save(provider_write(Some("secret"))).expect("create provider");
    providers.set_enabled(saved.id, false).unwrap();
    let token = saved.runtime_bindings[0].updated_at.clone();

    providers
      .delete_retired_legacy_binding(crate::domain::legacy_runtime_inventory::RetirementDeleteProviderInput {
        provider_id: saved.id.to_string(),
        adapter_id: "openai-compatible".into(),
        update_token: token,
      })
      .expect("isolated disabled provider deletes");

    assert!(providers.list().unwrap().is_empty(), "provider removed");
    assert_eq!(
      db.read(|conn| crate::repositories::provider_runtime_bindings::list_by_provider(conn, saved.id))
        .unwrap()
        .len(),
      0,
      "legacy binding cascade-removed"
    );
    // The credential journal finalized the vault slot; no provider-owned credential remains.
    assert!(
      providers
        .list()
        .unwrap()
        .iter()
        .all(|provider| provider.credential_kind == CredentialKind::None),
      "no provider row keeps a credential reference"
    );
  }
}
