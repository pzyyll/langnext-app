// ABOUTME: Main application window builder for the desktop shell.
// ABOUTME: Creates a frameless window; React owns the custom titlebar controls.
use crate::consts;
use tauri::{Manager, Runtime, WebviewWindowBuilder};

#[allow(unused)]
pub fn show<R: Runtime>(app: &tauri::AppHandle<R>) {
	match app.get_webview_window(consts::WIN_LABEL_MAIN) {
		Some(win) => {
			win.show().expect("failed to show window");
			if win.is_minimized().unwrap_or(false) {
				win.unminimize().expect("failed to unminimize window");
			}
			let _ = win.set_focus();
		}
		None => {
			let url = tauri::WebviewUrl::App("/".into());
			println!("Creating main window with URL: {:?}", url.to_string());

			let mut web_build = WebviewWindowBuilder::new(app, consts::WIN_LABEL_MAIN, url);

			#[cfg(windows)]
			{
				// Frameless on Windows so the React titlebar owns chrome.
				// Do not call decorum create_overlay_titlebar here: it injects a
				// fixed full-width drag layer that blocks custom React buttons
				// unless withGlobalTauri + decorum-owned controls are used.
				web_build = web_build.decorations(false);
			}

			let _win = web_build
				.resizable(true)
				.fullscreen(false)
				.title(consts::APP_NAME)
				.inner_size(800.0, 600.0)
				.min_inner_size(800.0, 600.0)
				.disable_drag_drop_handler()
				.visible(true)
				.center()
				.build()
				.expect("failed to create main window");
		}
	}
}
