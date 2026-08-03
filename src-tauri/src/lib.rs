// ABOUTME: Tauri application library: registers plugins, windows, tray, and IPC commands.
// ABOUTME: Initializes storage AppState before creating windows.
// Public service/repository helpers are part of the storage surface; lib-only builds
// do not always see IPC/test call sites as live uses, so dead_code is allowed here.
#![allow(dead_code)]
use tauri::{Manager, Runtime};

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
pub mod services;
mod shortcuts;
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

  let resource_dir = app
    .path()
    .resource_dir()
    .map_err(|e| format!("resolve resource dir: {e}"))?;

  let state = AppState::initialize(app_data_dir, Some(resource_dir))
    .map_err(|e| format!("storage initialization failed: {e}"))?;
  let initial_shortcuts = state
    .settings
    .get()
    .map(|dto| dto.settings.shortcuts)
    .unwrap_or_default();

  // Device state is needed by window setup for geometry restore.
  app.manage(state);
  app.manage(windows::quick_translate::QuickTranslateState::default());
  app.manage(windows::screenshot::RegionScreenshotState::default());
  app.manage(shortcuts::ShortcutRuntime::new());
  windows::setup(app.handle());
  log::info!("app_setup_complete windows_and_tray_ready");

  // Global shortcut plugin (bindings applied from settings below).
  // Plugin install failure must not block startup; tray still works.
  #[cfg(desktop)]
  {
    if let Err(err) = app
      .handle()
      .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    {
      log::error!("global_shortcut_plugin_failed error={err}");
    }
  }

  // Double Ctrl+C opens Quick Translate (Windows only via kmhook).
  // Uses a non-consuming raw-input path so a single Ctrl+C still copies.
  // Registration or startup failure must not block app startup.
  #[cfg(windows)]
  {
    shortcuts::register_double_ctrl_c(app.handle());
  }

  // Apply persisted (or default) shortcut settings after plugin + kmhook are ready.
  if let Some(runtime) = app.try_state::<shortcuts::ShortcutRuntime>() {
    if let Err(err) = runtime.apply(app.handle(), &initial_shortcuts) {
      log::error!("shortcut_apply_at_startup_failed error={err}");
    }
  }

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Panic hook uses eprintln! as a bootstrap fallback; release also logs a fixed panic_event.
  panic::install_panic_hook();

  let mut builder = tauri::Builder::default();

  // Single-instance must register first so a second .exe exits before other plugins/setup run.
  // Callback runs in the existing process: show/focus main (including when hidden to tray).
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      log::info!("single_instance_focus_existing");
      windows::main::show(app);
    }));
  }

  // Install logging as early as possible so subsequent plugin/setup work is captured.
  // Logger is not active until this plugin's setup runs; pre-plugin failures stay on stderr.
  builder
    .plugin(logging::plugin())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      cmds::snap::show_snap_overlay,
      windows::quick_translate::set_pin,
      windows::quick_translate::resize_window_height,
      windows::quick_translate::notify_ready,
      windows::screenshot::region_screenshot_get_backdrop,
      windows::screenshot::region_screenshot_get_backdrop_data,
      windows::screenshot::region_screenshot_reveal,
      windows::screenshot::region_screenshot_confirm,
      windows::screenshot::region_screenshot_cancel,
      windows::screenshot::start_region_screenshot,
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
      cmds::models::apply_provider_model_sync,
      cmds::models::apply_provider_model_sync_failure,
      cmds::provider_http::provider_http_request,
      cmds::provider_http::provider_http_stream,
      cmds::provider_http::cancel_provider_http,
      cmds::translation_profiles::list_translation_profiles,
      cmds::translation_profiles::get_translation_profile,
      cmds::translation_profiles::save_translation_profile,
      cmds::translation_profiles::set_translation_profile_enabled,
      cmds::translation_profiles::delete_translation_profile,
      cmds::service_translation::translate_service_profile,
      cmds::service_translation::detect_service_profile_language,
      cmds::ocr_services::list_ocr_services,
      cmds::ocr_services::get_ocr_service,
      cmds::ocr_services::save_ocr_service,
      cmds::ocr_services::delete_ocr_service,
      cmds::ocr_services::recognize_ocr,
      cmds::speech_services::list_speech_services,
      cmds::speech_services::get_speech_service,
      cmds::speech_services::save_speech_service,
      cmds::speech_services::delete_speech_service,
      cmds::speech_services::synthesize_speech,
      cmds::speech_services::cancel_speech_synthesis,
      cmds::plugin_packages::preview_plugin_package,
      cmds::plugin_packages::approve_plugin_package,
      cmds::plugin_packages::discard_plugin_package_preview,
      cmds::plugin_packages::list_installed_plugin_versions,
      cmds::plugin_packages::set_default_plugin_package,
      cmds::plugin_packages::list_plugin_publishers,
      cmds::plugin_packages::approve_user_plugin_publisher,
      cmds::plugin_packages::revoke_plugin_publisher,
      cmds::plugin_packages::restore_plugin_publisher,
      cmds::plugin_packages::remove_plugin_publisher,
      cmds::plugin_packages::uninstall_plugin_version,
      cmds::plugin_packages::get_plugin_version_dependencies,
      cmds::runtime_lifecycle::preview_integration_runtime_upgrade,
      cmds::runtime_lifecycle::apply_integration_runtime_upgrade,
      cmds::runtime_lifecycle::preview_integration_runtime_rollback,
      cmds::runtime_lifecycle::apply_integration_runtime_rollback,
      cmds::runtime_lifecycle::discard_integration_runtime_snapshot,
      cmds::runtime_providers::list_runtime_provider_catalog,
      cmds::runtime_providers::preview_provider_runtime_upgrade,
      cmds::runtime_providers::apply_provider_runtime_upgrade,
      cmds::runtime_providers::preview_provider_runtime_rollback,
      cmds::runtime_providers::apply_provider_runtime_rollback,
      cmds::runtime_providers::preview_provider_runtime_interface_attach,
      cmds::runtime_providers::apply_provider_runtime_interface_attach,
      cmds::runtime_providers::preview_provider_runtime_interface_rollback,
      cmds::runtime_providers::apply_provider_runtime_interface_rollback,
      cmds::runtime_providers::detach_provider_runtime_interface,
      cmds::runtime_providers::list_provider_runtime_snapshots,
      cmds::runtime_providers::discard_provider_runtime_snapshot,
      cmds::runtime_providers::provider_runtime_models_list,
      cmds::runtime_providers::provider_runtime_chat,
      cmds::runtime_providers::cancel_provider_runtime,
      cmds::service_integrations::list_service_integration_definitions,
      cmds::service_integrations::list_integration_instances,
      cmds::service_integrations::get_integration_instance,
      cmds::service_integrations::preview_integration_endpoint_trust,
      cmds::service_integrations::save_integration_instance,
      cmds::service_integrations::set_integration_instance_enabled,
      cmds::service_integrations::list_integration_instance_dependencies,
      cmds::service_integrations::delete_integration_instance,
      cmds::service_integrations::validate_integration_instance,
      cmds::translation_history::record_translation_history_completion,
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
      cmds::settings::set_app_shortcuts,
      cmds::settings::set_app_default_ocr_service,
      cmds::settings::set_app_default_speech_service,
      cmds::import_export::export_configuration,
      cmds::import_export::preview_configuration_import,
      cmds::import_export::import_configuration,
    ])
    .setup(app_setup)
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
