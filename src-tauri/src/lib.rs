// ABOUTME: Tauri application library: registers plugins, windows, tray, and IPC commands.
// ABOUTME: Creates the main window in code and wires system tray interactions.
use tauri::Runtime;

mod cmds;
mod consts;
mod windows;

fn app_setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
	windows::setup(app.handle());
	Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![
			cmds::greet,
			cmds::snap::show_snap_overlay
		])
		.setup(app_setup)
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
