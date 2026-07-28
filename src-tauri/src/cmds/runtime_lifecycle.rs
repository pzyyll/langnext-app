// ABOUTME: Tauri IPC commands for runtime upgrade preview/apply and rollback.
// ABOUTME: Emits coarse data-change events only after successful CAS commit.
use crate::cmds::runtime::run_blocking;
use crate::domain::runtime_lifecycle::{
  ApplyRuntimeRollbackInput, ApplyRuntimeUpgradeInput, RuntimeLifecycleResultDto, RuntimeRollbackPreviewDto,
  RuntimeUpgradePreviewDto,
};
use crate::error::IpcError;
use crate::events::{
  OCR_SERVICES_CHANGED, SERVICE_INTEGRATIONS_CHANGED, SPEECH_SERVICES_CHANGED, TRANSLATION_PROFILES_CHANGED,
  emit_data_changed,
};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn preview_integration_runtime_upgrade(
  state: State<'_, AppState>,
  instance_id: Uuid,
  target_package_digest: String,
) -> Result<RuntimeUpgradePreviewDto, IpcError> {
  let services = state.runtime_lifecycle.clone();
  run_blocking("preview_integration_runtime_upgrade", move || {
    services.preview_upgrade(instance_id, &target_package_digest)
  })
  .await
}

#[tauri::command]
pub async fn apply_integration_runtime_upgrade(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApplyRuntimeUpgradeInput,
) -> Result<RuntimeLifecycleResultDto, IpcError> {
  let services = state.runtime_lifecycle.clone();
  let result = run_blocking("apply_integration_runtime_upgrade", move || {
    services.apply_upgrade(input)
  })
  .await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  emit_data_changed(&app, OCR_SERVICES_CHANGED);
  emit_data_changed(&app, SPEECH_SERVICES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn preview_integration_runtime_rollback(
  state: State<'_, AppState>,
  instance_id: Uuid,
) -> Result<RuntimeRollbackPreviewDto, IpcError> {
  let services = state.runtime_lifecycle.clone();
  run_blocking("preview_integration_runtime_rollback", move || {
    services.preview_rollback(instance_id)
  })
  .await
}

#[tauri::command]
pub async fn apply_integration_runtime_rollback(
  app: AppHandle,
  state: State<'_, AppState>,
  input: ApplyRuntimeRollbackInput,
) -> Result<RuntimeLifecycleResultDto, IpcError> {
  let services = state.runtime_lifecycle.clone();
  let result = run_blocking("apply_integration_runtime_rollback", move || {
    services.apply_rollback(input)
  })
  .await?;
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  emit_data_changed(&app, OCR_SERVICES_CHANGED);
  emit_data_changed(&app, SPEECH_SERVICES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn discard_integration_runtime_snapshot(
  state: State<'_, AppState>,
  snapshot_id: Uuid,
) -> Result<(), IpcError> {
  let services = state.runtime_lifecycle.clone();
  run_blocking("discard_integration_runtime_snapshot", move || {
    services.discard_rollback_snapshot(snapshot_id)
  })
  .await
}
