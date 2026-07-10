// ABOUTME: Provider model CRUD and async connection/sync Tauri commands.
// ABOUTME: Returns sanitized DTOs; secrets never cross the IPC boundary.
use crate::cmds::runtime::run_blocking;
use crate::domain::model::{ConnectionTestResult, ManualModelWrite, ProviderModelDto, SyncModelsResult};
use crate::error::IpcError;
use crate::state::AppState;
use tauri::State;
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
