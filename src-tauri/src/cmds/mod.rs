// ABOUTME: IPC command handlers registered with the Tauri invoke system.
// ABOUTME: Includes greet demo, snap overlay, and storage subsystem commands.
pub mod import_export;
pub mod models;
pub mod providers;
pub mod runtime;
pub mod settings;
pub mod snap;
pub mod translation_profiles;

/// Demo command used by the home page greeting form.
#[tauri::command]
pub fn greet(name: &str) -> String {
	format!("Hello, {}! You've been greeted from Rust!", name)
}
