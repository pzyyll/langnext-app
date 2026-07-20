// ABOUTME: Region-screenshot overlay window and capture session for desktop targets.
// ABOUTME: Pre-warms a hidden overlay, serves backdrop via temp file, reveals after image load, copies crop to clipboard.
use crate::consts;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{imageops, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{
  Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, WebviewWindowBuilder,
};

/// Smallest accepted selection edge in captured image pixels.
const MIN_SELECTION_EDGE_PX: u32 = 4;

/// Brief pause after hiding app windows so the compositor drops them before capture.
const PRE_CAPTURE_HIDE_DELAY: Duration = Duration::from_millis(30);

/// Clipboard can be briefly locked by Explorer / other apps; retry a few times.
const CLIPBOARD_WRITE_ATTEMPTS: u32 = 5;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(40);

/// Subdirectory under the OS temp dir for screenshot backdrop files.
const SCREENSHOT_TEMP_DIRNAME: &str = "langnext-screenshot";
const BACKDROP_FILENAME: &str = "backdrop.png";

/// Physical-pixel rectangle on the virtual desktop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRegion {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

/// Cropped region screenshot returned to the frontend and emitted app-wide.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegionScreenshotResult {
  pub png_base64: String,
  pub width: u32,
  pub height: u32,
  pub region: ScreenRegion,
  /// Whether the image was written to the OS clipboard.
  pub copied_to_clipboard: bool,
}

/// Backdrop payload for the selection overlay (temp-file path, not base64).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegionScreenshotBackdrop {
  /// Absolute path to the full-monitor PNG used as the selection backdrop.
  pub path: String,
  pub width: u32,
  pub height: u32,
}

/// Selection rectangle in overlay CSS pixels, plus the viewport size used for mapping.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionScreenshotSelection {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub viewport_width: f64,
  pub viewport_height: f64,
}

struct ActiveSession {
  image: RgbaImage,
  monitor_x: i32,
  monitor_y: i32,
  backdrop_path: PathBuf,
  restore_main: bool,
  restore_quick_translate: bool,
}

/// App-managed region-screenshot session (at most one active overlay).
#[derive(Default)]
pub struct RegionScreenshotState {
  session: Mutex<Option<ActiveSession>>,
  /// Set once the warm overlay webview has finished its first page load.
  overlay_ready: AtomicBool,
}

/// Create the hidden overlay webview early so later triggers skip cold start.
pub fn prewarm<R: Runtime>(app: &tauri::AppHandle<R>) {
  if let Err(err) = ensure_overlay_window(app) {
    log::warn!("screenshot_overlay_prewarm_failed error={err}");
  }
}

/// Start a region screenshot: hide app windows, capture, prepare backdrop, place hidden overlay, notify UI.
pub fn start<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  // Cancel any previous session but keep the warm overlay webview.
  let _ = cancel_session_only(app);

  let restore_main = hide_window_if_visible(app, consts::WIN_LABEL_MAIN);
  let restore_quick_translate = hide_window_if_visible(app, consts::WIN_LABEL_QUICK_TRANSLATE);
  if restore_main || restore_quick_translate {
    thread::sleep(PRE_CAPTURE_HIDE_DELAY);
  }

  let cursor = app.cursor_position().map_err(|e| e.to_string())?;
  let cursor_x = cursor.x.round() as i32;
  let cursor_y = cursor.y.round() as i32;

  let capture = capture_monitor_at(cursor_x, cursor_y)?;
  let backdrop_path = write_backdrop_file(app, &capture.image)?;

  let Some(state) = app.try_state::<RegionScreenshotState>() else {
    restore_hidden_windows(app, restore_main, restore_quick_translate);
    let _ = std::fs::remove_file(&backdrop_path);
    return Err("region screenshot state is not managed".into());
  };

  let backdrop = RegionScreenshotBackdrop {
    path: backdrop_path.to_string_lossy().into_owned(),
    width: capture.image.width(),
    height: capture.image.height(),
  };

  {
    let mut guard = state
      .session
      .lock()
      .map_err(|_| "region screenshot lock poisoned".to_string())?;
    *guard = Some(ActiveSession {
      image: capture.image,
      monitor_x: capture.monitor_x,
      monitor_y: capture.monitor_y,
      backdrop_path,
      restore_main,
      restore_quick_translate,
    });
  }

  // Place hidden overlay over the captured monitor; reveal only after the image paints.
  if let Err(err) = place_overlay(
    app,
    capture.monitor_x,
    capture.monitor_y,
    capture.monitor_width,
    capture.monitor_height,
    capture.scale_factor,
  ) {
    let _ = cancel_internal(app);
    return Err(err);
  }

  notify_session_ready(app, &backdrop);
  Ok(())
}

struct MonitorCapture {
  image: RgbaImage,
  monitor_x: i32,
  monitor_y: i32,
  monitor_width: u32,
  monitor_height: u32,
  scale_factor: f64,
}

fn capture_monitor_at(x: i32, y: i32) -> Result<MonitorCapture, String> {
  #[cfg(desktop)]
  {
    use xcap::Monitor;

    let monitor = Monitor::from_point(x, y).map_err(|e| format!("resolve monitor: {e}"))?;
    let monitor_x = monitor.x().map_err(|e| format!("monitor x: {e}"))?;
    let monitor_y = monitor.y().map_err(|e| format!("monitor y: {e}"))?;
    let monitor_width = monitor.width().map_err(|e| format!("monitor width: {e}"))?;
    let monitor_height = monitor.height().map_err(|e| format!("monitor height: {e}"))?;
    let scale_factor = f64::from(monitor.scale_factor().map_err(|e| format!("monitor scale: {e}"))?);
    let image = monitor.capture_image().map_err(|e| format!("capture monitor: {e}"))?;

    Ok(MonitorCapture {
      image,
      monitor_x,
      monitor_y,
      monitor_width,
      monitor_height,
      scale_factor: if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
      } else {
        1.0
      },
    })
  }

  #[cfg(not(desktop))]
  {
    let _ = (x, y);
    Err("region screenshot is not supported on this platform".into())
  }
}

fn screenshot_temp_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
  let temp = app.path().temp_dir().map_err(|e| format!("resolve temp dir: {e}"))?;
  let dir = temp.join(SCREENSHOT_TEMP_DIRNAME);
  std::fs::create_dir_all(&dir).map_err(|e| format!("create screenshot temp dir: {e}"))?;
  Ok(dir)
}

fn write_backdrop_file<R: Runtime>(app: &tauri::AppHandle<R>, image: &RgbaImage) -> Result<PathBuf, String> {
  let path = screenshot_temp_dir(app)?.join(BACKDROP_FILENAME);
  // image::save is convenient and writes PNG; avoid an extra in-memory base64 step for the UI.
  image.save(&path).map_err(|e| format!("write backdrop: {e}"))?;
  Ok(path)
}

fn remove_backdrop_file(path: &Path) {
  if let Err(err) = std::fs::remove_file(path) {
    if err.kind() != std::io::ErrorKind::NotFound {
      log::debug!("screenshot_backdrop_cleanup_failed path={} error={err}", path.display());
    }
  }
}

fn ensure_overlay_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<WebviewWindow<R>, String> {
  if let Some(win) = app.get_webview_window(consts::WIN_LABEL_SCREENSHOT_OVERLAY) {
    return Ok(win);
  }

  let url = tauri::WebviewUrl::App("/screenshot-overlay".into());
  log::debug!("creating_screenshot_overlay_warm route=/screenshot-overlay");

  let mut builder = WebviewWindowBuilder::new(app, consts::WIN_LABEL_SCREENSHOT_OVERLAY, url);

  #[cfg(windows)]
  {
    builder = builder.decorations(false);
  }

  // Start hidden and tiny; place_overlay will size/position before reveal.
  builder = builder
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .title("Screenshot")
    .visible(false)
    .focused(false)
    .inner_size(8.0, 8.0)
    .position(-10_000.0, -10_000.0)
    .disable_drag_drop_handler();

  #[cfg(not(windows))]
  {
    builder =
      builder.initialization_script("document.addEventListener('contextmenu', event => event.preventDefault());");
  }

  let win = builder.build().map_err(|e| e.to_string())?;

  #[cfg(windows)]
  disable_default_context_menu(&win);

  wire_window_events(&win);
  Ok(win)
}

fn place_overlay<R: Runtime>(
  app: &tauri::AppHandle<R>,
  monitor_x: i32,
  monitor_y: i32,
  monitor_width: u32,
  monitor_height: u32,
  scale_factor: f64,
) -> Result<WebviewWindow<R>, String> {
  let win = ensure_overlay_window(app)?;

  log::debug!(
    "placing_screenshot_overlay monitor=({}, {}) size={}x{} scale={}",
    monitor_x,
    monitor_y,
    monitor_width,
    monitor_height,
    scale_factor
  );

  // Keep hidden until the frontend paints the backdrop (avoids blank flash).
  let _ = win.hide();
  let _ = win.set_size(PhysicalSize::new(monitor_width, monitor_height));
  let _ = win.set_position(PhysicalPosition::new(monitor_x, monitor_y));
  let _ = win.set_always_on_top(true);
  Ok(win)
}

fn notify_session_ready<R: Runtime>(app: &tauri::AppHandle<R>, backdrop: &RegionScreenshotBackdrop) {
  if let Some(win) = app.get_webview_window(consts::WIN_LABEL_SCREENSHOT_OVERLAY) {
    if let Err(err) = win.emit_to(
      EventTarget::webview_window(consts::WIN_LABEL_SCREENSHOT_OVERLAY),
      consts::REGION_SCREENSHOT_SESSION_READY_EVENT,
      backdrop.clone(),
    ) {
      log::warn!("region_screenshot_session_ready_emit_failed error={err}");
    }
  }
}

#[cfg(windows)]
fn disable_default_context_menu<R: Runtime>(window: &WebviewWindow<R>) {
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

fn wire_window_events<R: Runtime>(window: &WebviewWindow<R>) {
  let app = window.app_handle().clone();
  window.on_window_event(move |event| match event {
    tauri::WindowEvent::CloseRequested { api, .. } => {
      // Keep the warm webview; cancel session and hide instead of destroying.
      api.prevent_close();
      let _ = cancel_internal(&app);
    }
    tauri::WindowEvent::Destroyed => {
      if let Some(state) = app.try_state::<RegionScreenshotState>() {
        state.overlay_ready.store(false, Ordering::SeqCst);
      }
      let _ = cancel_session_only(&app);
    }
    _ => {}
  });
}

fn hide_window_if_visible<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> bool {
  let Some(win) = app.get_webview_window(label) else {
    return false;
  };
  match win.is_visible() {
    Ok(true) => {
      let _ = win.hide();
      true
    }
    _ => false,
  }
}

fn restore_hidden_windows<R: Runtime>(app: &tauri::AppHandle<R>, restore_main: bool, restore_quick_translate: bool) {
  if restore_main {
    if let Some(win) = app.get_webview_window(consts::WIN_LABEL_MAIN) {
      let _ = win.show();
    }
  }
  if restore_quick_translate {
    if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
      let _ = win.show();
      let _ = win.set_always_on_top(true);
    }
  }
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
  let mut bytes = Vec::new();
  {
    let mut cursor = Cursor::new(&mut bytes);
    let encoder = image::codecs::png::PngEncoder::new(&mut cursor);
    encoder
      .write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
      )
      .map_err(|e| format!("encode png: {e}"))?;
  }
  Ok(bytes)
}

fn hide_overlay<R: Runtime>(app: &tauri::AppHandle<R>) {
  if let Some(win) = app.get_webview_window(consts::WIN_LABEL_SCREENSHOT_OVERLAY) {
    let _ = win.hide();
  }
}

fn take_session<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Option<ActiveSession>, String> {
  let Some(state) = app.try_state::<RegionScreenshotState>() else {
    return Ok(None);
  };
  let mut guard = state
    .session
    .lock()
    .map_err(|_| "region screenshot lock poisoned".to_string())?;
  Ok(guard.take())
}

/// Drop session + temp file + restore windows; keep the warm overlay webview.
fn cancel_session_only<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  if let Some(session) = take_session(app)? {
    remove_backdrop_file(&session.backdrop_path);
    restore_hidden_windows(app, session.restore_main, session.restore_quick_translate);
    let _ = app.emit(consts::REGION_SCREENSHOT_CANCELLED_EVENT, ());
  }
  Ok(())
}

fn cancel_internal<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  let had_session = {
    let Some(state) = app.try_state::<RegionScreenshotState>() else {
      hide_overlay(app);
      return Ok(());
    };
    state.session.lock().map(|g| g.is_some()).unwrap_or(false)
  };
  hide_overlay(app);
  if had_session {
    cancel_session_only(app)?;
  }
  Ok(())
}

/// Frontend loads the pre-captured monitor image path for selection UI.
#[tauri::command]
pub async fn region_screenshot_get_backdrop<R: Runtime>(
  app: tauri::AppHandle<R>,
) -> Result<RegionScreenshotBackdrop, String> {
  let Some(state) = app.try_state::<RegionScreenshotState>() else {
    return Err("region screenshot state is not managed".into());
  };
  let guard = state
    .session
    .lock()
    .map_err(|_| "region screenshot lock poisoned".to_string())?;
  let Some(session) = guard.as_ref() else {
    return Err("no active region screenshot session".into());
  };
  Ok(RegionScreenshotBackdrop {
    path: session.backdrop_path.to_string_lossy().into_owned(),
    width: session.image.width(),
    height: session.image.height(),
  })
}

/// Show the already-positioned overlay after the backdrop has painted in the webview.
#[tauri::command]
pub async fn region_screenshot_reveal<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
  let Some(state) = app.try_state::<RegionScreenshotState>() else {
    return Err("region screenshot state is not managed".into());
  };
  let has_session = state.session.lock().map(|g| g.is_some()).unwrap_or(false);
  if !has_session {
    return Err("no active region screenshot session".into());
  }

  let Some(win) = app.get_webview_window(consts::WIN_LABEL_SCREENSHOT_OVERLAY) else {
    return Err("screenshot overlay window missing".into());
  };
  let _ = win.set_always_on_top(true);
  let _ = win.show();
  if win.is_minimized().unwrap_or(false) {
    let _ = win.unminimize();
  }
  let _ = win.set_focus();
  state.overlay_ready.store(true, Ordering::SeqCst);
  Ok(())
}

/// Crop the pre-captured image with the overlay selection and emit the result.
#[tauri::command]
pub async fn region_screenshot_confirm<R: Runtime>(
  app: tauri::AppHandle<R>,
  selection: RegionScreenshotSelection,
) -> Result<RegionScreenshotResult, String> {
  let Some(session) = take_session(&app)? else {
    return Err("no active region screenshot session".into());
  };

  let crop_result = (|| {
    if !selection.viewport_width.is_finite()
      || !selection.viewport_height.is_finite()
      || selection.viewport_width <= 0.0
      || selection.viewport_height <= 0.0
    {
      return Err("invalid viewport size".to_string());
    }
    if !selection.width.is_finite()
      || !selection.height.is_finite()
      || selection.width <= 0.0
      || selection.height <= 0.0
    {
      return Err("selection is empty".to_string());
    }

    let img_w = session.image.width() as f64;
    let img_h = session.image.height() as f64;
    let scale_x = img_w / selection.viewport_width;
    let scale_y = img_h / selection.viewport_height;

    let mut x0 = (selection.x * scale_x).floor() as i64;
    let mut y0 = (selection.y * scale_y).floor() as i64;
    let mut x1 = ((selection.x + selection.width) * scale_x).ceil() as i64;
    let mut y1 = ((selection.y + selection.height) * scale_y).ceil() as i64;

    x0 = x0.clamp(0, session.image.width() as i64);
    y0 = y0.clamp(0, session.image.height() as i64);
    x1 = x1.clamp(0, session.image.width() as i64);
    y1 = y1.clamp(0, session.image.height() as i64);

    if x1 <= x0 || y1 <= y0 {
      return Err("selection is empty".to_string());
    }

    let crop_w = (x1 - x0) as u32;
    let crop_h = (y1 - y0) as u32;
    if crop_w < MIN_SELECTION_EDGE_PX || crop_h < MIN_SELECTION_EDGE_PX {
      return Err(format!(
        "selection must be at least {MIN_SELECTION_EDGE_PX}x{MIN_SELECTION_EDGE_PX} pixels"
      ));
    }

    let cropped = imageops::crop_imm(&session.image, x0 as u32, y0 as u32, crop_w, crop_h).to_image();
    let png = encode_png(&cropped)?;
    Ok((
      cropped,
      RegionScreenshotResult {
        png_base64: BASE64.encode(&png),
        width: crop_w,
        height: crop_h,
        region: ScreenRegion {
          x: session.monitor_x + x0 as i32,
          y: session.monitor_y + y0 as i32,
          width: crop_w,
          height: crop_h,
        },
        copied_to_clipboard: false,
      },
    ))
  })();

  match crop_result {
    Ok((cropped, mut result)) => {
      if let Err(err) = copy_image_to_clipboard(&cropped) {
        if let Some(state) = app.try_state::<RegionScreenshotState>() {
          if let Ok(mut guard) = state.session.lock() {
            *guard = Some(session);
          }
        }
        log::error!("region_screenshot_clipboard_write_failed error={err}");
        return Err(err);
      }
      result.copied_to_clipboard = true;

      remove_backdrop_file(&session.backdrop_path);
      hide_overlay(&app);
      restore_hidden_windows(&app, session.restore_main, session.restore_quick_translate);
      if let Err(err) = app.emit(consts::REGION_SCREENSHOT_CAPTURED_EVENT, &result) {
        log::warn!("region_screenshot_emit_failed error={err}");
      }
      log::info!(
        "region_screenshot_captured size={}x{} region=({}, {}, {}x{}) clipboard=true",
        result.width,
        result.height,
        result.region.x,
        result.region.y,
        result.region.width,
        result.region.height
      );
      Ok(result)
    }
    Err(err) => {
      if let Some(state) = app.try_state::<RegionScreenshotState>() {
        if let Ok(mut guard) = state.session.lock() {
          *guard = Some(session);
        }
      }
      Err(err)
    }
  }
}

/// Copy an RGBA image to the system clipboard with retries.
fn copy_image_to_clipboard(image: &RgbaImage) -> Result<(), String> {
  #[cfg(desktop)]
  {
    use arboard::{Clipboard, ImageData};
    use std::borrow::Cow;

    if image.width() == 0 || image.height() == 0 {
      return Err("clipboard image is empty".into());
    }
    let expected_len = (image.width() as usize)
      .saturating_mul(image.height() as usize)
      .saturating_mul(4);
    if image.as_raw().len() < expected_len {
      return Err(format!(
        "clipboard image buffer too small: have {} need {expected_len}",
        image.as_raw().len()
      ));
    }

    let rgba = image.as_raw().to_vec();
    let width = image.width() as usize;
    let height = image.height() as usize;

    let mut last_error = String::from("clipboard write failed");
    for attempt in 1..=CLIPBOARD_WRITE_ATTEMPTS {
      match Clipboard::new() {
        Ok(mut clipboard) => {
          let data = ImageData {
            width,
            height,
            bytes: Cow::Borrowed(rgba.as_slice()),
          };
          match clipboard.set_image(data) {
            Ok(()) => {
              log::info!("region_screenshot_copied_to_clipboard size={width}x{height} attempt={attempt}");
              return Ok(());
            }
            Err(err) => {
              last_error = format!("set_image failed: {err}");
              log::warn!("region_screenshot_clipboard_retry attempt={attempt}/{CLIPBOARD_WRITE_ATTEMPTS} error={err}");
            }
          }
        }
        Err(err) => {
          last_error = format!("open clipboard failed: {err}");
          log::warn!("region_screenshot_clipboard_open_retry attempt={attempt}/{CLIPBOARD_WRITE_ATTEMPTS} error={err}");
        }
      }
      if attempt < CLIPBOARD_WRITE_ATTEMPTS {
        thread::sleep(CLIPBOARD_RETRY_DELAY.saturating_mul(attempt));
      }
    }

    Err(last_error)
  }

  #[cfg(not(desktop))]
  {
    let _ = image;
    Err("clipboard is not supported on this platform".into())
  }
}

/// Cancel the active region screenshot without producing an image.
#[tauri::command]
pub async fn region_screenshot_cancel<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
  cancel_internal(&app)
}
