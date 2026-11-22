//! Win32 screen capture: in-memory display snapshots and one selection surface per display.

use std::ffi::c_void;
use std::mem::{MaybeUninit, size_of};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use nsh_core::prelude::*;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLACK_BRUSH, BLENDFUNCTION, BeginPaint,
    BitBlt, CreateCompatibleDC, CreateDIBSection, CreatePen, CreateSolidBrush, DEFAULT_GUI_FONT,
    DIB_RGB_COLORS, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, DeleteDC, DeleteObject,
    DrawTextW, EndPaint, EnumDisplayMonitors, FillRect, GdiAlphaBlend, GetDC, GetMonitorInfoW,
    GetStockObject, HDC, HGDIOBJ, HMONITOR, InvalidateRect, LineTo, MONITORINFO, MONITORINFOEXW,
    MoveToEx, PAINTSTRUCT, PS_DOT, ReleaseDC, SRCCOPY, SelectObject, SetBkMode, SetTextColor,
    TRANSPARENT, WHITE_BRUSH,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, SetFocus, VK_DOWN, VK_ESCAPE, VK_LEFT, VK_RETURN, VK_RIGHT,
    VK_SPACE, VK_TAB, VK_UP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow,
    DispatchMessageW, GWLP_USERDATA, GetMessageW, GetWindowLongPtrW, HC_ACTION, HWND_TOPMOST,
    IDC_CROSS, KBDLLHOOKSTRUCT, LoadCursorW, MSG, PostThreadMessageW, RegisterClassW,
    SWP_NOACTIVATE, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_APP,
    WM_DISPLAYCHANGE, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_PAINT, WM_SYSKEYDOWN, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use super::{
    CaptureCrop, DesktopPoint, KEYBOARD_STEP, MAX_PNG_BYTES, MAX_SNAPSHOT_PIXELS, MonitorRect,
    ScreenCaptureOverlay, ScreenCaptureResult, resolve_capture_rect,
};

/// Height and inset of the instruction band drawn on the active display, in physical pixels.
const CAPTION_HEIGHT: i32 = 56;
const CAPTION_INSET: i32 = 24;
const CAPTION_MAX_WIDTH: i32 = 760;
const CAPTION_MIN_WIDTH: i32 = 240;

/// The black preview mask uses 40% opacity, independent of the app theme.
const MASK_ALPHA: u8 = 102;

/// Thickness and dash length of the selection frame, in physical pixels.
const FRAME_STROKE: i32 = 1;
const FRAME_DASH: i32 = 6;

/// Request posted to the capture worker's queue when TSX cancels the session.
const WM_APP_CANCEL: u32 = WM_APP + 1;
/// A capture key queued by the low-level keyboard hook.
const WM_APP_CAPTURE_KEY: u32 = WM_APP + 2;

/// One in-flight request, so at most one selection session runs at a time.
struct ActiveRequest {
    request_id: u64,
    thread_id: AtomicU32,
    cancelled: Arc<AtomicBool>,
}

static ACTIVE: Mutex<Option<ActiveRequest>> = Mutex::new(None);

/// Starts one capture session on a blocking thread and resolves with its outcome.
pub async fn capture(request_id: u64, overlay: ScreenCaptureOverlay) -> ScreenCaptureResult {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
        if active.is_some() {
            return ScreenCaptureResult::failed();
        }
        *active = Some(ActiveRequest {
            request_id,
            thread_id: AtomicU32::new(0),
            cancelled: cancelled.clone(),
        });
    }

    let worker_cancelled = cancelled.clone();
    let joined = blocking(move || run_session(request_id, worker_cancelled, overlay)).await;

    let mut active = ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
    if active
        .as_ref()
        .is_some_and(|entry| entry.request_id == request_id)
    {
        *active = None;
    }
    drop(active);

    joined.unwrap_or_else(|_| ScreenCaptureResult::failed())
}

/// Cancels `request_id` only; a different active request keeps running.
pub fn cancel(request_id: u64) {
    let active = ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
    let Some(entry) = active.as_ref() else {
        return;
    };
    if entry.request_id != request_id {
        return;
    }
    entry.cancelled.store(true, Ordering::Release);
    let thread_id = entry.thread_id.load(Ordering::Acquire);
    if thread_id != 0 {
        // SAFETY: a plain thread message; the worker's loop reads it before it dispatches.
        unsafe {
            PostThreadMessageW(thread_id, WM_APP_CANCEL, 0, 0);
        }
    }
}

/// Publishes this worker's thread id so `cancel` can post to its queue.
fn publish_thread_id(request_id: u64, thread_id: u32) {
    let mut active = ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(entry) = active.as_mut()
        && entry.request_id == request_id
    {
        entry.thread_id.store(thread_id, Ordering::Release);
    }
}

/// Converts an RGB or RGBA theme token to the opaque Win32 `COLORREF` format.
fn color_ref(value: &str) -> Option<u32> {
    let hex = value.trim().strip_prefix('#')?;
    if !matches!(hex.len(), 6 | 8) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    let rgb = if hex.len() == 8 { value >> 8 } else { value };
    Some(((rgb >> 16) & 0xff) | (rgb & 0x0000_ff00) | ((rgb & 0xff) << 16))
}

/// Keep a readable foreground/background pair if either caption token is invalid.
fn caption_colors(text: &str, backdrop: &str) -> (u32, u32) {
    const LIGHT_TEXT: u32 = 0x00ff_ffff;
    const DARK_BACKDROP: u32 = 0;
    color_ref(text)
        .zip(color_ref(backdrop))
        .unwrap_or((LIGHT_TEXT, DARK_BACKDROP))
}

/// A top-down 32-bit bitmap in a memory DC.
struct Snapshot {
    dc: HDC,
    bitmap: HGDIOBJ,
    previous: HGDIOBJ,
    pixels: *mut u32,
    width: i32,
    height: i32,
}

impl Snapshot {
    /// Copies one display's pixels into memory; `None` when Windows refuses the capture.
    fn capture(rect: MonitorRect) -> Option<Self> {
        // SAFETY: the screen DC is released before returning, even when the copy fails.
        unsafe {
            let screen = GetDC(ptr::null_mut());
            if screen.is_null() {
                return None;
            }
            let result = Self::new(screen, rect.right - rect.left, rect.bottom - rect.top).filter(
                |snapshot| {
                    BitBlt(
                        snapshot.dc,
                        0,
                        0,
                        snapshot.width,
                        snapshot.height,
                        screen,
                        rect.left,
                        rect.top,
                        SRCCOPY,
                    ) != 0
                },
            );
            ReleaseDC(ptr::null_mut(), screen);
            result
        }
    }

    fn black_mask() -> Option<Self> {
        let mask = Self::new(ptr::null_mut(), 1, 1)?;
        // SAFETY: this new DIB owns one pixel and no GDI draw has used it yet.
        unsafe { mask.pixels.write(0) };
        Some(mask)
    }

    /// Composes a cached preview in memory. Blending directly into a window DC can leave its
    /// pixels unchanged even when GdiAlphaBlend reports success.
    fn dimmed(&self, mask: &Self) -> Option<Self> {
        let preview = Self::new(self.dc, self.width, self.height)?;
        // SAFETY: all DCs own separate live bitmaps. Only the preview is a write destination.
        unsafe {
            let copied = BitBlt(
                preview.dc,
                0,
                0,
                self.width,
                self.height,
                self.dc,
                0,
                0,
                SRCCOPY,
            );
            let blended = copied != 0
                && GdiAlphaBlend(
                    preview.dc,
                    0,
                    0,
                    self.width,
                    self.height,
                    mask.dc,
                    0,
                    0,
                    mask.width,
                    mask.height,
                    BLENDFUNCTION {
                        BlendOp: AC_SRC_OVER as u8,
                        BlendFlags: 0,
                        SourceConstantAlpha: MASK_ALPHA,
                        AlphaFormat: 0,
                    },
                ) != 0;
            blended.then_some(preview)
        }
    }

    fn new(reference: HDC, width: i32, height: i32) -> Option<Self> {
        if width <= 0 || height <= 0 {
            return None;
        }
        // SAFETY: every handle created here is either owned by the result or released below.
        unsafe {
            let dc = CreateCompatibleDC(reference);
            if dc.is_null() {
                return None;
            }
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let mut bits: *mut c_void = ptr::null_mut();
            let bitmap = CreateDIBSection(
                reference,
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                ptr::null_mut(),
                0,
            );
            if !bitmap.is_null() && !bits.is_null() {
                let previous = SelectObject(dc, bitmap);
                if !previous.is_null() {
                    return Some(Self {
                        dc,
                        bitmap,
                        previous,
                        pixels: bits.cast::<u32>(),
                        width,
                        height,
                    });
                }
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            DeleteDC(dc);
            None
        }
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        // SAFETY: this snapshot owns the DC, the bitmap and their selection.
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

/// One display's snapshot and selection surface.
struct CaptureWindow {
    rect: MonitorRect,
    hwnd: HWND,
    snapshot: Snapshot,
    dimmed: Snapshot,
    scheduled_layers: Option<OverlayLayers>,
}

impl CaptureWindow {
    fn new(rect: MonitorRect, snapshot: Snapshot, mask: &Snapshot) -> Option<Self> {
        let dimmed = snapshot.dimmed(mask)?;
        Some(Self {
            rect,
            hwnd: ptr::null_mut(),
            snapshot,
            dimmed,
            scheduled_layers: None,
        })
    }
}

impl Drop for CaptureWindow {
    fn drop(&mut self) {
        if !self.hwnd.is_null() {
            // SAFETY: the window belongs to the worker thread that is dropping it.
            unsafe {
                DestroyWindow(self.hwnd);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct OverlayLayers {
    crop: Option<CaptureCrop>,
    crosshair: Option<DesktopPoint>,
    caption: bool,
}

/// Everything one selection session holds while its message loop runs.
struct CaptureState {
    displays: Vec<CaptureWindow>,
    back_buffer: Option<Snapshot>,
    caption: Vec<u16>,
    accent: u32,
    text: u32,
    backdrop: u32,
    anchor: Option<DesktopPoint>,
    cursor: Option<DesktopPoint>,
    active: usize,
    keyboard: bool,
    outcome: Option<ScreenCaptureResult>,
}

/// Copies the confirmed crop out of its display snapshot and encodes it as PNG.
fn encode_crop(state: &CaptureState, crop: CaptureCrop) -> ScreenCaptureResult {
    let Some(display) = state.displays.get(crop.monitor) else {
        return ScreenCaptureResult::failed();
    };
    let width = crop.width.max(0) as usize;
    let height = crop.height.max(0) as usize;
    if width == 0 || height == 0 {
        return ScreenCaptureResult::failed();
    }
    let stride = display.snapshot.width.max(0) as usize;
    let left = crop.x.max(0) as usize;
    let top = crop.y.max(0) as usize;
    if left + width > stride || top + height > display.snapshot.height.max(0) as usize {
        return ScreenCaptureResult::failed();
    }

    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        let start = (top + row) * stride + left;
        for column in 0..width {
            // SAFETY: the row and column ranges were checked against the snapshot size.
            let pixel = unsafe { *display.snapshot.pixels.add(start + column) };
            rgb.push(((pixel >> 16) & 0xff) as u8);
            rgb.push(((pixel >> 8) & 0xff) as u8);
            rgb.push((pixel & 0xff) as u8);
        }
    }

    let mut png: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let Ok(mut writer) = encoder.write_header() else {
            return ScreenCaptureResult::failed();
        };
        if writer.write_image_data(&rgb).is_err() || writer.finish().is_err() {
            return ScreenCaptureResult::failed();
        }
    }
    if png.len() > MAX_PNG_BYTES {
        return ScreenCaptureResult::too_large();
    }
    ScreenCaptureResult::captured(png)
}

/// Ends the session with the confirmed rectangle, if the drag left any pixels.
fn finish_selection(state: &mut CaptureState) {
    let Some(crop) = resolve_selection(state) else {
        return;
    };
    state.outcome = Some(encode_crop(state, crop));
}

/// Resolves the current drag against the display it started on.
fn resolve_selection(state: &CaptureState) -> Option<CaptureCrop> {
    let anchor = state.anchor?;
    let cursor = state.cursor?;
    state
        .displays
        .iter()
        .enumerate()
        .find_map(|(index, display)| {
            resolve_capture_rect(std::slice::from_ref(&display.rect), anchor, cursor).map(|crop| {
                CaptureCrop {
                    monitor: index,
                    ..crop
                }
            })
        })
}

/// Index of the display backing `hwnd`.
fn display_index(state: &CaptureState, hwnd: HWND) -> Option<usize> {
    state
        .displays
        .iter()
        .position(|display| display.hwnd == hwnd)
}

/// Translates a mouse message's client coordinates into a physical desktop point.
fn pointer_point(state: &CaptureState, hwnd: HWND, lparam: LPARAM) -> Option<DesktopPoint> {
    let index = display_index(state, hwnd)?;
    let rect = state.displays[index].rect;
    let x = (lparam & 0xffff) as u16 as i16 as i32;
    let y = ((lparam >> 16) & 0xffff) as u16 as i16 as i32;
    Some(DesktopPoint {
        x: rect.left.saturating_add(x),
        y: rect.top.saturating_add(y),
    })
}

/// Center of one display, used as the first keyboard crosshair position.
fn display_center(rect: MonitorRect) -> DesktopPoint {
    DesktopPoint {
        x: rect.left + (rect.right - rect.left) / 2,
        y: rect.top + (rect.bottom - rect.top) / 2,
    }
}

fn overlay_layers(state: &CaptureState, index: usize, crop: Option<CaptureCrop>) -> OverlayLayers {
    OverlayLayers {
        crop: crop.filter(|crop| crop.monitor == index),
        crosshair: state
            .cursor
            .filter(|&cursor| state.keyboard && state.displays[index].rect.contains(cursor)),
        caption: index == state.active && !state.caption.is_empty(),
    }
}

/// Schedules repaint only where content changed. An untouched display keeps its dimmed preview.
fn invalidate_changed(state: &mut CaptureState) {
    let crop = resolve_selection(state);
    for index in 0..state.displays.len() {
        let layers = overlay_layers(state, index, crop);
        let display = &mut state.displays[index];
        if display.scheduled_layers == Some(layers) {
            continue;
        }
        display.scheduled_layers = Some(layers);
        // SAFETY: each window belongs to this worker thread.
        unsafe {
            InvalidateRect(display.hwnd, ptr::null(), 0);
        }
    }
}

/// Brings the active display's surface to the foreground so keys reach it.
fn focus_active(state: &CaptureState) {
    let Some(display) = state.displays.get(state.active) else {
        return;
    };
    // SAFETY: plain window management calls on this worker thread's windows.
    unsafe {
        SetForegroundWindow(display.hwnd);
        BringWindowToTop(display.hwnd);
        SetFocus(display.hwnd);
    }
}

/// Moves keyboard focus and the crosshair to the next display.
fn cycle_display(state: &mut CaptureState) {
    if state.displays.len() < 2 {
        return;
    }
    state.active = (state.active + 1) % state.displays.len();
    state.keyboard = true;
    let rect = state.displays[state.active].rect;
    state.cursor = Some(match state.cursor {
        Some(point) => DesktopPoint {
            x: point.x.clamp(rect.left, rect.right - 1),
            y: point.y.clamp(rect.top, rect.bottom - 1),
        },
        None => display_center(rect),
    });
    focus_active(state);
    invalidate_changed(state);
}

/// Moves the keyboard crosshair by one step inside the active display.
fn move_crosshair(state: &mut CaptureState, vk: u16) {
    let Some(display) = state.displays.get(state.active) else {
        return;
    };
    let rect = display.rect;
    let mut point = state.cursor.unwrap_or_else(|| display_center(rect));
    match vk {
        VK_LEFT => point.x -= KEYBOARD_STEP,
        VK_RIGHT => point.x += KEYBOARD_STEP,
        VK_UP => point.y -= KEYBOARD_STEP,
        VK_DOWN => point.y += KEYBOARD_STEP,
        _ => return,
    }
    point.x = point.x.clamp(rect.left, rect.right - 1);
    point.y = point.y.clamp(rect.top, rect.bottom - 1);
    state.cursor = Some(point);
    state.keyboard = true;
    invalidate_changed(state);
}

/// Applies one capture key, in any focus state, through the low-level keyboard hook.
fn handle_key(state: &mut CaptureState, vk: u16) {
    match vk {
        VK_ESCAPE => state.outcome = Some(ScreenCaptureResult::cancelled()),
        VK_TAB => cycle_display(state),
        VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN => move_crosshair(state, vk),
        VK_SPACE => {
            state.keyboard = true;
            if let Some(point) = state.cursor {
                state.anchor = Some(point);
                invalidate_changed(state);
            }
        }
        VK_RETURN if state.anchor.is_some() => finish_selection(state),
        _ => {}
    }
}

/// Whether a key belongs to the capture session; other keys pass to the app behind.
fn is_capture_key(vk: u16) -> bool {
    matches!(
        vk,
        VK_ESCAPE | VK_TAB | VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_SPACE | VK_RETURN
    )
}

/// Reuses one back buffer on the capture thread and draws everything before presenting it.
fn compose_frame(state: &mut CaptureState, index: usize) -> Option<HDC> {
    let layers = overlay_layers(state, index, resolve_selection(state));
    let display = &state.displays[index];
    if layers == OverlayLayers::default() {
        return Some(display.dimmed.dc);
    }

    let width = display.snapshot.width;
    let height = display.snapshot.height;
    if state
        .back_buffer
        .as_ref()
        .is_none_or(|buffer| buffer.width != width || buffer.height != height)
    {
        state.back_buffer = Snapshot::new(display.dimmed.dc, width, height);
    }
    let dc = state.back_buffer.as_ref()?.dc;
    paint_preview(dc, &display.snapshot, &display.dimmed, layers.crop);
    if let Some(cursor) = layers.crosshair {
        draw_crosshair(dc, state.accent, cursor, display.rect);
    }
    if layers.caption {
        draw_caption(dc, state, width);
    }
    Some(dc)
}

/// Presents a complete frame in one window blit so intermediate layers are never shown.
fn paint(hwnd: HWND, state: &mut CaptureState) {
    let Some(index) = display_index(state, hwnd) else {
        return;
    };
    let source = compose_frame(state, index);
    let mut paint = MaybeUninit::<PAINTSTRUCT>::zeroed();
    // SAFETY: `paint` is a stack-allocated out-parameter for this window's paint cycle.
    let hdc = unsafe { BeginPaint(hwnd, paint.as_mut_ptr()) };
    if hdc.is_null() {
        return;
    }
    // SAFETY: BeginPaint filled the structure, and the source, if present, stays live.
    unsafe {
        let paint = paint.assume_init();
        if let Some(source) = source {
            let rect = paint.rcPaint;
            BitBlt(
                hdc,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                source,
                rect.left,
                rect.top,
                SRCCOPY,
            );
        } else {
            state.outcome = Some(ScreenCaptureResult::failed());
        }
        EndPaint(hwnd, &paint);
    }
}

/// Presents the cached dimmed preview and restores original pixels through the selection.
fn paint_preview(hdc: HDC, snapshot: &Snapshot, dimmed: &Snapshot, crop: Option<CaptureCrop>) {
    // SAFETY: all DCs are live, and the crop is already clipped to the snapshot bounds.
    unsafe {
        BitBlt(
            hdc,
            0,
            0,
            dimmed.width,
            dimmed.height,
            dimmed.dc,
            0,
            0,
            SRCCOPY,
        );
        if let Some(crop) = crop {
            BitBlt(
                hdc,
                crop.x,
                crop.y,
                crop.width,
                crop.height,
                snapshot.dc,
                crop.x,
                crop.y,
                SRCCOPY,
            );
            let rect = RECT {
                left: crop.x,
                top: crop.y,
                right: crop.x + crop.width,
                bottom: crop.y + crop.height,
            };
            draw_selection_frame(hdc, rect);
        }
    }
}

/// Paints the selection edge as alternating dark and light dashes, so the boundary reads as
/// dashed and stays visible on light and dark content.
fn draw_selection_frame(hdc: HDC, rect: RECT) {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return;
    }
    let stroke = FRAME_STROKE.min(width / 2).min(height / 2).max(1);
    let mut dark = true;
    let mut remaining = FRAME_DASH;

    // Walk clockwise from the top-left corner so the dash rhythm carries across corners.
    for (band, horizontal, forward, length) in [
        (rect.top, true, true, width),
        (rect.right - stroke, false, true, height),
        (rect.bottom - stroke, true, false, width),
        (rect.left, false, false, height),
    ] {
        let mut offset = 0;
        while offset < length {
            let run = remaining.min(length - offset);
            let first = if forward {
                offset
            } else {
                length - offset - run
            };
            let dash = if horizontal {
                RECT {
                    left: rect.left + first,
                    top: band,
                    right: rect.left + first + run,
                    bottom: band + stroke,
                }
            } else {
                RECT {
                    left: band,
                    top: rect.top + first,
                    right: band + stroke,
                    bottom: rect.top + first + run,
                }
            };
            // SAFETY: FillRect only reads the dash rectangle and the stock brush.
            unsafe {
                FillRect(
                    hdc,
                    &dash,
                    GetStockObject(if dark { BLACK_BRUSH } else { WHITE_BRUSH }),
                );
            }
            offset += run;
            remaining -= run;
            if remaining == 0 {
                dark = !dark;
                remaining = FRAME_DASH;
            }
        }
    }
}

/// Draws the dotted keyboard crosshair across the active display.
fn draw_crosshair(hdc: HDC, accent: u32, cursor: DesktopPoint, rect: MonitorRect) {
    let x = cursor.x - rect.left;
    let y = cursor.y - rect.top;
    // SAFETY: the dotted pen is selected back and deleted.
    unsafe {
        let pen = CreatePen(PS_DOT, 1, accent);
        let previous = SelectObject(hdc, pen);
        MoveToEx(hdc, x, 0, ptr::null_mut());
        LineTo(hdc, x, rect.bottom - rect.top);
        MoveToEx(hdc, 0, y, ptr::null_mut());
        LineTo(hdc, rect.right - rect.left, y);
        SelectObject(hdc, previous);
        DeleteObject(pen);
    }
}

/// Draws the localized instruction band at the top of the active display.
fn draw_caption(hdc: HDC, state: &CaptureState, display_width: i32) {
    let box_width = (display_width - CAPTION_INSET * 2).clamp(CAPTION_MIN_WIDTH, CAPTION_MAX_WIDTH);
    let left = (display_width - box_width) / 2;
    let mut rect = RECT {
        left,
        top: CAPTION_INSET,
        right: left + box_width,
        bottom: CAPTION_INSET + CAPTION_HEIGHT,
    };

    // SAFETY: the brush and the font are released inside the call.
    unsafe {
        let brush = CreateSolidBrush(state.backdrop);
        FillRect(hdc, &rect, brush);
        DeleteObject(brush);

        let previous_font = SelectObject(hdc, GetStockObject(DEFAULT_GUI_FONT));
        SetBkMode(hdc, TRANSPARENT as i32);
        SetTextColor(hdc, state.text);
        DrawTextW(
            hdc,
            state.caption.as_ptr(),
            state.caption.len() as i32,
            &mut rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
        );
        SelectObject(hdc, previous_font);
    }
}

/// Window procedure shared by every selection surface.
unsafe extern "system" fn capture_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_ERASEBKGND {
        return 1;
    }

    // SAFETY: the window's user data holds the live `CaptureState` set before it was shown,
    // and every window is destroyed before that state is dropped.
    let state = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut CaptureState };
    if state.is_null() {
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    let state = unsafe { &mut *state };

    match msg {
        WM_PAINT => {
            paint(hwnd, state);
            0
        }
        WM_LBUTTONDOWN => {
            if let Some(point) = pointer_point(state, hwnd, lparam) {
                if let Some(index) = display_index(state, hwnd) {
                    state.active = index;
                }
                state.anchor = Some(point);
                state.cursor = Some(point);
                state.keyboard = false;
                // SAFETY: capture belongs to this worker thread's window.
                unsafe {
                    SetCapture(hwnd);
                }
                invalidate_changed(state);
            }
            0
        }
        WM_MOUSEMOVE => {
            if state.anchor.is_some()
                && let Some(point) = pointer_point(state, hwnd, lparam)
                && state.cursor != Some(point)
            {
                state.cursor = Some(point);
                invalidate_changed(state);
            }
            0
        }
        WM_LBUTTONUP => {
            // SAFETY: releases the capture taken on press.
            unsafe {
                ReleaseCapture();
            }
            if let Some(point) = pointer_point(state, hwnd, lparam) {
                state.cursor = Some(point);
                finish_selection(state);
            }
            state.anchor = None;
            state.keyboard = false;
            if state.outcome.is_none() {
                invalidate_changed(state);
            }
            0
        }
        WM_KEYDOWN => {
            // The hook consumes keys it queues; this path covers a missing or failed hook.
            handle_key(state, wparam as u16);
            0
        }
        WM_DISPLAYCHANGE => {
            if state.outcome.is_none() {
                state.outcome = Some(ScreenCaptureResult::cancelled());
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Low-level keyboard hook: capture keys work even when another window holds the focus.
unsafe extern "system" fn capture_keyboard_hook(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32
        && (wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize)
    {
        // SAFETY: the hook always receives a `KBDLLHOOKSTRUCT` in `lparam`.
        let key = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let vk = key.vkCode as u16;
        // The hook runs inside GetMessageW. Post a message so the loop wakes even if no
        // other input arrives. In particular, crop encoding must not run inside the hook.
        // SAFETY: the hook runs on the installing thread, which owns this message queue.
        if is_capture_key(vk)
            && unsafe { PostThreadMessageW(GetCurrentThreadId(), WM_APP_CAPTURE_KEY, vk.into(), 0) }
                != 0
        {
            return 1;
        }
    }
    // SAFETY: chains to the next hook; no hook was skipped for the keys handled above.
    unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
}

/// Collects one display's physical rectangle; the camera is the caller's `Vec`.
unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _hdc: HDC,
    _clip: *mut RECT,
    data: LPARAM,
) -> windows_sys::core::BOOL {
    // SAFETY: `data` points to the `Vec<MonitorRect>` passed to `EnumDisplayMonitors`.
    let monitors = unsafe { &mut *(data as *mut Vec<MonitorRect>) };
    let info = MaybeUninit::<MONITORINFOEXW>::zeroed();
    // SAFETY: the out-parameter is zeroed and `cbSize` is set before the call.
    let mut info = unsafe { info.assume_init() };
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let found = unsafe { GetMonitorInfoW(monitor, (&mut info.monitorInfo) as *mut MONITORINFO) };
    if found == 0 {
        return 1;
    }
    let bounds = unsafe { ptr::addr_of!(info.monitorInfo.rcMonitor).read() };
    monitors.push(MonitorRect::new(
        bounds.left,
        bounds.top,
        bounds.right,
        bounds.bottom,
    ));
    1
}

/// Every active display, in the order Windows reports them.
fn enumerate_displays() -> Vec<MonitorRect> {
    let mut monitors: Vec<MonitorRect> = Vec::new();
    // SAFETY: the callback only writes to `monitors`, which outlives the call.
    let found = unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(collect_monitor),
            ptr::addr_of_mut!(monitors) as LPARAM,
        )
    };
    if found == 0 {
        monitors.clear();
    }
    monitors.retain(MonitorRect::has_area);
    monitors
}

/// Registers the shared overlay window class once per process.
fn register_overlay_class() -> bool {
    static REGISTERED: Mutex<bool> = Mutex::new(false);
    let mut registered = REGISTERED.lock().unwrap_or_else(|error| error.into_inner());
    if *registered {
        return true;
    }
    let class_name: Vec<u16> = "NshScreenCaptureOverlay"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let window_class = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(capture_wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        // SAFETY: the module handle of this executable is a valid instance handle.
        hInstance: unsafe { GetModuleHandleW(ptr::null()) },
        hIcon: ptr::null_mut(),
        // SAFETY: a shared system cursor resource, never destroyed here.
        hCursor: unsafe { LoadCursorW(ptr::null_mut(), IDC_CROSS) },
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    // SAFETY: the class name outlives the registration call, and the procedure is `'static`.
    let atom = unsafe { RegisterClassW(&window_class) };
    *registered = atom != 0;
    *registered
}

/// Creates one frameless surface per display and points it at the session state.
fn create_windows(state: &mut CaptureState) -> bool {
    let class_name: Vec<u16> = "NshScreenCaptureOverlay"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let state_pointer = ptr::from_mut(state);

    for index in 0..state.displays.len() {
        let rect = state.displays[index].rect;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        // SAFETY: the class is registered, the instance is this executable's, and the state
        // pointer stays valid until every window is destroyed.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                class_name.as_ptr(),
                WS_POPUP,
                rect.left,
                rect.top,
                width,
                height,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                state_pointer.cast(),
            )
        };
        if hwnd.is_null() {
            return false;
        }
        // SAFETY: the window belongs to this thread and holds the pointer until destruction.
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_pointer as isize);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                rect.left,
                rect.top,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
        state.displays[index].hwnd = hwnd;
    }
    true
}

/// Snapshot of the requested result and the rented Win32 resources for one session.
fn run_session(
    request_id: u64,
    cancelled: Arc<AtomicBool>,
    overlay: ScreenCaptureOverlay,
) -> ScreenCaptureResult {
    // SAFETY: the call only adjusts this worker thread's DPI context.
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        publish_thread_id(request_id, GetCurrentThreadId());
    }
    if cancelled.load(Ordering::Acquire) {
        return ScreenCaptureResult::cancelled();
    }

    let monitors = enumerate_displays();
    if monitors.is_empty() {
        return ScreenCaptureResult::failed();
    }
    let total_pixels: u64 = monitors.iter().map(MonitorRect::pixel_count).sum();
    if total_pixels == 0 || total_pixels > MAX_SNAPSHOT_PIXELS {
        return ScreenCaptureResult::failed();
    }
    if !register_overlay_class() {
        return ScreenCaptureResult::failed();
    }

    let Some(mask) = Snapshot::black_mask() else {
        return ScreenCaptureResult::failed();
    };
    let mut displays = Vec::with_capacity(monitors.len());
    for rect in monitors {
        let Some(display) =
            Snapshot::capture(rect).and_then(|snapshot| CaptureWindow::new(rect, snapshot, &mask))
        else {
            return ScreenCaptureResult::failed();
        };
        displays.push(display);
    }
    drop(mask);

    let (text, backdrop) = caption_colors(&overlay.text_color, &overlay.backdrop_color);
    let mut state = CaptureState {
        displays,
        back_buffer: None,
        caption: overlay.caption.encode_utf16().collect(),
        accent: color_ref(&overlay.accent_color).unwrap_or(text),
        text,
        backdrop,
        anchor: None,
        cursor: None,
        active: 0,
        keyboard: false,
        outcome: None,
    };

    if !create_windows(&mut state) {
        return ScreenCaptureResult::failed();
    }

    // The hook carries capture keys whatever window holds the focus; focus still helps the mouse.
    // SAFETY: a thread-wide low-level hook on this thread's queue, unhooked before returning.
    let hook = unsafe {
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(capture_keyboard_hook),
            ptr::null_mut(),
            0,
        )
    };
    focus_active(&state);
    invalidate_changed(&mut state);

    loop {
        if cancelled.load(Ordering::Acquire) {
            state.outcome = Some(ScreenCaptureResult::cancelled());
            break;
        }
        let mut message = MaybeUninit::<MSG>::zeroed();
        // SAFETY: `message` is an out-parameter for this thread's queue.
        let received = unsafe { GetMessageW(message.as_mut_ptr(), ptr::null_mut(), 0, 0) };
        if received <= 0 {
            break;
        }
        // SAFETY: `GetMessageW` returned a message, so the value is initialized.
        let message = unsafe { message.assume_init() };
        if message.hwnd.is_null() {
            match message.message {
                WM_APP_CANCEL => state.outcome = Some(ScreenCaptureResult::cancelled()),
                WM_APP_CAPTURE_KEY => handle_key(&mut state, message.wParam as u16),
                _ => {}
            }
        } else {
            // SAFETY: standard dispatch of this thread's messages to its windows.
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if state.outcome.is_some() {
            break;
        }
    }

    // SAFETY: releases this thread's hook and any pointer capture before the state drops.
    unsafe {
        if !hook.is_null() {
            UnhookWindowsHookEx(hook);
        }
        ReleaseCapture();
    }

    state
        .outcome
        .take()
        .unwrap_or_else(ScreenCaptureResult::cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Graphics::Gdi::{GetPixel, GetUpdateRect, UpdateWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumThreadWindows, IsWindowVisible, PM_REMOVE, PeekMessageW, SendMessageW,
    };

    #[test]
    fn theme_colors_keep_their_rgb_channels_with_or_without_alpha() {
        assert_eq!(color_ref("#123456ff"), Some(0x0056_3412));
        assert_eq!(color_ref("#123456"), Some(0x0056_3412));
        assert_eq!(
            caption_colors("#0a0a0aff", "#ffffffff"),
            (0x000a_0a0a, 0x00ff_ffff)
        );
        assert_eq!(
            caption_colors("#fafafaff", "#0a0a0aff"),
            (0x00fa_fafa, 0x000a_0a0a)
        );
        assert_eq!(caption_colors("#fafafaXY", "#ffffffff"), (0x00ff_ffff, 0));
    }

    #[test]
    fn preview_dims_only_unselected_pixels_and_keeps_the_crop_unmodified() {
        let frame = Snapshot::new(ptr::null_mut(), 32, 32).unwrap();
        let preview = Snapshot::new(frame.dc, 32, 32).unwrap();
        let mask = Snapshot::black_mask().unwrap();
        let crop = CaptureCrop {
            monitor: 0,
            x: 8,
            y: 8,
            width: 16,
            height: 16,
        };
        for (original, dim_range) in [(0x00ff_ffff, 152..=153), (0x0020_2020, 18..=19)] {
            // SAFETY: the source DIB holds 32 × 32 pixels. GDI only reads it in `paint_preview`.
            unsafe { std::slice::from_raw_parts_mut(frame.pixels, 32 * 32).fill(original) };
            let pixel = |x, y| unsafe { GetPixel(preview.dc, x, y) };
            let dimmed = frame.dimmed(&mask).unwrap();

            paint_preview(preview.dc, &frame, &dimmed, Some(crop));
            assert!(dim_range.contains(&(pixel(4, 4) & 0xff)));
            assert_eq!(pixel(7, 16), pixel(4, 4));
            assert_eq!(pixel(16, 16), original);

            let inside = 8 + FRAME_STROKE..24 - FRAME_STROKE;
            let edge: Vec<(u32, i32)> = inside.fold(Vec::new(), |mut runs, y| {
                let color = pixel(8, y);
                assert_eq!(
                    pixel(8 + FRAME_STROKE, y),
                    original,
                    "the frame is {FRAME_STROKE} pixels thick"
                );
                match runs.last_mut() {
                    Some((last, count)) if *last == color => *count += 1,
                    _ => runs.push((color, 1)),
                }
                runs
            });
            assert!(edge.iter().any(|&(color, _)| color == 0));
            assert!(edge.iter().any(|&(color, _)| color == 0x00ff_ffff));
            assert!(edge.iter().all(|&(_, count)| count <= FRAME_DASH));
            assert_eq!(unsafe { GetPixel(frame.dc, 8, 16) }, original);
            assert_eq!(unsafe { GetPixel(frame.dc, 4, 4) }, original);

            paint_preview(preview.dc, &frame, &dimmed, None);
            assert_eq!(pixel(16, 16), pixel(4, 4));
        }
    }

    #[test]
    fn terminal_capture_keys_post_a_message_without_other_input() {
        let mut message = MaybeUninit::<MSG>::zeroed();
        // SAFETY: this starts the test thread's message queue without real input.
        unsafe {
            PeekMessageW(message.as_mut_ptr(), ptr::null_mut(), 0, 0, PM_REMOVE);
        }

        for key in [VK_ESCAPE, VK_RETURN] {
            let event = KBDLLHOOKSTRUCT {
                vkCode: key.into(),
                ..Default::default()
            };
            // SAFETY: the hook receives a valid keyboard event for the duration of the call.
            let handled = unsafe {
                capture_keyboard_hook(
                    HC_ACTION as i32,
                    WM_KEYDOWN as usize,
                    &event as *const _ as LPARAM,
                )
            };
            assert_eq!(handled, 1);
            // SAFETY: reads the posted key from this test thread's queue.
            let received = unsafe {
                PeekMessageW(
                    message.as_mut_ptr(),
                    ptr::null_mut(),
                    WM_APP_CAPTURE_KEY,
                    WM_APP_CAPTURE_KEY,
                    PM_REMOVE,
                )
            };
            assert_ne!(received, 0);
            let posted = unsafe { message.assume_init_read() };
            assert_eq!(posted.wParam, usize::from(key));
        }
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn desktop_overlay_presents_the_complete_frame_on_the_affected_display() {
        const SIDE: i32 = 320;
        let mask = Snapshot::black_mask().unwrap();
        let display = |left| {
            let frame = Snapshot::new(ptr::null_mut(), SIDE, SIDE).unwrap();
            // SAFETY: the new DIB owns SIDE × SIDE pixels and has not been drawn into.
            unsafe {
                std::slice::from_raw_parts_mut(frame.pixels, (SIDE * SIDE) as usize)
                    .fill(0x00ff_ffff)
            };
            CaptureWindow::new(MonitorRect::new(left, 0, left + SIDE, SIDE), frame, &mask).unwrap()
        };
        let (text, backdrop) = caption_colors("#0a0a0aff", "#ffffffff");
        let mut state = CaptureState {
            displays: vec![display(0), display(SIDE)],
            back_buffer: None,
            caption: "Test: OCR preview".encode_utf16().collect(),
            accent: 0,
            text,
            backdrop,
            anchor: Some(DesktopPoint { x: 16, y: 88 }),
            cursor: Some(DesktopPoint { x: 48, y: 120 }),
            active: 0,
            keyboard: false,
            outcome: None,
        };
        assert!(register_overlay_class() && create_windows(&mut state));
        let hwnd = state.displays[0].hwnd;
        let other_hwnd = state.displays[1].hwnd;
        invalidate_changed(&mut state);
        let samples = |window, text, backdrop| {
            // SAFETY: this test owns the live window and samples only its synthetic preview.
            unsafe {
                UpdateWindow(window);
                let dc = GetDC(window);
                assert!(!dc.is_null());
                let selection = [GetPixel(dc, 32, 100), GetPixel(dc, 88, 100)];
                let caption_background = GetPixel(dc, CAPTION_INSET + 4, CAPTION_INSET + 4);
                let caption_has_glyph = (CAPTION_INSET + 12..CAPTION_INSET + CAPTION_HEIGHT - 12)
                    .any(|y| (SIDE / 2 - 60..SIDE / 2 + 60).any(|x| GetPixel(dc, x, y) == text));
                ReleaseDC(window, dc);
                assert_eq!(caption_background, backdrop);
                assert!(
                    caption_has_glyph,
                    "the caption must have a visible text pixel"
                );
                selection
            }
        };
        // SAFETY: both windows are owned by this test thread.
        unsafe { UpdateWindow(other_hwnd) };
        assert_eq!(
            samples(hwnd, state.text, state.backdrop),
            [0x00ff_ffff, 0x0099_9999]
        );

        (state.text, state.backdrop) = caption_colors("#fafafaff", "#0a0a0aff");
        // SAFETY: this sends a drag update only to the test's own window.
        unsafe {
            SendMessageW(hwnd, WM_MOUSEMOVE, 0, (120 << 16) | 104);
            assert_ne!(GetUpdateRect(hwnd, ptr::null_mut(), 0), 0);
            assert_eq!(GetUpdateRect(other_hwnd, ptr::null_mut(), 0), 0);
        }
        assert_eq!(
            samples(hwnd, state.text, state.backdrop),
            [0x00ff_ffff, 0x00ff_ffff]
        );

        unsafe { SendMessageW(hwnd, WM_MOUSEMOVE, 0, (120 << 16) | 8) };
        assert_eq!(
            samples(hwnd, state.text, state.backdrop),
            [0x0099_9999, 0x0099_9999]
        );
    }

    // Opt in on a Windows desktop: this creates the real selection surfaces and snapshots.
    // Send keys only to this capture worker, not to the global input stream.
    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn desktop_overlay_confirms_and_cancels_on_keyboard_messages() {
        use super::super::ScreenCaptureStatus;

        let captured = run_desktop_selection(&[VK_RIGHT, VK_SPACE, VK_RIGHT, VK_DOWN, VK_RETURN]);
        assert_eq!(captured.status, ScreenCaptureStatus::Captured);
        let png = captured.png.expect("keyboard confirmation returns a crop");
        let decoded = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .expect("the crop is a PNG");
        assert_eq!(decoded.info().width, KEYBOARD_STEP as u32);
        assert_eq!(decoded.info().height, KEYBOARD_STEP as u32);

        let cancelled = run_desktop_selection(&[VK_ESCAPE]);
        assert_eq!(cancelled.status, ScreenCaptureStatus::Cancelled);
        assert!(cancelled.png.is_none());
    }

    fn run_desktop_selection(keys: &[u16]) -> ScreenCaptureResult {
        unsafe extern "system" fn find_visible(hwnd: HWND, data: LPARAM) -> i32 {
            if unsafe { IsWindowVisible(hwnd) } != 0 {
                // SAFETY: EnumThreadWindows uses this pointer only during the call.
                unsafe { *(data as *mut bool) = true };
                return 0;
            }
            1
        }

        let thread_id = unsafe { GetCurrentThreadId() };
        let cancelled = Arc::new(AtomicBool::new(false));
        let (finished, done) = mpsc::channel();
        let timeout = Duration::from_secs(3);
        thread::scope(|scope| {
            let cancelled_by_timeout = cancelled.clone();
            let sender = scope.spawn(move || {
                let deadline = Instant::now() + timeout;
                while Instant::now() < deadline {
                    let mut ready = false;
                    // SAFETY: this test's capture worker has no windows other than its overlays.
                    unsafe {
                        EnumThreadWindows(
                            thread_id,
                            Some(find_visible),
                            ptr::addr_of_mut!(ready) as LPARAM,
                        )
                    };
                    if ready {
                        let sent = keys.iter().all(|&key| unsafe {
                            PostThreadMessageW(thread_id, WM_APP_CAPTURE_KEY, key.into(), 0) != 0
                        });
                        if sent && done.recv_timeout(timeout).is_ok() {
                            return true;
                        }
                        break;
                    }
                    thread::sleep(Duration::from_millis(15));
                }
                cancelled_by_timeout.store(true, Ordering::Release);
                unsafe { PostThreadMessageW(thread_id, WM_APP_CANCEL, 0, 0) };
                false
            });
            let result = run_session(
                0,
                cancelled.clone(),
                ScreenCaptureOverlay {
                    caption: "Test: OCR region selection".into(),
                    accent_color: "#ffffff".into(),
                    text_color: "#ffffff".into(),
                    backdrop_color: "#000000".into(),
                },
            );
            let _ = finished.send(());
            assert!(
                sender.join().unwrap(),
                "desktop selection did not complete from the queued keys"
            );
            result
        })
    }
}
