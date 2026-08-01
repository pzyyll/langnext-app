// ABOUTME: Sanitized Speech service CRUD and binary TTS synthesis Tauri commands.
// ABOUTME: Successful synthesis returns raw MP3 bytes via tauri::ipc::Response.
use crate::cmds::runtime::run_blocking;
use crate::domain::service_capability::validate_capability_request_id;
use crate::domain::speech_service::{SpeechServiceDto, SpeechServiceWrite, SpeechSynthesizeInput};
use crate::error::IpcError;
use crate::events::{SERVICE_INTEGRATIONS_CHANGED, SPEECH_SERVICES_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::ipc::Response;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_speech_services(state: State<'_, AppState>) -> Result<Vec<SpeechServiceDto>, IpcError> {
  let services = state.speech_services.clone();
  run_blocking("list_speech_services", move || services.list()).await
}

#[tauri::command]
pub async fn get_speech_service(state: State<'_, AppState>, id: Uuid) -> Result<SpeechServiceDto, IpcError> {
  let services = state.speech_services.clone();
  run_blocking("get_speech_service", move || services.get(id)).await
}

#[tauri::command]
pub async fn save_speech_service(
  app: AppHandle,
  state: State<'_, AppState>,
  input: SpeechServiceWrite,
) -> Result<SpeechServiceDto, IpcError> {
  let services = state.speech_services.clone();
  let result = run_blocking("save_speech_service", move || services.save(input)).await?;
  emit_data_changed(&app, SPEECH_SERVICES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn delete_speech_service(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let services = state.speech_services.clone();
  run_blocking("delete_speech_service", move || services.delete(id)).await?;
  emit_data_changed(&app, SPEECH_SERVICES_CHANGED);
  // Default Speech selection may have been cleared transactionally.
  emit_data_changed(&app, crate::events::APP_SETTINGS_CHANGED);
  Ok(())
}

/// Synthesize speech to bounded MP3 bytes. Returns raw binary on success.
#[tauri::command]
pub async fn synthesize_speech(
  app: AppHandle,
  state: State<'_, AppState>,
  input: SpeechSynthesizeInput,
) -> Result<Response, IpcError> {
  let services = state.speech_services.clone();
  let sessions = state.request_sessions.clone();
  let request_id = input.request_id.clone();
  let cancel = if let Some(ref rid) = request_id {
    if let Err(err) = validate_capability_request_id(rid) {
      return Err(IpcError::from(crate::error::StorageError::Validation(err.message)));
    }
    sessions.begin(rid)
  } else {
    crate::domain::cancel::CancelToken::new()
  };
  let result = services.synthesize(input, cancel).await.map_err(IpcError::from);
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  if let Some(ref rid) = request_id {
    sessions.end(rid);
  }
  let bytes = result?;
  Ok(Response::new(bytes))
}

/// Cancel an in-flight speech synthesis request by client request id.
#[tauri::command]
pub async fn cancel_speech_synthesis(state: State<'_, AppState>, request_id: String) -> Result<bool, IpcError> {
  let request_id = request_id.trim().to_string();
  if request_id.is_empty() {
    return Err(IpcError::from(crate::error::StorageError::Validation(
      "request_id must not be empty".into(),
    )));
  }
  if let Err(err) = validate_capability_request_id(&request_id) {
    return Err(IpcError::from(crate::error::StorageError::Validation(err.message)));
  }
  Ok(state.request_sessions.cancel(&request_id))
}
