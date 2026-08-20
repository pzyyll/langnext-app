// ABOUTME: Trusted-app IPC for Phase 12 legacy runtime retirement inventory.
// ABOUTME: Read-only; never mutates rows, grants, or defaults.
use crate::cmds::runtime::run_blocking;
use crate::domain::legacy_runtime_inventory::LegacyRuntimeInventoryDto;
use crate::error::IpcError;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_legacy_runtime_inventory(state: State<'_, AppState>) -> Result<LegacyRuntimeInventoryDto, IpcError> {
  let services = state.legacy_runtime_inventory.clone();
  run_blocking("list_legacy_runtime_inventory", move || services.list_inventory()).await
}
