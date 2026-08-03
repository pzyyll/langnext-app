// ABOUTME: Model CRUD and frontend sync-persistence service (no remote Provider orchestration).
// ABOUTME: Remote model list / translate / detect run on the frontend via provider plugins.
use crate::credentials::CredentialVault;
use crate::domain::model::{
  Availability, CapabilityOverridesV1, ManualModelWrite, ModelConfigWrite, ModelSource, ProviderModel,
  ProviderModelDto, RemoteModelSyncItem, SyncModelsResult,
};
use crate::domain::provider::{ModelsSyncStatus, ProviderInstanceDto};
use crate::domain::time::{new_id, now_rfc3339};
use crate::error::StorageError;
use crate::repositories::{provider_instances, provider_models, provider_runtime_bindings, translation_profiles};
use crate::services::models_dev_catalog::ModelsDevCatalog;
use crate::storage::Database;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

const MAX_MODEL_KEY_LEN: usize = 256;
const MAX_DISPLAY_NAME_OVERRIDE_LEN: usize = 200;
/// Non-persisted sync result when connection settings changed mid-flight.
pub const CONNECTION_CHANGED_CODE: &str = "connection_changed";

#[derive(Clone)]
pub struct ModelService {
  db: Database,
  #[allow(dead_code)]
  vault: Arc<dyn CredentialVault>,
  /// models.dev catalog (24h disk+memory cache) used to seed capability overrides on sync.
  models_dev: ModelsDevCatalog,
}

/// Outcome of a guarded sync write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncWriteOutcome {
  Applied,
  ConnectionChanged,
}

impl ModelService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>, cache_dir: PathBuf) -> Self {
    Self {
      db,
      vault,
      models_dev: ModelsDevCatalog::new(cache_dir),
    }
  }

  pub fn list_by_provider(&self, provider_id: Uuid) -> Result<Vec<ProviderModelDto>, StorageError> {
    self
      .db
      .read(|conn| provider_models::list_by_provider(conn, provider_id))
  }

  /// List every stored provider model (all channels). Used by the translate model picker.
  pub fn list_all(&self) -> Result<Vec<ProviderModelDto>, StorageError> {
    self.db.read(|conn| provider_models::list_all(conn))
  }

  pub fn save_manual(&self, input: ManualModelWrite) -> Result<ProviderModelDto, StorageError> {
    validate_manual_model(&input)?;
    let capability_overrides_json = CapabilityOverridesV1::from_json(&input.capability_overrides_json)?
      .map(|v| serde_json::to_value(v).expect("capability overrides serialize"));
    let adapter_id = normalize_model_adapter_id(&input.adapter_id)?;
    self.db.transaction(|uow| {
      provider_instances::get(uow.conn(), input.provider_instance_id)?;
      let now = now_rfc3339();
      match input.id {
        None => {
          let model = ProviderModel {
            id: new_id(),
            provider_instance_id: input.provider_instance_id,
            model_key: input.model_key.clone(),
            source: ModelSource::Manual,
            remote_display_name: None,
            display_name_override: input.display_name_override.clone(),
            enabled: input.enabled,
            availability: Availability::Available,
            remote_metadata_json: None,
            capability_overrides_json,
            adapter_id,
            source_adapter_id: String::new(),
            last_seen_at: None,
            created_at: now.clone(),
            updated_at: now,
          };
          provider_models::insert(uow.conn(), &model)?;
          Ok(model)
        }
        Some(id) => {
          let mut existing = provider_models::get(uow.conn(), id)?;
          if existing.source != ModelSource::Manual {
            return Err(StorageError::Validation(
              "only manual models can be edited with save_manual".into(),
            ));
          }
          if existing.provider_instance_id != input.provider_instance_id {
            return Err(StorageError::Validation("provider_instance_id cannot change".into()));
          }
          existing.model_key = input.model_key.clone();
          existing.display_name_override = input.display_name_override.clone();
          existing.enabled = input.enabled;
          existing.capability_overrides_json = capability_overrides_json;
          existing.adapter_id = adapter_id;
          existing.updated_at = now;
          provider_models::update(uow.conn(), &existing)?;
          Ok(existing)
        }
      }
    })
  }

  pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<ProviderModelDto, StorageError> {
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      provider_models::set_enabled(uow.conn(), id, enabled, &now)?;
      provider_models::get(uow.conn(), id)
    })
  }

  /// Set optional per-model API Type override for any model source.
  pub fn set_adapter_id(&self, id: Uuid, adapter_id: Option<String>) -> Result<ProviderModelDto, StorageError> {
    let adapter_id = normalize_model_adapter_id(&adapter_id)?;
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      provider_models::get(uow.conn(), id)?;
      provider_models::set_adapter_id(uow.conn(), id, adapter_id.as_deref(), &now)?;
      provider_models::get(uow.conn(), id)
    })
  }

  /// Update display name, API Type, and capability overrides for any model source.
  pub fn update_config(&self, input: ModelConfigWrite) -> Result<ProviderModelDto, StorageError> {
    let display_name_override = normalize_display_name_override(input.display_name_override)?;
    let capability_overrides_json = CapabilityOverridesV1::from_json(&input.capability_overrides_json)?
      .map(|v| serde_json::to_value(v).expect("capability overrides serialize"));
    let adapter_id = normalize_model_adapter_id(&input.adapter_id)?;
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      let mut existing = provider_models::get(uow.conn(), input.id)?;
      existing.display_name_override = display_name_override;
      existing.adapter_id = adapter_id;
      existing.capability_overrides_json = capability_overrides_json;
      existing.updated_at = now;
      provider_models::update(uow.conn(), &existing)?;
      Ok(existing)
    })
  }

  pub fn delete(&self, id: Uuid) -> Result<(), StorageError> {
    self.delete_many(vec![id]).map(|_| ())
  }

  pub fn delete_many(&self, ids: Vec<Uuid>) -> Result<usize, StorageError> {
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<Uuid> = ids.into_iter().filter(|id| seen.insert(*id)).collect();
    if unique.is_empty() {
      return Ok(0);
    }
    self.db.transaction(|uow| {
      let now = now_rfc3339();
      let id_set: std::collections::HashSet<Uuid> = unique.iter().copied().collect();
      translation_profiles::clear_detection_models(uow.conn(), &id_set, &now)?;
      translation_profiles::delete_targets_by_models(uow.conn(), &unique)?;
      for id in &unique {
        provider_models::delete(uow.conn(), *id)?;
      }
      Ok(unique.len())
    })
  }

  /// Pure cache-merge used by tests without connection identity guards.
  #[cfg(test)]
  pub fn apply_remote_merge(
    &self,
    provider_id: Uuid,
    source_adapter_id: &str,
    remote_models: &[RemoteModelSyncItem],
  ) -> Result<(), StorageError> {
    let seen_at = now_rfc3339();
    self.db.transaction(|uow| {
      provider_models::apply_remote_sync(uow.conn(), provider_id, source_adapter_id, remote_models, &seen_at)?;
      provider_instances::update_sync_status(
        uow.conn(),
        provider_id,
        Some(&seen_at),
        ModelsSyncStatus::Ok,
        None,
        &seen_at,
      )?;
      Ok(())
    })
  }

  /// Frontend model-sync persistence: apply a complete remote snapshot for ONE selected API
  /// type when `expected_updated_at` still matches. The selected type must have a binding row
  /// for this provider (attached interface or Provider default); an unknown type fails
  /// closed before any model row changes.
  pub fn apply_provider_model_sync(
    &self,
    provider_id: Uuid,
    adapter_id: &str,
    expected_updated_at: &str,
    remote_models: &[RemoteModelSyncItem],
  ) -> Result<SyncModelsResult, StorageError> {
    let adapter_id = adapter_id.trim().to_string();
    if adapter_id.is_empty() {
      return Err(StorageError::Validation("adapter_id is required for model sync".into()));
    }
    crate::domain::provider::validate_adapter_id(&adapter_id).map_err(StorageError::Validation)?;
    let seeded = remote_models.to_vec();
    let outcome = self.db.transaction(|uow| {
      let provider = provider_instances::get(uow.conn(), provider_id)?;
      if provider.updated_at != expected_updated_at {
        return Ok(SyncWriteOutcome::ConnectionChanged);
      }
      // Per-interface authority: the selected API type must be attached (binding row exists).
      let binding = provider_runtime_bindings::get_optional(uow.conn(), provider_id, &adapter_id)?;
      if binding.is_none() {
        return Err(StorageError::Validation(format!(
          "API type '{adapter_id}' is not attached to this provider"
        )));
      }
      let seen_at = now_rfc3339();
      provider_models::apply_remote_sync(uow.conn(), provider_id, &adapter_id, &seeded, &seen_at)?;
      provider_instances::update_sync_status(
        uow.conn(),
        provider_id,
        Some(&seen_at),
        ModelsSyncStatus::Ok,
        None,
        &seen_at,
      )?;
      Ok(SyncWriteOutcome::Applied)
    })?;
    let (provider, bindings) = self
      .db
      .read(|conn| provider_instances::get_with_runtime(conn, provider_id))?;
    let models = self.list_by_provider(provider_id)?;
    match outcome {
      SyncWriteOutcome::Applied => Ok(SyncModelsResult {
        ok: true,
        error_code: None,
        message: format!(
          "Synced {} models",
          models.iter().filter(|m| m.source == ModelSource::Remote).count()
        ),
        models,
        provider: ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings),
      }),
      SyncWriteOutcome::ConnectionChanged => Ok(SyncModelsResult {
        ok: false,
        error_code: Some(CONNECTION_CHANGED_CODE.into()),
        message: "Provider connection changed during sync".into(),
        models,
        provider: ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings),
      }),
    }
  }

  /// Frontend model-sync failure status when `expected_updated_at` still matches.
  pub fn apply_provider_model_sync_failure(
    &self,
    provider_id: Uuid,
    expected_updated_at: &str,
    error_code: &str,
  ) -> Result<SyncModelsResult, StorageError> {
    validate_sync_error_code(error_code)?;
    let outcome = self.db.transaction(|uow| {
      let provider = provider_instances::get(uow.conn(), provider_id)?;
      if provider.updated_at != expected_updated_at {
        return Ok(SyncWriteOutcome::ConnectionChanged);
      }
      let now = now_rfc3339();
      provider_instances::update_sync_failure(
        uow.conn(),
        provider_id,
        ModelsSyncStatus::Error,
        Some(error_code),
        &now,
      )?;
      Ok(SyncWriteOutcome::Applied)
    })?;
    let (provider, bindings) = self
      .db
      .read(|conn| provider_instances::get_with_runtime(conn, provider_id))?;
    let models = self.list_by_provider(provider_id)?;
    match outcome {
      SyncWriteOutcome::Applied => Ok(SyncModelsResult {
        ok: false,
        error_code: Some(error_code.to_string()),
        message: format!("Model sync failed: {error_code}"),
        models,
        provider: ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings),
      }),
      SyncWriteOutcome::ConnectionChanged => Ok(SyncModelsResult {
        ok: false,
        error_code: Some(CONNECTION_CHANGED_CODE.into()),
        message: "Provider connection changed during sync".into(),
        models,
        provider: ProviderInstanceDto::from_provider_and_runtime(&provider, &bindings),
      }),
    }
  }

  /// Unguarded failure write for direct unit tests of status persistence.
  #[cfg(test)]
  pub fn record_sync_error(&self, provider_id: Uuid, error_code: &str) -> Result<(), StorageError> {
    validate_sync_error_code(error_code)?;
    let now = now_rfc3339();
    self.db.transaction(|uow| {
      provider_instances::update_sync_failure(
        uow.conn(),
        provider_id,
        ModelsSyncStatus::Error,
        Some(error_code),
        &now,
      )?;
      Ok(())
    })
  }

  /// Attach models.dev (or default) capability overrides to each remote sync item.
  pub async fn seed_remote_capabilities(
    &self,
    mut remote_models: Vec<RemoteModelSyncItem>,
  ) -> Vec<RemoteModelSyncItem> {
    for item in &mut remote_models {
      if item.capability_overrides_json.is_some() {
        continue;
      }
      let caps = self.models_dev.capabilities_for_model_key(&item.model_key).await;
      item.capability_overrides_json = Some(serde_json::to_value(caps).expect("capability overrides serialize"));
    }
    remote_models
  }
}

/// Resolve the effective API type for one model row: explicit override → discovery source
/// type → Provider default. Delegates to the domain helper.
pub fn resolve_model_effective_adapter(
  model_adapter_id: Option<&str>,
  source_adapter_id: &str,
  provider_adapter_id: &str,
) -> String {
  crate::domain::model::resolve_model_effective_adapter(model_adapter_id, source_adapter_id, provider_adapter_id)
}

/// Prefer a non-empty model adapter override; otherwise use the channel default. Retained
/// for legacy callers; the source-aware effective resolver supersedes it.
pub(crate) fn resolve_model_adapter_id(model_adapter_id: Option<&str>, channel_adapter_id: &str) -> String {
  resolve_model_effective_adapter(model_adapter_id, "", channel_adapter_id)
}

fn normalize_model_adapter_id(adapter_id: &Option<String>) -> Result<Option<String>, StorageError> {
  match adapter_id {
    None => Ok(None),
    Some(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() {
        return Ok(None);
      }
      crate::domain::provider::validate_adapter_id(trimmed).map_err(StorageError::Validation)?;
      Ok(Some(trimmed.to_string()))
    }
  }
}

fn validate_manual_model(input: &ManualModelWrite) -> Result<(), StorageError> {
  let key = input.model_key.trim();
  if key.is_empty() {
    return Err(StorageError::Validation("model_key must not be empty".into()));
  }
  if key.len() > MAX_MODEL_KEY_LEN {
    return Err(StorageError::Validation(format!(
      "model_key must be at most {MAX_MODEL_KEY_LEN} characters"
    )));
  }
  Ok(())
}

fn normalize_display_name_override(value: Option<String>) -> Result<Option<String>, StorageError> {
  let Some(raw) = value else {
    return Ok(None);
  };
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }
  if trimmed.len() > MAX_DISPLAY_NAME_OVERRIDE_LEN {
    return Err(StorageError::Validation(format!(
      "display_name_override must be at most {MAX_DISPLAY_NAME_OVERRIDE_LEN} characters"
    )));
  }
  Ok(Some(trimmed.to_string()))
}

/// Validate codes that may be persisted on `models_sync_error_code`.
pub fn validate_sync_error_code(code: &str) -> Result<(), StorageError> {
  match code {
    "auth" | "rate_limited" | "network" | "timeout" | "server" | "invalid_response" | "credential_unavailable" => {
      Ok(())
    }
    other => Err(StorageError::Validation(format!(
      "invalid models_sync_error_code: {other}"
    ))),
  }
}

#[cfg(test)]
mod resolve_tests {
  use super::*;

  #[test]
  fn resolve_model_adapter_id_prefers_model_then_channel() {
    assert_eq!(resolve_model_adapter_id(Some("gemini"), "openai-compatible"), "gemini");
    assert_eq!(resolve_model_adapter_id(None, "openai-compatible"), "openai-compatible");
    assert_eq!(resolve_model_adapter_id(Some("  "), "anthropic"), "anthropic");
    assert_eq!(
      resolve_model_adapter_id(Some(""), "openai-responses"),
      "openai-responses"
    );
  }

  #[test]
  fn effective_adapter_prefers_override_then_source_then_provider_default() {
    assert_eq!(
      resolve_model_effective_adapter(Some("override"), "source-type", "provider-default"),
      "override"
    );
    assert_eq!(
      resolve_model_effective_adapter(None, "source-type", "provider-default"),
      "source-type"
    );
    assert_eq!(
      resolve_model_effective_adapter(Some("  "), "source-type", "provider-default"),
      "source-type"
    );
    assert_eq!(
      resolve_model_effective_adapter(None, "", "provider-default"),
      "provider-default"
    );
  }
}
