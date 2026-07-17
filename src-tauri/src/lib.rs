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
mod events;
mod logging;
mod panic;
mod repositories;
mod services;
mod state;
mod storage;
mod windows;

use state::AppState;

fn app_setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
	// Plugin setup has already installed the global logger before this hook runs.
	logging::log_startup();

	let app_data_dir = app
		.path()
		.app_data_dir()
		.map_err(|e| format!("resolve app data dir: {e}"))?;

	let state = AppState::initialize(app_data_dir).map_err(|e| format!("storage initialization failed: {e}"))?;

	// Device state is needed by window setup for geometry restore.
	app.manage(state);
	app.manage(windows::quick_translate::QuickTranslateState::default());
	windows::setup(app.handle());
	log::info!("app_setup_complete windows_and_tray_ready");

	// Global hotkey opens the always-on-top Quick Translate window.
	// Registration failure (e.g. conflict with another app) must not block startup; tray still works.
	#[cfg(desktop)]
	{
		use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

		match tauri_plugin_global_shortcut::Builder::new().with_shortcuts(["ctrl+shift+t"]) {
			Ok(builder) => {
				if let Err(err) = app.handle().plugin(
					builder
						.with_handler(|app, shortcut, event| {
							if event.state == ShortcutState::Pressed
								&& shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyT)
							{
								if let Err(e) = windows::quick_translate::show(app) {
									log::error!("quick_translate_show_failed error={e}");
								}
							}
						})
						.build(),
				) {
					log::error!("global_shortcut_plugin_failed error={err}");
				}
			}
			Err(err) => {
				log::error!("global_shortcut_register_failed error={err}");
			}
		}
	}

	// Double Ctrl+C opens Quick Translate (Windows only via kmhook).
	// Uses a non-consuming raw-input path so a single Ctrl+C still copies.
	// Registration or startup failure must not block app startup.
	#[cfg(windows)]
	{
		use kmhook::enginer as kmhook_enginer;

		// trigger count = 2; interval in ms (kmhook default is 400).
		let app_handle = app.handle().clone();
		match kmhook_enginer::add_global_shortcut_trigger(
			"Ctrl+C",
			move || {
				windows::quick_translate::try_show_on_cpcp(&app_handle);
			},
			2,
			Some(400),
		) {
			Ok(_) => {
				// startup returns Option<JoinHandle<()>>, not Result; dropping detaches the worker.
				if kmhook_enginer::startup(Some(true)).is_none() {
					log::warn!("kmhook_startup_no_worker_thread");
				}
			}
			Err(err) => {
				log::error!("kmhook_double_ctrl_c_register_failed error={err}");
			}
		}
	}

	Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	// Panic hook uses eprintln! as a bootstrap fallback; release also logs a fixed panic_event.
	panic::install_panic_hook();
	// Install logging as early as possible so subsequent plugin/setup work is captured.
	// Logger is not active until this plugin's setup runs; pre-plugin failures stay on stderr.
	tauri::Builder::default()
		.plugin(logging::plugin())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_clipboard_manager::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_fs::init())
		.invoke_handler(tauri::generate_handler![
			cmds::snap::show_snap_overlay,
			windows::quick_translate::set_pin,
			windows::quick_translate::resize_window_height,
			cmds::providers::list_provider_instances,
			cmds::providers::save_provider_instance,
			cmds::providers::set_provider_enabled,
			cmds::providers::delete_provider_instance,
			cmds::providers::reorder_provider_instances,
			cmds::models::list_provider_models,
			cmds::models::list_all_provider_models,
			cmds::models::save_manual_model,
			cmds::models::set_model_enabled,
			cmds::models::set_model_adapter_id,
			cmds::models::update_model_config,
			cmds::models::delete_provider_model,
			cmds::models::delete_provider_models,
			cmds::models::test_provider_connection,
			cmds::models::sync_provider_models,
			cmds::models::translate_text,
			cmds::models::translate_text_stream,
			cmds::models::cancel_translate,
			cmds::models::detect_language,
			cmds::translation_profiles::list_translation_profiles,
			cmds::translation_profiles::get_translation_profile,
			cmds::translation_profiles::save_translation_profile,
			cmds::translation_profiles::set_translation_profile_enabled,
			cmds::translation_profiles::delete_translation_profile,
			cmds::translation_history::list_translation_history,
			cmds::translation_history::get_translation_history,
			cmds::translation_history::get_translation_history_many,
			cmds::translation_history::list_translation_history_model_facets,
			cmds::translation_history::delete_translation_history,
			cmds::translation_history::delete_all_translation_history,
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
