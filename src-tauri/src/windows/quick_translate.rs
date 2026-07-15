// ABOUTME: Always-on-top Quick Translate secondary window builder.
// ABOUTME: Creates a frameless webview at /quick-translate and reuses it on show.

use crate::consts;
use tauri::{Manager, Runtime, WebviewWindowBuilder};

/// Disable the webview's default right-click context menu (Windows WebView2).
#[cfg(windows)]
fn disable_default_context_menu<R: Runtime>(window: &tauri::WebviewWindow<R>) {
	let _ = window.with_webview(|platform_webview| unsafe {
		let Ok(core) = platform_webview.controller().CoreWebView2() else {
			return;
		};
		let Ok(settings) = core.Settings() else {
			return;
		};
		let _ = settings.SetAreDefaultContextMenusEnabled(false);
	});
}

/// Hide on close so the next tray/shortcut open is instant.
fn wire_close_to_hide<R: Runtime>(window: &tauri::WebviewWindow<R>) {
	let window_ref = window.clone();
	window.on_window_event(move |event| {
		if let tauri::WindowEvent::CloseRequested { api, .. } = event {
			api.prevent_close();
			let _ = window_ref.hide();
		}
	});
}

/// Show the Quick Translate window, creating it on first use.
pub fn show<R: Runtime>(app: &tauri::AppHandle<R>) {
	match app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
		Some(win) => {
			let _ = win.set_always_on_top(true);
			win.show().expect("failed to show quick translate window");
			if win.is_minimized().unwrap_or(false) {
				win.unminimize().expect("failed to unminimize quick translate window");
			}
			let _ = win.set_focus();
		}
		None => {
			let url = tauri::WebviewUrl::App("/quick-translate".into());
			log::debug!("creating_quick_translate_window route=/quick-translate");

			let mut web_build = WebviewWindowBuilder::new(app, consts::WIN_LABEL_QUICK_TRANSLATE, url);

			#[cfg(windows)]
			{
				web_build = web_build.decorations(false);
			}

			web_build = web_build
				.resizable(true)
				.fullscreen(false)
				.always_on_top(true)
				.title(consts::APP_NAME)
				.inner_size(600.0, 640.0)
				.min_inner_size(420.0, 480.0)
				.disable_drag_drop_handler()
				.center()
				.visible(true);

			#[cfg(not(windows))]
			{
				web_build =
					web_build.initialization_script("document.addEventListener('contextmenu', event => event.preventDefault());");
			}

			let win = web_build.build().expect("failed to create quick translate window");

			#[cfg(windows)]
			disable_default_context_menu(&win);

			wire_close_to_hide(&win);
			let _ = win.set_focus();
		}
	}
}
