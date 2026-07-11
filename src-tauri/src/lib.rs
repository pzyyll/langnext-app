// ABOUTME: Tauri application library: registers plugins, windows, tray, and IPC commands.
// ABOUTME: Initializes storage AppState before creating windows.
// Public service/repository helpers are part of the storage surface; lib-only builds
// do not always see IPC/test call sites as live uses, so dead_code is allowed here.
#![allow(dead_code)]
use tauri::{Manager, Runtime};

mod adapters;
mod cmds;
mod consts;
mod credentials;
mod device_state;
mod domain;
mod error;
mod panic;
mod repositories;
mod services;
mod state;
mod storage;
mod windows;

use state::AppState;

fn app_setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
	let app_data_dir = app
		.path()
		.app_data_dir()
		.map_err(|e| format!("resolve app data dir: {e}"))?;

	let state = AppState::initialize(app_data_dir).map_err(|e| format!("storage initialization failed: {e}"))?;

	// Device state is needed by window setup for geometry restore.
	app.manage(state);
	windows::setup(app.handle());
	Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	panic::install_panic_hook();
	tauri::Builder::default()
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![
			cmds::greet,
			cmds::snap::show_snap_overlay,
			cmds::providers::list_provider_instances,
			cmds::providers::save_provider_instance,
			cmds::providers::set_provider_enabled,
			cmds::providers::delete_provider_instance,
			cmds::providers::reorder_provider_instances,
			cmds::models::list_provider_models,
			cmds::models::save_manual_model,
			cmds::models::set_model_enabled,
			cmds::models::delete_provider_model,
			cmds::models::test_provider_connection,
			cmds::models::sync_provider_models,
			cmds::translation_profiles::list_translation_profiles,
			cmds::translation_profiles::get_translation_profile,
			cmds::translation_profiles::save_translation_profile,
			cmds::translation_profiles::set_translation_profile_enabled,
			cmds::translation_profiles::delete_translation_profile,
			cmds::settings::get_app_settings,
			cmds::settings::update_app_settings,
			cmds::settings::set_app_theme,
			cmds::settings::set_app_ui_language,
			cmds::import_export::export_configuration,
			cmds::import_export::preview_configuration_import,
			cmds::import_export::import_configuration,
		])
		.setup(app_setup)
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
