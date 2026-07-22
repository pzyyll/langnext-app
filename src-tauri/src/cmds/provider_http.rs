// ABOUTME: Tauri commands for generic provider HTTP request, stream, and cancel.
// ABOUTME: Channel events carry raw response bytes only; secrets never cross IPC.
use crate::domain::provider_http::{ProviderHttpRequest, ProviderHttpResponse, ProviderHttpStreamEvent};
use crate::error::IpcError;
use crate::state::AppState;
use tauri::State;
use tauri::ipc::Channel;

#[tauri::command]
pub async fn provider_http_request(
  state: State<'_, AppState>,
  input: ProviderHttpRequest,
) -> Result<ProviderHttpResponse, IpcError> {
  let service = state.provider_http.clone();
  let sessions = state.request_sessions.clone();
  let request_id = input.request_id.clone();
  let token = sessions.begin(&request_id);
  let result = service.request(input, Some(&token)).await.map_err(IpcError::from);
  sessions.end(&request_id);
  result
}

#[tauri::command]
pub async fn provider_http_stream(
  state: State<'_, AppState>,
  input: ProviderHttpRequest,
  on_event: Channel<ProviderHttpStreamEvent>,
) -> Result<(), IpcError> {
  let service = state.provider_http.clone();
  let sessions = state.request_sessions.clone();
  let request_id = input.request_id.clone();
  let token = sessions.begin(&request_id);
  let cancel = token.clone();
  let result = service
    .stream(
      input,
      cancel,
      Box::new(move |event| {
        on_event
          .send(event)
          .map_err(|_| crate::error::StorageError::Validation("stream consumer disconnected".into()))
      }),
    )
    .await
    .map_err(IpcError::from);
  sessions.end(&request_id);
  result
}

#[tauri::command]
pub async fn cancel_provider_http(state: State<'_, AppState>, request_id: String) -> Result<bool, IpcError> {
  let request_id = request_id.trim().to_string();
  if request_id.is_empty() {
    return Ok(false);
  }
  Ok(state.request_sessions.cancel(&request_id))
}
