// ABOUTME: Translation history Tauri commands: list/get/facets/delete/clear.
// ABOUTME: Delete and clear emit the history-changed event for cross-window invalidation.
use crate::cmds::runtime::run_blocking;
use crate::domain::translation_history::{
  TranslationHistoryDto, TranslationHistoryListQuery, TranslationHistoryListResult, TranslationHistoryModelFacet,
};
use crate::error::IpcError;
use crate::events::{TRANSLATION_HISTORY_CHANGED, emit_data_changed};
use crate::services::translation_history::FrontendHistoryCompletion;
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn record_translation_history_completion(
  app: AppHandle,
  state: State<'_, AppState>,
  input: FrontendHistoryCompletion,
) -> Result<(), IpcError> {
  let history = state.history.clone();
  run_blocking("record_translation_history_completion", move || {
    history.record_completion(input)
  })
  .await?;
  emit_data_changed(&app, TRANSLATION_HISTORY_CHANGED);
  Ok(())
}

#[tauri::command]
pub async fn list_translation_history(
  state: State<'_, AppState>,
  query: TranslationHistoryListQuery,
) -> Result<TranslationHistoryListResult, IpcError> {
  let history = state.history.clone();
  run_blocking("list_translation_history", move || history.list(query)).await
}

#[tauri::command]
pub async fn get_translation_history(state: State<'_, AppState>, id: Uuid) -> Result<TranslationHistoryDto, IpcError> {
  let history = state.history.clone();
  run_blocking("get_translation_history", move || history.get(id)).await
}

#[tauri::command]
pub async fn get_translation_history_many(
  state: State<'_, AppState>,
  ids: Vec<Uuid>,
) -> Result<Vec<TranslationHistoryDto>, IpcError> {
  let history = state.history.clone();
  run_blocking("get_translation_history_many", move || history.get_many(ids)).await
}

#[tauri::command]
pub async fn list_translation_history_model_facets(
  state: State<'_, AppState>,
) -> Result<Vec<TranslationHistoryModelFacet>, IpcError> {
  let history = state.history.clone();
  run_blocking("list_translation_history_model_facets", move || {
    history.list_model_facets()
  })
  .await
}

/// Delete rows by id. Absent ids are ignored. Emits history-changed on success.
#[tauri::command]
pub async fn delete_translation_history(
  app: AppHandle,
  state: State<'_, AppState>,
  ids: Vec<Uuid>,
) -> Result<(), IpcError> {
  let history = state.history.clone();
  let deleted = run_blocking("delete_translation_history", move || history.delete_many(ids)).await?;
  if deleted > 0 {
    emit_data_changed(&app, TRANSLATION_HISTORY_CHANGED);
  }
  Ok(())
}

/// Clear the entire history table. Emits history-changed on success.
#[tauri::command]
pub async fn delete_all_translation_history(app: AppHandle, state: State<'_, AppState>) -> Result<(), IpcError> {
  let history = state.history.clone();
  let deleted = run_blocking("delete_all_translation_history", move || history.delete_all()).await?;
  if deleted > 0 {
    emit_data_changed(&app, TRANSLATION_HISTORY_CHANGED);
  }
  Ok(())
}
