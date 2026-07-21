// ABOUTME: Portable application settings Tauri commands.
// ABOUTME: Update accepts ProxyCredentialUpdate; response exposes only proxyHasCredential.
use crate::cmds::runtime::run_blocking;
use crate::domain::settings::{AppSettingsDto, AppSettingsUpdate, ShortcutDefinition};
use crate::error::IpcError;
use crate::shortcuts::ShortcutRuntime;
use crate::state::AppState;
use tauri::{AppHandle, Runtime, State};
use uuid::Uuid;

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

#[tauri::command]
pub async fn set_app_ui_language(state: State<'_, AppState>, ui_language: String) -> Result<AppSettingsDto, IpcError> {
  let settings = state.settings.clone();
  run_blocking("set_app_ui_language", move || settings.set_ui_language(ui_language)).await
}

/// Persist shortcuts and re-apply OS registration / double Ctrl+C gate.
#[tauri::command]
pub async fn set_app_shortcuts<R: Runtime>(
  app: AppHandle<R>,
  state: State<'_, AppState>,
  runtime: State<'_, ShortcutRuntime>,
  shortcuts: Vec<ShortcutDefinition>,
) -> Result<AppSettingsDto, IpcError> {
  let settings = state.settings.clone();
  let dto = run_blocking("set_app_shortcuts", move || settings.set_shortcuts(shortcuts)).await?;
  runtime
    .apply(&app, &dto.settings.shortcuts)
    .map_err(|message| IpcError::new("shortcut_apply_failed", message))?;
  Ok(dto)
}

/// Persist the OCR service used for region-screenshot text recognition.
#[tauri::command]
pub async fn set_app_default_ocr_service(
  state: State<'_, AppState>,
  default_ocr_service_id: Option<Uuid>,
) -> Result<AppSettingsDto, IpcError> {
  let settings = state.settings.clone();
  run_blocking("set_app_default_ocr_service", move || {
    settings.set_default_ocr_service_id(default_ocr_service_id)
  })
  .await
}
