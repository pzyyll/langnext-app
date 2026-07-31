// ABOUTME: Speech service validation, CRUD, default resolution, and TTS synthesis dispatch.
// ABOUTME: Capability-backed only; reuses shared Google Cloud integration instances.
use crate::domain::cancel::CancelToken;
use crate::domain::service_capability::SpeechSynthesizeRequest;
use crate::domain::service_capability::validate_speech_synthesize_text;
use crate::domain::service_integration::{IntegrationHealthStatus, validate_capability_id};
use crate::domain::speech_service::{
  SPEECH_DISPLAY_NAME_MAX_LEN, SpeechService, SpeechServiceDto, SpeechServiceWrite, SpeechSynthesizeInput,
};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{app_settings, integration_instances, speech_services};
use crate::services::service_capabilities::{ServiceCapabilityService, execution_context};
use crate::services::service_integration_registry::ServiceIntegrationRegistry;
use crate::services::translation_profiles::{capabilities_major_compatible, capability_name};
use crate::storage::Database;
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

/// Capability name prefix for speech synthesis (`speech.synthesize@N`).
const SPEECH_SYNTHESIZE_CAPABILITY_NAME: &str = "speech.synthesize";

#[derive(Clone)]
pub struct SpeechServiceService {
  db: Database,
  definition_registry: Arc<ServiceIntegrationRegistry>,
  service_capabilities: ServiceCapabilityService,
}

impl SpeechServiceService {
  pub fn new(
    db: Database,
    definition_registry: Arc<ServiceIntegrationRegistry>,
    service_capabilities: ServiceCapabilityService,
  ) -> Self {
    Self {
      db,
      definition_registry,
      service_capabilities,
    }
  }

  pub fn list(&self) -> Result<Vec<SpeechServiceDto>, StorageError> {
    self.db.read_snapshot(|conn| {
      let services = speech_services::list(conn)?;
      Ok(
        services
          .into_iter()
          .map(|s| SpeechServiceDto::from_service(&s))
          .collect(),
      )
    })
  }

  pub fn get(&self, id: Uuid) -> Result<SpeechServiceDto, StorageError> {
    self.db.read(|conn| {
      let service = speech_services::get(conn, id)?;
      Ok(SpeechServiceDto::from_service(&service))
    })
  }

  pub fn save(&self, input: SpeechServiceWrite) -> Result<SpeechServiceDto, StorageError> {
    validate_speech_write(&input)?;
    match input.id {
      None => self.create(input),
      Some(id) => self.update(id, input),
    }
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    self.db.transaction(|uow| {
      speech_services::delete(uow.conn(), id)?;
      let mut settings = app_settings::get(uow.conn())?;
      if settings.default_speech_service_id == Some(id) {
        settings.default_speech_service_id = None;
        app_settings::update(uow.conn(), &settings)?;
      }
      Ok(())
    })
  }

  fn create(&self, input: SpeechServiceWrite) -> Result<SpeechServiceDto, StorageError> {
    let preferences = self.validate_plugin_binding(
      input.integration_instance_id,
      &input.capability_id,
      input.preferences_schema_version,
      &input.preferences,
    )?;

    let now = now_rfc3339();
    let service = SpeechService {
      id: new_id(),
      display_name: input.display_name.trim().to_string(),
      enabled: input.enabled,
      sort_order: 0,
      integration_instance_id: input.integration_instance_id,
      capability_id: input.capability_id.trim().to_string(),
      preferences_schema_version: input.preferences_schema_version,
      preferences,
      created_at: now.clone(),
      updated_at: now,
    };

    self.db.transaction(|uow| {
      speech_services::insert(uow.conn(), &service)?;
      let saved = speech_services::get(uow.conn(), service.id)?;
      Ok(SpeechServiceDto::from_service(&saved))
    })
  }

  fn update(&self, id: Uuid, input: SpeechServiceWrite) -> Result<SpeechServiceDto, StorageError> {
    let existing = self.db.read(|conn| speech_services::get(conn, id))?;
    if let Some(expected) = input.expected_updated_at.as_deref() {
      if expected != existing.updated_at {
        return Err(StorageError::Conflict("speech service was modified".into()));
      }
    }

    // Capability major is immutable after create; only rebind compatible instances.
    if !capabilities_major_compatible(&existing.capability_id, &input.capability_id) {
      return Err(StorageError::Validation(
        "speech service capability major is immutable after create".into(),
      ));
    }

    let preferences = self.validate_plugin_binding(
      input.integration_instance_id,
      &input.capability_id,
      input.preferences_schema_version,
      &input.preferences,
    )?;

    let now = now_rfc3339();
    self.db.transaction(|uow| {
      speech_services::update_configuration(
        uow.conn(),
        id,
        input.display_name.trim(),
        input.enabled,
        input.integration_instance_id,
        input.capability_id.trim(),
        input.preferences_schema_version,
        &preferences,
        &now,
      )?;
      let saved = speech_services::get(uow.conn(), id)?;
      Ok(SpeechServiceDto::from_service(&saved))
    })
  }

  fn validate_plugin_binding(
    &self,
    integration_instance_id: Uuid,
    capability_id: &str,
    preferences_schema_version: i32,
    preferences: &Value,
  ) -> Result<Value, StorageError> {
    validate_capability_id(capability_id).map_err(StorageError::Validation)?;
    if capability_name(capability_id) != Some(SPEECH_SYNTHESIZE_CAPABILITY_NAME) {
      return Err(StorageError::Validation(format!(
        "unsupported speech capability id: {capability_id}"
      )));
    }

    let instance = self
      .db
      .read(|conn| integration_instances::get(conn, integration_instance_id))?;
    if !instance.enabled {
      return Err(StorageError::Validation("integration instance is disabled".into()));
    }
    let registration = self
      .definition_registry
      .get_registration(&instance.plugin_id)
      .ok_or_else(|| StorageError::Validation("plugin definition is missing".into()))?;
    let cap_def = registration.capability(capability_id).ok_or_else(|| {
      StorageError::Validation(format!(
        "capability {capability_id} is not declared on plugin {}",
        instance.plugin_id
      ))
    })?;
    if preferences_schema_version != cap_def.descriptor.preferences_schema_version as i32 {
      return Err(StorageError::Validation(format!(
        "unsupported speech preferences schema version: {preferences_schema_version}"
      )));
    }
    if instance.health_status != IntegrationHealthStatus::Ready {
      return Err(StorageError::Validation(
        "integration instance must be ready before binding".into(),
      ));
    }
    cap_def.preference_adapter.normalize_preferences(preferences)
  }

  /// Synthesize MP3 bytes for the given text/language via the selected or default Speech service.
  pub async fn synthesize(&self, input: SpeechSynthesizeInput, cancel: CancelToken) -> Result<Vec<u8>, StorageError> {
    validate_speech_synthesize_text(&input.text).map_err(|e| StorageError::Validation(e.message))?;
    if input.language_id.trim().is_empty() {
      return Err(StorageError::Validation("language_id is required".into()));
    }

    let request_id = input
      .request_id
      .clone()
      .filter(|s| !s.trim().is_empty())
      .unwrap_or_else(|| new_id().to_string());
    let db = self.db.clone();
    let registry = self.definition_registry.clone();
    let prepared = spawn_blocking_storage(move || {
      prepare_speech_synthesis(&db, &registry, input.speech_service_id, input.text, input.language_id)
    })
    .await?;

    if cancel.is_cancelled() {
      return Err(StorageError::Validation("speech synthesis cancelled".into()));
    }

    let handler = self
      .service_capabilities
      .resolve_speech_synthesize(prepared.integration_instance_id, &prepared.capability_id)
      .map_err(map_capability_error)?;

    let context = execution_context(
      request_id,
      cancel,
      prepared.integration_instance_id,
      prepared.plugin_id,
      prepared.capability_id.clone(),
    );

    let response = handler
      .synthesize(
        prepared.integration_instance_id,
        SpeechSynthesizeRequest {
          text: prepared.text,
          language_id: prepared.language_id,
          preferences: prepared.preferences,
        },
        context,
      )
      .await
      .map_err(map_capability_error)?;
    Ok(response.mp3_bytes)
  }
}

struct PreparedSpeechSynthesis {
  integration_instance_id: Uuid,
  plugin_id: String,
  capability_id: String,
  preferences: Value,
  text: String,
  language_id: String,
}

fn prepare_speech_synthesis(
  db: &Database,
  registry: &ServiceIntegrationRegistry,
  requested_service_id: Option<Uuid>,
  text: String,
  language_id: String,
) -> Result<PreparedSpeechSynthesis, StorageError> {
  let service_id = match requested_service_id {
    Some(id) => id,
    None => {
      let settings = db.read(app_settings::get)?;
      settings
        .default_speech_service_id
        .ok_or_else(|| StorageError::Validation("default Speech service is not configured".into()))?
    }
  };

  let service = db.read(|conn| speech_services::get(conn, service_id))?;
  if !service.enabled {
    return Err(StorageError::Validation("Speech service is disabled".into()));
  }

  let instance = db.read(|conn| integration_instances::get(conn, service.integration_instance_id))?;
  if !instance.enabled {
    return Err(StorageError::Validation("integration instance is disabled".into()));
  }
  if instance.health_status != IntegrationHealthStatus::Ready {
    return Err(StorageError::Validation("integration instance is not ready".into()));
  }

  let preferences = service.preferences.clone();
  let registration = registry
    .get_registration(&instance.plugin_id)
    .ok_or_else(|| StorageError::Validation("plugin definition is missing".into()))?;
  let cap_def = registration
    .capability(&service.capability_id)
    .ok_or_else(|| StorageError::Validation("capability is not declared on plugin".into()))?;
  if service.preferences_schema_version != cap_def.descriptor.preferences_schema_version as i32 {
    return Err(StorageError::Validation(
      "speech preferences schema version mismatch".into(),
    ));
  }
  // Preferences were normalized at save time; re-normalize as a defense-in-depth check.
  let preferences = cap_def.preference_adapter.normalize_preferences(&preferences)?;

  Ok(PreparedSpeechSynthesis {
    integration_instance_id: service.integration_instance_id,
    plugin_id: instance.plugin_id,
    capability_id: service.capability_id,
    preferences,
    text,
    language_id: language_id.trim().to_string(),
  })
}

fn validate_speech_write(input: &SpeechServiceWrite) -> Result<(), StorageError> {
  let name = input.display_name.trim();
  if name.is_empty() {
    return Err(StorageError::Validation("display_name is required".into()));
  }
  if name.chars().count() > SPEECH_DISPLAY_NAME_MAX_LEN {
    return Err(StorageError::Validation(format!(
      "display_name exceeds {SPEECH_DISPLAY_NAME_MAX_LEN} characters"
    )));
  }
  if input.capability_id.trim().is_empty() {
    return Err(StorageError::Validation("capability_id is required".into()));
  }
  if input.preferences_schema_version < 1 {
    return Err(StorageError::Validation(
      "preferences_schema_version must be >= 1".into(),
    ));
  }
  // Default empty object is allowed only when caller supplies defaults.
  if input.preferences.is_null() {
    return Err(StorageError::Validation("preferences are required".into()));
  }
  Ok(())
}

fn map_capability_error(err: crate::domain::service_capability::CapabilityError) -> StorageError {
  use crate::domain::service_capability::CapabilityErrorCode;
  match err.code {
    CapabilityErrorCode::InvalidConfiguration | CapabilityErrorCode::InvalidRequest => {
      StorageError::Validation(err.message)
    }
    CapabilityErrorCode::Cancelled => StorageError::Capability {
      code: "cancelled".into(),
      message: err.message,
    },
    CapabilityErrorCode::Auth => StorageError::Capability {
      code: "auth".into(),
      message: err.message,
    },
    CapabilityErrorCode::PermissionDenied => StorageError::Capability {
      code: "permission_denied".into(),
      message: err.message,
    },
    CapabilityErrorCode::EndpointTrustRequired => StorageError::EndpointTrustRequired(err.message),
    CapabilityErrorCode::QuotaExceeded => StorageError::Capability {
      code: "quota_exceeded".into(),
      message: err.message,
    },
    CapabilityErrorCode::RateLimited => StorageError::Capability {
      code: "rate_limited".into(),
      message: err.message,
    },
    CapabilityErrorCode::UnsupportedInput => StorageError::Capability {
      code: "unsupported_input".into(),
      message: err.message,
    },
    CapabilityErrorCode::UnsupportedLanguage => StorageError::Capability {
      code: "unsupported_language".into(),
      message: err.message,
    },
    CapabilityErrorCode::Network => StorageError::Capability {
      code: "network".into(),
      message: err.message,
    },
    CapabilityErrorCode::Timeout => StorageError::Capability {
      code: "timeout".into(),
      message: err.message,
    },
    CapabilityErrorCode::InvalidResponse => StorageError::Capability {
      code: "invalid_response".into(),
      message: err.message,
    },
    CapabilityErrorCode::ProviderUnavailable => StorageError::Capability {
      code: "provider_unavailable".into(),
      message: err.message,
    },
    CapabilityErrorCode::PluginUnavailable => StorageError::PluginUnavailable(err.message),
    CapabilityErrorCode::Internal => StorageError::Internal(err.message),
  }
}

async fn spawn_blocking_storage<T, F>(work: F) -> Result<T, StorageError>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T, StorageError> + Send + 'static,
{
  tokio::task::spawn_blocking(work)
    .await
    .map_err(|e| StorageError::Internal(format!("blocking task failed: {e}")))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_capability::{
    SPEECH_SYNTHESIZE_CAPABILITY_ID, SpeechSynthesizePreferences, validate_speech_synthesize_preferences,
  };
  use crate::domain::speech_service::{
    GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION, default_google_tts_preferences, parse_speech_synthesize_preferences,
  };

  #[test]
  fn validate_speech_write_rejects_blank_and_oversized_names() {
    let mut write = SpeechServiceWrite {
      id: None,
      display_name: "  ".into(),
      enabled: true,
      integration_instance_id: new_id(),
      capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
      preferences_schema_version: GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
      preferences: default_google_tts_preferences(),
      expected_updated_at: None,
    };
    assert!(validate_speech_write(&write).is_err());

    write.display_name = "a".repeat(SPEECH_DISPLAY_NAME_MAX_LEN + 1);
    assert!(validate_speech_write(&write).is_err());

    write.display_name = "Google TTS".into();
    assert!(validate_speech_write(&write).is_ok());
  }

  #[test]
  fn default_preferences_are_valid() {
    let prefs: SpeechSynthesizePreferences =
      parse_speech_synthesize_preferences(&default_google_tts_preferences()).unwrap();
    assert!(validate_speech_synthesize_preferences(&prefs).is_ok());
  }
}
