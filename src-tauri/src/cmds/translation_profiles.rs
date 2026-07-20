// ABOUTME: Translation profile and fallback-chain Tauri commands.
// ABOUTME: Profiles are validated in Rust before any repository write.
use crate::cmds::runtime::run_blocking;
use crate::domain::translation_profile::TranslationProfileDto;
use crate::domain::translation_profile::TranslationProfileWrite;
use crate::error::IpcError;
use crate::events::{TRANSLATION_PROFILES_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_translation_profiles(state: State<'_, AppState>) -> Result<Vec<TranslationProfileDto>, IpcError> {
  let profiles = state.profiles.clone();
  run_blocking("list_translation_profiles", move || profiles.list()).await
}

#[tauri::command]
pub async fn get_translation_profile(state: State<'_, AppState>, id: Uuid) -> Result<TranslationProfileDto, IpcError> {
  let profiles = state.profiles.clone();
  run_blocking("get_translation_profile", move || profiles.get(id)).await
}

#[tauri::command]
pub async fn save_translation_profile(
  app: AppHandle,
  state: State<'_, AppState>,
  input: TranslationProfileWrite,
) -> Result<TranslationProfileDto, IpcError> {
  let profiles = state.profiles.clone();
  let result = run_blocking("save_translation_profile", move || profiles.save(input)).await?;
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn set_translation_profile_enabled(
  app: AppHandle,
  state: State<'_, AppState>,
  id: Uuid,
  enabled: bool,
) -> Result<TranslationProfileDto, IpcError> {
  let profiles = state.profiles.clone();
  let result = run_blocking("set_translation_profile_enabled", move || {
    profiles.set_enabled(id, enabled)
  })
  .await?;
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn delete_translation_profile(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let profiles = state.profiles.clone();
  run_blocking("delete_translation_profile", move || profiles.delete(id)).await?;
  emit_data_changed(&app, TRANSLATION_PROFILES_CHANGED);
  Ok(())
}
