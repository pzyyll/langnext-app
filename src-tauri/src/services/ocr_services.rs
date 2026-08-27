// ABOUTME: OCR service validation, CRUD, dual-key vault orchestration, and image recognition.
// ABOUTME: Baidu secrets use the crash-safe credential journal; AI rows store model + templates.
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::ocr_service::{
  OCR_DISPLAY_NAME_MAX_LEN, OCR_PROMPT_TEMPLATE_NAME_MAX_LEN, OcrPromptTemplate, OcrProviderType, OcrRecognizeInput,
  OcrRecognizeResult, OcrService, OcrServiceDto, OcrServiceWrite, default_google_vision_preferences,
  parse_ocr_image_preferences,
};
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, OcrImagePreferences, OcrImageRequest, ProviderAttemptTracker,
  validate_ocr_image_preferences,
};
use crate::domain::service_integration::{IntegrationHealthStatus, validate_capability_id};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{app_settings, integration_instances, ocr_prompt_templates, ocr_services, provider_models};
use crate::services::service_capabilities::{ServiceCapabilityService, execution_context_with_tracker};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::translation_profiles::{capabilities_major_compatible, capability_name};
use crate::storage::Database;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

/// Baidu OCR REST base path template (`{action}` is the API version slug).
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
    self.db.transaction(|uow| {
      ocr_services::delete(uow.conn(), id)?;
      // Drop screenshot default when the selected OCR service is removed.
      let mut settings = app_settings::get(uow.conn())?;
      if settings.default_ocr_service_id == Some(id) {
        settings.default_ocr_service_id = None;
        app_settings::update(uow.conn(), &settings)?;
      }
      Ok(())
    })
  }

  fn create(&self, input: OcrServiceWrite) -> Result<OcrServiceDto, StorageError> {
    let id = new_id();
    let now = now_rfc3339();
    match input.provider_type {
      OcrProviderType::Ai => self.create_ai(id, input, &now),
      OcrProviderType::PluginCapability => self.create_plugin(id, input, &now),
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
    let expected_updated_at = require_expected_updated_at(&input)?;
    let existing = self.db.read(|conn| ocr_services::get(conn, id))?;
    ensure_expected_version(&existing, &expected_updated_at)?;
    if existing.provider_type != input.provider_type {
      return Err(StorageError::Validation(
        "ocr provider_type is immutable after create".into(),
      ));
    }

    match input.provider_type {
      OcrProviderType::Ai => self.update_ai(existing, input, &expected_updated_at),
      OcrProviderType::PluginCapability => self.update_plugin(existing, input, &expected_updated_at),
    }
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
        let provider_attempt = ProviderAttemptTracker::new();
        let call_cancel = cancel.clone();
        let context = execution_context_with_tracker(
          request_id,
          cancel,
          plugin.integration_instance_id,
          plugin.plugin_id,
          plugin.ocr_capability_id.clone(),
          provider_attempt.clone(),
        );
        let call_result = handler
          .recognize(
            plugin.integration_instance_id,
            OcrImageRequest {
              png_base64: plugin.png_base64,
              preferences: plugin.preferences,
            },
            context,
          )
          .await;
        let call_result = if call_cancel.is_cancelled() {
          Err(CapabilityError::new(
            CapabilityErrorCode::Cancelled,
            "OCR request cancelled",
          ))
        } else {
          call_result
        };
        if !call_cancel.is_cancelled() {
          let _ = self.service_capabilities.record_provider_result_if_current(
            plugin.integration_instance_id,
            &plugin.ocr_capability_id,
            &provider_attempt,
            call_result.is_ok(),
            call_result.as_ref().err().map(|error| error.code),
            Some(plugin.instance_updated_at.as_str()),
          );
        }
        let response = call_result.map_err(map_capability_error)?;
        Ok(OcrRecognizeResult {
          text: response.text,
          ocr_service_id: plugin.service_id,
        })
      }
    }
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
    OcrProviderType::Ai => {
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

/// Prepared plugin OCR call after DB resolution.
struct PreparedPluginOcr {
  service_id: Uuid,
  integration_instance_id: Uuid,
  instance_updated_at: String,
  plugin_id: String,
  ocr_capability_id: String,
  preferences: OcrImagePreferences,
  png_base64: String,
}

enum PreparedOcr {
  Plugin(PreparedPluginOcr),
}

fn prepare_ocr_recognition(
  db: &Database,
  _vault: &dyn CredentialVault,
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
    OcrProviderType::Ai => Err(StorageError::Validation(
      "AI OCR is handled by the frontend provider workflow".into(),
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
        instance_updated_at: instance.updated_at,
        plugin_id: instance.plugin_id,
        ocr_capability_id,
        preferences,
        png_base64,
      }))
    }
  }
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

fn map_capability_error(err: CapabilityError) -> StorageError {
  match err.code {
    CapabilityErrorCode::PluginUnavailable => StorageError::PluginUnavailable(err.message),
    CapabilityErrorCode::Internal => StorageError::Internal(err.message),
    _ => StorageError::Validation(format!("{}: {}", err.code.as_str(), err.message)),
  }
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
  use crate::services::token_grant::{GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID, TokenInjectionKind};
  use crate::storage::Database;
  use std::sync::Arc;
  use tempfile::TempDir;

  fn test_ocr_service(db: Database, vault: Arc<dyn CredentialVault>) -> OcrServiceService {
    let registry = Arc::new(ServiceIntegrationRegistry::empty());
    let caps = ServiceCapabilityService::new(db.clone(), registry.clone());
    OcrServiceService::new(db, vault, registry, caps)
  }

  struct TestExchanger;
  impl crate::services::token_grant::TokenExchanger for TestExchanger {
    fn driver_id(&self) -> &'static str {
      GOOGLE_SERVICE_ACCOUNT_AUTH_DRIVER_ID
    }

    fn injection_kind(&self) -> TokenInjectionKind {
      TokenInjectionKind::BearerHeader
    }

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
          source_adapter_id: String::new(),
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
}
