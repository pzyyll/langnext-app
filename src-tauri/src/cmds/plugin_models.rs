// ABOUTME: Trusted-app IPC for plugin model resource status, download, and cancel.
// ABOUTME: Download URLs/digests stay host-resolved from the signed package only.
use crate::cmds::runtime::run_blocking;
use crate::domain::plugin_model::{
  CancelPluginModelDownloadInput, DownloadPluginModelInput, PluginModelDownloadProgress, PluginModelResourceDto,
};
use crate::error::IpcError;
use crate::state::AppState;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn list_plugin_model_resources(
  state: State<'_, AppState>,
  instance_id: String,
) -> Result<Vec<PluginModelResourceDto>, IpcError> {
  let services = state.plugin_models.clone();
  run_blocking("list_plugin_model_resources", move || {
    services.list_for_instance(&instance_id)
  })
  .await
}

#[tauri::command]
pub async fn download_plugin_model(
  state: State<'_, AppState>,
  input: DownloadPluginModelInput,
  progress: Channel<PluginModelDownloadProgress>,
) -> Result<PluginModelResourceDto, IpcError> {
  let services = state.plugin_models.clone();
  run_blocking("download_plugin_model", move || {
    services.download_model(input, |event| {
      let _ = progress.send(event);
    })
  })
  .await
}

#[tauri::command]
pub async fn cancel_plugin_model_download(
  state: State<'_, AppState>,
  input: CancelPluginModelDownloadInput,
) -> Result<(), IpcError> {
  let services = state.plugin_models.clone();
  run_blocking("cancel_plugin_model_download", move || services.cancel_download(input)).await
}

// Keep AppHandle import available for future emit hooks without unused warnings on Windows.
#[allow(dead_code)]
fn _keep_app_handle(_app: &AppHandle) {}
