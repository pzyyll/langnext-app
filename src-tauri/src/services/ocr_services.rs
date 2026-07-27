// ABOUTME: OCR service validation, CRUD, dual-key vault orchestration, and image recognition.
// ABOUTME: Baidu secrets use the crash-safe credential journal; AI rows store model + templates.
use crate::credentials::coordinator;
use crate::credentials::{CredentialVault, ocr_api_key_ref, ocr_secret_key_ref};
use crate::domain::cancel::CancelToken;
use crate::domain::ocr_service::{
  BaiduOcrAction, OCR_DISPLAY_NAME_MAX_LEN, OCR_PROMPT_TEMPLATE_NAME_MAX_LEN, OcrPromptTemplate, OcrProviderType,
  OcrRecognizeInput, OcrRecognizeResult, OcrService, OcrServiceDto, OcrServiceWrite, default_google_vision_preferences,
  parse_ocr_image_preferences,
};
use crate::domain::provider::{CredentialUpdate, ProxyMode};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, OcrImagePreferences, OcrImageRequest, validate_ocr_image_preferences,
};
use crate::domain::service_integration::{IntegrationHealthStatus, validate_capability_id};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::credential_operations::{self, CredentialOperation, OwnerKind};
use crate::repositories::{app_settings, integration_instances, ocr_prompt_templates, ocr_services, provider_models};
use crate::services::service_capabilities::{ServiceCapabilityService, execution_context};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::translation_profiles::{capabilities_major_compatible, capability_name};
use crate::storage::Database;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

/// Baidu OAuth token endpoint.
const BAIDU_OAUTH_TOKEN_URL: &str = "https://aip.baidubce.com/oauth/2.0/token";
/// Baidu OCR REST base path template (`{action}` is the API version slug).
const BAIDU_OCR_URL_PREFIX: &str = "https://aip.baidubce.com/rest/2.0/ocr/v1/";
/// Capability name prefix for image OCR (`ocr.image@N`).
const OCR_IMAGE_CAPABILITY_NAME: &str = "ocr.image";

#[derive(Clone)]
pub struct OcrServiceService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  definition_registry: Arc<ServiceIntegrationRegistry>,
  service_capabilities: ServiceCapabilityService,
}

impl OcrServiceService {
  pub fn new(
    db: Database,
    vault: Arc<dyn CredentialVault>,
    definition_registry: Arc<ServiceIntegrationRegistry>,
    service_capabilities: ServiceCapabilityService,
  ) -> Self {
    Self {
      db,
      vault,
      definition_registry,
      service_capabilities,
    }
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
      // Drop screenshot default when the selected OCR service is removed.
      let mut settings = app_settings::get(uow.conn())?;
      if settings.default_ocr_service_id == Some(id) {
        settings.default_ocr_service_id = None;
        app_settings::update(uow.conn(), &settings)?;
      }
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
      OcrProviderType::PluginCapability => self.create_plugin(id, input, &now),
    }
  }

  fn create_baidu(&self, id: Uuid, input: OcrServiceWrite, now: &str) -> Result<OcrServiceDto, StorageError> {
    let baidu_action = input.baidu_action.unwrap_or(BaiduOcrAction::Accurate);
    let (api_key_ref, api_secret, api_op) = plan_create_secret(id, &input.api_key, OwnerKind::OcrApiKey)?;
    let (secret_key_ref, secret_secret, secret_op) =
      plan_create_secret(id, &input.secret_key, OwnerKind::OcrSecretKey)?;

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
      integration_instance_id: None,
      ocr_capability_id: None,
      capability_preferences_version: None,
      capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
      };
      ocr_services::insert(uow.conn(), &service)?;
      ocr_prompt_templates::replace_for_service(uow.conn(), id, &templates)?;
      let stored = ocr_services::get(uow.conn(), id)?;
      Ok(OcrServiceDto::from_service(&stored, templates))
    })
  }

  fn create_plugin(&self, id: Uuid, input: OcrServiceWrite, now: &str) -> Result<OcrServiceDto, StorageError> {
    let binding = resolve_plugin_write_fields(&input)?;
    self.db.transaction(|uow| {
      let preferences = validate_plugin_ocr_binding(uow.conn(), self.definition_registry.as_ref(), &binding)?;
      let service = OcrService {
        id,
        provider_type: OcrProviderType::PluginCapability,
        display_name: input.display_name.trim().to_string(),
        enabled: input.enabled,
        sort_order: 0,
        baidu_action: None,
        api_key_ref: None,
        secret_key_ref: None,
        provider_model_id: None,
        temperature: None,
        default_prompt_template_id: None,
        integration_instance_id: Some(binding.integration_instance_id),
        ocr_capability_id: Some(binding.ocr_capability_id.clone()),
        capability_preferences_version: Some(binding.capability_preferences_version),
        capability_preferences: Some(preferences),
        created_at: now.to_string(),
        updated_at: now.to_string(),
      };
      ocr_services::insert(uow.conn(), &service)?;
      let stored = ocr_services::get(uow.conn(), id)?;
      Ok(OcrServiceDto::from_service(&stored, vec![]))
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
      OcrProviderType::PluginCapability => self.update_plugin(existing, input, &expected_updated_at),
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
      current = self.apply_key_mutation(current, &input, OwnerKind::OcrApiKey, &input.api_key, &expected)?;
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
        || credential_operations::get_for_owner(uow.conn(), OwnerKind::OcrSecretKey, &current.id.to_string())?.is_some()
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

  fn update_plugin(
    &self,
    existing: OcrService,
    input: OcrServiceWrite,
    expected_updated_at: &str,
  ) -> Result<OcrServiceDto, StorageError> {
    let binding = resolve_plugin_write_fields(&input)?;
    // Rebind is allowed when capability major stays compatible.
    if let (Some(old_cap), Some(old_instance)) =
      (existing.ocr_capability_id.as_deref(), existing.integration_instance_id)
    {
      if old_instance != binding.integration_instance_id || old_cap.trim() != binding.ocr_capability_id {
        if !capabilities_major_compatible(old_cap, &binding.ocr_capability_id) {
          return Err(StorageError::Validation(
            "rebind rejected: OCR capability major is incompatible".into(),
          ));
        }
      }
    }

    let now = now_rfc3339();
    self.db.transaction(|uow| {
      let latest = ocr_services::get(uow.conn(), existing.id)?;
      ensure_expected_version(&latest, expected_updated_at)?;
      let preferences = validate_plugin_ocr_binding(uow.conn(), self.definition_registry.as_ref(), &binding)?;
      ocr_services::update_plugin_configuration(
        uow.conn(),
        existing.id,
        input.display_name.trim(),
        input.enabled,
        binding.integration_instance_id,
        &binding.ocr_capability_id,
        binding.capability_preferences_version,
        &preferences,
        &now,
      )?;
      let service = ocr_services::get(uow.conn(), existing.id)?;
      Ok(OcrServiceDto::from_service(&service, vec![]))
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
      credential_operations::insert_prepared(uow.conn(), op_id, owner_kind, owner_id, expected_old_ref, Some(new_ref))
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

  /// Recognize text with a Baidu or plugin OCR service.
  ///
  /// AI OCR is executed on the frontend through provider plugins + `provider_http_*`.
  /// When `input.request_id` is set, the caller must have registered it on the shared
  /// session registry (see `recognize_ocr` command); this method reuses that token.
  pub async fn recognize(
    &self,
    input: OcrRecognizeInput,
    cancel: CancelToken,
  ) -> Result<OcrRecognizeResult, StorageError> {
    let png_base64 = input.png_base64.trim().to_string();
    if png_base64.is_empty() {
      return Err(StorageError::Validation("png_base64 must not be empty".into()));
    }

    let db = self.db.clone();
    let vault = self.vault.clone();
    let prepared =
      spawn_blocking_storage(move || prepare_ocr_recognition(&db, vault.as_ref(), input.ocr_service_id, png_base64))
        .await?;

    match prepared {
      PreparedOcr::Baidu(baidu) => {
        if cancel.is_cancelled() {
          return Err(StorageError::Validation("OCR request cancelled".into()));
        }
        let text = recognize_baidu_ocr(baidu.api_key, baidu.secret_key, baidu.action, baidu.png_base64).await?;
        Ok(OcrRecognizeResult {
          text,
          ocr_service_id: baidu.service_id,
        })
      }
      PreparedOcr::Plugin(plugin) => {
        let handler = self
          .service_capabilities
          .resolve_ocr(plugin.integration_instance_id, &plugin.ocr_capability_id)
          .map_err(map_capability_error)?;
        let request_id = input
          .request_id
          .clone()
          .filter(|s| !s.trim().is_empty())
          .unwrap_or_else(|| new_id().to_string());
        let context = execution_context(
          request_id,
          cancel,
          plugin.integration_instance_id,
          plugin.plugin_id,
          plugin.ocr_capability_id.clone(),
        );
        let response = handler
          .recognize(
            plugin.integration_instance_id,
            OcrImageRequest {
              png_base64: plugin.png_base64,
              preferences: plugin.preferences,
            },
            context,
          )
          .await
          .map_err(map_capability_error)?;
        Ok(OcrRecognizeResult {
          text: response.text,
          ocr_service_id: plugin.service_id,
        })
      }
    }
  }
}

/// Prepared Baidu OCR call after DB/vault resolution (secrets never leave the service layer).
struct PreparedBaiduOcr {
  service_id: Uuid,
  api_key: String,
  secret_key: String,
  action: BaiduOcrAction,
  png_base64: String,
}

/// Prepared plugin OCR call after DB resolution.
struct PreparedPluginOcr {
  service_id: Uuid,
  integration_instance_id: Uuid,
  plugin_id: String,
  ocr_capability_id: String,
  preferences: OcrImagePreferences,
  png_base64: String,
}

enum PreparedOcr {
  Baidu(PreparedBaiduOcr),
  Plugin(PreparedPluginOcr),
}

fn prepare_ocr_recognition(
  db: &Database,
  vault: &dyn CredentialVault,
  requested_service_id: Option<Uuid>,
  png_base64: String,
) -> Result<PreparedOcr, StorageError> {
  let service_id = match requested_service_id {
    Some(id) => id,
    None => {
      let settings = db.read(app_settings::get)?;
      settings
        .default_ocr_service_id
        .ok_or_else(|| StorageError::Validation("default OCR service is not configured".into()))?
    }
  };

  let service = db.read(|conn| ocr_services::get(conn, service_id))?;

  if !service.enabled {
    return Err(StorageError::Validation("OCR service is disabled".into()));
  }

  match service.provider_type {
    OcrProviderType::Baidu => {
      let action = service.baidu_action.unwrap_or(BaiduOcrAction::Accurate);
      let api_key_ref = service
        .api_key_ref
        .as_deref()
        .ok_or_else(|| StorageError::Validation("Baidu OCR API key is not configured".into()))?;
      let secret_key_ref = service
        .secret_key_ref
        .as_deref()
        .ok_or_else(|| StorageError::Validation("Baidu OCR secret key is not configured".into()))?;
      let api_key = vault.get_for_backend_use(api_key_ref)?;
      let secret_key = vault.get_for_backend_use(secret_key_ref)?;
      Ok(PreparedOcr::Baidu(PreparedBaiduOcr {
        service_id: service.id,
        api_key,
        secret_key,
        action,
        png_base64,
      }))
    }
    OcrProviderType::Ai => Err(StorageError::Validation(
      "AI OCR is handled by the frontend provider plugin workflow".into(),
    )),
    OcrProviderType::PluginCapability => {
      let integration_instance_id = service
        .integration_instance_id
        .ok_or_else(|| StorageError::Validation("plugin OCR service is missing integration_instance_id".into()))?;
      let ocr_capability_id = service
        .ocr_capability_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| StorageError::Validation("plugin OCR service is missing ocr_capability_id".into()))?;
      let preferences_value = service
        .capability_preferences
        .clone()
        .unwrap_or_else(default_google_vision_preferences);
      let preferences = parse_ocr_image_preferences(&preferences_value)
        .map_err(StorageError::Validation)
        .and_then(|prefs| {
          validate_ocr_image_preferences(&prefs).map_err(map_capability_error)?;
          Ok(prefs)
        })?;
      let instance = db.read(|conn| integration_instances::get(conn, integration_instance_id))?;
      if !instance.enabled {
        return Err(StorageError::PluginUnavailable(
          "integration instance is disabled".into(),
        ));
      }
      Ok(PreparedOcr::Plugin(PreparedPluginOcr {
        service_id: service.id,
        integration_instance_id,
        plugin_id: instance.plugin_id,
        ocr_capability_id,
        preferences,
        png_base64,
      }))
    }
  }
}

async fn recognize_baidu_ocr(
  api_key: String,
  secret_key: String,
  action: BaiduOcrAction,
  png_base64: String,
) -> Result<String, StorageError> {
  let client = ocr_http_client(ProxyMode::Inherit)?;
  let token = fetch_baidu_access_token(&client, &api_key, &secret_key).await?;
  let mut url = url::Url::parse(&format!("{BAIDU_OCR_URL_PREFIX}{}", action.as_str()))
    .map_err(|_| StorageError::Internal("invalid Baidu OCR URL".into()))?;
  url.query_pairs_mut().append_pair("access_token", &token);

  let form_body = url::form_urlencoded::Serializer::new(String::new())
    .append_pair("image", &png_base64)
    .append_pair("language_type", "auto_detect")
    .append_pair("detect_direction", "false")
    .append_pair("detect_language", "false")
    .append_pair("vertexes_location", "false")
    .append_pair("paragraph", "false")
    .append_pair("probability", "false")
    .finish();

  let response = client
    .post(url)
    .header("Accept", "application/json")
    .header("Content-Type", "application/x-www-form-urlencoded")
    .body(form_body)
    .send()
    .await
    .map_err(map_reqwest_network_error)?;

  let status = response.status();
  let body = response.text().await.map_err(map_reqwest_network_error)?;
  if !status.is_success() {
    return Err(StorageError::Validation(format!(
      "Baidu OCR HTTP {status}: {}",
      truncate_for_error(&body)
    )));
  }

  let parsed: BaiduOcrResponse = serde_json::from_str(&body)
    .map_err(|_| StorageError::Validation("Baidu OCR returned an invalid response".into()))?;
  if let Some(code) = parsed.error_code {
    if code != 0 {
      let message = parsed
        .error_msg
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Baidu OCR error_code={code}"));
      return Err(StorageError::Validation(message));
    }
  }

  let lines = parsed
    .words_result
    .unwrap_or_default()
    .into_iter()
    .map(|item| item.words.trim().to_string())
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>();
  Ok(lines.join("\n"))
}

async fn fetch_baidu_access_token(
  client: &reqwest::Client,
  api_key: &str,
  secret_key: &str,
) -> Result<String, StorageError> {
  let mut url =
    url::Url::parse(BAIDU_OAUTH_TOKEN_URL).map_err(|_| StorageError::Internal("invalid Baidu OAuth URL".into()))?;
  url
    .query_pairs_mut()
    .append_pair("grant_type", "client_credentials")
    .append_pair("client_id", api_key)
    .append_pair("client_secret", secret_key);

  let response = client.post(url).send().await.map_err(map_reqwest_network_error)?;

  let status = response.status();
  let body = response.text().await.map_err(map_reqwest_network_error)?;
  if !status.is_success() {
    return Err(StorageError::Validation(format!(
      "Baidu OAuth HTTP {status}: {}",
      truncate_for_error(&body)
    )));
  }

  let parsed: BaiduTokenResponse = serde_json::from_str(&body)
    .map_err(|_| StorageError::Validation("Baidu OAuth returned an invalid response".into()))?;
  if let Some(token) = parsed.access_token.filter(|value| !value.trim().is_empty()) {
    return Ok(token);
  }
  let message = parsed
    .error_description
    .or(parsed.error)
    .unwrap_or_else(|| "Baidu OAuth token missing".into());
  Err(StorageError::Validation(message))
}

fn ocr_http_client(proxy_mode: ProxyMode) -> Result<reqwest::Client, StorageError> {
  let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
  if matches!(proxy_mode, ProxyMode::Direct) {
    builder = builder.no_proxy();
  }
  builder
    .build()
    .map_err(|_| StorageError::Internal("failed to build OCR HTTP client".into()))
}

fn map_reqwest_network_error(err: reqwest::Error) -> StorageError {
  if err.is_timeout() {
    StorageError::Validation("OCR request timed out".into())
  } else {
    StorageError::Validation("OCR network request failed".into())
  }
}

fn truncate_for_error(body: &str) -> String {
  const MAX_CHARS: usize = 180;
  let trimmed = body.trim();
  if trimmed.chars().count() <= MAX_CHARS {
    return trimmed.to_string();
  }
  let mut out = trimmed.chars().take(MAX_CHARS).collect::<String>();
  out.push('…');
  out
}

async fn spawn_blocking_storage<T, F>(f: F) -> Result<T, StorageError>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T, StorageError> + Send + 'static,
{
  match tauri::async_runtime::spawn_blocking(f).await {
    Ok(result) => result,
    Err(_) => Err(StorageError::Internal("OCR prepare task failed".into())),
  }
}

#[derive(Debug, serde::Deserialize)]
struct BaiduTokenResponse {
  access_token: Option<String>,
  error: Option<String>,
  error_description: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BaiduOcrResponse {
  error_code: Option<i64>,
  error_msg: Option<String>,
  words_result: Option<Vec<BaiduWordResult>>,
}

#[derive(Debug, serde::Deserialize)]
struct BaiduWordResult {
  words: String,
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
        return Err(StorageError::Validation(
          "baidu_action is required for Baidu OCR".into(),
        ));
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
      reject_plugin_fields_for_non_plugin(input)?;
    }
    OcrProviderType::Ai => {
      if input.baidu_action.is_some() {
        return Err(StorageError::Validation("baidu_action must be empty for AI OCR".into()));
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
      let default_id = input
        .default_prompt_template_id
        .ok_or_else(|| StorageError::Validation("default_prompt_template_id is required for AI OCR".into()))?;
      validate_ocr_prompt_templates(&input.prompt_templates, default_id)?;
      reject_plugin_fields_for_non_plugin(input)?;
    }
    OcrProviderType::PluginCapability => {
      if input.baidu_action.is_some() {
        return Err(StorageError::Validation(
          "baidu_action must be empty for plugin OCR".into(),
        ));
      }
      if !matches!(input.api_key, CredentialUpdate::Keep) || !matches!(input.secret_key, CredentialUpdate::Keep) {
        return Err(StorageError::Validation(
          "credential fields are not accepted for plugin OCR".into(),
        ));
      }
      if input.provider_model_id.is_some()
        || input.temperature.is_some()
        || input.default_prompt_template_id.is_some()
        || !input.prompt_templates.is_empty()
      {
        return Err(StorageError::Validation(
          "AI-only fields must be empty for plugin OCR".into(),
        ));
      }
      // Full binding validation (instance ready / schema) runs inside create/update transactions.
      let _ = resolve_plugin_write_fields(input)?;
    }
  }
  Ok(())
}

fn reject_plugin_fields_for_non_plugin(input: &OcrServiceWrite) -> Result<(), StorageError> {
  if input.integration_instance_id.is_some()
    || input.ocr_capability_id.is_some()
    || input.capability_preferences_version.is_some()
    || input.capability_preferences.is_some()
  {
    return Err(StorageError::Validation(
      "plugin-only fields must be empty for non-plugin OCR".into(),
    ));
  }
  Ok(())
}

struct PluginOcrWriteFields {
  integration_instance_id: Uuid,
  ocr_capability_id: String,
  capability_preferences_version: i32,
  capability_preferences: Value,
}

fn resolve_plugin_write_fields(input: &OcrServiceWrite) -> Result<PluginOcrWriteFields, StorageError> {
  let integration_instance_id = input
    .integration_instance_id
    .ok_or_else(|| StorageError::Validation("integration_instance_id is required for plugin OCR".into()))?;
  let ocr_capability_id = input
    .ocr_capability_id
    .as_ref()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| StorageError::Validation("ocr_capability_id is required for plugin OCR".into()))?;
  validate_capability_id(&ocr_capability_id).map_err(StorageError::Validation)?;
  if capability_name(&ocr_capability_id) != Some(OCR_IMAGE_CAPABILITY_NAME) {
    return Err(StorageError::Validation(
      "ocr_capability_id must be an ocr.image@N capability".into(),
    ));
  }

  let capability_preferences_version = input
    .capability_preferences_version
    .ok_or_else(|| StorageError::Validation("capability_preferences_version is required for plugin OCR".into()))?;
  let capability_preferences = input
    .capability_preferences
    .clone()
    .unwrap_or_else(default_google_vision_preferences);
  if !capability_preferences.is_object() {
    return Err(StorageError::Validation(
      "capability_preferences must be a JSON object".into(),
    ));
  }

  Ok(PluginOcrWriteFields {
    integration_instance_id,
    ocr_capability_id,
    capability_preferences_version,
    capability_preferences,
  })
}

fn validate_plugin_ocr_binding(
  conn: &rusqlite::Connection,
  registry: &ServiceIntegrationRegistry,
  binding: &PluginOcrWriteFields,
) -> Result<Value, StorageError> {
  let instance = integration_instances::get(conn, binding.integration_instance_id)?;
  if !instance.enabled {
    return Err(StorageError::Validation(
      "integration instance must be enabled for plugin OCR".into(),
    ));
  }
  if !matches!(instance.health_status, IntegrationHealthStatus::Ready) {
    return Err(StorageError::Validation(
      "integration instance must be ready for plugin OCR".into(),
    ));
  }
  let registration = registry
    .get_registration(&instance.plugin_id)
    .ok_or_else(|| StorageError::Validation("integration plugin definition is missing".into()))?;
  let cap_def = registration.capability(&binding.ocr_capability_id).ok_or_else(|| {
    StorageError::Validation(format!(
      "OCR capability {} is not declared on plugin {}",
      binding.ocr_capability_id, instance.plugin_id
    ))
  })?;
  if binding.capability_preferences_version != cap_def.descriptor.preferences_schema_version as i32 {
    return Err(StorageError::Validation(format!(
      "OCR preferences schema version must be {}",
      cap_def.descriptor.preferences_schema_version
    )));
  }
  cap_def
    .preference_adapter
    .normalize_preferences(&binding.capability_preferences)
}

fn is_supported_app_language(language_id: &str) -> bool {
  let candidate = language_id.trim().to_ascii_lowercase();
  crate::domain::language_detection::supported_languages()
    .iter()
    .any(|lang| *lang == candidate)
}

/// Map capability failures into storage/IPC-facing errors without leaking provider bodies.
fn map_capability_error(err: CapabilityError) -> StorageError {
  match err.code {
    CapabilityErrorCode::PluginUnavailable => StorageError::PluginUnavailable(err.message),
    CapabilityErrorCode::Internal => StorageError::Internal(err.message),
    _ => StorageError::Validation(format!("{}: {}", err.code.as_str(), err.message)),
  }
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
  use crate::domain::provider::{
    AuthSchemeV1, BaseUrlSource, CredentialKind, ModelsSyncStatus, ProviderInstance, ProxyMode,
  };
  use crate::repositories::{provider_instances, provider_models};
  use crate::storage::Database;
  use std::sync::Arc;
  use tempfile::TempDir;

  fn test_ocr_service(db: Database, vault: Arc<dyn CredentialVault>) -> OcrServiceService {
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let network = Arc::new(crate::services::network_broker::NetworkBroker::new(
      db.clone(),
      registry.clone(),
    ));
    let tokens = Arc::new(crate::services::token_grant::TokenGrantService::new(Arc::new(
      TestExchanger,
    )));
    let handlers = Arc::new(
      crate::services::bundled_plugins::build_capability_registry(
        crate::services::bundled_plugins::HandlerDeps {
          db: db.clone(),
          broker: network,
          tokens,
        },
        &registry,
      )
      .unwrap(),
    );
    let caps = ServiceCapabilityService::new(db.clone(), registry.clone(), handlers);
    OcrServiceService::new(db, vault, registry, caps)
  }

  struct TestExchanger;
  impl crate::services::token_grant::GoogleTokenExchanger for TestExchanger {
    fn exchange(
      &self,
      _instance_id: Uuid,
      _scopes: Vec<String>,
      _now_unix_secs: u64,
      _cancel: Option<CancelToken>,
    ) -> std::pin::Pin<
      Box<
        dyn std::future::Future<Output = Result<crate::services::token_grant::ExchangedToken, CapabilityError>>
          + Send
          + '_,
      >,
    > {
      Box::pin(async {
        Ok(crate::services::token_grant::ExchangedToken {
          access_token: "t".into(),
          expires_in: 3600,
          credential_revision: 1,
        })
      })
    }
  }

  fn setup() -> (TempDir, OcrServiceService, Database) {
    let dir = TempDir::new().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let vault: Arc<dyn CredentialVault> = Arc::new(MemoryCredentialVault::default());
    let service = test_ocr_service(db.clone(), vault);
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
          base_url: "https://api.openai.com/v1".into(),
          base_url_source: BaseUrlSource::PluginDefault,
          auth_scheme: AuthSchemeV1::none(),
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
    let service = test_ocr_service(db, vault as Arc<dyn CredentialVault>);

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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
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
        integration_instance_id: None,
        ocr_capability_id: None,
        capability_preferences_version: None,
        capability_preferences: None,
        expected_updated_at: Some(created.updated_at.clone()),
      })
      .unwrap_err();

    match err {
      StorageError::Validation(msg) => {
        assert!(msg.contains("Partial credential update"), "msg={msg}");
        assert!(msg.contains("secret_key was not"), "msg={msg}");
        assert!(
          msg.contains(&created.updated_at) || msg.contains("has_api_key=true"),
          "msg={msg}"
        );
      }
      other => panic!("expected Validation partial error, got {other:?}"),
    }

    let after = service.get(created.id).unwrap();
    assert!(after.has_api_key, "api_key must remain after partial apply");
    assert!(!after.has_secret_key, "secret_key must not be set after partial apply");
    assert_ne!(
      after.updated_at, created.updated_at,
      "api_key commit advances updated_at"
    );
  }
}
