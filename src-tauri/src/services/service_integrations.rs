// ABOUTME: Service integration CRUD, local validation, and crash-safe credential slots.
// ABOUTME: Phase 1A never sets ready from local validation and never calls Google APIs.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, integration_ref};
use crate::domain::provider::CredentialUpdate;
use crate::domain::service_integration::{
  CredentialSlotStatusDto, GOOGLE_CLOUD_DEFAULT_LOCATION, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
  GOOGLE_OAUTH_TOKEN_URI, GoogleCloudConfigV1, INTEGRATION_CONFIG_JSON_MAX_LEN, INTEGRATION_DISPLAY_NAME_MAX_LEN,
  IntegrationDependencyDto, IntegrationHealthStatus, IntegrationInstance, IntegrationInstanceDto,
  IntegrationInstanceWrite, IntegrationValidationResult, SERVICE_ACCOUNT_JSON_MAX_LEN, ServiceIntegrationManifest,
  derive_effective_status, validate_plugin_id, validate_slot_id,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{integration_credential_bindings, integration_instances};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::storage::Database;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct ServiceIntegrationService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  registry: Arc<ServiceIntegrationRegistry>,
}

impl ServiceIntegrationService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>, registry: Arc<ServiceIntegrationRegistry>) -> Self {
    Self { db, vault, registry }
  }

  pub fn list_definitions(&self) -> Vec<ServiceIntegrationManifest> {
    self.registry.list_definitions()
  }

  pub fn list_instances(&self) -> Result<Vec<IntegrationInstanceDto>, StorageError> {
    self.db.read(|conn| {
      let instances = integration_instances::list(conn)?;
      let mut dtos = Vec::with_capacity(instances.len());
      for instance in instances {
        let bindings = integration_credential_bindings::list_for_instance(conn, instance.id)?;
        dtos.push(self.to_dto(&instance, &bindings));
      }
      Ok(dtos)
    })
  }

  pub fn get_instance(&self, id: Uuid) -> Result<IntegrationInstanceDto, StorageError> {
    self.db.read(|conn| {
      let instance = integration_instances::get(conn, id)?;
      let bindings = integration_credential_bindings::list_for_instance(conn, id)?;
      Ok(self.to_dto(&instance, &bindings))
    })
  }

  pub fn save(&self, input: IntegrationInstanceWrite) -> Result<IntegrationInstanceDto, StorageError> {
    match input.id {
      None => self.create(input),
      Some(id) => self.update(id, input),
    }
  }

  pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<IntegrationInstanceDto, StorageError> {
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      integration_instances::get(uow.conn(), id)?;
      integration_instances::set_enabled(uow.conn(), id, enabled, &now)?;
      Ok(())
    })?;
    self.get_instance(id)
  }

  /// Phase 1A dependency query: repository hook returns empty until domain FKs exist.
  pub fn list_dependencies(&self, id: Uuid) -> Result<Vec<IntegrationDependencyDto>, StorageError> {
    self.db.read(|conn| integration_instances::list_dependencies(conn, id))
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    let deps = self.list_dependencies(id)?;
    if !deps.is_empty() {
      return Err(StorageError::InUse(format!(
        "integration instance {id} is referenced by {} resource(s)",
        deps.len()
      )));
    }

    let bindings = self
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, id))?;
    for binding in &bindings {
      coordinator::preflight_owner_slot(
        &self.db,
        self.vault.as_ref(),
        OwnerKind::Integration,
        &id.to_string(),
        &binding.slot_id,
      )?;
    }

    let cleanup_ops: Vec<CredentialOperation> = self.db.transaction(|uow| {
      let mut ops = Vec::new();
      for binding in &bindings {
        if binding.credential_ref.is_some() {
          ops.push(credential_operations::insert_db_committed_slot(
            uow.conn(),
            new_id(),
            OwnerKind::Integration,
            &id.to_string(),
            &binding.slot_id,
            binding.credential_ref.as_deref(),
            None,
          )?);
        }
      }
      // Cascade removes bindings; delete instance row explicitly for clear errors.
      integration_credential_bindings::delete_for_instance(uow.conn(), id)?;
      integration_instances::delete(uow.conn(), id)?;
      Ok(ops)
    })?;

    for op in cleanup_ops {
      let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
    }
    Ok(())
  }

  /// Local-only validation. Never claims remote/IAM health; never sets ready.
  pub fn validate_instance(&self, id: Uuid) -> Result<IntegrationValidationResult, StorageError> {
    let (instance, bindings) = self.db.read(|conn| {
      let instance = integration_instances::get(conn, id)?;
      let bindings = integration_credential_bindings::list_for_instance(conn, id)?;
      Ok((instance, bindings))
    })?;

    let plugin_present = self.registry.contains(&instance.plugin_id);
    if !plugin_present {
      let effective = derive_effective_status(instance.enabled, false, instance.health_status);
      return Ok(IntegrationValidationResult {
        instance_id: id,
        health_status: instance.health_status,
        effective_status: effective,
        remote_checked: false,
        message: Some("plugin definition is missing from the host registry".into()),
      });
    }

    let manifest = self
      .registry
      .get(&instance.plugin_id)
      .ok_or_else(|| StorageError::PluginUnavailable(instance.plugin_id.clone()))?;

    let has_required_credentials = required_slots_satisfied(manifest, &bindings);
    let config_ok = validate_config_for_plugin(manifest, &instance.config_json).is_ok()
      && google_cloud_config_complete(manifest, &instance.config_json);
    let health = if !config_ok || !has_required_credentials {
      IntegrationHealthStatus::Unconfigured
    } else {
      // Local shape valid only — remote auth is Phase 1B.
      IntegrationHealthStatus::Unvalidated
    };

    let now = now_rfc3339();
    self.db.transaction(|uow| {
      integration_instances::update_health(uow.conn(), id, &instance.updated_at, health, Some(&now), None, &now)
    })?;

    let refreshed = self.get_instance(id)?;
    Ok(IntegrationValidationResult {
      instance_id: id,
      health_status: refreshed.health_status,
      effective_status: refreshed.effective_status,
      remote_checked: false,
      message: None,
    })
  }

  fn create(&self, input: IntegrationInstanceWrite) -> Result<IntegrationInstanceDto, StorageError> {
    let plugin_id = input.plugin_id.trim().to_string();
    validate_plugin_id(&plugin_id).map_err(StorageError::Validation)?;
    let manifest = self
      .registry
      .get(&plugin_id)
      .ok_or_else(|| StorageError::PluginUnavailable(plugin_id.clone()))?
      .clone();

    let display_name = validate_display_name(&input.display_name)?;
    let config_json = normalize_and_validate_config(&manifest, &input.config_json)?;
    let credential_map = collect_credential_updates(&input, &manifest)?;

    // Pre-validate replace payloads before any vault write.
    for slot in &manifest.credential_slots {
      if let Some(CredentialUpdate::Replace(secret)) = credential_map.get(&slot.id) {
        validate_slot_secret(&manifest, &slot.id, secret)?;
      } else if slot.required {
        // Create without required secret → unconfigured (allowed).
      }
    }

    let id = new_id();
    let now = now_rfc3339();
    let mut prepared_ops: Vec<CredentialOperation> = Vec::new();
    let mut slot_refs: HashMap<String, Option<String>> = HashMap::new();

    for slot in &manifest.credential_slots {
      let update = credential_map.get(&slot.id).cloned().unwrap_or(CredentialUpdate::Keep);
      match update {
        CredentialUpdate::Replace(secret) => {
          let op_id = new_id();
          let new_ref = integration_ref(id, &slot.id, op_id)?;
          match self.prepare_vault_write(op_id, &id.to_string(), &slot.id, None, &new_ref, &secret) {
            Ok(op) => {
              prepared_ops.push(op);
              slot_refs.insert(slot.id.clone(), Some(new_ref));
            }
            Err(e) => {
              for op in &prepared_ops {
                let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
              }
              return Err(e);
            }
          }
        }
        CredentialUpdate::Keep | CredentialUpdate::Clear => {
          slot_refs.insert(slot.id.clone(), None);
        }
      }
    }

    let health = compute_local_health(&manifest, &config_json, &slot_refs);
    let instance = IntegrationInstance {
      id,
      plugin_id: manifest.id.clone(),
      plugin_version: manifest.version.clone(),
      display_name,
      enabled: input.enabled,
      config_json,
      config_schema_version: manifest.config_schema_version,
      health_status: health,
      last_validated_at: None,
      last_error_code: None,
      created_at: now.clone(),
      updated_at: now.clone(),
    };

    let commit = self.db.transaction(|uow| {
      integration_instances::insert(uow.conn(), &instance)?;
      for slot in &manifest.credential_slots {
        let binding = crate::domain::service_integration::IntegrationCredentialBinding {
          id: new_id(),
          integration_instance_id: id,
          slot_id: slot.id.clone(),
          credential_ref: slot_refs.get(&slot.id).cloned().flatten(),
          credential_revision: 0,
          created_at: now.clone(),
          updated_at: now.clone(),
        };
        integration_credential_bindings::insert(uow.conn(), &binding)?;
      }
      let mut committed = Vec::new();
      for op in &prepared_ops {
        committed.push(credential_operations::mark_db_committed(uow.conn(), op.id)?);
      }
      Ok(committed)
    });

    match commit {
      Ok(ops) => {
        for op in ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        self.get_instance(id)
      }
      Err(e) => {
        for op in &prepared_ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
        }
        Err(e)
      }
    }
  }

  fn update(&self, id: Uuid, input: IntegrationInstanceWrite) -> Result<IntegrationInstanceDto, StorageError> {
    let expected_updated_at = input
      .expected_updated_at
      .as_deref()
      .map(str::trim)
      .filter(|s| !s.is_empty())
      .ok_or_else(|| StorageError::Validation("expected_updated_at is required on update".into()))?
      .to_string();

    let existing = self.db.read(|conn| integration_instances::get(conn, id))?;
    if existing.updated_at != expected_updated_at {
      return Err(StorageError::Conflict(
        "integration instance changed concurrently".into(),
      ));
    }
    if existing.plugin_id != input.plugin_id.trim() {
      return Err(StorageError::Validation("plugin_id is immutable after create".into()));
    }

    // Missing plugin: retain instance and block execution. set_enabled remains available for
    // metadata disable without a manifest. Full save requires the definition for schema/slots.
    let manifest = match self.registry.get(&existing.plugin_id) {
      Some(m) => m.clone(),
      None => {
        return Err(StorageError::PluginUnavailable(existing.plugin_id.clone()));
      }
    };

    let display_name = validate_display_name(&input.display_name)?;
    let config_json = normalize_and_validate_config(&manifest, &input.config_json)?;
    let credential_map = collect_credential_updates(&input, &manifest)?;

    let existing_bindings = self
      .db
      .read(|conn| integration_credential_bindings::list_for_instance(conn, id))?;
    let binding_by_slot: HashMap<String, _> = existing_bindings.into_iter().map(|b| (b.slot_id.clone(), b)).collect();

    // Validate replace secrets before any vault or journal work.
    for slot in &manifest.credential_slots {
      if let Some(CredentialUpdate::Replace(secret)) = credential_map.get(&slot.id) {
        validate_slot_secret(&manifest, &slot.id, secret)?;
      }
    }

    // Preflight only slots that actually mutate credentials. Config-only Keep saves must not
    // require the OS vault (and must not be blocked by an unrelated stuck journal on a slot
    // that is not being changed).
    for slot in &manifest.credential_slots {
      let update = credential_map.get(&slot.id).cloned().unwrap_or(CredentialUpdate::Keep);
      let current_ref = binding_by_slot.get(&slot.id).and_then(|b| b.credential_ref.clone());
      let mutates = match update {
        CredentialUpdate::Keep => false,
        CredentialUpdate::Replace(_) => true,
        CredentialUpdate::Clear => current_ref.is_some(),
      };
      if mutates {
        coordinator::preflight_owner_slot(
          &self.db,
          self.vault.as_ref(),
          OwnerKind::Integration,
          &id.to_string(),
          &slot.id,
        )?;
      }
    }

    let mut prepared_ops: Vec<CredentialOperation> = Vec::new();
    // slot_id -> (expected_old_ref, new_ref) for CAS; None entry means keep.
    let mut slot_mutations: HashMap<String, Option<(Option<String>, Option<String>)>> = HashMap::new();

    for slot in &manifest.credential_slots {
      let update = credential_map.get(&slot.id).cloned().unwrap_or(CredentialUpdate::Keep);
      let current_ref = binding_by_slot.get(&slot.id).and_then(|b| b.credential_ref.clone());
      match update {
        CredentialUpdate::Keep => {
          slot_mutations.insert(slot.id.clone(), None);
        }
        CredentialUpdate::Replace(secret) => {
          let op_id = new_id();
          let new_ref = integration_ref(id, &slot.id, op_id)?;
          match self.prepare_vault_write(
            op_id,
            &id.to_string(),
            &slot.id,
            current_ref.as_deref(),
            &new_ref,
            &secret,
          ) {
            Ok(op) => {
              prepared_ops.push(op);
              slot_mutations.insert(slot.id.clone(), Some((current_ref, Some(new_ref))));
            }
            Err(e) => {
              for op in &prepared_ops {
                let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
              }
              return Err(e);
            }
          }
        }
        CredentialUpdate::Clear => {
          if current_ref.is_none() {
            slot_mutations.insert(slot.id.clone(), None);
            continue;
          }
          let op_id = new_id();
          match self.prepare_vault_clear(op_id, &id.to_string(), &slot.id, current_ref.as_deref()) {
            Ok(op) => {
              prepared_ops.push(op);
              slot_mutations.insert(slot.id.clone(), Some((current_ref, None)));
            }
            Err(e) => {
              for op in &prepared_ops {
                let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
              }
              return Err(e);
            }
          }
        }
      }
    }

    // Final slot ref map for health computation.
    let mut final_refs: HashMap<String, Option<String>> = HashMap::new();
    for slot in &manifest.credential_slots {
      let current_ref = binding_by_slot.get(&slot.id).and_then(|b| b.credential_ref.clone());
      match slot_mutations.get(&slot.id) {
        Some(Some((_, new_ref))) => {
          final_refs.insert(slot.id.clone(), new_ref.clone());
        }
        _ => {
          final_refs.insert(slot.id.clone(), current_ref);
        }
      }
    }
    let health = compute_local_health(&manifest, &config_json, &final_refs);
    let now = now_rfc3339();

    let commit = self.db.transaction(|uow| {
      integration_instances::compare_and_set(
        uow.conn(),
        id,
        &expected_updated_at,
        &display_name,
        input.enabled,
        &config_json,
        manifest.config_schema_version,
        health,
        existing.last_validated_at.as_deref(),
        existing.last_error_code.as_deref(),
        &now,
      )?;
      for (slot_id, mutation) in &slot_mutations {
        if let Some((expected_old, new_ref)) = mutation {
          integration_credential_bindings::compare_and_set_ref(
            uow.conn(),
            id,
            slot_id,
            expected_old.as_deref(),
            new_ref.as_deref(),
            &now,
          )?;
        }
      }
      let mut committed = Vec::new();
      for op in &prepared_ops {
        committed.push(credential_operations::mark_db_committed(uow.conn(), op.id)?);
      }
      Ok(committed)
    });

    match commit {
      Ok(ops) => {
        for op in ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        self.get_instance(id)
      }
      Err(e) => {
        for op in &prepared_ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
        }
        Err(e)
      }
    }
  }

  fn prepare_vault_write(
    &self,
    op_id: Uuid,
    owner_id: &str,
    slot_id: &str,
    expected_old_ref: Option<&str>,
    new_ref: &str,
    secret: &str,
  ) -> Result<CredentialOperation, StorageError> {
    let op = self.db.transaction(|uow| {
      credential_operations::insert_prepared_slot(
        uow.conn(),
        op_id,
        OwnerKind::Integration,
        owner_id,
        slot_id,
        expected_old_ref,
        Some(new_ref),
      )
    })?;
    if let Err(e) = self.vault.set(new_ref, secret) {
      // Vault never received the secret; drop the uncommitted journal without vault I/O.
      // finalize_operation would try vault.delete and can leave a stuck journal when the
      // OS credential store is unavailable (same pattern as providers/OCR).
      let _ = self.db.transaction(|uow| {
        credential_operations::delete(uow.conn(), op_id)?;
        Ok(())
      });
      return Err(e);
    }
    Ok(op)
  }

  fn prepare_vault_clear(
    &self,
    op_id: Uuid,
    owner_id: &str,
    slot_id: &str,
    expected_old_ref: Option<&str>,
  ) -> Result<CredentialOperation, StorageError> {
    self.db.transaction(|uow| {
      credential_operations::insert_prepared_slot(
        uow.conn(),
        op_id,
        OwnerKind::Integration,
        owner_id,
        slot_id,
        expected_old_ref,
        None,
      )
    })
  }

  fn to_dto(
    &self,
    instance: &IntegrationInstance,
    bindings: &[crate::domain::service_integration::IntegrationCredentialBinding],
  ) -> IntegrationInstanceDto {
    let plugin_present = self.registry.contains(&instance.plugin_id);
    let effective = derive_effective_status(instance.enabled, plugin_present, instance.health_status);
    let credential_slots = if let Some(manifest) = self.registry.get(&instance.plugin_id) {
      let binding_map: HashMap<&str, _> = bindings.iter().map(|b| (b.slot_id.as_str(), b)).collect();
      manifest
        .credential_slots
        .iter()
        .map(|slot| {
          let binding = binding_map.get(slot.id.as_str());
          CredentialSlotStatusDto {
            slot_id: slot.id.clone(),
            has_credential: binding.and_then(|b| b.credential_ref.as_ref()).is_some(),
            credential_revision: binding.map(|b| b.credential_revision).unwrap_or(0),
          }
        })
        .collect()
    } else {
      bindings
        .iter()
        .map(|b| CredentialSlotStatusDto {
          slot_id: b.slot_id.clone(),
          has_credential: b.credential_ref.is_some(),
          credential_revision: b.credential_revision,
        })
        .collect()
    };

    IntegrationInstanceDto {
      id: instance.id,
      plugin_id: instance.plugin_id.clone(),
      plugin_version: instance.plugin_version.clone(),
      display_name: instance.display_name.clone(),
      enabled: instance.enabled,
      config_json: instance.config_json.clone(),
      config_schema_version: instance.config_schema_version,
      health_status: instance.health_status,
      effective_status: effective,
      last_validated_at: instance.last_validated_at.clone(),
      last_error_code: instance.last_error_code.clone(),
      credential_slots,
      created_at: instance.created_at.clone(),
      updated_at: instance.updated_at.clone(),
    }
  }
}

fn validate_display_name(name: &str) -> Result<String, StorageError> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err(StorageError::Validation("display_name is required".into()));
  }
  if trimmed.len() > INTEGRATION_DISPLAY_NAME_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "display_name exceeds {INTEGRATION_DISPLAY_NAME_MAX_LEN} characters"
    )));
  }
  Ok(trimmed.to_string())
}

fn collect_credential_updates(
  input: &IntegrationInstanceWrite,
  manifest: &ServiceIntegrationManifest,
) -> Result<HashMap<String, CredentialUpdate>, StorageError> {
  let declared: HashMap<&str, _> = manifest.credential_slots.iter().map(|s| (s.id.as_str(), s)).collect();
  let mut map = HashMap::new();
  for entry in &input.credentials {
    validate_slot_id(&entry.slot_id).map_err(StorageError::Validation)?;
    if !declared.contains_key(entry.slot_id.as_str()) {
      return Err(StorageError::Validation(format!(
        "unknown credential slot: {}",
        entry.slot_id
      )));
    }
    if map.contains_key(&entry.slot_id) {
      return Err(StorageError::Validation(format!(
        "duplicate credential slot write: {}",
        entry.slot_id
      )));
    }
    map.insert(entry.slot_id.clone(), entry.credential.clone());
  }
  Ok(map)
}

fn normalize_and_validate_config(
  manifest: &ServiceIntegrationManifest,
  config_json: &str,
) -> Result<String, StorageError> {
  if config_json.len() > INTEGRATION_CONFIG_JSON_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "config_json exceeds {INTEGRATION_CONFIG_JSON_MAX_LEN} bytes"
    )));
  }
  validate_config_for_plugin(manifest, config_json)
}

fn validate_config_for_plugin(
  manifest: &ServiceIntegrationManifest,
  config_json: &str,
) -> Result<String, StorageError> {
  if manifest.id == GOOGLE_CLOUD_PLUGIN_ID {
    return validate_google_cloud_config(config_json);
  }
  // Unknown plugins should not reach here when registry is authoritative.
  Err(StorageError::PluginUnavailable(manifest.id.clone()))
}

fn validate_google_cloud_config(config_json: &str) -> Result<String, StorageError> {
  let value: Value =
    serde_json::from_str(config_json).map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
  let obj = value
    .as_object()
    .ok_or_else(|| StorageError::Validation("config_json must be an object".into()))?;

  // Reject custom base URL / proxy endpoint fields.
  for forbidden in [
    "baseUrl",
    "base_url",
    "proxyUrl",
    "proxy_url",
    "endpoint",
    "customEndpoint",
  ] {
    if obj.contains_key(forbidden) {
      return Err(StorageError::Validation(format!(
        "Google Cloud config rejects custom field `{forbidden}`"
      )));
    }
  }

  let mut config: GoogleCloudConfigV1 =
    serde_json::from_value(value).map_err(|e| StorageError::Validation(format!("invalid Google Cloud config: {e}")))?;

  config.project_id = config.project_id.trim().to_string();
  config.location = {
    let loc = config.location.trim();
    if loc.is_empty() {
      GOOGLE_CLOUD_DEFAULT_LOCATION.to_string()
    } else {
      loc.to_string()
    }
  };

  // Empty project_id is allowed and yields health_status = unconfigured.
  if config.project_id.len() > 128 {
    return Err(StorageError::Validation("project_id exceeds 128 characters".into()));
  }
  if config.location.len() > 64 {
    return Err(StorageError::Validation("location exceeds 64 characters".into()));
  }
  // ProxyMode only inherit | direct (enum already enforces).
  let _ = config.proxy_mode.as_str();

  serde_json::to_string(&config).map_err(StorageError::from)
}

fn validate_slot_secret(
  manifest: &ServiceIntegrationManifest,
  slot_id: &str,
  secret: &str,
) -> Result<(), StorageError> {
  if secret.len() > SERVICE_ACCOUNT_JSON_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "credential exceeds {SERVICE_ACCOUNT_JSON_MAX_LEN} bytes"
    )));
  }
  if secret.trim().is_empty() {
    return Err(StorageError::Validation("credential value is required".into()));
  }
  if manifest.id == GOOGLE_CLOUD_PLUGIN_ID && slot_id == GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT {
    return validate_service_account_json(secret);
  }
  Ok(())
}

fn validate_service_account_json(secret: &str) -> Result<(), StorageError> {
  let value: Value = serde_json::from_str(secret)
    .map_err(|_| StorageError::Validation("service-account credential must be valid JSON".into()))?;
  let obj = value
    .as_object()
    .ok_or_else(|| StorageError::Validation("service-account credential must be a JSON object".into()))?;

  let client_email = obj
    .get("client_email")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty());
  if client_email.is_none() {
    return Err(StorageError::Validation(
      "service-account JSON requires client_email".into(),
    ));
  }

  let private_key = obj
    .get("private_key")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty());
  if private_key.is_none() {
    return Err(StorageError::Validation(
      "service-account JSON requires private_key".into(),
    ));
  }

  let token_uri = obj
    .get("token_uri")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .unwrap_or("");
  if token_uri != GOOGLE_OAUTH_TOKEN_URI {
    return Err(StorageError::Validation(format!(
      "service-account JSON requires token_uri = {GOOGLE_OAUTH_TOKEN_URI}"
    )));
  }
  Ok(())
}

fn required_slots_satisfied(
  manifest: &ServiceIntegrationManifest,
  bindings: &[crate::domain::service_integration::IntegrationCredentialBinding],
) -> bool {
  let binding_map: HashMap<&str, _> = bindings.iter().map(|b| (b.slot_id.as_str(), b)).collect();
  manifest.credential_slots.iter().all(|slot| {
    if !slot.required {
      return true;
    }
    binding_map
      .get(slot.id.as_str())
      .and_then(|b| b.credential_ref.as_ref())
      .is_some()
  })
}

fn compute_local_health(
  manifest: &ServiceIntegrationManifest,
  config_json: &str,
  slot_refs: &HashMap<String, Option<String>>,
) -> IntegrationHealthStatus {
  let config_ok = validate_config_for_plugin(manifest, config_json).is_ok()
    && google_cloud_config_complete(manifest, config_json);
  let credentials_ok = manifest.credential_slots.iter().all(|slot| {
    if !slot.required {
      return true;
    }
    slot_refs.get(&slot.id).and_then(|r| r.as_ref()).is_some()
  });
  if !config_ok || !credentials_ok {
    IntegrationHealthStatus::Unconfigured
  } else {
    // Locally valid only — never ready from Phase 1A local validation.
    IntegrationHealthStatus::Unvalidated
  }
}

fn google_cloud_config_complete(manifest: &ServiceIntegrationManifest, config_json: &str) -> bool {
  if manifest.id != GOOGLE_CLOUD_PLUGIN_ID {
    return true;
  }
  match serde_json::from_str::<GoogleCloudConfigV1>(config_json) {
    Ok(config) => !config.project_id.trim().is_empty() && !config.location.trim().is_empty(),
    Err(_) => false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::credentials::{FailingCredentialVault, MemoryCredentialVault};
  use crate::domain::provider::ProxyMode;
  use crate::domain::service_integration::{IntegrationEffectiveStatus, IntegrationSlotCredentialWrite};

  fn setup() -> (tempfile::TempDir, ServiceIntegrationService, Arc<MemoryCredentialVault>) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let service = ServiceIntegrationService::new(db, vault.clone(), registry);
    (dir, service, vault)
  }

  fn valid_sa_json() -> String {
    serde_json::json!({
      "type": "service_account",
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
      "token_uri": GOOGLE_OAUTH_TOKEN_URI,
    })
    .to_string()
  }

  fn google_config(project_id: &str) -> String {
    serde_json::to_string(&GoogleCloudConfigV1 {
      project_id: project_id.into(),
      location: GOOGLE_CLOUD_DEFAULT_LOCATION.into(),
      proxy_mode: ProxyMode::Inherit,
    })
    .unwrap()
  }

  fn write_create(with_secret: bool) -> IntegrationInstanceWrite {
    let mut credentials = Vec::new();
    if with_secret {
      credentials.push(IntegrationSlotCredentialWrite {
        slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
        credential: CredentialUpdate::Replace(valid_sa_json()),
      });
    }
    IntegrationInstanceWrite {
      id: None,
      plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
      display_name: "GCP Main".into(),
      enabled: true,
      config_json: google_config("my-project"),
      credentials,
      expected_updated_at: None,
    }
  }

  #[test]
  fn service_integrations_create_unvalidated_with_secret() {
    let (_d, service, vault) = setup();
    let dto = service.save(write_create(true)).unwrap();
    assert_eq!(dto.plugin_id, GOOGLE_CLOUD_PLUGIN_ID);
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(dto.effective_status, IntegrationEffectiveStatus::Unvalidated);
    assert_eq!(dto.credential_slots.len(), 1);
    assert!(dto.credential_slots[0].has_credential);
    // DTO never echoes secret or ref.
    let serialized = serde_json::to_string(&dto).unwrap();
    assert!(!serialized.contains("private_key"));
    assert!(!serialized.contains("BEGIN PRIVATE KEY"));
    assert!(!serialized.contains("integration/"));
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_create_unconfigured_without_secret() {
    let (_d, service, _vault) = setup();
    let dto = service.save(write_create(false)).unwrap();
    assert_eq!(dto.health_status, IntegrationHealthStatus::Unconfigured);
    assert!(!dto.credential_slots[0].has_credential);
  }

  #[test]
  fn service_integrations_rejects_bad_service_account() {
    let (_d, service, vault) = setup();
    let mut input = write_create(true);
    input.credentials[0].credential = CredentialUpdate::Replace(r#"{"client_email":"x"}"#.into());
    let err = service.save(input).unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));
    assert_eq!(vault.len(), 0);
  }

  #[test]
  fn service_integrations_rejects_custom_base_url() {
    let (_d, service, _vault) = setup();
    let mut input = write_create(false);
    input.config_json =
      r#"{"projectId":"p","location":"global","proxyMode":"inherit","baseUrl":"https://evil"}"#.into();
    let err = service.save(input).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("baseUrl")));
  }

  #[test]
  fn service_integrations_update_clear_and_conflict() {
    let (_d, service, vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    assert_eq!(vault.len(), 1);

    let cleared = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Clear,
        }],
        expected_updated_at: Some(created.updated_at.clone()),
      })
      .unwrap();
    assert!(!cleared.credential_slots[0].has_credential);
    assert_eq!(cleared.health_status, IntegrationHealthStatus::Unconfigured);
    assert_eq!(cleared.credential_slots[0].credential_revision, 1);
    assert_eq!(vault.len(), 0);

    let err = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "x".into(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![],
        expected_updated_at: Some(created.updated_at), // stale
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Conflict(_)));
  }

  #[test]
  fn service_integrations_disable_preserves_health() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    assert_eq!(created.health_status, IntegrationHealthStatus::Unvalidated);
    let disabled = service.set_enabled(created.id, false).unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.health_status, IntegrationHealthStatus::Unvalidated);
    assert_eq!(disabled.effective_status, IntegrationEffectiveStatus::Disabled);
    let enabled = service.set_enabled(created.id, true).unwrap();
    assert_eq!(enabled.effective_status, IntegrationEffectiveStatus::Unvalidated);
  }

  #[test]
  fn service_integrations_validate_never_ready() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    let result = service.validate_instance(created.id).unwrap();
    assert!(!result.remote_checked);
    assert_ne!(result.health_status, IntegrationHealthStatus::Ready);
    assert_eq!(result.health_status, IntegrationHealthStatus::Unvalidated);
  }

  #[test]
  fn service_integrations_delete_and_dependencies() {
    let (_d, service, vault) = setup();
    let created = service.save(write_create(true)).unwrap();
    assert!(service.list_dependencies(created.id).unwrap().is_empty());
    service.delete(created.id).unwrap();
    assert!(matches!(
      service.get_instance(created.id),
      Err(StorageError::NotFound(_))
    ));
    assert_eq!(vault.len(), 0);
  }

  #[test]
  fn service_integrations_plugin_id_immutable() {
    let (_d, service, _vault) = setup();
    let created = service.save(write_create(false)).unwrap();
    let err = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: "com.langnext.other".into(),
        display_name: created.display_name,
        enabled: true,
        config_json: created.config_json,
        credentials: vec![],
        expected_updated_at: Some(created.updated_at),
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("immutable")));
  }

  #[test]
  fn service_integrations_list_definitions() {
    let (_d, service, _vault) = setup();
    let defs = service.list_definitions();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].id, GOOGLE_CLOUD_PLUGIN_ID);
  }

  #[test]
  fn service_integrations_rejects_wrong_token_uri() {
    let (_d, service, vault) = setup();
    let mut input = write_create(true);
    let bad_sa = serde_json::json!({
      "type": "service_account",
      "client_email": "bot@example.iam.gserviceaccount.com",
      "private_key": "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
      "token_uri": "https://evil.example/token",
    })
    .to_string();
    input.credentials[0].credential = CredentialUpdate::Replace(bad_sa);

    let err = service.save(input).unwrap_err();
    assert!(
      matches!(err, StorageError::Validation(ref msg) if msg.contains("token_uri")),
      "expected token_uri validation error, got {err:?}"
    );
    // No vault write and no persisted instance/binding.
    assert_eq!(vault.len(), 0);
    assert!(service.list_instances().unwrap().is_empty());
  }

  #[test]
  fn service_integrations_retains_plugin_missing_on_list_get() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let full_registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let create_service = ServiceIntegrationService::new(db.clone(), vault.clone(), full_registry);
    let created = create_service.save(write_create(true)).unwrap();
    assert_ne!(created.effective_status, IntegrationEffectiveStatus::PluginMissing);

    // Simulate host without the bundled definition (registry miss).
    let empty_registry = Arc::new(ServiceIntegrationRegistry::empty());
    let missing_service = ServiceIntegrationService::new(db, vault.clone(), empty_registry);

    let listed = missing_service.list_instances().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);
    assert_eq!(listed[0].effective_status, IntegrationEffectiveStatus::PluginMissing);
    // Persisted health is unchanged; plugin_missing is derived only.
    assert_eq!(listed[0].health_status, IntegrationHealthStatus::Unvalidated);

    let got = missing_service.get_instance(created.id).unwrap();
    assert_eq!(got.effective_status, IntegrationEffectiveStatus::PluginMissing);
    assert_eq!(got.id, created.id);
    // Secret still held; missing plugin must not delete vault material.
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_plugin_missing_allows_disable_blocks_save() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let full_registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let create_service = ServiceIntegrationService::new(db.clone(), vault.clone(), full_registry);
    let created = create_service.save(write_create(true)).unwrap();

    let empty_registry = Arc::new(ServiceIntegrationRegistry::empty());
    let missing_service = ServiceIntegrationService::new(db, vault.clone(), empty_registry);

    // Metadata disable does not need the manifest.
    let disabled = missing_service.set_enabled(created.id, false).unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.effective_status, IntegrationEffectiveStatus::PluginMissing);
    assert_eq!(disabled.health_status, IntegrationHealthStatus::Unvalidated);

    // Full save (config/credential path) stays blocked without the definition.
    let err = missing_service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: false,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(disabled.updated_at.clone()),
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::PluginUnavailable(_)));

    // Keep/no-op credential payload is still a full save and requires the manifest.
    let err_keep = missing_service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "renamed".into(),
        enabled: false,
        config_json: created.config_json.clone(),
        credentials: vec![],
        expected_updated_at: Some(disabled.updated_at),
      })
      .unwrap_err();
    assert!(matches!(err_keep, StorageError::PluginUnavailable(_)));

    // Instance retained; secret untouched.
    let still = missing_service.get_instance(created.id).unwrap();
    assert_eq!(still.display_name, created.display_name);
    assert!(!still.enabled);
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn integration_credential_recovery_after_prepared() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(MemoryCredentialVault::new());
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let service = ServiceIntegrationService::new(db.clone(), vault.clone(), registry);
    let created = service.save(write_create(true)).unwrap();

    // Simulate unfinished prepared op for the slot after a crash-like leftover.
    let op_id = new_id();
    let orphan_ref = integration_ref(created.id, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, op_id).unwrap();
    vault.set(&orphan_ref, "orphan").unwrap();
    db.transaction(|uow| {
      credential_operations::insert_prepared_slot(
        uow.conn(),
        op_id,
        OwnerKind::Integration,
        &created.id.to_string(),
        GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        None,
        Some(&orphan_ref),
      )?;
      Ok(())
    })
    .unwrap();

    coordinator::preflight_owner_slot(
      &db,
      vault.as_ref(),
      OwnerKind::Integration,
      &created.id.to_string(),
      GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
    )
    .unwrap();
    assert!(!vault.exists(&orphan_ref).unwrap());
    // Original credential still present.
    assert_eq!(vault.len(), 1);
  }

  #[test]
  fn service_integrations_keep_only_update_skips_unavailable_vault() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(FailingCredentialVault::new());
    vault.set_fail_set(true);
    vault.set_fail_exists(true);
    vault.set_fail_delete(true);
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let service = ServiceIntegrationService::new(db, vault.clone() as Arc<dyn CredentialVault>, registry);

    // Create without secret does not touch the vault.
    let created = service.save(write_create(false)).unwrap();

    // Config-only Keep update must succeed even when the OS vault is down.
    let updated = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "Google Cloud (2)".into(),
        enabled: true,
        config_json: google_config("my-project"),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Keep,
        }],
        expected_updated_at: Some(created.updated_at.clone()),
      })
      .unwrap();
    assert_eq!(updated.display_name, "Google Cloud (2)");
    assert!(updated.config_json.contains("my-project"));
    assert!(!updated.credential_slots[0].has_credential);
  }

  #[test]
  fn service_integrations_failed_replace_does_not_block_later_keep() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault = Arc::new(FailingCredentialVault::new());
    vault.set_fail_set(true);
    vault.set_fail_exists(true);
    vault.set_fail_delete(true);
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let service = ServiceIntegrationService::new(db.clone(), vault.clone() as Arc<dyn CredentialVault>, registry);

    let created = service.save(write_create(false)).unwrap();

    // Replace fails because the vault is unavailable; journal must not stick.
    let err = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: created.display_name.clone(),
        enabled: true,
        config_json: created.config_json.clone(),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Replace(valid_sa_json()),
        }],
        expected_updated_at: Some(created.updated_at.clone()),
      })
      .unwrap_err();
    assert!(matches!(
      err,
      StorageError::CredentialUnavailable | StorageError::CredentialAccess
    ));
    let leftover = db
      .read(|conn| {
        credential_operations::get_for_owner_slot(
          conn,
          OwnerKind::Integration,
          &created.id.to_string(),
          GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        )
      })
      .unwrap();
    assert!(leftover.is_none(), "failed replace must drop prepared journal");

    // Subsequent Keep-only config save still works.
    let updated = service
      .save(IntegrationInstanceWrite {
        id: Some(created.id),
        plugin_id: GOOGLE_CLOUD_PLUGIN_ID.into(),
        display_name: "Renamed after vault failure".into(),
        enabled: true,
        config_json: google_config("proj-after-fail"),
        credentials: vec![IntegrationSlotCredentialWrite {
          slot_id: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT.into(),
          credential: CredentialUpdate::Keep,
        }],
        expected_updated_at: Some(created.updated_at),
      })
      .unwrap();
    assert_eq!(updated.display_name, "Renamed after vault failure");
    assert!(updated.config_json.contains("proj-after-fail"));
  }
}
