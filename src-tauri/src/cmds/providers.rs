// ABOUTME: Sanitized Provider CRUD Tauri commands.
// ABOUTME: Dispatches blocking storage work and maps failures to IpcError.
use crate::cmds::runtime::run_blocking;
use crate::domain::provider::{ProviderInstanceDto, ProviderInstanceWrite};
use crate::error::IpcError;
use crate::events::{emit_data_changed, PROVIDERS_CHANGED, TRANSLATION_PROFILES_CHANGED};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_provider_instances(state: State<'_, AppState>) -> Result<Vec<ProviderInstanceDto>, IpcError> {
  let providers = state.providers.clone();
  run_blocking("list_provider_instances", move || providers.list()).await
}

#[tauri::command]
pub async fn save_provider_instance(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ProviderInstanceWrite,
) -> Result<ProviderInstanceDto, IpcError> {
  let providers = state.providers.clone();
  let result = run_blocking("save_provider_instance", move || providers.save(input)).await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn set_provider_enabled(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
  enabled: bool,
) -> Result<ProviderInstanceDto, IpcError> {
  let providers = state.providers.clone();
  let result = run_blocking("set_provider_enabled", move || providers.set_enabled(id, enabled)).await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn delete_provider_instance(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let providers = state.providers.clone();
  run_blocking("delete_provider_instance", move || providers.delete(id)).await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  Ok(())
}

#[tauri::command]
pub async fn reorder_provider_instances(
  app: AppHandle,
  state: State<'_, AppState>,
  ids: Vec<Uuid>,
) -> Result<(), IpcError> {
  let providers = state.providers.clone();
  run_blocking("reorder_provider_instances", move || providers.reorder(ids)).await?;
  emit_data_changed(&app, PROVIDERS_CHANGED);
  Ok(())
}
