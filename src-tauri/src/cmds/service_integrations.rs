// ABOUTME: Sanitized service-integration definition/instance Tauri commands.
// ABOUTME: Emits coarse change events after successful mutations only.
use crate::cmds::runtime::run_blocking;
use crate::domain::service_integration::{
  IntegrationDependencyDto, IntegrationInstanceDto, IntegrationInstanceWrite, IntegrationValidationResult,
  ServiceIntegrationManifest,
};
use crate::error::IpcError;
use crate::events::{SERVICE_INTEGRATIONS_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_service_integration_definitions(
  state: State<'_, AppState>,
) -> Result<Vec<ServiceIntegrationManifest>, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("list_service_integration_definitions", move || {
    Ok(services.list_definitions())
  })
  .await
}

#[tauri::command]
pub async fn list_integration_instances(state: State<'_, AppState>) -> Result<Vec<IntegrationInstanceDto>, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("list_integration_instances", move || services.list_instances()).await
}

#[tauri::command]
pub async fn get_integration_instance(
  state: State<'_, AppState>,
  id: Uuid,
) -> Result<IntegrationInstanceDto, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("get_integration_instance", move || services.get_instance(id)).await
}

#[tauri::command]
pub async fn save_integration_instance(
  app: AppHandle,
  state: State<'_, AppState>,
  input: IntegrationInstanceWrite,
) -> Result<IntegrationInstanceDto, IpcError> {
  let services = state.service_integrations.clone();
  let result = run_blocking("save_integration_instance", move || services.save(input)).await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn set_integration_instance_enabled(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
  enabled: bool,
) -> Result<IntegrationInstanceDto, IpcError> {
  let services = state.service_integrations.clone();
  let result = run_blocking("set_integration_instance_enabled", move || {
    services.set_enabled(id, enabled)
  })
  .await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn list_integration_instance_dependencies(
  state: State<'_, AppState>,
  id: Uuid,
) -> Result<Vec<IntegrationDependencyDto>, IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("list_integration_instance_dependencies", move || {
    services.list_dependencies(id)
  })
  .await
}

#[tauri::command]
pub async fn delete_integration_instance(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let services = state.service_integrations.clone();
  run_blocking("delete_integration_instance", move || services.delete(id)).await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(())
}

/// Local-only validation (Phase 1A). Never claims remote/IAM health.
#[tauri::command]
pub async fn validate_integration_instance(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
) -> Result<IntegrationValidationResult, IpcError> {
  let services = state.service_integrations.clone();
  let result = run_blocking("validate_integration_instance", move || services.validate_instance(id)).await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  Ok(result)
}
