// ABOUTME: Provider model CRUD and frontend sync-persistence Tauri commands.
// ABOUTME: Returns sanitized DTOs; secrets never cross the IPC boundary.
use crate::cmds::runtime::run_blocking;
use crate::domain::model::{ManualModelWrite, ModelConfigWrite, ProviderModelDto, SyncModelsResult};
use crate::error::IpcError;
use crate::events::{MODELS_CHANGED, PROVIDERS_CHANGED, TRANSLATION_PROFILES_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_provider_models(
  state: State<'_, AppState>,
  provider_instance_id: Uuid,
) -> Result<Vec<ProviderModelDto>, IpcError> {
  let models = state.models.clone();
  run_blocking("list_provider_models", move || {
    models.list_by_provider(provider_instance_id)
  })
  .await
}

#[tauri::command]
pub async fn list_all_provider_models(state: State<'_, AppState>) -> Result<Vec<ProviderModelDto>, IpcError> {
  let models = state.models.clone();
  run_blocking("list_all_provider_models", move || models.list_all()).await
}

#[tauri::command]
pub async fn save_manual_model(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ManualModelWrite,
) -> Result<ProviderModelDto, IpcError> {
  let models = state.models.clone();
  let result = run_blocking("save_manual_model", move || models.save_manual(input)).await?;
  emit_data_changed(&app, MODELS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn set_model_enabled(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
  enabled: bool,
) -> Result<ProviderModelDto, IpcError> {
  let models = state.models.clone();
  let result = run_blocking("set_model_enabled", move || models.set_enabled(id, enabled)).await?;
  emit_data_changed(&app, MODELS_CHANGED);
  Ok(result)
}

/// Set optional per-model API Type (`adapter_id`). Pass null to inherit the channel adapter.
#[tauri::command]
pub async fn set_model_adapter_id(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
  adapter_id: Option<String>,
) -> Result<ProviderModelDto, IpcError> {
  let models = state.models.clone();
  let result = run_blocking("set_model_adapter_id", move || models.set_adapter_id(id, adapter_id)).await?;
  emit_data_changed(&app, MODELS_CHANGED);
  Ok(result)
}

/// Update per-model display name, API Type, and capability overrides for any model source.
#[tauri::command]
pub async fn update_model_config(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ModelConfigWrite,
) -> Result<ProviderModelDto, IpcError> {
  let models = state.models.clone();
  let result = run_blocking("update_model_config", move || models.update_config(input)).await?;
  emit_data_changed(&app, MODELS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn delete_provider_model(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let models = state.models.clone();
  run_blocking("delete_provider_model", move || models.delete(id)).await?;
  emit_data_changed(&app, MODELS_CHANGED);
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  Ok(())
}

/// Bulk-delete models in a single SQLite transaction. Emits model + profile events once on success.
#[tauri::command]
pub async fn delete_provider_models(
  app: AppHandle,
  state: State<'_, AppState>,
  ids: Vec<Uuid>,
) -> Result<(), IpcError> {
  let models = state.models.clone();
  let deleted = run_blocking("delete_provider_models", move || models.delete_many(ids)).await?;
  if deleted > 0 {
    emit_data_changed(&app, MODELS_CHANGED);
    emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  }
  Ok(())
}

/// Persist a frontend-parsed complete remote model snapshot.
#[tauri::command]
pub async fn apply_provider_model_sync(
  app: AppHandle,
  state: State<'_, AppState>,
  provider_instance_id: Uuid,
  expected_updated_at: String,
  remote_models: Vec<crate::domain::model::RemoteModelSyncItem>,
) -> Result<SyncModelsResult, IpcError> {
  let models = state.models.clone();
  let seeded = models.seed_remote_capabilities(remote_models).await;
  let models = state.models.clone();
  let result = run_blocking("apply_provider_model_sync", move || {
    models.apply_provider_model_sync(provider_instance_id, &expected_updated_at, &seeded)
  })
  .await?;
  if result.ok {
    emit_data_changed(&app, MODELS_CHANGED);
    emit_data_changed(&app, PROVIDERS_CHANGED);
  }
  Ok(result)
}

/// Persist a frontend model-sync failure status when the provider version still matches.
#[tauri::command]
pub async fn apply_provider_model_sync_failure(
  app: AppHandle,
  state: State<'_, AppState>,
  provider_instance_id: Uuid,
  expected_updated_at: String,
  error_code: String,
) -> Result<SyncModelsResult, IpcError> {
  let models = state.models.clone();
  let result = run_blocking("apply_provider_model_sync_failure", move || {
    models.apply_provider_model_sync_failure(provider_instance_id, &expected_updated_at, &error_code)
  })
  .await?;
  if result.error_code.as_deref() != Some("connection_changed") {
    emit_data_changed(&app, PROVIDERS_CHANGED);
  }
  Ok(result)
}
