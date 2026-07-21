// ABOUTME: Region-screenshot overlay window and capture session for desktop targets.
// ABOUTME: Pre-warms overlay, serves backdrop via temp file, optional post-capture OCR into Quick Translate.
use crate::consts;
use crate::domain::ocr_service::OcrRecognizeInput;
use crate::state::AppState;
use crate::windows;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{ImageEncoder, RgbaImage, imageops};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{
  Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, WebviewWindowBuilder,
};

/// Smallest accepted selection edge in captured image pixels.
const MIN_SELECTION_EDGE_PX: u32 = 4;

/// Brief pause after hiding app windows before checking their visibility state.
const PRE_CAPTURE_HIDE_DELAY: Duration = Duration::from_millis(50);

/// Extra time for DWM and its GDI redirection surface to drop hidden windows.
const POST_HIDE_COMPOSITOR_DELAY: Duration = Duration::from_millis(150);

/// One low-refresh-rate display frame between the throwaway and final GDI captures.
const CAPTURE_REFRESH_DELAY: Duration = Duration::from_millis(34);

/// Max time to wait for hide() to take effect before capturing.
const HIDE_SETTLE_TIMEOUT: Duration = Duration::from_millis(200);
const HIDE_SETTLE_POLL: Duration = Duration::from_millis(10);

/// Clipboard can be briefly locked by Explorer / other apps; retry a few times.
const CLIPBOARD_WRITE_ATTEMPTS: u32 = 5;
const CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(40);

/// Subdirectory under the OS temp dir for screenshot backdrop files.
const SCREENSHOT_TEMP_DIRNAME: &str = "langnext-screenshot";
const BACKDROP_FILENAME: &str = "backdrop.png";

/// Temporary global Escape binding while a region-screenshot session is active.
/// Overlay webviews often lack keyboard focus until the user clicks, so window-level
/// Esc handlers alone are unreliable.
const ESCAPE_CANCEL_BINDING: &str = "Escape";

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

/// Backdrop payload for the selection overlay (temp-file path + optional PNG data URL fallback).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureMode {
  Plain,
  Ocr,
}

impl CaptureMode {
  fn as_str(self) -> &'static str {
    match self {
      Self::Plain => "plain",
      Self::Ocr => "ocr",
    }
  }
}

/// How to put a window back after a capture session that hid it.
#[derive(Debug, Clone, Copy, Default)]
struct WindowRestore {
  /// Window was visible and we hid it for capture.
  restore: bool,
  /// Was the foreground window when hidden; restore may re-focus only then.
  was_foreground: bool,
}

impl WindowRestore {
  fn merge(self, other: Self) -> Self {
    Self {
      restore: self.restore || other.restore,
      was_foreground: self.was_foreground || other.was_foreground,
    }
  }
}

struct ActiveSession {
  image: RgbaImage,
  monitor_x: i32,
  monitor_y: i32,
  backdrop_path: PathBuf,
  main: WindowRestore,
  quick_translate: WindowRestore,
  /// Foreground HWND before we hid anything / focused the overlay (Windows).
  #[cfg(windows)]
  previous_foreground: Option<isize>,
  mode: CaptureMode,
}

/// App-managed region-screenshot session (at most one active overlay).
#[derive(Default)]
pub struct RegionScreenshotState {
  session: Mutex<Option<ActiveSession>>,
  /// Serializes start so concurrent hotkeys cannot interleave hide/restore.
  start_gate: Mutex<()>,
  /// Set once the warm overlay webview has finished its first page load.
  overlay_ready: AtomicBool,
  /// Whether the temporary Escape global shortcut is currently registered.
  escape_registered: AtomicBool,
}

/// Create the hidden overlay webview early so later triggers skip cold start.
pub fn prewarm<R: Runtime>(app: &tauri::AppHandle<R>) {
  if let Err(err) = ensure_overlay_window(app) {
    log::warn!("screenshot_overlay_prewarm_failed error={err}");
  }
}

/// Start a plain region screenshot without post-capture OCR.
pub fn start<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  start_with_mode(app, CaptureMode::Plain)
}

/// Start a screenshot session with immutable per-session capture behavior.
fn start_with_mode<R: Runtime>(app: &tauri::AppHandle<R>, mode: CaptureMode) -> Result<(), String> {
  let Some(state) = app.try_state::<RegionScreenshotState>() else {
    return Err("region screenshot state is not managed".into());
  };
  let _start_guard = state
    .start_gate
    .lock()
    .map_err(|_| "region screenshot start gate poisoned".to_string())?;

  // Drop any previous session without restoring windows (avoids hide→show flash on re-entry).
  let previous = discard_session_keep_hidden(app)?;
  let (prev_main, prev_quick_translate, prev_foreground) = match previous {
    Some((main, qt, fg)) => (main, qt, fg),
    None => (WindowRestore::default(), WindowRestore::default(), None),
  };

  // Snapshot the user's foreground window before we touch any of ours. Prefer the value from a
  // superseded session so re-entry does not treat the overlay as the original foreground app.
  // Global hotkeys do not change the foreground; GetForegroundWindow is more reliable than
  // Tauri is_focused() around hide/show races.
  #[cfg(windows)]
  let previous_foreground = prev_foreground.or_else(foreground_hwnd_raw);
  #[cfg(not(windows))]
  let _ = prev_foreground;

  let main = hide_app_window_for_capture(app, consts::WIN_LABEL_MAIN).merge(prev_main);
  let quick_translate =
    hide_app_window_for_capture(app, consts::WIN_LABEL_QUICK_TRANSLATE).merge(prev_quick_translate);
  if main.restore || quick_translate.restore {
    wait_for_windows_hidden(
      app,
      main.restore.then_some(consts::WIN_LABEL_MAIN),
      quick_translate.restore.then_some(consts::WIN_LABEL_QUICK_TRANSLATE),
    );
  }

  let cursor = app.cursor_position().map_err(|e| e.to_string())?;
  let cursor_x = cursor.x.round() as i32;
  let cursor_y = cursor.y.round() as i32;

  let capture = capture_monitor_at(cursor_x, cursor_y)?;
  let backdrop_path = write_backdrop_file(app, &capture.image)?;

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
      main,
      quick_translate,
      #[cfg(windows)]
      previous_foreground,
      mode,
    });
  }
  log::info!("region_screenshot_session_started mode={}", mode.as_str());

  // Place overlay over the captured monitor. Show immediately (black until image paints):
  // waiting for webview onload while hidden is unreliable on WebView2 and can leave the
  // session stuck with no visible UI.
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
  if let Err(err) = show_overlay_now(app) {
    log::warn!("region_screenshot_show_failed error={err}");
  }
  register_escape_cancel(app);
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

    #[cfg(windows)]
    {
      // xcap uses GDI BitBlt by default. Prime its desktop redirection surface, then wait for a
      // newer composed frame so a recently hidden app window cannot leak into the final image.
      if let Err(err) = monitor.capture_image() {
        log::debug!("screenshot_capture_prime_failed error={err}");
      }
      thread::sleep(CAPTURE_REFRESH_DELAY);
      flush_desktop_composition();
    }

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

  // Size/position first while still hidden, then caller shows once the session is ready.
  let _ = win.hide();
  let _ = win.set_size(PhysicalSize::new(monitor_width, monitor_height));
  let _ = win.set_position(PhysicalPosition::new(monitor_x, monitor_y));
  let _ = win.set_always_on_top(true);
  Ok(win)
}

fn show_overlay_now<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  let Some(win) = app.get_webview_window(consts::WIN_LABEL_SCREENSHOT_OVERLAY) else {
    return Err("screenshot overlay window missing".into());
  };
  let _ = win.set_always_on_top(true);
  let _ = win.show();
  if win.is_minimized().unwrap_or(false) {
    let _ = win.unminimize();
  }
  let _ = win.set_focus();
  if let Some(state) = app.try_state::<RegionScreenshotState>() {
    state.overlay_ready.store(true, Ordering::SeqCst);
  }
  Ok(())
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

/// Hide an app window only when it would pollute the capture.
///
/// - Main: hide only when it is the foreground window. An unfocused main sitting behind
///   the user's work is left alone so we never raise it via hide→show (SW_SHOW / NOACTIVATE
///   both promote Z-order).
/// - Quick Translate: always hide when visible (always-on-top, would appear in the capture).
fn hide_app_window_for_capture<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) -> WindowRestore {
  let Some(win) = app.get_webview_window(label) else {
    return WindowRestore::default();
  };
  if !win.is_visible().unwrap_or(false) {
    return WindowRestore::default();
  }

  let was_foreground = is_window_foreground(&win);

  if label == consts::WIN_LABEL_MAIN && !was_foreground {
    log::debug!("screenshot_skip_hide_unfocused_main");
    return WindowRestore::default();
  }

  let _ = win.hide();
  if label == consts::WIN_LABEL_QUICK_TRANSLATE {
    // Drop QT auto-close hooks while the overlay owns the pointer; otherwise residual
    // move events close the hidden window mid-selection and leave stale hook state.
    windows::quick_translate::on_hidden_by_host();
  }
  WindowRestore {
    restore: true,
    was_foreground,
  }
}

fn wait_for_windows_hidden<R: Runtime>(app: &tauri::AppHandle<R>, main_label: Option<&str>, quick_label: Option<&str>) {
  thread::sleep(PRE_CAPTURE_HIDE_DELAY);
  let deadline = std::time::Instant::now() + HIDE_SETTLE_TIMEOUT;
  let hidden_before_timeout = loop {
    let main_hidden =
      main_label.is_none_or(|label| app.get_webview_window(label).and_then(|w| w.is_visible().ok()) != Some(true));
    let quick_hidden =
      quick_label.is_none_or(|label| app.get_webview_window(label).and_then(|w| w.is_visible().ok()) != Some(true));
    if main_hidden && quick_hidden {
      break true;
    }
    if std::time::Instant::now() >= deadline {
      break false;
    }
    thread::sleep(HIDE_SETTLE_POLL);
  };

  if !hidden_before_timeout {
    log::warn!("screenshot_hide_settle_timeout");
  }

  flush_desktop_composition();
  thread::sleep(POST_HIDE_COMPOSITOR_DELAY);
  flush_desktop_composition();
}

/// Wait until DWM has presented the hide operation before capturing the desktop.
fn flush_desktop_composition() {
  #[cfg(windows)]
  {
    let result = unsafe { win32::DwmFlush() };
    if result < 0 {
      log::debug!("screenshot_dwm_flush_failed hresult=0x{:08X}", result as u32);
    }
  }
}

fn restore_hidden_windows<R: Runtime>(
  app: &tauri::AppHandle<R>,
  main: WindowRestore,
  quick_translate: WindowRestore,
  #[cfg(windows)] previous_foreground: Option<isize>,
) {
  let mut want_our_focus = false;

  if main.restore {
    if let Some(win) = app.get_webview_window(consts::WIN_LABEL_MAIN) {
      let _ = win.show();
      if main.was_foreground {
        let _ = win.set_focus();
        want_our_focus = true;
      }
    }
  }

  if quick_translate.restore {
    if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
      let _ = win.show();
      let _ = win.set_always_on_top(true);
      if quick_translate.was_foreground {
        let _ = win.set_focus();
        want_our_focus = true;
      }
    }
  }

  // Closing the always-on-top overlay often activates another window in this process (main).
  // Hand focus back to the pre-capture foreground app unless we intentionally re-focused ours.
  #[cfg(windows)]
  if !want_our_focus {
    restore_previous_foreground(previous_foreground);
  }
}

/// True when this window (or a child HWND such as WebView2) is the OS foreground window.
fn is_window_foreground<R: Runtime>(win: &WebviewWindow<R>) -> bool {
  #[cfg(windows)]
  {
    let Ok(hwnd) = win.hwnd() else {
      return win.is_focused().unwrap_or(false);
    };
    let root = hwnd.0;
    if root.is_null() {
      return false;
    }
    let fg = unsafe { win32::GetForegroundWindow() };
    if fg.is_null() {
      return false;
    }
    if fg == root {
      return true;
    }
    // WebView2 focuses a child HWND; treat the root owner as foreground.
    let fg_root = unsafe { win32::GetAncestor(fg, win32::GA_ROOT) };
    return !fg_root.is_null() && fg_root == root;
  }

  #[cfg(not(windows))]
  {
    win.is_focused().unwrap_or(false)
  }
}

#[cfg(windows)]
fn foreground_hwnd_raw() -> Option<isize> {
  let fg = unsafe { win32::GetForegroundWindow() };
  if fg.is_null() || unsafe { win32::IsWindow(fg) } == 0 {
    None
  } else {
    Some(fg as isize)
  }
}

#[cfg(windows)]
fn restore_previous_foreground(previous: Option<isize>) {
  let Some(raw) = previous else {
    return;
  };
  let target = raw as *mut std::ffi::c_void;
  if target.is_null() || unsafe { win32::IsWindow(target) } == 0 {
    return;
  }

  unsafe {
    let current = win32::GetForegroundWindow();
    if current == target {
      return;
    }

    // AttachThreadInput lets us bypass the foreground lock after our overlay held focus.
    let current_thread = win32::GetCurrentThreadId();
    let fg_thread = if current.is_null() {
      0
    } else {
      win32::GetWindowThreadProcessId(current, std::ptr::null_mut())
    };
    let target_thread = win32::GetWindowThreadProcessId(target, std::ptr::null_mut());

    let attached_fg =
      fg_thread != 0 && fg_thread != current_thread && win32::AttachThreadInput(fg_thread, current_thread, 1) != 0;
    let attached_target = target_thread != 0
      && target_thread != current_thread
      && target_thread != fg_thread
      && win32::AttachThreadInput(target_thread, current_thread, 1) != 0;

    let _ = win32::SetForegroundWindow(target);

    if attached_fg {
      let _ = win32::AttachThreadInput(fg_thread, current_thread, 0);
    }
    if attached_target {
      let _ = win32::AttachThreadInput(target_thread, current_thread, 0);
    }
  }
}

/// Win32 helpers for desktop composition, foreground detection, and focus restore.
#[cfg(windows)]
mod win32 {
  use std::ffi::c_void;

  pub const GA_ROOT: u32 = 2;

  #[link(name = "user32")]
  unsafe extern "system" {
    pub fn GetForegroundWindow() -> *mut c_void;
    pub fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
    pub fn GetAncestor(hwnd: *mut c_void, flags: u32) -> *mut c_void;
    pub fn IsWindow(hwnd: *mut c_void) -> i32;
    pub fn GetWindowThreadProcessId(hwnd: *mut c_void, process_id: *mut u32) -> u32;
    pub fn AttachThreadInput(attach_id: u32, attach_to_id: u32, attach: i32) -> i32;
  }

  #[link(name = "kernel32")]
  unsafe extern "system" {
    pub fn GetCurrentThreadId() -> u32;
  }

  #[link(name = "dwmapi")]
  unsafe extern "system" {
    pub fn DwmFlush() -> i32;
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

/// Register a temporary global Escape that cancels the active screenshot session.
fn register_escape_cancel<R: Runtime>(app: &tauri::AppHandle<R>) {
  #[cfg(desktop)]
  {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let Some(state) = app.try_state::<RegionScreenshotState>() else {
      return;
    };
    if state.escape_registered.load(Ordering::SeqCst) {
      return;
    }

    match app
      .global_shortcut()
      .on_shortcut(ESCAPE_CANCEL_BINDING, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
          log::debug!("region_screenshot_escape_cancel");
          // Defer cancellation: cancel_internal unregisters Escape, and unregistering
          // synchronously inside this callback would re-enter the plugin mutex and deadlock.
          let app = app.clone();
          std::thread::spawn(move || {
            let _ = cancel_internal(&app);
          });
        }
      }) {
      Ok(()) => {
        state.escape_registered.store(true, Ordering::SeqCst);
        log::debug!("region_screenshot_escape_registered");
      }
      Err(err) => {
        log::warn!("region_screenshot_escape_register_failed error={err}");
      }
    }
  }

  #[cfg(not(desktop))]
  {
    let _ = app;
  }
}

/// Unregister the temporary Escape binding if it is active.
fn unregister_escape_cancel<R: Runtime>(app: &tauri::AppHandle<R>) {
  #[cfg(desktop)]
  {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let Some(state) = app.try_state::<RegionScreenshotState>() else {
      return;
    };
    if !state.escape_registered.swap(false, Ordering::SeqCst) {
      return;
    }
    if let Err(err) = app.global_shortcut().unregister(ESCAPE_CANCEL_BINDING) {
      log::warn!("region_screenshot_escape_unregister_failed error={err}");
    } else {
      log::debug!("region_screenshot_escape_unregistered");
    }
  }

  #[cfg(not(desktop))]
  {
    let _ = app;
  }
}

/// Start region screenshot that will OCR the crop and open Quick Translate only when text is ready.
pub fn start_for_ocr<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  start_with_mode(app, CaptureMode::Ocr)
}

/// Run default OCR and deliver recognized text into Quick Translate (show only when text exists).
fn spawn_ocr_to_quick_translate<R: Runtime>(app: tauri::AppHandle<R>, png_base64: String) {
  tauri::async_runtime::spawn(async move {
    let Some(app_state) = app.try_state::<AppState>() else {
      log::error!("screenshot_ocr_missing_app_state");
      return;
    };
    let ocr = app_state.ocr_services.clone();
    match ocr
      .recognize(OcrRecognizeInput {
        png_base64,
        ocr_service_id: None,
      })
      .await
    {
      Ok(result) => {
        let text = result.text.trim().to_string();
        if text.is_empty() {
          log::info!("screenshot_ocr_empty_result");
          return;
        }
        windows::quick_translate::deliver_source_text(&app, text);
      }
      Err(err) => {
        log::error!("screenshot_ocr_failed error={err}");
      }
    }
  });
}

/// Drop session + temp file without restoring windows (used when starting a new session).
/// Returns pending restore flags and the original pre-capture foreground HWND (Windows).
fn discard_session_keep_hidden<R: Runtime>(
  app: &tauri::AppHandle<R>,
) -> Result<Option<(WindowRestore, WindowRestore, Option<isize>)>, String> {
  unregister_escape_cancel(app);
  hide_overlay(app);
  if let Some(session) = take_session(app)? {
    remove_backdrop_file(&session.backdrop_path);
    #[cfg(windows)]
    let previous_foreground = session.previous_foreground;
    #[cfg(not(windows))]
    let previous_foreground = None;
    Ok(Some((
      session.main,
      session.quick_translate,
      previous_foreground,
    )))
  } else {
    Ok(None)
  }
}

/// Drop session + temp file + restore windows; keep the warm overlay webview.
fn cancel_session_only<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  unregister_escape_cancel(app);
  if let Some(session) = take_session(app)? {
    remove_backdrop_file(&session.backdrop_path);
    restore_hidden_windows(
      app,
      session.main,
      session.quick_translate,
      #[cfg(windows)]
      session.previous_foreground,
    );
    let _ = app.emit(consts::REGION_SCREENSHOT_CANCELLED_EVENT, ());
  }
  Ok(())
}

fn cancel_internal<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
  let had_session = {
    let Some(state) = app.try_state::<RegionScreenshotState>() else {
      unregister_escape_cancel(app);
      hide_overlay(app);
      return Ok(());
    };
    state.session.lock().map(|g| g.is_some()).unwrap_or(false)
  };
  hide_overlay(app);
  // Always drop Escape even if the session was already taken (e.g. confirm path).
  unregister_escape_cancel(app);
  if had_session {
    // Session still present: full cancel cleanup (unregister is idempotent).
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

/// Fallback when asset-protocol loading fails: return the backdrop as base64 PNG.
#[tauri::command]
pub async fn region_screenshot_get_backdrop_data<R: Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
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
  // Prefer the temp file (already encoded); fall back to re-encoding the in-memory capture.
  match std::fs::read(&session.backdrop_path) {
    Ok(bytes) if !bytes.is_empty() => Ok(BASE64.encode(bytes)),
    _ => {
      let png = encode_png(&session.image)?;
      Ok(BASE64.encode(png))
    }
  }
}

/// Re-focus / re-show the overlay after the frontend paints the backdrop.
#[tauri::command]
pub async fn region_screenshot_reveal<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
  let Some(state) = app.try_state::<RegionScreenshotState>() else {
    return Err("region screenshot state is not managed".into());
  };
  let has_session = state.session.lock().map(|g| g.is_some()).unwrap_or(false);
  if !has_session {
    return Err("no active region screenshot session".into());
  }
  show_overlay_now(&app)?;
  register_escape_cancel(&app);
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

      unregister_escape_cancel(&app);
      remove_backdrop_file(&session.backdrop_path);
      hide_overlay(&app);
      restore_hidden_windows(
        &app,
        session.main,
        session.quick_translate,
        #[cfg(windows)]
        session.previous_foreground,
      );
      if let Err(err) = app.emit(consts::REGION_SCREENSHOT_CAPTURED_EVENT, &result) {
        log::warn!("region_screenshot_emit_failed error={err}");
      }
      log::info!(
        "region_screenshot_captured mode={} size={}x{} region=({}, {}, {}x{}) clipboard=true",
        session.mode.as_str(),
        result.width,
        result.height,
        result.region.x,
        result.region.y,
        result.region.width,
        result.region.height
      );
      if session.mode == CaptureMode::Ocr {
        log::info!("screenshot_ocr_dispatch");
        spawn_ocr_to_quick_translate(app.clone(), result.png_base64.clone());
      }
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

/// Start the region-screenshot overlay from the frontend (Quick Translate OCR, etc.).
///
/// Runs on a blocking pool so Escape shortcut registration does not hold the async runtime.
#[tauri::command]
pub async fn start_region_screenshot<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || start(&app))
    .await
    .map_err(|err| format!("failed to start region screenshot: {err}"))?
}
