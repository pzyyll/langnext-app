// ABOUTME: OCR service validation, CRUD, and dual-key vault orchestration.
// ABOUTME: Baidu secrets use the crash-safe credential journal; AI rows store model + templates.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, ocr_api_key_ref, ocr_secret_key_ref};
use crate::domain::ocr_service::{
  BaiduOcrAction, OCR_DISPLAY_NAME_MAX_LEN, OCR_PROMPT_TEMPLATE_NAME_MAX_LEN, OcrPromptTemplate, OcrProviderType,
  OcrService, OcrServiceDto, OcrServiceWrite,
};
use crate::domain::provider::CredentialUpdate;
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{ocr_prompt_templates, ocr_services, provider_models};
use crate::storage::Database;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct OcrServiceService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
}

impl OcrServiceService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self { db, vault }
  }

  pub fn list(&self) -> Result<Vec<OcrServiceDto>, StorageError> {
    self.db.read_snapshot(|conn| {
      let services = ocr_services::list(conn)?;
      let all_templates = ocr_prompt_templates::list_all(conn)?;
      let mut templates_by_service: std::collections::HashMap<Uuid, Vec<OcrPromptTemplate>> =
        std::collections::HashMap::new();
      for row in all_templates {
        templates_by_service
          .entry(row.ocr_service_id)
          .or_default()
          .push(OcrPromptTemplate {
            id: row.id,
            name: row.name,
            system_template: row.system_template,
            user_template: row.user_template,
          });
      }
      Ok(
        services
          .into_iter()
          .map(|service| {
            let templates = templates_by_service.remove(&service.id).unwrap_or_default();
            OcrServiceDto::from_service(&service, templates)
          })
          .collect(),
      )
    })
  }

  pub fn get(&self, id: Uuid) -> Result<OcrServiceDto, StorageError> {
    self.db.read(|conn| {
      let service = ocr_services::get(conn, id)?;
      let templates = ocr_prompt_templates::list_for_service(conn, id)?;
      Ok(OcrServiceDto::from_service(&service, templates))
    })
  }

  pub fn save(&self, input: OcrServiceWrite) -> Result<OcrServiceDto, StorageError> {
    validate_ocr_write(&input)?;
    match input.id {
      None => self.create(input),
      Some(id) => self.update(id, input),
    }
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::OcrApiKey, &id.to_string())?;
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::OcrSecretKey, &id.to_string())?;

    let existing = self.db.read(|conn| ocr_services::get(conn, id))?;
    let api_key_ref = existing.api_key_ref.clone();
    let secret_key_ref = existing.secret_key_ref.clone();

    let cleanup_ops: Vec<CredentialOperation> = self.db.transaction(|uow| {
      ocr_services::delete(uow.conn(), id)?;
      let mut ops = Vec::new();
      if api_key_ref.is_some() {
        ops.push(credential_operations::insert_db_committed(
          uow.conn(),
          new_id(),
          OwnerKind::OcrApiKey,
          &id.to_string(),
          api_key_ref.as_deref(),
          None,
        )?);
      }
      if secret_key_ref.is_some() {
        ops.push(credential_operations::insert_db_committed(
          uow.conn(),
          new_id(),
          OwnerKind::OcrSecretKey,
          &id.to_string(),
          secret_key_ref.as_deref(),
          None,
        )?);
      }
      Ok(ops)
    })?;

    for op in cleanup_ops {
      let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
    }
    Ok(())
  }

  fn create(&self, input: OcrServiceWrite) -> Result<OcrServiceDto, StorageError> {
    let id = new_id();
    let now = now_rfc3339();
    match input.provider_type {
      OcrProviderType::Baidu => self.create_baidu(id, input, &now),
      OcrProviderType::Ai => self.create_ai(id, input, &now),
    }
  }

  fn create_baidu(&self, id: Uuid, input: OcrServiceWrite, now: &str) -> Result<OcrServiceDto, StorageError> {
    let baidu_action = input.baidu_action.unwrap_or(BaiduOcrAction::Accurate);
    let (api_key_ref, api_secret, api_op) = plan_create_secret(id, &input.api_key, OwnerKind::OcrApiKey)?;
    let (secret_key_ref, secret_secret, secret_op) = plan_create_secret(id, &input.secret_key, OwnerKind::OcrSecretKey)?;

    let mut prepared_ops = Vec::new();
    if let (Some(ref_name), Some(secret), Some(op_id)) = (&api_key_ref, &api_secret, api_op) {
      let prepared = self.prepare_vault_write(op_id, OwnerKind::OcrApiKey, &id.to_string(), None, ref_name, secret)?;
      prepared_ops.push(prepared);
    }
    if let (Some(ref_name), Some(secret), Some(op_id)) = (&secret_key_ref, &secret_secret, secret_op) {
      match self.prepare_vault_write(op_id, OwnerKind::OcrSecretKey, &id.to_string(), None, ref_name, secret) {
        Ok(prepared) => prepared_ops.push(prepared),
        Err(e) => {
          for op in &prepared_ops {
            let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
          }
          return Err(e);
        }
      }
    }

    let service = OcrService {
      id,
      provider_type: OcrProviderType::Baidu,
      display_name: input.display_name.trim().to_string(),
      enabled: input.enabled,
      sort_order: 0,
      baidu_action: Some(baidu_action),
      api_key_ref,
      secret_key_ref,
      provider_model_id: None,
      temperature: None,
      default_prompt_template_id: None,
      created_at: now.to_string(),
      updated_at: now.to_string(),
    };

    let commit = self.db.transaction(|uow| {
      ocr_services::insert(uow.conn(), &service)?;
      let mut committed = Vec::new();
      for op in &prepared_ops {
        committed.push(credential_operations::mark_db_committed(uow.conn(), op.id)?);
      }
      // Re-read so SQL-assigned sort_order is returned to the client.
      let stored = ocr_services::get(uow.conn(), id)?;
      Ok((stored, committed))
    });

    match commit {
      Ok((service, ops)) => {
        for op in ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        Ok(OcrServiceDto::from_service(&service, vec![]))
      }
      Err(e) => {
        for op in &prepared_ops {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), op);
        }
        Err(e)
      }
    }
  }

  fn create_ai(&self, id: Uuid, input: OcrServiceWrite, now: &str) -> Result<OcrServiceDto, StorageError> {
    let provider_model_id = input
      .provider_model_id
      .ok_or_else(|| StorageError::Validation("provider_model_id is required for AI OCR".into()))?;
    let default_prompt_template_id = input
      .default_prompt_template_id
      .ok_or_else(|| StorageError::Validation("default_prompt_template_id is required for AI OCR".into()))?;
    let templates = input.prompt_templates.clone();

    self.db.transaction(|uow| {
      provider_models::get(uow.conn(), provider_model_id)?;
      let service = OcrService {
        id,
        provider_type: OcrProviderType::Ai,
        display_name: input.display_name.trim().to_string(),
        enabled: input.enabled,
        sort_order: 0,
        baidu_action: None,
        api_key_ref: None,
        secret_key_ref: None,
        provider_model_id: Some(provider_model_id),
        temperature: input.temperature,
        default_prompt_template_id: Some(default_prompt_template_id),
        created_at: now.to_string(),
        updated_at: now.to_string(),
      };
      ocr_services::insert(uow.conn(), &service)?;
      ocr_prompt_templates::replace_for_service(uow.conn(), id, &templates)?;
      let stored = ocr_services::get(uow.conn(), id)?;
      Ok(OcrServiceDto::from_service(&stored, templates))
    })
  }

  fn update(&self, id: Uuid, input: OcrServiceWrite) -> Result<OcrServiceDto, StorageError> {
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::OcrApiKey, &id.to_string())?;
    coordinator::preflight_owner(&self.db, self.vault.as_ref(), OwnerKind::OcrSecretKey, &id.to_string())?;

    let expected_updated_at = require_expected_updated_at(&input)?;
    let existing = self.db.read(|conn| ocr_services::get(conn, id))?;
    ensure_expected_version(&existing, &expected_updated_at)?;
    if existing.provider_type != input.provider_type {
      return Err(StorageError::Validation(
        "ocr provider_type is immutable after create".into(),
      ));
    }

    match input.provider_type {
      OcrProviderType::Baidu => self.update_baidu(existing, input, &expected_updated_at),
      OcrProviderType::Ai => self.update_ai(existing, input, &expected_updated_at),
    }
  }

  fn update_baidu(
    &self,
    existing: OcrService,
    input: OcrServiceWrite,
    expected_updated_at: &str,
  ) -> Result<OcrServiceDto, StorageError> {
    let mut expected = expected_updated_at.to_string();
    let mut current = existing;

    // Dual Baidu keys are separate vault/DB commits (api_key then secret_key).
    // If the first succeeds and the second fails, the first mutation stays durable.
    // Callers must re-read has_* flags / updatedAt after any error (frontend invalidates).
    let mut api_key_committed = false;
    if !matches!(input.api_key, CredentialUpdate::Keep) {
      current = self.apply_key_mutation(
        current,
        &input,
        OwnerKind::OcrApiKey,
        &input.api_key,
        &expected,
      )?;
      expected = current.updated_at.clone();
      api_key_committed = true;
    }
    if !matches!(input.secret_key, CredentialUpdate::Keep) {
      match self.apply_key_mutation(
        current.clone(),
        &input,
        OwnerKind::OcrSecretKey,
        &input.secret_key,
        &expected,
      ) {
        Ok(next) => {
          current = next;
          expected = current.updated_at.clone();
        }
        Err(err) if api_key_committed => {
          let latest = self
            .db
            .read(|conn| ocr_services::get(conn, current.id))
            .unwrap_or(current);
          return Err(partial_baidu_dual_key_error(err, &latest));
        }
        Err(err) => return Err(err),
      }
    }

    // Config-only (or final config pass after credential mutations).
    let now = now_rfc3339();
    let baidu_action = input.baidu_action.unwrap_or(BaiduOcrAction::Accurate);
    self.db.transaction(|uow| {
      let latest = ocr_services::get(uow.conn(), current.id)?;
      ensure_expected_version(&latest, &expected)?;
      if credential_operations::get_for_owner(uow.conn(), OwnerKind::OcrApiKey, &current.id.to_string())?.is_some()
        || credential_operations::get_for_owner(uow.conn(), OwnerKind::OcrSecretKey, &current.id.to_string())?
          .is_some()
      {
        return Err(StorageError::CredentialBusy);
      }
      ocr_services::update_configuration_keep_credentials(
        uow.conn(),
        current.id,
        input.display_name.trim(),
        input.enabled,
        Some(baidu_action),
        None,
        None,
        None,
        &now,
      )?;
      let service = ocr_services::get(uow.conn(), current.id)?;
      Ok(OcrServiceDto::from_service(&service, vec![]))
    })
  }

  fn update_ai(
    &self,
    existing: OcrService,
    input: OcrServiceWrite,
    expected_updated_at: &str,
  ) -> Result<OcrServiceDto, StorageError> {
    let provider_model_id = input
      .provider_model_id
      .ok_or_else(|| StorageError::Validation("provider_model_id is required for AI OCR".into()))?;
    let default_prompt_template_id = input
      .default_prompt_template_id
      .ok_or_else(|| StorageError::Validation("default_prompt_template_id is required for AI OCR".into()))?;
    let templates = input.prompt_templates.clone();
    let now = now_rfc3339();

    self.db.transaction(|uow| {
      let latest = ocr_services::get(uow.conn(), existing.id)?;
      ensure_expected_version(&latest, expected_updated_at)?;
      provider_models::get(uow.conn(), provider_model_id)?;
      ocr_services::update_configuration_keep_credentials(
        uow.conn(),
        existing.id,
        input.display_name.trim(),
        input.enabled,
        None,
        Some(provider_model_id),
        input.temperature,
        Some(default_prompt_template_id),
        &now,
      )?;
      ocr_prompt_templates::replace_for_service(uow.conn(), existing.id, &templates)?;
      let service = ocr_services::get(uow.conn(), existing.id)?;
      Ok(OcrServiceDto::from_service(&service, templates))
    })
  }

  fn apply_key_mutation(
    &self,
    existing: OcrService,
    input: &OcrServiceWrite,
    owner_kind: OwnerKind,
    update: &CredentialUpdate,
    expected_updated_at: &str,
  ) -> Result<OcrService, StorageError> {
    match update {
      CredentialUpdate::Keep => Ok(existing),
      CredentialUpdate::Replace(secret) => {
        if secret.is_empty() {
          return Err(StorageError::Validation("credential secret must not be empty".into()));
        }
        self.replace_key(existing, input, owner_kind, secret, expected_updated_at)
      }
      CredentialUpdate::Clear => self.clear_key(existing, input, owner_kind, expected_updated_at),
    }
  }

  fn replace_key(
    &self,
    existing: OcrService,
    input: &OcrServiceWrite,
    owner_kind: OwnerKind,
    secret: &str,
    expected_updated_at: &str,
  ) -> Result<OcrService, StorageError> {
    let op_id = new_id();
    let new_ref = match owner_kind {
      OwnerKind::OcrApiKey => ocr_api_key_ref(existing.id, op_id),
      OwnerKind::OcrSecretKey => ocr_secret_key_ref(existing.id, op_id),
      _ => return Err(StorageError::Internal("invalid ocr owner kind".into())),
    };
    let old_ref = match owner_kind {
      OwnerKind::OcrApiKey => existing.api_key_ref.clone(),
      OwnerKind::OcrSecretKey => existing.secret_key_ref.clone(),
      _ => None,
    };

    let prepared = self.prepare_vault_write(
      op_id,
      owner_kind,
      &existing.id.to_string(),
      old_ref.as_deref(),
      &new_ref,
      secret,
    )?;

    let now = now_rfc3339();
    let commit = self.db.transaction(|uow| {
      let latest = ocr_services::get(uow.conn(), existing.id)?;
      ensure_expected_version(&latest, expected_updated_at)?;
      match owner_kind {
        OwnerKind::OcrApiKey => {
          ocr_services::compare_and_set_api_key_ref(uow.conn(), existing.id, old_ref.as_deref(), Some(&new_ref), &now)?;
        }
        OwnerKind::OcrSecretKey => {
          ocr_services::compare_and_set_secret_key_ref(
            uow.conn(),
            existing.id,
            old_ref.as_deref(),
            Some(&new_ref),
            &now,
          )?;
        }
        _ => {}
      }
      // Also refresh display fields so partial credential saves stay consistent.
      ocr_services::update_configuration_keep_credentials(
        uow.conn(),
        existing.id,
        input.display_name.trim(),
        input.enabled,
        input.baidu_action.or(Some(BaiduOcrAction::Accurate)),
        None,
        None,
        None,
        &now,
      )?;
      let op = credential_operations::mark_db_committed(uow.conn(), op_id)?;
      let service = ocr_services::get(uow.conn(), existing.id)?;
      Ok((service, op))
    });

    match commit {
      Ok((service, op)) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        Ok(service)
      }
      Err(e) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &prepared);
        Err(e)
      }
    }
  }

  fn clear_key(
    &self,
    existing: OcrService,
    input: &OcrServiceWrite,
    owner_kind: OwnerKind,
    expected_updated_at: &str,
  ) -> Result<OcrService, StorageError> {
    let op_id = new_id();
    let old_ref = match owner_kind {
      OwnerKind::OcrApiKey => existing.api_key_ref.clone(),
      OwnerKind::OcrSecretKey => existing.secret_key_ref.clone(),
      _ => None,
    };

    self.db.transaction(|uow| {
      credential_operations::insert_prepared(
        uow.conn(),
        op_id,
        owner_kind,
        &existing.id.to_string(),
        old_ref.as_deref(),
        None,
      )?;
      Ok(())
    })?;

    let now = now_rfc3339();
    let commit = self.db.transaction(|uow| {
      let latest = ocr_services::get(uow.conn(), existing.id)?;
      ensure_expected_version(&latest, expected_updated_at)?;
      match owner_kind {
        OwnerKind::OcrApiKey => {
          ocr_services::compare_and_set_api_key_ref(uow.conn(), existing.id, old_ref.as_deref(), None, &now)?;
        }
        OwnerKind::OcrSecretKey => {
          ocr_services::compare_and_set_secret_key_ref(uow.conn(), existing.id, old_ref.as_deref(), None, &now)?;
        }
        _ => {}
      }
      ocr_services::update_configuration_keep_credentials(
        uow.conn(),
        existing.id,
        input.display_name.trim(),
        input.enabled,
        input.baidu_action.or(Some(BaiduOcrAction::Accurate)),
        None,
        None,
        None,
        &now,
      )?;
      let op = credential_operations::mark_db_committed(uow.conn(), op_id)?;
      let service = ocr_services::get(uow.conn(), existing.id)?;
      Ok((service, op))
    });

    match commit {
      Ok((service, op)) => {
        let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        Ok(service)
      }
      Err(e) => {
        if let Ok(Some(op)) = self.db.read(|conn| credential_operations::get_by_id(conn, op_id)) {
          let _ = coordinator::finalize_operation(&self.db, self.vault.as_ref(), &op);
        }
        Err(e)
      }
    }
  }

  fn prepare_vault_write(
    &self,
    op_id: Uuid,
    owner_kind: OwnerKind,
    owner_id: &str,
    expected_old_ref: Option<&str>,
    new_ref: &str,
    secret: &str,
  ) -> Result<CredentialOperation, StorageError> {
    let prepared = self.db.transaction(|uow| {
      credential_operations::insert_prepared(
        uow.conn(),
        op_id,
        owner_kind,
        owner_id,
        expected_old_ref,
        Some(new_ref),
      )
    })?;

    if let Err(e) = self.vault.set(new_ref, secret) {
      let _ = self.db.transaction(|uow| {
        credential_operations::delete(uow.conn(), op_id)?;
        Ok(())
      });
      return Err(e);
    }
    Ok(prepared)
  }
}

fn plan_create_secret(
  service_id: Uuid,
  update: &CredentialUpdate,
  owner_kind: OwnerKind,
) -> Result<(Option<String>, Option<String>, Option<Uuid>), StorageError> {
  match update {
    CredentialUpdate::Keep | CredentialUpdate::Clear => Ok((None, None, None)),
    CredentialUpdate::Replace(secret) => {
      if secret.is_empty() {
        return Err(StorageError::Validation("credential secret must not be empty".into()));
      }
      let op = new_id();
      let ref_name = match owner_kind {
        OwnerKind::OcrApiKey => ocr_api_key_ref(service_id, op),
        OwnerKind::OcrSecretKey => ocr_secret_key_ref(service_id, op),
        _ => return Err(StorageError::Internal("invalid ocr owner kind".into())),
      };
      Ok((Some(ref_name), Some(secret.clone()), Some(op)))
    }
  }
}

fn require_expected_updated_at(input: &OcrServiceWrite) -> Result<String, StorageError> {
  input
    .expected_updated_at
    .as_ref()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .ok_or_else(|| StorageError::Validation("expected_updated_at is required on update".into()))
}

fn ensure_expected_version(existing: &OcrService, expected_updated_at: &str) -> Result<(), StorageError> {
  if existing.updated_at != expected_updated_at {
    return Err(StorageError::Conflict(
      "ocr service was modified by another session".into(),
    ));
  }
  Ok(())
}

/// Surface an honest partial-apply error after api_key committed but secret_key failed.
fn partial_baidu_dual_key_error(err: StorageError, latest: &OcrService) -> StorageError {
  let cause = match &err {
    StorageError::Validation(msg)
    | StorageError::Conflict(msg)
    | StorageError::NotFound(msg)
    | StorageError::InUse(msg)
    | StorageError::StorageUnavailable(msg)
    | StorageError::Internal(msg) => msg.clone(),
    StorageError::CredentialBusy => "credential operation already in progress".into(),
    StorageError::CredentialUnavailable => "credential store unavailable".into(),
    StorageError::CredentialAccess => "credential access failed".into(),
    other => other.to_string(),
  };
  StorageError::Validation(format!(
    "Partial credential update: api_key was saved (has_api_key={}, has_secret_key={}, updated_at={}); secret_key was not. Reload the service and retry secret_key. Cause: {cause}",
    latest.api_key_ref.is_some(),
    latest.secret_key_ref.is_some(),
    latest.updated_at,
  ))
}

fn validate_ocr_write(input: &OcrServiceWrite) -> Result<(), StorageError> {
  let name = input.display_name.trim();
  if name.is_empty() {
    return Err(StorageError::Validation("display_name must not be empty".into()));
  }
  if name.len() > OCR_DISPLAY_NAME_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "display_name must be at most {OCR_DISPLAY_NAME_MAX_LEN} characters"
    )));
  }

  match input.provider_type {
    OcrProviderType::Baidu => {
      if input.baidu_action.is_none() {
        return Err(StorageError::Validation("baidu_action is required for Baidu OCR".into()));
      }
      if input.provider_model_id.is_some()
        || input.temperature.is_some()
        || input.default_prompt_template_id.is_some()
        || !input.prompt_templates.is_empty()
      {
        return Err(StorageError::Validation(
          "AI-only fields must be empty for Baidu OCR".into(),
        ));
      }
    }
    OcrProviderType::Ai => {
      if input.baidu_action.is_some() {
        return Err(StorageError::Validation(
          "baidu_action must be empty for AI OCR".into(),
        ));
      }
      if !matches!(input.api_key, CredentialUpdate::Keep) || !matches!(input.secret_key, CredentialUpdate::Keep) {
        return Err(StorageError::Validation(
          "credential fields are not accepted for AI OCR".into(),
        ));
      }
      if input.provider_model_id.is_none() {
        return Err(StorageError::Validation(
          "provider_model_id is required for AI OCR".into(),
        ));
      }
      if let Some(temp) = input.temperature {
        if temp < 0.0 {
          return Err(StorageError::Validation("temperature must be >= 0".into()));
        }
      }
      let default_id = input.default_prompt_template_id.ok_or_else(|| {
        StorageError::Validation("default_prompt_template_id is required for AI OCR".into())
      })?;
      validate_ocr_prompt_templates(&input.prompt_templates, default_id)?;
    }
  }
  Ok(())
}

fn validate_ocr_prompt_templates(
  templates: &[OcrPromptTemplate],
  default_prompt_template_id: Uuid,
) -> Result<(), StorageError> {
  if templates.is_empty() {
    return Err(StorageError::Validation(
      "AI OCR requires at least one prompt template".into(),
    ));
  }
  let mut seen = HashSet::new();
  for template in templates {
    let name = template.name.trim();
    if name.is_empty() {
      return Err(StorageError::Validation(
        "prompt template name must not be empty".into(),
      ));
    }
    if name.len() > OCR_PROMPT_TEMPLATE_NAME_MAX_LEN {
      return Err(StorageError::Validation(format!(
        "prompt template name must be at most {OCR_PROMPT_TEMPLATE_NAME_MAX_LEN} characters"
      )));
    }
    if template.system_template.trim().is_empty() {
      return Err(StorageError::Validation(
        "prompt template system_template must not be empty".into(),
      ));
    }
    if template.user_template.trim().is_empty() {
      return Err(StorageError::Validation(
        "prompt template user_template must not be empty".into(),
      ));
    }
    if !seen.insert(template.id) {
      return Err(StorageError::Validation("prompt template ids must be unique".into()));
    }
  }
  if !seen.contains(&default_prompt_template_id) {
    return Err(StorageError::Validation(
      "default_prompt_template_id must reference a template on this service".into(),
    ));
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::credentials::MemoryCredentialVault;
  use crate::domain::model::{Availability, ModelSource, ProviderModel};
  use crate::domain::provider::{CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode};
  use crate::repositories::{provider_instances, provider_models};
  use crate::storage::Database;
  use std::sync::Arc;
  use tempfile::TempDir;

  fn setup() -> (TempDir, OcrServiceService, Database) {
    let dir = TempDir::new().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault: Arc<dyn CredentialVault> = Arc::new(MemoryCredentialVault::default());
    let service = OcrServiceService::new(db.clone(), vault);
    (dir, service, db)
  }

  fn seed_model(db: &Database) -> Uuid {
    let provider_id = new_id();
    let model_id = new_id();
    let now = now_rfc3339();
    db.transaction(|uow| {
      provider_instances::insert(
        uow.conn(),
        &ProviderInstance {
          id: provider_id,
          adapter_id: "openai-compatible".into(),
          display_name: "Local".into(),
          base_url_override: None,
          credential_kind: CredentialKind::None,
          credential_ref: None,
          enabled: true,
          proxy_mode: ProxyMode::Inherit,
          insecure_http_confirmed_at: None,
          models_synced_at: None,
          models_sync_status: ModelsSyncStatus::Never,
          models_sync_error_code: None,
          created_at: now.clone(),
          updated_at: now.clone(),
        },
      )?;
      provider_models::insert(
        uow.conn(),
        &ProviderModel {
          id: model_id,
          provider_instance_id: provider_id,
          model_key: "gpt-test".into(),
          source: ModelSource::Manual,
          remote_display_name: None,
          display_name_override: Some("GPT Test".into()),
          enabled: true,
          availability: Availability::Available,
          remote_metadata_json: None,
          capability_overrides_json: None,
          adapter_id: None,
          last_seen_at: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    model_id
  }

  #[test]
  fn baidu_create_update_delete_with_dual_keys() {
    let (_dir, service, _db) = setup();
    let created = service
      .save(OcrServiceWrite {
        id: None,
        provider_type: OcrProviderType::Baidu,
        display_name: " Baidu One ".into(),
        enabled: true,
        baidu_action: Some(BaiduOcrAction::Accurate),
        api_key: CredentialUpdate::Replace("api-secret".into()),
        secret_key: CredentialUpdate::Replace("secret-secret".into()),
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: None,
      })
      .unwrap();
    assert_eq!(created.display_name, "Baidu One");
    assert!(created.has_api_key);
    assert!(created.has_secret_key);
    assert!(created.prompt_templates.is_empty());

    let updated = service
      .save(OcrServiceWrite {
        id: Some(created.id),
        provider_type: OcrProviderType::Baidu,
        display_name: "Baidu Two".into(),
        enabled: false,
        baidu_action: Some(BaiduOcrAction::GeneralBasic),
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Clear,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: Some(created.updated_at),
      })
      .unwrap();
    assert_eq!(updated.display_name, "Baidu Two");
    assert!(!updated.enabled);
    assert_eq!(updated.baidu_action, Some(BaiduOcrAction::GeneralBasic));
    assert!(updated.has_api_key);
    assert!(!updated.has_secret_key);

    service.delete(created.id).unwrap();
    assert!(service.get(created.id).is_err());
  }

  #[test]
  fn ai_create_requires_model_and_templates() {
    let (_dir, service, db) = setup();
    let model_id = seed_model(&db);
    let template_id = new_id();
    let created = service
      .save(OcrServiceWrite {
        id: None,
        provider_type: OcrProviderType::Ai,
        display_name: "AI OCR".into(),
        enabled: true,
        baidu_action: None,
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Keep,
        provider_model_id: Some(model_id),
        temperature: Some(0.2),
        default_prompt_template_id: Some(template_id),
        prompt_templates: vec![OcrPromptTemplate {
          id: template_id,
          name: "Default".into(),
          system_template: "sys".into(),
          user_template: "user".into(),
        }],
        expected_updated_at: None,
      })
      .unwrap();
    assert_eq!(created.prompt_templates.len(), 1);
    assert_eq!(created.provider_model_id, Some(model_id));

    let err = service
      .save(OcrServiceWrite {
        id: None,
        provider_type: OcrProviderType::Ai,
        display_name: "Missing templates".into(),
        enabled: true,
        baidu_action: None,
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Keep,
        provider_model_id: Some(model_id),
        temperature: None,
        default_prompt_template_id: Some(template_id),
        prompt_templates: vec![],
        expected_updated_at: None,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));
  }

  #[test]
  fn update_requires_expected_updated_at() {
    let (_dir, service, _db) = setup();
    let created = service
      .save(OcrServiceWrite {
        id: None,
        provider_type: OcrProviderType::Baidu,
        display_name: "Baidu".into(),
        enabled: true,
        baidu_action: Some(BaiduOcrAction::Accurate),
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Keep,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: None,
      })
      .unwrap();
    let err = service
      .save(OcrServiceWrite {
        id: Some(created.id),
        provider_type: OcrProviderType::Baidu,
        display_name: "Baidu".into(),
        enabled: true,
        baidu_action: Some(BaiduOcrAction::Accurate),
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Keep,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: None,
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Validation(_)));

    let err = service
      .save(OcrServiceWrite {
        id: Some(created.id),
        provider_type: OcrProviderType::Baidu,
        display_name: "Baidu".into(),
        enabled: true,
        baidu_action: Some(BaiduOcrAction::Accurate),
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Keep,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: Some("not-the-real-version".into()),
      })
      .unwrap_err();
    assert!(matches!(err, StorageError::Conflict(_)));
  }

  /// Vault that fails after N successful `set` calls (for dual-key partial apply).
  struct FailAfterNSetsVault {
    inner: MemoryCredentialVault,
    remaining_ok_sets: std::sync::Mutex<usize>,
  }

  impl FailAfterNSetsVault {
    fn new(ok_sets: usize) -> Self {
      Self {
        inner: MemoryCredentialVault::new(),
        remaining_ok_sets: std::sync::Mutex::new(ok_sets),
      }
    }
  }

  impl CredentialVault for FailAfterNSetsVault {
    fn set(&self, account: &str, secret: &str) -> Result<(), StorageError> {
      let mut remaining = self.remaining_ok_sets.lock().expect("lock");
      if *remaining == 0 {
        return Err(StorageError::CredentialUnavailable);
      }
      *remaining -= 1;
      self.inner.set(account, secret)
    }

    fn get_for_backend_use(&self, account: &str) -> Result<String, StorageError> {
      self.inner.get_for_backend_use(account)
    }

    fn delete(&self, account: &str) -> Result<(), StorageError> {
      self.inner.delete(account)
    }

    fn exists(&self, account: &str) -> Result<bool, StorageError> {
      self.inner.exists(account)
    }
  }

  #[test]
  fn baidu_update_second_key_failure_keeps_first_and_reports_partial() {
    let dir = TempDir::new().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    // First vault.set succeeds (api_key), second fails (secret_key).
    let vault = Arc::new(FailAfterNSetsVault::new(1));
    let service = OcrServiceService::new(db, vault as Arc<dyn CredentialVault>);

    let created = service
      .save(OcrServiceWrite {
        id: None,
        provider_type: OcrProviderType::Baidu,
        display_name: "Baidu Partial".into(),
        enabled: true,
        baidu_action: Some(BaiduOcrAction::Accurate),
        api_key: CredentialUpdate::Keep,
        secret_key: CredentialUpdate::Keep,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: None,
      })
      .unwrap();
    assert!(!created.has_api_key);
    assert!(!created.has_secret_key);

    let err = service
      .save(OcrServiceWrite {
        id: Some(created.id),
        provider_type: OcrProviderType::Baidu,
        display_name: "Baidu Partial".into(),
        enabled: true,
        baidu_action: Some(BaiduOcrAction::Accurate),
        api_key: CredentialUpdate::Replace("api-ok".into()),
        secret_key: CredentialUpdate::Replace("secret-fail".into()),
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        prompt_templates: vec![],
        expected_updated_at: Some(created.updated_at.clone()),
      })
      .unwrap_err();

    match err {
      StorageError::Validation(msg) => {
        assert!(msg.contains("Partial credential update"), "msg={msg}");
        assert!(msg.contains("secret_key was not"), "msg={msg}");
        assert!(msg.contains(&created.updated_at) || msg.contains("has_api_key=true"), "msg={msg}");
      }
      other => panic!("expected Validation partial error, got {other:?}"),
    }

    let after = service.get(created.id).unwrap();
    assert!(after.has_api_key, "api_key must remain after partial apply");
    assert!(!after.has_secret_key, "secret_key must not be set after partial apply");
    assert_ne!(after.updated_at, created.updated_at, "api_key commit advances updated_at");
  }
}
