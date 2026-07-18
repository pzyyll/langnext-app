// ABOUTME: Main application window builder for the desktop shell.
// ABOUTME: Restores validated geometry from device state and persists move/resize changes.
use crate::consts;
use crate::device_state::WindowGeometry;
use crate::state::AppState;
use tauri::{Manager, Runtime, WebviewWindowBuilder};

/// Disable the webview's default right-click context menu (Back/Forward/Reload/Save As/etc.).
///
/// Tauri 2.11 has no `WebviewWindowBuilder::disable_context_menu()`. On Windows we set the
/// native WebView2 `AreDefaultContextMenusEnabled` flag after the window is created.
#[cfg(windows)]
fn disable_default_context_menu<R: Runtime>(window: &tauri::WebviewWindow<R>) {
  let _ = window.with_webview(|platform_webview| {
    // with_webview runs this closure on the webview UI thread.
    unsafe {
      let Ok(core) = platform_webview.controller().CoreWebView2() else {
        return;
      };
      let Ok(settings) = core.Settings() else {
        return;
      };
      let _ = settings.SetAreDefaultContextMenusEnabled(false);
    }
  });
}

/// Intercept close so X / Alt+F4 hide to tray instead of destroying the window.
fn wire_close_to_hide<R: Runtime>(window: &tauri::WebviewWindow<R>) {
  let window_ref = window.clone();
  window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let _ = window_ref.hide();
    }
  });
}

fn wire_geometry_persistence<R: Runtime>(window: &tauri::WebviewWindow<R>, app: &tauri::AppHandle<R>) {
  let app_handle = app.clone();
  let window_ref = window.clone();
  window.on_window_event(move |event| match event {
    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
      if let Some(state) = app_handle.try_state::<AppState>() {
        if let Ok(geometry) = read_geometry(&window_ref) {
          // Real delayed flush is scheduled inside DeviceStateManager.
          state.device_state.schedule_main_window(geometry);
        }
      }
    }
    _ => {}
  });
}

fn read_geometry<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<WindowGeometry, tauri::Error> {
  let position = window.outer_position()?;
  let size = window.outer_size()?;
  let scale = window.scale_factor()?;
  let maximized = window.is_maximized().unwrap_or(false);
  Ok(WindowGeometry {
    x: position.x as f64 / scale,
    y: position.y as f64 / scale,
    width: size.width as f64 / scale,
    height: size.height as f64 / scale,
    maximized,
  })
}

/// Validate geometry against current monitors; reject non-positive sizes or fully off-screen.
fn is_geometry_usable<R: Runtime>(app: &tauri::AppHandle<R>, geometry: &WindowGeometry) -> bool {
  if !geometry.is_valid_size() {
    return false;
  }
  let Ok(monitors) = app.available_monitors() else {
    return true;
  };
  if monitors.is_empty() {
    return true;
  }
  // Logical geometry intersects at least one monitor in logical space.
  for monitor in monitors {
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    let mx = pos.x as f64 / scale;
    let my = pos.y as f64 / scale;
    let mw = size.width as f64 / scale;
    let mh = size.height as f64 / scale;
    let intersects = geometry.x < mx + mw
      && geometry.x + geometry.width > mx
      && geometry.y < my + mh
      && geometry.y + geometry.height > my;
    if intersects {
      return true;
    }
  }
  false
}

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
      log::debug!("creating_main_window route=/");

      let mut web_build = WebviewWindowBuilder::new(app, consts::WIN_LABEL_MAIN, url);

      #[cfg(windows)]
      {
        // Frameless on Windows so the React titlebar owns chrome.
        // Do not call decorum create_overlay_titlebar here: it injects a
        // fixed full-width drag layer that blocks custom React buttons
        // unless withGlobalTauri + decorum-owned controls are used.
        web_build = web_build.decorations(false);
      }

      let geometry = app
        .try_state::<AppState>()
        .map(|s| s.device_state.main_window())
        .unwrap_or_else(WindowGeometry::default_main);

      let usable = is_geometry_usable(app, &geometry);
      let width = if usable { geometry.width.max(800.0) } else { 800.0 };
      let height = if usable { geometry.height.max(600.0) } else { 600.0 };

      web_build = web_build
        .resizable(true)
        .fullscreen(false)
        .title(consts::APP_NAME)
        .inner_size(width, height)
        .min_inner_size(800.0, 600.0)
        .disable_drag_drop_handler()
        .visible(true);

      // Non-Windows: no WebView2 settings API; suppress default context menu at init.
      #[cfg(not(windows))]
      {
        web_build =
          web_build.initialization_script("document.addEventListener('contextmenu', event => event.preventDefault());");
      }

      if usable {
        web_build = web_build.position(geometry.x, geometry.y);
      } else {
        web_build = web_build.center();
      }

      let win = web_build.build().expect("failed to create main window");

      // Windows: native WebView2 AreDefaultContextMenusEnabled = false.
      #[cfg(windows)]
      disable_default_context_menu(&win);

      if usable && geometry.maximized {
        let _ = win.maximize();
      }

      wire_close_to_hide(&win);
      wire_geometry_persistence(&win, app);
    }
  }
}
