// ABOUTME: Provider model CRUD, connection/sync, and translate Tauri commands.
// ABOUTME: Returns sanitized DTOs; secrets never cross the IPC boundary.
use crate::cmds::runtime::run_blocking;
use crate::domain::model::{ConnectionTestResult, ManualModelWrite, ProviderModelDto, SyncModelsResult};
use crate::domain::translation::{
	TranslateInput, TranslateResult, TranslateStreamError, TRANSLATE_ERROR_EVENT,
};
use crate::error::IpcError;
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

	let request_id = request_id
		.map(|id| id.trim().to_string())
		.filter(|id| !id.is_empty());
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

#[tauri::command]
pub async fn save_manual_model(
	state: State<'_, AppState>,
	input: ManualModelWrite,
) -> Result<ProviderModelDto, IpcError> {
	let models = state.models.clone();
	run_blocking("save_manual_model", move || models.save_manual(input)).await
}

#[tauri::command]
pub async fn set_model_enabled(
	state: State<'_, AppState>,
	id: Uuid,
	enabled: bool,
) -> Result<ProviderModelDto, IpcError> {
	let models = state.models.clone();
	run_blocking("set_model_enabled", move || models.set_enabled(id, enabled)).await
}

#[tauri::command]
pub async fn delete_provider_model(state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
	let models = state.models.clone();
	run_blocking("delete_provider_model", move || models.delete(id)).await
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
	state: State<'_, AppState>,
	provider_instance_id: Uuid,
) -> Result<SyncModelsResult, IpcError> {
	let models = state.models.clone();
	models.sync_models(provider_instance_id).await.map_err(IpcError::from)
}
