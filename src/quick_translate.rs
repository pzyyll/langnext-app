//! Native Quick Translate helpers for cursor monitor lookup and double-copy detection on Windows.

use std::future::poll_fn;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::{Duration, Instant};

use nsh_core::prelude::*;

/// Virtual-key code for the `'C'` key used in `Ctrl+C`.
pub const VK_C: u16 = 0x43;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_LWIN: u16 = 0x5B;
const VK_RWIN: u16 = 0x5C;
const VK_LSHIFT: u16 = 0xA0;
const VK_RSHIFT: u16 = 0xA1;
const VK_LCONTROL: u16 = 0xA2;
const VK_RCONTROL: u16 = 0xA3;
const VK_LMENU: u16 = 0xA4;
const VK_RMENU: u16 = 0xA5;

/// Maximum elapsed time between two distinct Ctrl+C presses to count as double copy.
pub const MAX_DOUBLE_COPY_INTERVAL: Duration = Duration::from_millis(400);

/// Maximum time waited off the engine thread after the second press for clipboard sequence settlement.
pub const CLIPBOARD_SETTLE_TIMEOUT: Duration = Duration::from_millis(150);

/// Poll interval while waiting off the engine thread for the clipboard sequence number to advance.
pub const CLIPBOARD_SETTLE_POLL: Duration = Duration::from_millis(10);

/// Physical cursor location relative to the containing monitor's desktop rectangle.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct CursorAnchor {
    /// Stable NSH display identifier formatted identically to `displays()[i].id`.
    pub display_id: nsh_core::desktop::DisplayId,
    /// Horizontal cursor offset in physical pixels from `rcMonitor.left`.
    pub offset_x: f64,
    /// Vertical cursor offset in physical pixels from `rcMonitor.top`.
    pub offset_y: f64,
}

/// Double-copy activation event delivered on the NSH engine thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, JsObject)]
pub struct DoubleCopyEvent {
    /// Whether the clipboard sequence number updated during the double-copy pair.
    pub has_valid_copy: bool,
}

/// Global pointer press, located like [`CursorAnchor`]: its display and physical offset.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct PointerPress {
    /// Stable NSH display identifier formatted identically to `displays()[i].id`.
    pub display_id: nsh_core::desktop::DisplayId,
    /// Horizontal press offset in physical pixels from `rcMonitor.left`.
    pub offset_x: f64,
    /// Vertical press offset in physical pixels from `rcMonitor.top`.
    pub offset_y: f64,
}

/// Raw Input mouse button-down flags: left, right, middle, back (4) and forward (5).
const MOUSE_PRESS_FLAGS: u16 = 0x0001 | 0x0004 | 0x0010 | 0x0040 | 0x0100;

/// Whether Raw Input mouse `button_flags` report any button going down.
pub const fn is_mouse_press(button_flags: u16) -> bool {
    button_flags & MOUSE_PRESS_FLAGS != 0
}

#[cfg(windows)]
const _: () = {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_LEFT_BUTTON_DOWN,
        RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN,
    };

    assert!(
        MOUSE_PRESS_FLAGS
            == (RI_MOUSE_LEFT_BUTTON_DOWN
                | RI_MOUSE_RIGHT_BUTTON_DOWN
                | RI_MOUSE_MIDDLE_BUTTON_DOWN
                | RI_MOUSE_BUTTON_4_DOWN
                | RI_MOUSE_BUTTON_5_DOWN) as u16
    );
};

/// Active modifier state evaluated on keyboard events.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

impl Modifiers {
    /// No modifiers pressed.
    pub const NONE: Self = Self {
        ctrl: false,
        alt: false,
        shift: false,
        win: false,
    };

    /// Only Ctrl pressed.
    pub const CTRL: Self = Self {
        ctrl: true,
        alt: false,
        shift: false,
        win: false,
    };

    /// Returns true strictly when Ctrl is pressed without Alt, Shift, or Win.
    pub const fn is_strict_ctrl(self) -> bool {
        self.ctrl && !self.alt && !self.shift && !self.win
    }
}

/// Clipboard sequence checkpoints captured when a valid double-Ctrl+C pair completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DoubleCopyDecision {
    pub seq_before_first: u32,
    pub seq_at_second: u32,
}

#[derive(Debug, Clone, Copy)]
struct PendingFirstCopy {
    first_press_at: Instant,
    released: bool,
    seq_before_first: u32,
}

/// Pure key-sequence recognizer accepting two distinct Ctrl+C press/release cycles within 400 ms.
#[derive(Debug, Default)]
pub struct DoubleCopyRecognizer {
    ctrl_mask: u8,
    alt_mask: u8,
    shift_mask: u8,
    win_mask: u8,
    c_down: bool,
    pending: Option<PendingFirstCopy>,
}

impl DoubleCopyRecognizer {
    /// Creates an idle recognizer.
    pub const fn new() -> Self {
        Self {
            ctrl_mask: 0,
            alt_mask: 0,
            shift_mask: 0,
            win_mask: 0,
            c_down: false,
            pending: None,
        }
    }

    /// Clears tracked modifier state, C key-down latch, and any pending first Ctrl+C press.
    pub fn reset(&mut self) {
        self.ctrl_mask = 0;
        self.alt_mask = 0;
        self.shift_mask = 0;
        self.win_mask = 0;
        self.c_down = false;
        self.pending = None;
    }

    /// Returns the currently tracked modifier summary.
    pub const fn modifiers(&self) -> Modifiers {
        Modifiers {
            ctrl: self.ctrl_mask != 0,
            alt: self.alt_mask != 0,
            shift: self.shift_mask != 0,
            win: self.win_mask != 0,
        }
    }

    /// Clears non-Ctrl modifier latches if the OS reports those keys are no longer held.
    pub fn clear_stale_modifiers(
        &mut self,
        alt_still_down: bool,
        shift_still_down: bool,
        win_still_down: bool,
    ) {
        if !alt_still_down {
            self.alt_mask = 0;
        }
        if !shift_still_down {
            self.shift_mask = 0;
        }
        if !win_still_down {
            self.win_mask = 0;
        }
    }

    fn update_modifier_bit(mask: &mut u8, bit: u8, is_down: bool) {
        if is_down {
            *mask |= bit;
        } else {
            *mask &= !bit;
        }
    }

    /// Consumes a raw virtual-key transition without blocking or synthesizing keys.
    pub fn handle_raw_key(
        &mut self,
        vkey: u16,
        is_down: bool,
        at: Instant,
        clipboard_seq: u32,
    ) -> Option<DoubleCopyDecision> {
        // Ignore unassigned / fake prefix scan events (0 or 0xFF) sent by Windows IME/media drivers.
        if vkey == 0 || vkey == 0xFF {
            return None;
        }

        match vkey {
            VK_LCONTROL => {
                Self::update_modifier_bit(&mut self.ctrl_mask, 0b01, is_down);
                return None;
            }
            VK_RCONTROL => {
                Self::update_modifier_bit(&mut self.ctrl_mask, 0b10, is_down);
                return None;
            }
            VK_CONTROL => {
                if is_down {
                    self.ctrl_mask |= 0b100;
                } else {
                    self.ctrl_mask = 0;
                }
                return None;
            }
            VK_LMENU => {
                Self::update_modifier_bit(&mut self.alt_mask, 0b01, is_down);
                if is_down {
                    self.pending = None;
                }
                return None;
            }
            VK_RMENU => {
                Self::update_modifier_bit(&mut self.alt_mask, 0b10, is_down);
                if is_down {
                    self.pending = None;
                }
                return None;
            }
            VK_MENU => {
                if is_down {
                    self.alt_mask |= 0b100;
                    self.pending = None;
                } else {
                    self.alt_mask = 0;
                }
                return None;
            }
            VK_LSHIFT => {
                Self::update_modifier_bit(&mut self.shift_mask, 0b01, is_down);
                if is_down {
                    self.pending = None;
                }
                return None;
            }
            VK_RSHIFT => {
                Self::update_modifier_bit(&mut self.shift_mask, 0b10, is_down);
                if is_down {
                    self.pending = None;
                }
                return None;
            }
            VK_SHIFT => {
                if is_down {
                    self.shift_mask |= 0b100;
                    self.pending = None;
                } else {
                    self.shift_mask = 0;
                }
                return None;
            }
            VK_LWIN => {
                Self::update_modifier_bit(&mut self.win_mask, 0b01, is_down);
                if is_down {
                    self.pending = None;
                }
                return None;
            }
            VK_RWIN => {
                Self::update_modifier_bit(&mut self.win_mask, 0b10, is_down);
                if is_down {
                    self.pending = None;
                }
                return None;
            }
            _ => {}
        }

        if vkey != VK_C {
            if is_down {
                self.pending = None;
            }
            return None;
        }

        if !is_down {
            self.c_down = false;
            if let Some(pending) = &mut self.pending {
                pending.released = true;
            }
            return None;
        }

        // Ignore key-repeat events while C stays held down.
        if self.c_down {
            return None;
        }
        self.c_down = true;

        if !self.modifiers().is_strict_ctrl() {
            self.pending = None;
            return None;
        }

        if let Some(pending) = self.pending
            && pending.released
            && at.saturating_duration_since(pending.first_press_at) < MAX_DOUBLE_COPY_INTERVAL
        {
            self.pending = None;
            return Some(DoubleCopyDecision {
                seq_before_first: pending.seq_before_first,
                seq_at_second: clipboard_seq,
            });
        }

        self.pending = Some(PendingFirstCopy {
            first_press_at: at,
            released: false,
            seq_before_first: clipboard_seq,
        });
        None
    }
}

/// Waits off the engine thread for the clipboard sequence number to reflect a copy from either press.
pub fn settle_clipboard_copy<FSeq, FCancel>(
    seq_before_first: u32,
    seq_at_second: u32,
    timeout: Duration,
    poll_interval: Duration,
    mut read_seq: FSeq,
    is_cancelled: FCancel,
) -> bool
where
    FSeq: FnMut() -> u32,
    FCancel: Fn() -> bool,
{
    if is_cancelled() {
        return false;
    }

    let deadline = Instant::now() + timeout;
    loop {
        if is_cancelled() {
            return false;
        }
        let current = read_seq();
        if current != seq_at_second {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return seq_at_second != seq_before_first;
        }
        let remaining = deadline.saturating_duration_since(now);
        std::thread::sleep(remaining.min(poll_interval));
    }
}

#[derive(Default)]
struct LatestState<T> {
    value: Option<T>,
    waker: Option<Waker>,
    closed: bool,
}

/// Bounded capacity-1 signal keeping only the newest event for the NSH engine thread.
struct LatestSignal<T> {
    state: Mutex<LatestState<T>>,
}

impl<T> LatestSignal<T> {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(LatestState {
                value: None,
                waker: None,
                closed: false,
            }),
        })
    }

    fn send_latest(&self, value: T) {
        let waker = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.closed {
                return;
            }
            guard.value = Some(value);
            guard.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    fn close(&self) {
        let waker = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.closed = true;
            guard.value = None;
            guard.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    async fn recv(&self) -> Option<T> {
        poll_fn(|cx| {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(value) = guard.value.take() {
                return Poll::Ready(Some(value));
            }
            if guard.closed {
                return Poll::Ready(None);
            }
            guard.waker = Some(cx.waker().clone());
            Poll::Pending
        })
        .await
    }
}

struct WorkerSession {
    stopped: Arc<AtomicBool>,
    latest_pair: AtomicU64,
    signal: Arc<LatestSignal<DoubleCopyEvent>>,
}

impl WorkerSession {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stopped: Arc::new(AtomicBool::new(false)),
            latest_pair: AtomicU64::new(0),
            signal: LatestSignal::new(),
        })
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.latest_pair.fetch_add(1, Ordering::AcqRel);
        self.signal.close();
    }
}

/// Bounded capacity-1 delivery of the newest pointer press.
struct PressSession {
    stopped: Arc<AtomicBool>,
    signal: Arc<LatestSignal<PointerPress>>,
}

impl PressSession {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stopped: Arc::new(AtomicBool::new(false)),
            signal: LatestSignal::new(),
        })
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.signal.close();
    }
}

/// Native platform functions backing the Quick Translate floating window.
#[module]
pub struct QuickTranslateNative;

#[module]
impl QuickTranslateNative {
    /// Returns the cursor's monitor ID and physical offset from that monitor's origin, or null outside Windows.
    ///
    /// # Rust
    ///
    /// Matches NSH 0.6.0's Windows screen enumeration (`EnumDisplayDevicesW` interface name,
    /// falling back to `szDevice`) so `DisplayId::from_name` aligns on mixed-DPI setups.
    pub fn cursor_anchor() -> Option<CursorAnchor> {
        platform_cursor_anchor()
    }

    /// Listens for global Windows double-Ctrl+C copy pairs and returns a stop handle.
    ///
    /// # Rust
    ///
    /// Registers keyboard-only Raw Input (`RIDEV_INPUTSINK`) on a dedicated worker thread,
    /// confirms registration before returning, evaluates the clipboard sequence number off the
    /// engine thread, and posts `DoubleCopyEvent` back onto the NSH engine thread.
    pub fn on_double_copy(
        #[args(event)] listener: Callback<DoubleCopyEvent>,
        cx: CallCx<'_>,
    ) -> Result<Stop, String> {
        let session = WorkerSession::new();
        let stop_worker = match platform_start_double_copy(session.clone()) {
            Ok(stop) => stop,
            Err(message) => {
                session.stop();
                return Err(message);
            }
        };

        let delivery_session = session.clone();
        cx.start(async move {
            while let Some(event) = delivery_session.signal.recv().await {
                if delivery_session.is_stopped() {
                    break;
                }
                listener.post(event);
            }
            drop(listener);
        });

        Ok(Stop::new(move || {
            session.stop();
            stop_worker();
        }))
    }

    /// Listens for global Windows mouse button presses and returns a stop handle.
    ///
    /// # Rust
    ///
    /// Registers mouse-only Raw Input (`RIDEV_INPUTSINK`) on a dedicated worker thread,
    /// confirms registration before returning, and posts each press's display and physical
    /// offset back onto the NSH engine thread as `PointerPress`.
    pub fn on_pointer_press(
        #[args(event)] listener: Callback<PointerPress>,
        cx: CallCx<'_>,
    ) -> Result<Stop, String> {
        let session = PressSession::new();
        let stop_worker = match platform_start_pointer_press(session.clone()) {
            Ok(stop) => stop,
            Err(message) => {
                session.stop();
                return Err(message);
            }
        };

        let delivery_session = session.clone();
        cx.start(async move {
            while let Some(press) = delivery_session.signal.recv().await {
                if delivery_session.is_stopped() {
                    break;
                }
                listener.post(press);
            }
            drop(listener);
        });

        Ok(Stop::new(move || {
            session.stop();
            stop_worker();
        }))
    }
}

#[cfg(windows)]
fn utf16_z_to_string(units: &[u16]) -> String {
    let end = units.iter().position(|c| *c == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

#[cfg(windows)]
fn resolve_monitor_key(device_id: &[u16], sz_device: &[u16]) -> String {
    if device_id.first().copied().unwrap_or(0) != 0 {
        utf16_z_to_string(device_id)
    } else {
        utf16_z_to_string(sz_device)
    }
}

#[cfg(windows)]
fn platform_cursor_anchor() -> Option<CursorAnchor> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: `point` is a stack-allocated Win32 POINT out-parameter.
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return None;
    }

    monitor_anchor(point)
}

/// Display ID and offset of screen point `point` from that display's origin.
#[cfg(windows)]
fn monitor_anchor(point: windows_sys::Win32::Foundation::POINT) -> Option<CursorAnchor> {
    use windows_sys::Win32::Graphics::Gdi::{
        DISPLAY_DEVICEW, EnumDisplayDevicesW, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST,
        MONITORINFO, MONITORINFOEXW, MonitorFromPoint,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;

    // SAFETY: `point` is initialized by the caller.
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }

    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: `info` has `cbSize` set to `size_of::<MONITORINFOEXW>()`, matching the Win32 contract.
    if unsafe {
        GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
    } == 0
    {
        return None;
    }

    let native = info.monitorInfo.rcMonitor;
    if native.right <= native.left || native.bottom <= native.top {
        return None;
    }

    let mut device: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
    device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
    // SAFETY: `info.szDevice` is NUL-terminated; `device.cb` matches `size_of::<DISPLAY_DEVICEW>()`.
    let has_interface = unsafe {
        EnumDisplayDevicesW(
            info.szDevice.as_ptr(),
            0,
            &mut device,
            EDD_GET_DEVICE_INTERFACE_NAME,
        )
    } != 0;

    let stable_name = if has_interface {
        resolve_monitor_key(&device.DeviceID, &info.szDevice)
    } else {
        utf16_z_to_string(&info.szDevice)
    };

    Some(CursorAnchor {
        display_id: nsh_core::desktop::DisplayId::from_name(stable_name.as_bytes()),
        offset_x: f64::from(point.x - native.left),
        offset_y: f64::from(point.y - native.top),
    })
}

#[cfg(not(windows))]
fn platform_cursor_anchor() -> Option<CursorAnchor> {
    None
}

#[cfg(windows)]
static NEXT_RAW_INPUT_CLASS_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
const WM_APP_STOP_RAW_INPUT: u32 = 0x8001;

#[cfg(windows)]
unsafe extern "system" fn raw_input_wnd_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    // SAFETY: Standard default message handling for our message-only Raw Input sink window.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(windows)]
fn normalize_win32_vkey(vkey: u16, make_code: u16, flags: u16) -> u16 {
    const RI_KEY_E0_FLAG: u16 = 0x02;
    let is_e0 = (flags & RI_KEY_E0_FLAG) != 0;
    match vkey {
        VK_CONTROL => {
            if is_e0 {
                VK_RCONTROL
            } else {
                VK_LCONTROL
            }
        }
        VK_MENU => {
            if is_e0 {
                VK_RMENU
            } else {
                VK_LMENU
            }
        }
        VK_SHIFT => {
            if make_code == 0x36 {
                VK_RSHIFT
            } else {
                VK_LSHIFT
            }
        }
        other => other,
    }
}

#[cfg(windows)]
fn is_vkey_async_down(vkey: u16) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // SAFETY: `GetAsyncKeyState` accepts any Windows virtual-key code and reads MSB pressed bit.
    (unsafe { GetAsyncKeyState(i32::from(vkey)) } as u16 & 0x8000) != 0
}

/// Reads the Raw Input event `lparam` names, or `None` when it cannot be read.
#[cfg(windows)]
fn read_raw_input(
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> Option<windows_sys::Win32::UI::Input::RAWINPUT> {
    use std::mem::size_of;
    use windows_sys::Win32::UI::Input::{
        GetRawInputData, HRAWINPUT, RAWINPUT, RAWINPUTHEADER, RID_INPUT,
    };

    let mut stack_buf = [0u64; 16];
    let mut size = size_of::<[u64; 16]>() as u32;
    let header_size = size_of::<RAWINPUTHEADER>() as u32;

    // SAFETY: Query Raw Input buffer into our aligned stack buffer first.
    let copied = unsafe {
        GetRawInputData(
            lparam as HRAWINPUT,
            RID_INPUT,
            stack_buf.as_mut_ptr().cast(),
            &mut size,
            header_size,
        )
    };

    let raw: RAWINPUT = if copied != u32::MAX {
        if (copied as usize) < size_of::<RAWINPUTHEADER>() {
            return None;
        }
        // SAFETY: `stack_buf` holds `copied` bytes written by `GetRawInputData`.
        unsafe { std::ptr::read_unaligned(stack_buf.as_ptr().cast::<RAWINPUT>()) }
    } else {
        let mut needed = 0u32;
        // SAFETY: `pData == NULL` queries the required byte size into `needed`.
        let res = unsafe {
            GetRawInputData(
                lparam as HRAWINPUT,
                RID_INPUT,
                std::ptr::null_mut(),
                &mut needed,
                header_size,
            )
        };
        if res == u32::MAX || (needed as usize) < size_of::<RAWINPUT>() {
            return None;
        }
        let mut heap_buf = vec![0u8; needed as usize];
        // SAFETY: `heap_buf` has `needed` bytes available.
        let read_bytes = unsafe {
            GetRawInputData(
                lparam as HRAWINPUT,
                RID_INPUT,
                heap_buf.as_mut_ptr().cast(),
                &mut needed,
                header_size,
            )
        };
        if read_bytes == u32::MAX || (read_bytes as usize) < size_of::<RAWINPUT>() {
            return None;
        }
        // SAFETY: `heap_buf` contains at least `size_of::<RAWINPUT>()` initialized bytes.
        unsafe { std::ptr::read_unaligned(heap_buf.as_ptr().cast::<RAWINPUT>()) }
    };

    Some(raw)
}

/// Feeds one Raw Input event to the double-copy recognizer and clipboard settle.
#[cfg(windows)]
fn handle_keyboard_input(
    raw: &windows_sys::Win32::UI::Input::RAWINPUT,
    recognizer: &mut DoubleCopyRecognizer,
    session: &Arc<WorkerSession>,
) {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows_sys::Win32::UI::Input::RIM_TYPEKEYBOARD;
    use windows_sys::Win32::UI::WindowsAndMessaging::RI_KEY_BREAK;

    if raw.header.dwType != RIM_TYPEKEYBOARD {
        return;
    }

    // SAFETY: `raw.header.dwType == RIM_TYPEKEYBOARD` selects the `keyboard` union variant.
    let kb = unsafe { raw.data.keyboard };
    if kb.VKey == 0 || kb.VKey == 0xFF {
        return;
    }

    let is_down = (u32::from(kb.Flags) & RI_KEY_BREAK) == 0;
    let normalized = normalize_win32_vkey(kb.VKey, kb.MakeCode, kb.Flags);

    // Clear stale stuck non-Ctrl modifiers if an up transition happened inside an elevated window.
    if normalized == VK_C && is_down {
        recognizer.clear_stale_modifiers(
            is_vkey_async_down(VK_MENU),
            is_vkey_async_down(VK_SHIFT),
            is_vkey_async_down(VK_LWIN) || is_vkey_async_down(VK_RWIN),
        );
    }

    // SAFETY: `GetClipboardSequenceNumber` is a lock-free Win32 query returning u32.
    let seq = unsafe { GetClipboardSequenceNumber() };
    let Some(decision) = recognizer.handle_raw_key(normalized, is_down, Instant::now(), seq) else {
        return;
    };

    let pair_id = session.latest_pair.fetch_add(1, Ordering::AcqRel) + 1;
    let settle_session = Arc::clone(session);
    let _ = std::thread::Builder::new()
        .name("quick-translate-clip-settle".into())
        .spawn(move || {
            let has_valid_copy = settle_clipboard_copy(
                decision.seq_before_first,
                decision.seq_at_second,
                CLIPBOARD_SETTLE_TIMEOUT,
                CLIPBOARD_SETTLE_POLL,
                // SAFETY: Reading clipboard change counter only; never reads clipboard contents.
                || unsafe { GetClipboardSequenceNumber() },
                || {
                    settle_session.is_stopped()
                        || settle_session.latest_pair.load(Ordering::Acquire) != pair_id
                },
            );
            if settle_session.is_stopped()
                || settle_session.latest_pair.load(Ordering::Acquire) != pair_id
            {
                return;
            }
            settle_session
                .signal
                .send_latest(DoubleCopyEvent { has_valid_copy });
        });
}

#[cfg(windows)]
fn platform_start_double_copy(session: Arc<WorkerSession>) -> Result<Box<dyn FnOnce()>, String> {
    use windows_sys::Win32::UI::Input::RIM_TYPEKEYBOARD;

    let worker_session = Arc::clone(&session);
    let mut recognizer = DoubleCopyRecognizer::new();
    platform_start_raw_input(&[(0x01, 0x06)], Arc::clone(&session.stopped), move |raw| {
        if raw.header.dwType == RIM_TYPEKEYBOARD {
            handle_keyboard_input(&raw, &mut recognizer, &worker_session);
        }
    })
}

#[cfg(not(windows))]
fn platform_start_double_copy(_session: Arc<WorkerSession>) -> Result<Box<dyn FnOnce()>, String> {
    Err("Double copy is only supported on Windows.".to_owned())
}

/// Reports the newest global mouse button press to `session`.
#[cfg(windows)]
fn handle_pointer_press(
    raw: &windows_sys::Win32::UI::Input::RAWINPUT,
    session: &Arc<PressSession>,
) {
    use windows_sys::Win32::UI::Input::RIM_TYPEMOUSE;

    if raw.header.dwType != RIM_TYPEMOUSE {
        return;
    }
    // SAFETY: `dwType == RIM_TYPEMOUSE` selects the `mouse` union variant.
    let mouse = unsafe { raw.data.mouse };
    // SAFETY: reading the button flags of an initialized `RAWMOUSE`.
    let flags = unsafe { mouse.Anonymous.Anonymous.usButtonFlags };
    if !is_mouse_press(flags) {
        return;
    }
    let Some(press) = cursor_pointer_press() else {
        return;
    };
    session.signal.send_latest(press);
}

/// The cursor's display and physical offset now, located as `cursor_anchor` locates it.
#[cfg(windows)]
fn cursor_pointer_press() -> Option<PointerPress> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: `point` is a stack-allocated Win32 POINT out-parameter.
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return None;
    }
    let anchor = monitor_anchor(point)?;
    Some(PointerPress {
        display_id: anchor.display_id,
        offset_x: anchor.offset_x,
        offset_y: anchor.offset_y,
    })
}

#[cfg(windows)]
fn platform_start_pointer_press(session: Arc<PressSession>) -> Result<Box<dyn FnOnce()>, String> {
    let worker_session = Arc::clone(&session);
    platform_start_raw_input(&[(0x01, 0x02)], Arc::clone(&session.stopped), move |raw| {
        handle_pointer_press(&raw, &worker_session);
    })
}

#[cfg(not(windows))]
fn platform_start_pointer_press(_session: Arc<PressSession>) -> Result<Box<dyn FnOnce()>, String> {
    Err("Pointer press monitoring is only supported on Windows.".to_owned())
}

/// Registers Raw Input sinks for `usages` (HID page, usage) on a dedicated worker thread, hands
/// every event to `on_input` there, and returns a handle that stops and joins the thread.
#[cfg(windows)]
fn platform_start_raw_input(
    usages: &[(u16, u16)],
    stopped: Arc<AtomicBool>,
    mut on_input: impl FnMut(windows_sys::Win32::UI::Input::RAWINPUT) + Send + 'static,
) -> Result<Box<dyn FnOnce()>, String> {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::{RAWINPUTDEVICE, RIDEV_INPUTSINK, RegisterRawInputDevices};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG,
        PostMessageW, RegisterClassExW, TranslateMessage, UnregisterClassW, WM_INPUT, WNDCLASSEXW,
    };

    let usages = usages.to_vec();
    let device_size = std::mem::size_of::<RAWINPUTDEVICE>() as u32;
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<isize, String>>(1);
    let worker_stopped = Arc::clone(&stopped);

    let join = std::thread::Builder::new()
        .name("quick-translate-raw-input".into())
        .spawn(move || {
            let class_id = NEXT_RAW_INPUT_CLASS_ID.fetch_add(1, Ordering::Relaxed);
            let class_name: Vec<u16> = format!("MyTranslatorRawInput_{class_id}\0")
                .encode_utf16()
                .collect();

            // SAFETY: NULL returns HMODULE for current executable.
            let hinstance = unsafe { GetModuleHandleW(std::ptr::null()) };
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(raw_input_wnd_proc),
                hInstance: hinstance,
                lpszClassName: class_name.as_ptr(),
                ..Default::default()
            };

            // SAFETY: `wc` is properly initialized and `class_name` is NUL-terminated UTF-16.
            if unsafe { RegisterClassExW(&wc) } == 0 {
                let _ = ready_tx.send(Err("Failed to register Raw Input window class.".into()));
                return;
            }

            // SAFETY: Message-only window class and instance are valid; cleaned up before exit.
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    std::ptr::null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    hinstance,
                    std::ptr::null(),
                )
            };
            if hwnd.is_null() {
                // SAFETY: Class was registered on this `hinstance` and has no live windows.
                unsafe { UnregisterClassW(class_name.as_ptr(), hinstance) };
                let _ = ready_tx.send(Err("Failed to create Raw Input message window.".into()));
                return;
            }

            let devices: Vec<RAWINPUTDEVICE> = usages
                .iter()
                .map(|&(page, usage)| RAWINPUTDEVICE {
                    usUsagePage: page,
                    usUsage: usage,
                    dwFlags: RIDEV_INPUTSINK,
                    hwndTarget: hwnd,
                })
                .collect();
            // SAFETY: Every device targets our valid message-only window.
            if unsafe {
                RegisterRawInputDevices(devices.as_ptr(), devices.len() as u32, device_size)
            } == 0
            {
                // SAFETY: Clean up created `hwnd` and window class before reporting failure.
                unsafe {
                    DestroyWindow(hwnd);
                    UnregisterClassW(class_name.as_ptr(), hinstance);
                }
                let _ = ready_tx.send(Err("Failed to register the Raw Input listener.".into()));
                return;
            }

            if ready_tx.send(Ok(hwnd as isize)).is_err() {
                let remove = raw_input_devices_to_remove(&usages);
                // SAFETY: `hwndTarget` is NULL for `RIDEV_REMOVE`, as that flag requires.
                unsafe {
                    RegisterRawInputDevices(remove.as_ptr(), remove.len() as u32, device_size);
                    DestroyWindow(hwnd);
                    UnregisterClassW(class_name.as_ptr(), hinstance);
                }
                return;
            }

            let mut msg = MSG::default();
            // SAFETY: Standard Win32 thread message loop for our thread-owned window.
            while !worker_stopped.load(Ordering::Acquire)
                && unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0
            {
                if msg.message == WM_APP_STOP_RAW_INPUT || worker_stopped.load(Ordering::Acquire) {
                    break;
                }
                if msg.message == WM_INPUT {
                    if let Some(raw) = read_raw_input(msg.lParam) {
                        on_input(raw);
                    }
                } else {
                    // SAFETY: Standard message dispatch for thread window messages.
                    unsafe {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            }

            let remove = raw_input_devices_to_remove(&usages);
            // SAFETY: Removes the sinks registered above; then the window and class go.
            unsafe {
                RegisterRawInputDevices(remove.as_ptr(), remove.len() as u32, device_size);
                DestroyWindow(hwnd);
                UnregisterClassW(class_name.as_ptr(), hinstance);
            }
        })
        .map_err(|err| format!("Failed to spawn the Raw Input listener thread: {err}"))?;

    let hwnd_raw = match ready_rx.recv() {
        Ok(Ok(hwnd_raw)) => hwnd_raw,
        Ok(Err(message)) => {
            stopped.store(true, Ordering::Release);
            let _ = join.join();
            return Err(message);
        }
        Err(_) => {
            stopped.store(true, Ordering::Release);
            let _ = join.join();
            return Err("The Raw Input listener terminated during initialization.".into());
        }
    };

    Ok(Box::new(move || {
        use windows_sys::Win32::Foundation::HWND;
        stopped.store(true, Ordering::Release);
        // SAFETY: `hwnd_raw` is valid until `join` completes below.
        unsafe {
            PostMessageW(hwnd_raw as HWND, WM_APP_STOP_RAW_INPUT, 0, 0);
        }
        let _ = join.join();
    }))
}

/// The `RIDEV_REMOVE` devices that release the sinks `usages` registered.
#[cfg(windows)]
fn raw_input_devices_to_remove(
    usages: &[(u16, u16)],
) -> Vec<windows_sys::Win32::UI::Input::RAWINPUTDEVICE> {
    use windows_sys::Win32::UI::Input::{RAWINPUTDEVICE, RIDEV_REMOVE};

    usages
        .iter()
        .map(|&(page, usage)| RAWINPUTDEVICE {
            usUsagePage: page,
            usUsage: usage,
            dwFlags: RIDEV_REMOVE,
            hwndTarget: std::ptr::null_mut(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resolves_interface_name_over_gdi_device_name() {
        let iface: Vec<u16> = "\\\\?\\DISPLAY#DEL1234#0\0".encode_utf16().collect();
        let gdi: Vec<u16> = "\\\\.\\DISPLAY1\0".encode_utf16().collect();
        assert_eq!(
            resolve_monitor_key(&iface, &gdi),
            "\\\\?\\DISPLAY#DEL1234#0"
        );
        assert_eq!(resolve_monitor_key(&[0], &gdi), "\\\\.\\DISPLAY1");
    }

    #[cfg(windows)]
    #[test]
    fn windows_cursor_anchor_returns_valid_display_id_or_headless_none() {
        if let Some(anchor) = platform_cursor_anchor() {
            assert_ne!(anchor.display_id.0, 0);
            assert!(anchor.offset_x.is_finite());
            assert!(anchor.offset_y.is_finite());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_raw_input_worker_starts_and_stops_cleanly_across_restarts() {
        for _ in 0..2 {
            let session = WorkerSession::new();
            let stop = platform_start_double_copy(Arc::clone(&session))
                .expect("Win32 Raw Input worker should register cleanly");
            assert!(!session.is_stopped());
            stop();
            assert!(session.is_stopped());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_pointer_press_worker_starts_and_stops_cleanly_across_restarts() {
        for _ in 0..2 {
            let session = PressSession::new();
            let stop = platform_start_pointer_press(Arc::clone(&session))
                .expect("Win32 Raw Input worker should register cleanly");
            assert!(!session.is_stopped());
            stop();
            assert!(session.is_stopped());
        }
    }

    #[test]
    fn mouse_press_flags_accept_every_button_down_and_ignore_ups_and_motion() {
        // Left, right, middle, back and forward going down.
        for down in [0x0001u16, 0x0004, 0x0010, 0x0040, 0x0100] {
            assert!(is_mouse_press(down));
        }
        // The same buttons going up, a wheel turn, and pure motion report no press.
        for other in [
            0x0000u16, 0x0002, 0x0008, 0x0020, 0x0080, 0x0200, 0x0400, 0x0800,
        ] {
            assert!(!is_mouse_press(other));
        }
    }
}
