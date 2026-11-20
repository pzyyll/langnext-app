//! Screen region capture: display rectangle math plus the native selection session.

use nsh_core::prelude::*;

#[cfg(windows)]
mod windows;

/// Largest snapshot budget for all displays together, in physical pixels, before allocation.
pub const MAX_SNAPSHOT_PIXELS: u64 = 64 * 1024 * 1024;

/// Largest PNG the OCR upload accepts; checked before the bytes reach TSX.
pub const MAX_PNG_BYTES: usize = 3 * 1024 * 1024;

/// Physical pixels one arrow-key press moves the keyboard crosshair.
pub const KEYBOARD_STEP: i32 = 8;

/// A display's physical rectangle in virtual-desktop coordinates; both origins can be negative.
/// `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRect {
    /// Left edge, physical pixels, virtual-desktop coordinates.
    pub left: i32,
    /// Top edge, physical pixels, virtual-desktop coordinates.
    pub top: i32,
    /// Right edge, exclusive.
    pub right: i32,
    /// Bottom edge, exclusive.
    pub bottom: i32,
}

impl MonitorRect {
    /// Builds a display rectangle from its desktop edges.
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    /// Whether this display has a positive capture area.
    pub fn has_area(&self) -> bool {
        self.right > self.left && self.bottom > self.top
    }

    /// Whether desktop `point` falls inside this display.
    pub fn contains(&self, point: DesktopPoint) -> bool {
        i64::from(point.x) >= i64::from(self.left)
            && i64::from(point.x) < i64::from(self.right)
            && i64::from(point.y) >= i64::from(self.top)
            && i64::from(point.y) < i64::from(self.bottom)
    }

    /// Pixel count of this display, or zero when it is degenerate.
    pub fn pixel_count(&self) -> u64 {
        if !self.has_area() {
            return 0;
        }
        (i64::from(self.right) - i64::from(self.left)) as u64
            * (i64::from(self.bottom) - i64::from(self.top)) as u64
    }
}

/// A physical point on the virtual desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopPoint {
    /// Horizontal position, physical pixels.
    pub x: i32,
    /// Vertical position, physical pixels.
    pub y: i32,
}

/// A monitor-local crop of one snapshot in physical pixels; `width` and `height` are positive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureCrop {
    /// Index of the display the selection started on.
    pub monitor: usize,
    /// Left offset inside that display's snapshot.
    pub x: i32,
    /// Top offset inside that display's snapshot.
    pub y: i32,
    /// Crop width in pixels.
    pub width: i32,
    /// Crop height in pixels.
    pub height: i32,
}

/// Turns one drag into a display-local crop.
///
/// The drag is normalized, so either direction works, then clipped to the display under
/// `anchor`: pointer-down chooses the display and the selection never crosses its edge.
/// Returns `None` for a degenerate drag, so a click without movement never yields an image.
pub fn resolve_capture_rect(
    monitors: &[MonitorRect],
    anchor: DesktopPoint,
    cursor: DesktopPoint,
) -> Option<CaptureCrop> {
    let (index, monitor) = monitors
        .iter()
        .enumerate()
        .find(|(_, monitor)| monitor.has_area() && monitor.contains(anchor))?;

    let left = i64::from(anchor.x.min(cursor.x)).max(i64::from(monitor.left));
    let right = i64::from(anchor.x.max(cursor.x)).min(i64::from(monitor.right));
    let top = i64::from(anchor.y.min(cursor.y)).max(i64::from(monitor.top));
    let bottom = i64::from(anchor.y.max(cursor.y)).min(i64::from(monitor.bottom));
    if right <= left || bottom <= top {
        return None;
    }

    Some(CaptureCrop {
        monitor: index,
        x: (left - i64::from(monitor.left)) as i32,
        y: (top - i64::from(monitor.top)) as i32,
        width: (right - left) as i32,
        height: (bottom - top) as i32,
    })
}

/// How one capture request ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ScreenCaptureStatus {
    /// The user confirmed a selection and `png` holds the cropped image.
    Captured,
    /// The user cancelled, or the display topology changed mid-session.
    Cancelled,
    /// The cropped PNG exceeds the upload limit.
    TooLarge,
    /// Windows refused the capture or the overlay could not take input.
    Failed,
}

/// Instruction line and theme colors the capture overlay draws.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ScreenCaptureOverlay {
    /// Localized instruction shown on every display's overlay.
    pub caption: String,
    /// Selection border color, as `#rrggbb`.
    pub accent_color: String,
    /// Instruction text color, as `#rrggbb`.
    pub text_color: String,
    /// Fill behind the instruction text, as `#rrggbb`.
    pub backdrop_color: String,
}

/// One capture answer: how it ended, plus the cropped PNG when the user confirmed.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ScreenCaptureResult {
    /// How the request ended.
    pub status: ScreenCaptureStatus,
    /// Cropped PNG bytes, present only for [`ScreenCaptureStatus::Captured`].
    pub png: Option<Vec<u8>>,
}

impl ScreenCaptureResult {
    /// A confirmed selection with its cropped PNG.
    pub fn captured(png: Vec<u8>) -> Self {
        Self {
            status: ScreenCaptureStatus::Captured,
            png: Some(png),
        }
    }

    /// A cancelled session; no image was taken.
    pub fn cancelled() -> Self {
        Self {
            status: ScreenCaptureStatus::Cancelled,
            png: None,
        }
    }

    /// A crop whose PNG exceeds the upload limit.
    pub fn too_large() -> Self {
        Self {
            status: ScreenCaptureStatus::TooLarge,
            png: None,
        }
    }

    /// A session Windows or the overlay could not complete.
    pub fn failed() -> Self {
        Self {
            status: ScreenCaptureStatus::Failed,
            png: None,
        }
    }
}

/// Native screen capture: one display-region selection session backed by Win32.
#[module]
pub struct ScreenCaptureNative;

#[module]
impl ScreenCaptureNative {
    /// Captures one selected screen region and resolves with its cropped PNG.
    ///
    /// # Rust
    ///
    /// Shows a frameless selection surface on every active display from an in-memory
    /// snapshot, then returns the confirmed rectangle's PNG. At most one request runs at a
    /// time; `cancel` ends the same request. Outside Windows the request fails without
    /// opening a surface.
    pub async fn capture(request_id: f64, overlay: ScreenCaptureOverlay) -> ScreenCaptureResult {
        platform_capture(request_id as u64, overlay).await
    }

    /// Cancels one running capture request; other requests are untouched.
    pub fn cancel(request_id: f64) {
        platform_cancel(request_id as u64);
    }
}

#[cfg(windows)]
async fn platform_capture(request_id: u64, overlay: ScreenCaptureOverlay) -> ScreenCaptureResult {
    windows::capture(request_id, overlay).await
}

#[cfg(not(windows))]
async fn platform_capture(_request_id: u64, _overlay: ScreenCaptureOverlay) -> ScreenCaptureResult {
    ScreenCaptureResult::failed()
}

#[cfg(windows)]
fn platform_cancel(request_id: u64) {
    windows::cancel(request_id);
}

#[cfg(not(windows))]
fn platform_cancel(_request_id: u64) {}
