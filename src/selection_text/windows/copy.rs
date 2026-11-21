mod editor_metadata;

use std::mem::size_of;
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HWND;
use windows_sys::Win32::Foundation::HWND as RawHwnd;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber, OpenClipboard,
};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY, VK_C, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowThreadProcessId};

use super::{ReadFailure, SelectionTextResult, is_current};

const KEY_RELEASE_TIMEOUT: Duration = Duration::from_millis(400);
const CLIPBOARD_TIMEOUT: Duration = Duration::from_millis(350);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const TERMINAL_CLASSES: [&str; 2] = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"];

pub(super) fn read(
    target: &str,
    foreground: HWND,
    require_editor_selection: bool,
    focus_matches: impl Fn() -> Result<bool, ReadFailure>,
) -> Result<SelectionTextResult, ReadFailure> {
    let pid = window_process(foreground.0);
    if pid == 0 || !allows_copy_shortcut(foreground.0) {
        return Ok(SelectionTextResult::unavailable());
    }

    let key_deadline = Instant::now() + KEY_RELEASE_TIMEOUT;
    while copy_keys_held() {
        if !is_current(target) {
            return Ok(SelectionTextResult::stale());
        }
        if Instant::now() >= key_deadline {
            return Ok(SelectionTextResult::unavailable());
        }
        thread::sleep(POLL_INTERVAL);
    }
    if !focus_matches()? || !is_current(target) {
        return Ok(SelectionTextResult::stale());
    }

    let baseline = clipboard_sequence();
    if baseline == 0 || copy_keys_held() || !send_copy() {
        return Ok(SelectionTextResult::unavailable());
    }

    let deadline = Instant::now() + CLIPBOARD_TIMEOUT;
    while Instant::now() < deadline {
        if !is_current(target) {
            return Ok(SelectionTextResult::stale());
        }
        if clipboard_sequence() != baseline
            && let Some(clipboard) = ClipboardRead::open()
        {
            let result = clipboard.read_fresh_text(baseline, pid, require_editor_selection);
            drop(clipboard);
            if !focus_matches()? || !is_current(target) {
                return Ok(SelectionTextResult::stale());
            }
            return Ok(result.map_or_else(
                SelectionTextResult::unavailable,
                SelectionTextResult::selected,
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
    Ok(SelectionTextResult::unavailable())
}

fn allows_copy_shortcut(window: RawHwnd) -> bool {
    let mut class = [0_u16; 256];
    // SAFETY: the buffer is writable for the length passed to Win32.
    let length = unsafe { GetClassNameW(window, class.as_mut_ptr(), class.len() as i32) };
    length > 0
        && !TERMINAL_CLASSES.iter().any(|name| {
            name.encode_utf16()
                .eq(class[..length as usize].iter().copied())
        })
}

fn copy_keys_held() -> bool {
    [VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN, VK_RWIN, VK_C]
        .into_iter()
        // SAFETY: these are valid virtual keys. A negative value means the key is down.
        .any(|key| unsafe { GetAsyncKeyState(i32::from(key)) } < 0)
}

fn send_copy() -> bool {
    let chord = [
        key(VK_CONTROL, false),
        key(VK_C, false),
        key(VK_C, true),
        key(VK_CONTROL, true),
    ];
    // SAFETY: the input buffer contains initialized keyboard events and is valid for the call.
    let sent = unsafe {
        SendInput(
            chord.len() as u32,
            chord.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent == chord.len() as u32 {
        return true;
    }
    // Release only the keys already pressed if Windows inserted part of the chord.
    let release = match sent {
        1 | 3 => &chord[3..],
        2 => &chord[2..],
        _ => return false,
    };
    // SAFETY: the slice contains only the remaining key-up events.
    unsafe {
        SendInput(
            release.len() as u32,
            release.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    false
}

fn key(code: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                ..Default::default()
            },
        },
    }
}

fn clipboard_sequence() -> u32 {
    // SAFETY: this queries system state without opening or changing the clipboard.
    unsafe { GetClipboardSequenceNumber() }
}

fn window_process(window: RawHwnd) -> u32 {
    if window.is_null() {
        return 0;
    }
    let mut pid = 0;
    // SAFETY: `pid` is writable, and Win32 checks the window handle.
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    pid
}

struct ClipboardRead;

impl ClipboardRead {
    fn open() -> Option<Self> {
        // SAFETY: a null window opens the clipboard for the current task. Drop closes it.
        (unsafe { OpenClipboard(ptr::null_mut()) } != 0).then_some(Self)
    }

    fn read_fresh_text(
        &self,
        baseline: u32,
        source_pid: u32,
        require_editor_selection: bool,
    ) -> Option<String> {
        let sequence = clipboard_sequence();
        // SAFETY: this queries the owner without retaining its handle.
        let owner = unsafe { GetClipboardOwner() };
        if sequence == 0 || sequence == baseline || window_process(owner) != source_pid {
            return None;
        }
        if require_editor_selection
            && self.with_data(editor_metadata::format(), editor_metadata::has_selection)
                != Some(true)
        {
            return None;
        }
        let text = self.with_data(u32::from(CF_UNICODETEXT), |data| {
            let units = data.as_chunks::<2>().0;
            let end = units.iter().position(|unit| *unit == [0, 0])?;
            char::decode_utf16(utf16_units(&units[..end]))
                .collect::<Result<String, _>>()
                .ok()
                .filter(|text| !text.trim().is_empty())
        })??;
        (clipboard_sequence() == sequence).then_some(text)
    }

    fn with_data<R>(&self, format: u32, read: impl FnOnce(&[u8]) -> R) -> Option<R> {
        if format == 0 {
            return None;
        }
        // SAFETY: both clipboard formats use an HGLOBAL. The buffer stays locked during the read.
        unsafe {
            let handle = GetClipboardData(format);
            if handle.is_null() {
                return None;
            }
            let size = GlobalSize(handle);
            if size == 0 || size > isize::MAX as usize {
                return None;
            }
            let buffer = GlobalLock(handle).cast::<u8>();
            if buffer.is_null() {
                return None;
            }
            let result = read(std::slice::from_raw_parts(buffer, size));
            GlobalUnlock(handle);
            Some(result)
        }
    }
}

fn utf16_units(units: &[[u8; 2]]) -> impl Iterator<Item = u16> + '_ {
    units.iter().copied().map(u16::from_le_bytes)
}

impl Drop for ClipboardRead {
    fn drop(&mut self) {
        // SAFETY: this guard is constructed only after opening the clipboard on this thread.
        unsafe { CloseClipboard() };
    }
}
