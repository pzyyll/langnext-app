// ABOUTME: Provider model CRUD, connection/sync, and translate Tauri commands.
// ABOUTME: Returns sanitized DTOs; secrets never cross the IPC boundary.
use crate::cmds::runtime::run_blocking;
use crate::domain::language_detection::{DetectLanguageInput, DetectLanguageResult};
use crate::domain::model::{
  ConnectionTestResult, ManualModelWrite, ModelConfigWrite, ProviderModelDto, SyncModelsResult,
};
use crate::domain::translation::{TranslateInput, TranslateResult, TranslateStreamError, TRANSLATE_ERROR_EVENT};
use crate::error::IpcError;
use crate::events::{emit_data_changed, MODELS_CHANGED, PROVIDERS_CHANGED};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, State};
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

/// Non-streaming translate. Optional `request_id` enables mid-flight cancel via `cancel_translate`.
#[tauri::command]
pub async fn translate_text(
  state: State<'_, AppState>,
  input: TranslateInput,
  request_id: Option<String>,
) -> Result<TranslateResult, IpcError> {
  let models = state.models.clone();
  let sessions = state.translate_sessions.clone();

  let request_id = request_id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
  if let Some(ref id) = request_id {
    if id.len() > 128 {
      return Err(IpcError::new(
        "validation_failed",
        "request_id must be at most 128 characters",
      ));
    }
  }

  let token = request_id.as_ref().map(|id| sessions.begin(id));
  let result = models.translate(input, token.as_ref()).await.map_err(IpcError::from);
  if let Some(id) = request_id.as_ref() {
    sessions.end(id);
  }
  result
}

/// Start a streaming translation. Progress arrives via events:
/// `translate://chunk`, `translate://reset`, `translate://done`, and `translate://error`.
///
/// The WebView generates `request_id` and registers listeners *before* invoking this
/// command so early validation failures cannot race past the active-id assignment.
#[tauri::command]
pub async fn translate_text_stream(
  app: AppHandle,
  state: State<'_, AppState>,
  input: TranslateInput,
  request_id: String,
) -> Result<(), IpcError> {
  let request_id = request_id.trim().to_string();
  if request_id.is_empty() || request_id.len() > 128 {
    return Err(IpcError::new(
      "validation_failed",
      "request_id must be a non-empty id up to 128 characters",
    ));
  }
  let models = state.models.clone();
  let sessions = state.translate_sessions.clone();
  let id_for_task = request_id.clone();
  let app_for_task = app.clone();

  // Register cancel token before the invoke returns so cancel_translate can race safely.
  let token = sessions.begin(&request_id);

  // Detach so the invoke returns after listeners are already keyed to request_id.
  tauri::async_runtime::spawn(async move {
    let result = models
      .translate_stream(app_for_task.clone(), id_for_task.clone(), input, Some(&token))
      .await;
    sessions.end(&id_for_task);
    if let Err(err) = result {
      let ipc = IpcError::from(err);
      let _ = app_for_task.emit(
        TRANSLATE_ERROR_EVENT,
        TranslateStreamError {
          id: id_for_task,
          error_code: ipc.code,
          message: ipc.message,
          latency_ms: 0,
        },
      );
    }
  });

  Ok(())
}

/// Abort an in-flight translate (stream or non-stream) identified by `request_id`.
///
/// Returns `cancelled: true` when a session was found. Unknown ids are a no-op success
/// (the request may have already finished).
#[tauri::command]
pub async fn cancel_translate(state: State<'_, AppState>, request_id: String) -> Result<bool, IpcError> {
  let request_id = request_id.trim().to_string();
  if request_id.is_empty() || request_id.len() > 128 {
    return Err(IpcError::new(
      "validation_failed",
      "request_id must be a non-empty id up to 128 characters",
    ));
  }
  Ok(state.translate_sessions.cancel(&request_id))
}

/// Detect the language of `input.text` via a non-streaming chat completion. Optional `request_id`
/// enables mid-flight cancel via `cancel_translate` (same session registry as translate).
#[tauri::command]
pub async fn detect_language(
  state: State<'_, AppState>,
  input: DetectLanguageInput,
  request_id: Option<String>,
) -> Result<DetectLanguageResult, IpcError> {
  let models = state.models.clone();
  let sessions = state.translate_sessions.clone();

  let request_id = request_id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
  if let Some(ref id) = request_id {
    if id.len() > 128 {
      return Err(IpcError::new(
        "validation_failed",
        "request_id must be at most 128 characters",
      ));
    }
  }

  let token = request_id.as_ref().map(|id| sessions.begin(id));
  let result = models
    .detect_language(input, token.as_ref())
    .await
    .map_err(IpcError::from);
  if let Some(id) = request_id.as_ref() {
    sessions.end(id);
  }
  result
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
  Ok(())
}

/// Bulk-delete models in a single SQLite transaction. Emits MODELS_CHANGED once on success.
/// Empty lists are a no-op success and do not emit.
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
  }
  Ok(())
}

#[tauri::command]
pub async fn test_provider_connection(
  state: State<'_, AppState>,
  provider_instance_id: Uuid,
) -> Result<ConnectionTestResult, IpcError> {
  // Service moves SQLite/vault work off the async worker; do not wrap in run_blocking.
  let models = state.models.clone();
  models
    .test_connection(provider_instance_id)
    .await
    .map_err(IpcError::from)
}

#[tauri::command]
pub async fn sync_provider_models(
  app: AppHandle,
  state: State<'_, AppState>,
  provider_instance_id: Uuid,
) -> Result<SyncModelsResult, IpcError> {
  let models = state.models.clone();
  let result = models.sync_models(provider_instance_id).await.map_err(IpcError::from)?;
  // Only broadcast after a successful remote merge; soft failures leave models unchanged.
  // Provider sync status fields also change, so notify provider consumers as well.
  if result.ok {
    emit_data_changed(&app, MODELS_CHANGED);
    emit_data_changed(&app, PROVIDERS_CHANGED);
  }
  Ok(result)
}
