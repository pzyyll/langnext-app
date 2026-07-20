// ABOUTME: System tray icon setup for the desktop application.
// ABOUTME: Left-click shows the main window; menu opens tools or exits.
use crate::consts;
use crate::state::AppState;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{Manager, Runtime};

pub fn setup<R: Runtime>(app: &tauri::AppHandle<R>) {
  let tray_icon = app
    .tray_by_id(consts::TRAY_ID)
    .expect("tray not found; check tauri.conf.json trayIcon.id");
  let _ = tray_icon.set_tooltip(Some(consts::APP_NAME));

  let menu = MenuBuilder::new(app)
    .item(
      &MenuItemBuilder::with_id("quick_translate", "Quick Translate")
        .build(app)
        .expect("failed to build quick translate menu item"),
    )
    .item(
      &MenuItemBuilder::with_id("region_screenshot", "Screenshot")
        .build(app)
        .expect("failed to build screenshot menu item"),
    )
    .item(
      &MenuItemBuilder::with_id("exit", "Exit")
        .build(app)
        .expect("failed to build exit menu item"),
    )
    .build()
    .expect("failed to build tray menu");

  let _ = tray_icon.set_menu(Some(menu));
  tray_icon.on_menu_event(|app, event| match event.id.as_ref() {
    "quick_translate" => {
      if let Err(e) = crate::windows::quick_translate::show(app) {
        log::error!("quick_translate_show_failed error={e}");
      }
    }
    "region_screenshot" => {
      if let Err(e) = crate::windows::screenshot::start(app) {
        log::error!("region_screenshot_start_failed error={e}");
      }
    }
    "exit" => {
      if let Some(state) = app.try_state::<AppState>() {
        if let Err(e) = state.device_state.flush() {
          // Preserve previous durable state; do not silently discard the error.
          log::error!("device_state_final_flush_failed error={}", e);
        }
      }
      app.exit(0);
    }
    _ => {}
  });

  tray_icon.on_tray_icon_event(|tray_icon, event: tauri::tray::TrayIconEvent| {
    if let tauri::tray::TrayIconEvent::Click {
      button, button_state, ..
    } = event
    {
      if button == tauri::tray::MouseButton::Left && button_state == tauri::tray::MouseButtonState::Up {
        log::debug!("tray_left_click");
        crate::windows::main::show(tray_icon.app_handle());
      }
    }
  });
}
