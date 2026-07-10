// ABOUTME: Sanitized Provider CRUD Tauri commands.
// ABOUTME: Dispatches blocking storage work and maps failures to IpcError.
use crate::cmds::runtime::run_blocking;
use crate::domain::provider::{ProviderInstanceDto, ProviderInstanceWrite};
use crate::error::IpcError;
use crate::state::AppState;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub async fn list_provider_instances(state: State<'_, AppState>) -> Result<Vec<ProviderInstanceDto>, IpcError> {
	let providers = state.providers.clone();
	run_blocking("list_provider_instances", move || providers.list()).await
}

#[tauri::command]
pub async fn save_provider_instance(
	state: State<'_, AppState>,
	input: ProviderInstanceWrite,
) -> Result<ProviderInstanceDto, IpcError> {
	let providers = state.providers.clone();
	run_blocking("save_provider_instance", move || providers.save(input)).await
}

#[tauri::command]
pub async fn set_provider_enabled(
	state: State<'_, AppState>,
	id: Uuid,
	enabled: bool,
) -> Result<ProviderInstanceDto, IpcError> {
	let providers = state.providers.clone();
	run_blocking("set_provider_enabled", move || providers.set_enabled(id, enabled)).await
}

#[tauri::command]
pub async fn delete_provider_instance(state: State<'_, AppState>, id: Uuid) -> Result<(), IpcError> {
	let providers = state.providers.clone();
	run_blocking("delete_provider_instance", move || providers.delete(id)).await
}
