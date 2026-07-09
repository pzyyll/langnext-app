// ABOUTME: System tray icon setup for the desktop application.
// ABOUTME: Left-click shows the main window; tray menu offers Exit.
use crate::consts;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Runtime;

pub fn setup<R: Runtime>(app: &tauri::AppHandle<R>) {
	let tray_icon = app
		.tray_by_id(consts::TRAY_ID)
		.expect("tray not found; check tauri.conf.json trayIcon.id");
	let _ = tray_icon.set_tooltip(Some(consts::APP_NAME));

	let menu = MenuBuilder::new(app)
		.item(
			&MenuItemBuilder::with_id("exit", "Exit")
				.build(app)
				.expect("failed to build exit menu item"),
		)
		.build()
		.expect("failed to build tray menu");

	let _ = tray_icon.set_menu(Some(menu));
	tray_icon.on_menu_event(|app, event| {
		if event.id.as_ref() == "exit" {
			app.exit(0);
		}
	});

	tray_icon.on_tray_icon_event(|tray_icon, event: tauri::tray::TrayIconEvent| {
		match event {
			tauri::tray::TrayIconEvent::Click {
				button,
				button_state,
				..
			} => {
				if button == tauri::tray::MouseButton::Left
					&& button_state == tauri::tray::MouseButtonState::Up
				{
					println!("Tray left click");
					crate::windows::main::show(tray_icon.app_handle());
				}
			}
			_ => {}
		}
	});
}
