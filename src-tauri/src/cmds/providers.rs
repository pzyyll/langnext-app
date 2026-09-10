// ABOUTME: Sanitized Provider CRUD Tauri commands.
// ABOUTME: Dispatches blocking storage work and maps failures to IpcError.
use crate::cmds::runtime::run_blocking;
use crate::domain::provider::{ProviderInstanceDto, ProviderInstanceWrite};
use crate::domain::runtime_provider::ProviderRuntimeState;
use crate::error::IpcError;
use crate::events::{PROVIDERS_CHANGED, TRANSLATION_PROFILES_CHANGED, emit_data_changed};
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

  // The catalog default is the only default authority: activate pending bindings now.
  let pending: Vec<String> = result
    .runtime_bindings
    .iter()
    .filter(|binding| binding.state == ProviderRuntimeState::PendingActivation && binding.package_digest.is_some())
    .map(|binding| binding.adapter_id.clone())
    .collect();
  if !pending.is_empty() {
    let runtime = state.runtime_providers.clone();
    let provider_id = result.id;
    let activated = run_blocking("activate_provider_runtime_defaults", move || {
      for adapter_id in &pending {
        runtime.activate_with_catalog_default(provider_id, adapter_id)?;
      }
      Ok(())
    })
    .await?;
    let _ = activated;
    emit_data_changed(&app, PROVIDERS_CHANGED);
  }

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
