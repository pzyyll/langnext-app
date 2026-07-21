// ABOUTME: Always-on-top Quick Translate secondary window builder.
// ABOUTME: Cursor-follow show, click-outside hide, clipboard paste, and source-text delivery.

use crate::consts;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, EventTarget, Manager, PhysicalPosition, Pixel, Runtime, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[cfg(windows)]
use kmhook::enginer as mouse_enginer;
#[cfg(windows)]
use kmhook::types::{ClickState, EventType, MouseButton, Pos};

/// Default logical inner size used until content-driven resize runs.
const INIT_WIN_SIZE: (f64, f64) = (420.0, 360.0);

/// Minimum logical inner size (width fixed floor; height content-adaptive).
const MIN_WIN_SIZE: (f64, f64) = (420.0, 280.0);

/// Logical px: shift the window up so the cursor starts inside the top edge.
/// Larger than a few px so post-show pointer jitter does not read as "outside".
const CURSOR_TOP_OFFSET: f64 = 24.0;

/// After show/re-show, ignore move-out dismiss for this long (OCR / screenshot handoff).
const MOVE_OUT_GRACE: Duration = Duration::from_millis(1_500);

/// Process start; grace deadline is stored as millis since this instant.
static PROCESS_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

static MOUSE_EVENT_ID: AtomicUsize = AtomicUsize::new(0);
/// Pointer has entered the window at least once since the current mouse hook was armed.
static POINTER_ENTERED: AtomicBool = AtomicBool::new(false);
/// Move-out dismiss is ignored until this process-relative deadline (millis).
static MOVE_OUT_GRACE_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static WIN_SIZE: Mutex<(f64, f64)> = Mutex::new(INIT_WIN_SIZE);

fn process_start() -> Instant {
  *PROCESS_START.get_or_init(Instant::now)
}

fn arm_move_out_grace() {
  let until = process_start().elapsed().as_millis() as u64 + MOVE_OUT_GRACE.as_millis() as u64;
  MOVE_OUT_GRACE_UNTIL_MS.store(until, Ordering::SeqCst);
  POINTER_ENTERED.store(false, Ordering::SeqCst);
}

fn in_move_out_grace() -> bool {
  let until = MOVE_OUT_GRACE_UNTIL_MS.load(Ordering::SeqCst);
  if until == 0 {
    return false;
  }
  (process_start().elapsed().as_millis() as u64) < until
}

/// App-level pin / clipboard-delivery state for the single Quick Translate window.
///
/// `frontend_ready` is set only after the webview has registered its event listeners.
/// Until then, source text (clipboard / OCR) is held in `pending_clipboard` (latest wins).
#[derive(Debug, Default)]
pub struct QuickTranslateState {
  pub is_pin: Mutex<bool>,
  frontend_ready: AtomicBool,
  pending_clipboard: Mutex<Option<String>>,
}

impl QuickTranslateState {
  pub fn reset(&self) {
    *self.is_pin.lock().unwrap() = false;
    // Hold the pending lock while clearing ready so deliver/notify cannot interleave.
    let mut pending = self.pending_clipboard.lock().unwrap();
    self.frontend_ready.store(false, Ordering::SeqCst);
    *pending = None;
  }
}

/// Disable the webview's default right-click context menu (Windows WebView2).
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

fn record_win_outer_size<R: Runtime>(win: &WebviewWindow<R>) {
  let _ = win.outer_size().inspect(|outer_size| {
    if outer_size.width == 0 && outer_size.height == 0 {
      return;
    }
    let mut size = WIN_SIZE.lock().unwrap();
    *size = (outer_size.width as f64, outer_size.height as f64);
  });
}

/// Resolve physical outer size (live measurement, else last recorded).
fn win_outer_size_px<R: Runtime>(win: &WebviewWindow<R>) -> (f64, f64) {
  match win.outer_size() {
    Ok(size) if size.width > 0 && size.height > 0 => (size.width as f64, size.height as f64),
    _ => {
      let size = WIN_SIZE.lock().unwrap();
      (size.0, size.1)
    }
  }
}

/// Position relative to the cursor (center-top, offset 10) when provided; otherwise keep the
/// current top-left and only clamp into the monitor under that point.
fn adjust_win_position<R: Runtime, P: Pixel>(win: &WebviewWindow<R>, cursor: Option<PhysicalPosition<P>>) {
  let (win_w, win_h) = win_outer_size_px(win);

  // Anchor point used for monitor lookup; also the cursor when re-anchoring.
  let (anchor_x, anchor_y, reanchor) = if let Some(cursor) = cursor {
    (cursor.x.into(), cursor.y.into(), true)
  } else {
    let pos: PhysicalPosition<f64> = win.outer_position().unwrap_or_default().cast();
    (pos.x, pos.y, false)
  };

  let (mut x, mut y) = if reanchor {
    // Horizontal center on cursor; top edge slightly above cursor so the pointer starts inside.
    (anchor_x - win_w / 2.0, anchor_y - CURSOR_TOP_OFFSET)
  } else {
    (anchor_x, anchor_y)
  };

  let _ = win
    .app_handle()
    .monitor_from_point(anchor_x, anchor_y)
    .inspect(|monitor| {
      let Some(m) = monitor else {
        return;
      };

      // Prefer logical offset scaled to this monitor when re-anchoring to the cursor.
      if reanchor {
        let top_offset = CURSOR_TOP_OFFSET * m.scale_factor();
        x = anchor_x - win_w / 2.0;
        y = anchor_y - top_offset;
      }

      let min_x = m.position().x as f64;
      let min_y = m.position().y as f64;
      let max_x = min_x + m.size().width as f64;
      let max_y = min_y + m.size().height as f64;

      if x + win_w > max_x {
        x = max_x - win_w;
      }
      if y + win_h > max_y {
        y = max_y - win_h;
      }
      if x < min_x {
        x = min_x;
      }
      if y < min_y {
        y = min_y;
      }
    });

  let _ = win.set_position(PhysicalPosition::new(P::from_f64(x), P::from_f64(y)));
}

fn read_clipboard_text<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
  app.clipboard().read_text().ok().filter(|text| !text.is_empty())
}

fn emit_clipboard_text<R: Runtime>(app: &tauri::AppHandle<R>, text: String) {
  if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
    let _ = win.emit_to(
      EventTarget::webview_window(consts::WIN_LABEL_QUICK_TRANSLATE),
      consts::QUICK_TRANSLATE_CLIPBOARD_EVENT,
      text,
    );
  } else {
    log::error!("quick_translate_window_missing_on_clipboard_emit");
  }
}

/// Deliver clipboard text now if the frontend is listening; otherwise queue the latest payload.
fn deliver_or_queue_clipboard<R: Runtime>(app: &tauri::AppHandle<R>, text: String) {
  let Some(state) = app.try_state::<QuickTranslateState>() else {
    emit_clipboard_text(app, text);
    return;
  };

  // Decision under the pending lock so notify_ready cannot set ready between check and queue.
  {
    let mut pending = state.pending_clipboard.lock().unwrap();
    if !state.frontend_ready.load(Ordering::SeqCst) {
      *pending = Some(text);
      log::debug!("quick_translate_clipboard_queued awaiting_frontend_ready");
      return;
    }
  }

  emit_clipboard_text(app, text);
}

/// Called by the frontend after its event listeners are registered.
#[tauri::command]
pub async fn notify_ready<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
  let Some(state) = app.try_state::<QuickTranslateState>() else {
    return Ok(());
  };

  // Mark ready and take pending under one lock so concurrent deliver cannot lose text.
  let pending = {
    let mut pending = state.pending_clipboard.lock().unwrap();
    state.frontend_ready.store(true, Ordering::SeqCst);
    pending.take()
  };
  if let Some(text) = pending {
    log::debug!("quick_translate_clipboard_flush_on_ready");
    emit_clipboard_text(&app, text);
  }
  Ok(())
}

/// Pin toggle: when true, click-outside / move-out auto-close is disabled.
#[tauri::command]
pub async fn set_pin<R: Runtime>(
  app: tauri::AppHandle<R>,
  state: tauri::State<'_, QuickTranslateState>,
  is_pin: bool,
) -> Result<(), String> {
  *state.is_pin.lock().unwrap() = is_pin;
  // Keep always-on-top so a pinned window stays above while editing elsewhere.
  if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
    let _ = win.set_always_on_top(true);
  }
  Ok(())
}

/// Resize the Quick Translate window's logical inner height to match content.
/// Keeps the current width; clamps so the outer frame stays inside the monitor work area.
#[tauri::command]
pub async fn resize_window_height<R: Runtime>(window: tauri::Window<R>, height: f64) -> Result<(), String> {
  if !height.is_finite() || height <= 0.0 {
    return Ok(());
  }

  let scale = window.scale_factor().map_err(|e| e.to_string())?;
  let outer_pos = window
    .outer_position()
    .map_err(|e| e.to_string())?
    .to_logical::<f64>(scale);
  let outer_size = window.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
  let inner_size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);

  let frame_height = (outer_size.height - inner_size.height).max(0.0);
  let min_height = MIN_WIN_SIZE.1;
  let requested = height.max(min_height);

  // Max logical inner height that keeps the outer bottom inside the work area.
  let max_height = {
    let physical_pos = window.outer_position().map_err(|e| e.to_string())?;
    let monitor = window
      .monitor_from_point(physical_pos.x as f64, physical_pos.y as f64)
      .ok()
      .flatten()
      .or_else(|| window.current_monitor().ok().flatten());

    if let Some(m) = monitor {
      let work = m.work_area();
      let work_bottom = (work.position.y as f64 + work.size.height as f64) / scale;
      let available_outer = (work_bottom - outer_pos.y).max(min_height + frame_height);
      (available_outer - frame_height).max(min_height)
    } else {
      requested
    }
  };

  let set_height = requested.min(max_height);

  // Skip no-op resizes to avoid event churn / flicker.
  if (set_height - inner_size.height).abs() < 0.5 {
    return Ok(());
  }

  window
    .set_size(tauri::LogicalSize::new(inner_size.width, set_height))
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// Re-show an existing hidden window at the cursor and re-register the mouse hook.
fn set_win_visible<R: Runtime>(app: &tauri::AppHandle<R>, win: &WebviewWindow<R>) {
  if let Ok(cursor) = app.cursor_position() {
    adjust_win_position(win, Some(cursor));
  }
  let _ = win.set_always_on_top(true);
  let _ = win.show();
  if win.is_minimized().unwrap_or(false) {
    let _ = win.unminimize();
  }
  let _ = win.set_focus();
  // Fresh hook + grace so screenshot/OCR handoff cannot dismiss on residual mouse motion.
  arm_move_out_grace();
  #[cfg(windows)]
  {
    del_mouse_event();
    reg_mouse_event(Arc::new(win.clone()));
  }
}

/// Ensure the Quick Translate window exists and is visible (cursor-follow on first show).
fn ensure_quick_translate_visible<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
  match app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
    Some(win) => {
      if let Ok(visible) = win.is_visible() {
        if !visible {
          set_win_visible(app, &win);
        }
      }
      true
    }
    None => {
      if let Err(e) = show(app) {
        log::error!("quick_translate_show_failed error={e}");
        return false;
      }
      true
    }
  }
}

/// Double Ctrl+C entry: show at cursor and paste clipboard into the source input.
pub fn try_show_on_cpcp<R: Runtime>(app: &tauri::AppHandle<R>) {
  // Capture clipboard at trigger time so a later flush still uses the intended text.
  let clipboard_text = read_clipboard_text(app);

  if !ensure_quick_translate_visible(app) {
    return;
  }

  if let Some(text) = clipboard_text {
    deliver_or_queue_clipboard(app, text);
  }
}

/// Show Quick Translate (if needed) and deliver source text into the input field.
/// Used after screenshot OCR recognizes non-empty text.
///
/// Always re-anchors via `show` so a previously restored/hidden frame is not left
/// off-cursor, and move-out grace is armed for the post-selection handoff.
pub fn deliver_source_text<R: Runtime>(app: &tauri::AppHandle<R>, text: String) {
  if text.trim().is_empty() {
    return;
  }
  if let Err(e) = show(app) {
    log::error!("quick_translate_show_failed error={e}");
    return;
  }
  deliver_or_queue_clipboard(app, text);
}

/// Drop auto-close mouse hooks when another host flow hides this window (screenshot).
pub fn on_hidden_by_host() {
  del_mouse_event();
  MOVE_OUT_GRACE_UNTIL_MS.store(0, Ordering::SeqCst);
  POINTER_ENTERED.store(false, Ordering::SeqCst);
}

/// Show the Quick Translate window, creating it on first use at the cursor position.
pub fn show<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<WebviewWindow<R>, String> {
  if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
    set_win_visible(app, &win);
    return Ok(win);
  }

  let cursor = app.cursor_position().map_err(|e| e.to_string())?;

  // Logical top-left: horizontally centered on cursor, top edge offset above cursor.
  let (x, y) = app
    .monitor_from_point(cursor.x, cursor.y)
    .map(|monitor| {
      monitor.map_or((cursor.x - INIT_WIN_SIZE.0 / 2.0, cursor.y - CURSOR_TOP_OFFSET), |m| {
        let logical = cursor.to_logical::<f64>(m.scale_factor());
        (logical.x - INIT_WIN_SIZE.0 / 2.0, logical.y - CURSOR_TOP_OFFSET)
      })
    })
    .map_err(|e| e.to_string())?;

  let url = tauri::WebviewUrl::App("/quick-translate".into());
  log::debug!("creating_quick_translate_window route=/quick-translate");

  let mut web_build = WebviewWindowBuilder::new(app, consts::WIN_LABEL_QUICK_TRANSLATE, url);

  #[cfg(windows)]
  {
    web_build = web_build.decorations(false);
  }

  web_build = web_build
    .resizable(true)
    .maximizable(false)
    .fullscreen(false)
    .always_on_top(true)
    .title(consts::APP_NAME)
    .inner_size(INIT_WIN_SIZE.0, INIT_WIN_SIZE.1)
    .min_inner_size(MIN_WIN_SIZE.0, MIN_WIN_SIZE.1)
    .disable_drag_drop_handler()
    .position(x, y)
    .visible(true)
    .on_page_load(move |window, payload| {
      use tauri::webview::PageLoadEvent;
      if payload.event() == PageLoadEvent::Finished {
        record_win_outer_size(&window);
        // Re-anchor with measured outer size so centering matches the real frame.
        // Clipboard delivery waits for frontend notify_ready (listener registered).
        adjust_win_position(&window, Some(cursor));
      }
    });

  #[cfg(not(windows))]
  {
    web_build =
      web_build.initialization_script("document.addEventListener('contextmenu', event => event.preventDefault());");
  }

  let win = web_build.build().map_err(|e| e.to_string())?;

  #[cfg(windows)]
  disable_default_context_menu(&win);

  // Reset pin on (re)creation; state is managed app-level in app_setup.
  if let Some(state) = app.try_state::<QuickTranslateState>() {
    state.reset();
  }

  wire_window_events(&win);
  arm_move_out_grace();
  #[cfg(windows)]
  reg_mouse_event(Arc::new(win.clone()));
  let _ = win.set_focus();

  Ok(win)
}

fn wire_window_events<R: Runtime>(window: &WebviewWindow<R>) {
  let win = Arc::new(window.clone());
  window.on_window_event(move |event| match event {
    tauri::WindowEvent::CloseRequested { api, .. } => {
      api.prevent_close();
      del_mouse_event();
      let _ = win.hide();
    }
    tauri::WindowEvent::Destroyed => {
      del_mouse_event();
      // Next recreation must wait for the frontend listener again.
      if let Some(state) = win.app_handle().try_state::<QuickTranslateState>() {
        state.reset();
      }
    }
    tauri::WindowEvent::Resized(_) => {
      record_win_outer_size(&win);
    }
    #[cfg(not(windows))]
    tauri::WindowEvent::Focused(false) => {
      // Non-Windows fallback for click-outside close (no kmhook).
      let app = win.app_handle();
      if let Some(state) = app.try_state::<QuickTranslateState>() {
        if *state.is_pin.lock().unwrap() {
          return;
        }
      }
      let _ = win.hide();
    }
    _ => {}
  });
}

#[cfg(windows)]
fn check_pos_in_window<R: Runtime>(window: &WebviewWindow<R>, pos: &Pos) -> bool {
  if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
    let (xmin, ymin) = (position.x, position.y);
    let (xmax, ymax) = (xmin + size.width as i32, ymin + size.height as i32);
    if pos.x < xmin || pos.x > xmax || pos.y < ymin || pos.y > ymax {
      return false;
    }
  }
  true
}

#[cfg(windows)]
fn reg_mouse_event<R: Runtime>(window: Arc<WebviewWindow<R>>) {
  if MOUSE_EVENT_ID.load(Ordering::Relaxed) != 0 {
    return;
  }
  // Clicked inside once → only click-outside closes (move-out ignored).
  let once_focus = Arc::new(AtomicBool::new(false));
  let reg_id = mouse_enginer::add_event_listener(
    move |event_type| {
      if let EventType::MouseEvent(Some(event)) = event_type {
        if let Some(MouseButton::Left(state)) = event.button {
          if state == ClickState::Released {
            return;
          }
          if let Some(pin_state) = window.app_handle().try_state::<QuickTranslateState>() {
            if *pin_state.is_pin.lock().unwrap() {
              return;
            }
          }
          if check_pos_in_window(&window, &event.pos) {
            POINTER_ENTERED.store(true, Ordering::SeqCst);
            if state == ClickState::Pressed {
              once_focus.store(true, Ordering::Relaxed);
            }
            return;
          }
          // Click-outside still closes during grace (explicit dismiss).
          log::debug!("quick_translate_close_mouse_left_out");
          let _ = window.close();
        } else if event.button.is_none() {
          if check_pos_in_window(&window, &event.pos) {
            POINTER_ENTERED.store(true, Ordering::SeqCst);
            return;
          }
          // After click-in, only click-outside dismisses.
          if once_focus.load(Ordering::Relaxed) {
            return;
          }
          if let Some(pin_state) = window.app_handle().try_state::<QuickTranslateState>() {
            if *pin_state.is_pin.lock().unwrap() {
              return;
            }
          }
          // Post-show grace: screenshot OCR often delivers while the cursor is still
          // settling from the selection drag — do not dismiss on residual motion.
          if in_move_out_grace() {
            return;
          }
          // Never been inside this show cycle: keep the window until the user enters
          // then leaves, or clicks outside. Prevents instant dismiss when the window
          // opens under a cursor that is already outside the new frame.
          if !POINTER_ENTERED.load(Ordering::SeqCst) {
            return;
          }
          log::debug!("quick_translate_close_mouse_move_out");
          let _ = window.close();
        }
      }
    },
    Some(EventType::MouseEvent(None)),
  );
  if let Ok(id) = reg_id {
    MOUSE_EVENT_ID.store(id, Ordering::Relaxed);
  }
}

fn del_mouse_event() {
  if MOUSE_EVENT_ID.load(Ordering::Relaxed) == 0 {
    return;
  }
  #[cfg(windows)]
  {
    mouse_enginer::del_event_by_id(MOUSE_EVENT_ID.load(Ordering::Relaxed));
  }
  MOUSE_EVENT_ID.store(0, Ordering::Relaxed);
}
