// ABOUTME: Portable application settings Tauri commands.
// ABOUTME: Update accepts ProxyCredentialUpdate; response exposes only proxyHasCredential.
use crate::cmds::runtime::run_blocking;
use crate::domain::settings::{AppSettingsDto, AppSettingsUpdate};
use crate::error::IpcError;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettingsDto, IpcError> {
	let settings = state.settings.clone();
	run_blocking("get_app_settings", move || settings.get()).await
}

#[tauri::command]
pub async fn update_app_settings(
	state: State<'_, AppState>,
	input: AppSettingsUpdate,
) -> Result<AppSettingsDto, IpcError> {
	let settings = state.settings.clone();
	run_blocking("update_app_settings", move || settings.update(input)).await
}

#[tauri::command]
pub async fn set_app_theme(state: State<'_, AppState>, theme: Option<String>) -> Result<AppSettingsDto, IpcError> {
	let settings = state.settings.clone();
	run_blocking("set_app_theme", move || settings.set_theme(theme)).await
}
