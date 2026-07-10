// ABOUTME: Configuration export/preview/import Tauri commands.
// ABOUTME: Uses structured DTOs or JSON strings, never arbitrary filesystem paths.
use crate::cmds::runtime::run_blocking;
use crate::domain::import_export::{ConfigurationExport, ImportConflictMode, ImportPreview, ImportResult};
use crate::error::IpcError;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn export_configuration(state: State<'_, AppState>) -> Result<ConfigurationExport, IpcError> {
	let service = state.import_export.clone();
	run_blocking("export_configuration", move || service.export()).await
}

#[tauri::command]
pub async fn preview_configuration_import(
	state: State<'_, AppState>,
	document: ConfigurationExport,
	mode: ImportConflictMode,
) -> Result<ImportPreview, IpcError> {
	let service = state.import_export.clone();
	run_blocking("preview_configuration_import", move || service.preview(&document, mode)).await
}

#[tauri::command]
pub async fn import_configuration(
	state: State<'_, AppState>,
	document: ConfigurationExport,
	mode: ImportConflictMode,
) -> Result<ImportResult, IpcError> {
	let service = state.import_export.clone();
	run_blocking("import_configuration", move || service.import(document, mode)).await
}
