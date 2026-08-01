// ABOUTME: Sanitized OCR service CRUD and image recognition Tauri commands.
// ABOUTME: Dispatches blocking storage work and maps failures to IpcError.
use crate::cmds::runtime::run_blocking;
use crate::domain::ocr_service::{OcrRecognizeInput, OcrRecognizeResult, OcrServiceDto, OcrServiceWrite};
use crate::domain::service_capability::validate_capability_request_id;
use crate::error::IpcError;
use crate::events::{OCR_SERVICES_CHANGED, SERVICE_INTEGRATIONS_CHANGED, emit_data_changed};
use crate::state::AppState;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn list_ocr_services(state: State<'_, AppState>) -> Result<Vec<OcrServiceDto>, IpcError> {
  let services = state.ocr_services.clone();
  run_blocking("list_ocr_services", move || services.list()).await
}

#[tauri::command]
pub async fn get_ocr_service(state: State<'_, AppState>, id: Uuid) -> Result<OcrServiceDto, IpcError> {
  let services = state.ocr_services.clone();
  run_blocking("get_ocr_service", move || services.get(id)).await
}

#[tauri::command]
pub async fn save_ocr_service(
  app: AppHandle,
  state: State<'_, AppState>,
  input: OcrServiceWrite,
) -> Result<OcrServiceDto, IpcError> {
  let services = state.ocr_services.clone();
  let result = run_blocking("save_ocr_service", move || services.save(input)).await?;
  emit_data_changed(&app, OCR_SERVICES_CHANGED);
  Ok(result)
}

#[tauri::command]
pub async fn delete_ocr_service(app: AppHandle, state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
  let services = state.ocr_services.clone();
  run_blocking("delete_ocr_service", move || services.delete(id)).await?;
  emit_data_changed(&app, OCR_SERVICES_CHANGED);
  Ok(())
}

/// Recognize text from a PNG image using the configured (or default) OCR service.
/// When `request_id` is set, registers a cancel token on the shared session registry.
#[tauri::command]
pub async fn recognize_ocr(
  app: AppHandle,
  state: State<'_, AppState>,
  input: OcrRecognizeInput,
) -> Result<OcrRecognizeResult, IpcError> {
  let services = state.ocr_services.clone();
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
  let result = services.recognize(input, cancel).await.map_err(IpcError::from);
  emit_data_changed(&app, SERVICE_INTEGRATIONS_CHANGED);
  if let Some(ref rid) = request_id {
    sessions.end(rid);
  }
  result
}
