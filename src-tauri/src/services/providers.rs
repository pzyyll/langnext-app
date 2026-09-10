// ABOUTME: Provider validation, CRUD, and credential orchestration with crash recovery.
// ABOUTME: Vault writes never share a transaction with SQLite; journal coordinates both.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, provider_ref};
use crate::domain::provider::{
  AuthSchemeV1, BaseUrlSource, CredentialKind, CredentialUpdate, ModelsSyncStatus, ProviderInstance,
  ProviderInstanceDto, ProviderInstanceWrite, ProxyMode, validate_adapter_id,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{provider_instances, provider_models, provider_runtime_bindings, translation_profiles};
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
  /// Reviewed catalog default wiring: new matching Providers receive the resolved default
  /// package/grant in their create transaction; every provider is package-first.
  runtime_defaults: Option<Arc<ProviderRuntimeService>>,
}

/// Credential plan for create: optional ref name, secret material, and journal op id.
type PlannedCreateCredential = (Option<String>, Option<String>, Option<Uuid>);

impl ProviderService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self {
      db,
      vault,
      runtime_defaults: None,
    }
  }

  /// Attach the provider runtime service so newly created matching Providers receive the
  /// reviewed catalog default package/grant. Resolution failures fail closed.
  pub fn with_runtime_defaults(mut self, runtime: Arc<ProviderRuntimeService>) -> Self {
    self.runtime_defaults = Some(runtime);
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

    // Package-first create: every new provider requires an applicable catalog default package.
    // No legacy frontend executor exists, so genuine absence and blocked defaults fail closed
    // without writing a provider or binding row.
    let default: Option<PreparedProviderDefault> = match &self.runtime_defaults {
      Some(runtime) => match runtime.resolve_applicable_provider_default(&input)? {
        ProviderDefaultResolution::Applicable(prepared) => Some(prepared),
        ProviderDefaultResolution::NoApplicableDefault => {
          return Err(StorageError::Validation(
            "provider create requires a catalog default package; install it first".into(),
          ));
        }
        ProviderDefaultResolution::Blocked(block) => {
          return Err(StorageError::Validation(format!("{}: {}", block.code, block.message)));
        }
      },
      None => {
        return Err(StorageError::Validation(
          "provider create requires a catalog default package".into(),
        ));
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
      ensure_default_binding(conn, id, &existing.adapter_id, &input.adapter_id)?;
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
      ensure_default_binding(conn, existing.id, &provider.adapter_id, &input.adapter_id)?;
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
      ensure_default_binding(conn, existing.id, &provider.adapter_id, &input.adapter_id)?;
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

  /// Startup recovery for unfinished credential operations.
  pub fn recover_credential_operations(db: &Database, vault: &dyn CredentialVault) -> coordinator::RecoveryReport {
    coordinator::recover_all(db, vault)
  }
}

/// Insert the exact package-first pending binding for a new provider. Package-only create
/// never writes a legacy binding; callers must resolve a catalog default first.
fn insert_selected_runtime_binding(
  conn: &rusqlite::Connection,
  provider: &ProviderInstance,
  _input: &ProviderInstanceWrite,
  prepared_default: &Option<PreparedProviderDefault>,
  now: &str,
) -> Result<crate::domain::runtime_provider::ProviderRuntimeBinding, StorageError> {
  match prepared_default {
    Some(prepared) => apply_package_first_pending_binding(conn, provider, prepared, now),
    None => Err(StorageError::Validation(
      "provider create requires a catalog default package".into(),
    )),
  }
}

/// Ensure the Provider default API type keeps whatever binding row exists after the persisted
/// adapter changes. When the provider's default adapter changes, migrate the provider-default
/// binding row (the one keyed to the previous default adapter) to the new adapter id so the
/// (provider, default adapter) read invariant holds and its exact package identity moves with
/// the provider's default interface. A provider with no binding yet stays unbound.
fn ensure_default_binding(
  conn: &rusqlite::Connection,
  provider_id: Uuid,
  old_adapter_id: &str,
  new_adapter_id: &str,
) -> Result<(), StorageError> {
  if old_adapter_id == new_adapter_id {
    return Ok(());
  }
  let Some(mut migrated) = provider_runtime_bindings::get_optional(conn, provider_id, old_adapter_id)? else {
    return Ok(());
  };
  migrated.adapter_id = new_adapter_id.to_string();
  if let Some(raw) = migrated.runtime_requirement_json.as_deref() {
    if let Ok(mut requirement) =
      serde_json::from_str::<crate::domain::runtime_provider::ProviderRuntimeRequirementExport>(raw)
    {
      requirement.adapter_id = Some(new_adapter_id.to_string());
      let json = serde_json::to_string(&requirement).expect("serialize migrated requirement");
      if serde_json::from_str::<crate::domain::runtime_provider::ProviderRuntimeRequirementExport>(&json).is_ok() {
        migrated.runtime_requirement_json = Some(json);
      }
    }
  }
  // Rename the binding row keyed to the old default adapter (the repository update matches
  // on (provider_id, adapter_id), so the rename is a direct adapter-keyed UPDATE).
  let changed = conn
    .execute(
      "UPDATE provider_runtime_bindings SET
        adapter_id = ?3,
        package_digest = ?4,
        grant_set_revision = ?5,
        state = ?6,
        error_code = ?7,
        error_message = ?8,
        runtime_requirement_json = ?9,
        updated_at = ?10
       WHERE provider_id = ?1 AND adapter_id = ?2",
      rusqlite::params![
        provider_id.to_string(),
        old_adapter_id,
        migrated.adapter_id,
        migrated.package_digest,
        migrated.grant_set_revision.map(|revision| revision as i64),
        migrated.state.as_str(),
        migrated.error_code,
        migrated.error_message,
        migrated.runtime_requirement_json,
        migrated.updated_at,
      ],
    )
    .map_err(|error| crate::error::StorageError::Sqlite(error))?;
  if changed == 0 {
    return Err(crate::error::StorageError::NotFound(format!(
      "provider runtime binding {provider_id} adapter {old_adapter_id}"
    )));
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
  use crate::services::plugin_catalog::PluginCatalog;
  use crate::services::runtime_providers::ProviderRuntimeService;
  use crate::services::test_support::{
    OPENAI_COMPATIBLE_ARCHIVE, OPENAI_COMPATIBLE_PLUGIN_ID, catalog_with_builtins, fixture_digest, wasm_runtime,
  };

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

  fn setup(archive_names: &[&str]) -> (tempfile::TempDir, Database, Arc<PluginCatalog>, ProviderService) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let catalog = catalog_with_builtins(db.clone(), dir.path(), archive_names);
    let runtime = ProviderRuntimeService::new(db.clone(), catalog.clone(), wasm_runtime());
    let providers =
      ProviderService::new(db.clone(), Arc::new(MemoryCredentialVault::new())).with_runtime_defaults(Arc::new(runtime));
    (dir, db, catalog, providers)
  }

  /// Catalog-default create: without a catalog default the save fails closed; with one, both
  /// branches (vault write and vault-free) insert exactly one package-first binding.
  #[test]
  fn create_inserts_exactly_one_selected_runtime_binding() {
    let (_empty_dir, _empty_db, _empty_catalog, empty_providers) = setup(&[]);
    let err = empty_providers.save(provider_write(Some("secret"))).unwrap_err();
    assert!(err.to_string().contains("catalog default package"), "got {err}");
    assert!(empty_providers.list().unwrap().is_empty(), "no provider written");

    let (_dir, db, catalog, providers) = setup(&[OPENAI_COMPATIBLE_ARCHIVE]);
    let digest = fixture_digest(&catalog, OPENAI_COMPATIBLE_PLUGIN_ID);
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
}
