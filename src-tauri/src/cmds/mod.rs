// ABOUTME: IPC command handlers registered with the Tauri invoke system.
// ABOUTME: Includes greet demo and Windows Snap Layout overlay trigger.
pub mod snap;

/// Demo command used by the home page greeting form.
#[tauri::command]
pub fn greet(name: &str) -> String {
	format!("Hello, {}! You've been greeted from Rust!", name)
}
