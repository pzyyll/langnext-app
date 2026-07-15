// ABOUTME: Window and tray module entry for the Tauri shell.
// ABOUTME: Creates the main window in code and wires the system tray.
use tauri::Runtime;

pub mod main;
pub mod quick_translate;
pub mod tray;

pub fn setup<R: Runtime>(app: &tauri::AppHandle<R>) {
	main::show(app);
	tray::setup(app);
}
