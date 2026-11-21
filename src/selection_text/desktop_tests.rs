//! Real Win32 checks for the foreground selection reader.

use std::mem::size_of;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GlobalFree, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetFocus, GetKeyState, SetFocus, VK_C, VK_CONTROL,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    ASFW_ANY, AllowSetForegroundWindow, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW,
    DestroyWindow, DispatchMessageW, ES_AUTOVSCROLL, ES_MULTILINE, ES_PASSWORD, ES_WANTRETURN,
    GA_ROOT, GUITHREADINFO, GWLP_USERDATA, GetAncestor, GetForegroundWindow, GetGUIThreadInfo,
    GetWindowLongPtrW, GetWindowThreadProcessId, HWND_NOTOPMOST, HWND_TOPMOST, MSG, PM_REMOVE,
    PeekMessageW, RegisterClassW, SW_SHOWNORMAL, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    SendMessageW, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow,
    TranslateMessage, UnregisterClassW, WM_KEYDOWN, WM_QUIT, WNDCLASSW, WS_CHILD,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE, WS_VSCROLL,
};

use super::{SelectionTextNative, SelectionTextStatus, read_target};

/// `EM_SETSEL`: the production reader never sends this message.
const EM_SETSEL: u32 = 177;

const FIXTURE_TEXT: &str = "alpha SELECTED beta";
const SELECTED_TEXT: &str = "SELECTED";
const CLASS_NAME: &str = "MyTranslatorSelectionFixture";
const COVER_CLASS_NAME: &str = "MyTranslatorSelectionCover";
const COPY_CLASS_NAME: &str = "MyTranslatorCopyOnlyFixture";
const COPY_PROBE_CLASS_NAME: &str = "MyTranslatorCopyProbeFixture";
const COPY_PROBE_WAITING: isize = 1;
const COPY_PROBE_SEEN: isize = 2;

struct TextFixture {
    top: HWND,
    edit: HWND,
    stop: std::sync::Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl TextFixture {
    fn selected_range() -> Self {
        let start = FIXTURE_TEXT
            .find(SELECTED_TEXT)
            .expect("the fixture contains the selected word");
        Self::open(
            CLASS_NAME,
            FIXTURE_TEXT,
            start,
            start + SELECTED_TEXT.len(),
            false,
        )
    }

    fn caret() -> Self {
        let caret = FIXTURE_TEXT
            .find(' ')
            .expect("the fixture contains a caret position");
        Self::open(CLASS_NAME, FIXTURE_TEXT, caret, caret, false)
    }

    fn password() -> Self {
        const SECRET: &str = "secret";
        Self::open(CLASS_NAME, SECRET, 0, SECRET.len(), true)
    }

    fn cover() -> Self {
        Self::open(COVER_CLASS_NAME, "cover", 0, 0, false)
    }

    fn open(class_name: &str, text: &str, start: usize, end: usize, password: bool) -> Self {
        let (ready_tx, ready_rx) = mpsc::channel();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let stop_in_thread = stop.clone();
        let text = text.to_string();
        let class_name = class_name.to_string();
        let thread = thread::spawn(move || {
            run_fixture(
                class_name,
                text,
                start,
                end,
                password,
                ready_tx,
                &stop_in_thread,
            );
        });
        let (top, edit) = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("test setup failed: the fixture window did not open");
        let fixture = Self {
            top: top as HWND,
            edit: edit as HWND,
            stop,
            thread: Some(thread),
        };
        fixture.require_foreground();
        fixture
    }

    fn require_foreground(&self) {
        // SAFETY: the fixture thread owns these live windows; this only reads their focus.
        let focused = foreground_edit(self.top);
        if focused != Some(self.edit) {
            panic!(
                "test setup failed: Windows did not give the fixture foreground focus (top {:?}, edit {:?}, focused {:?})",
                self.top, self.edit, focused
            );
        }
    }
}

impl Drop for TextFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run_fixture(
    class_name: String,
    text: String,
    start: usize,
    end: usize,
    password: bool,
    ready: mpsc::Sender<(isize, isize)>,
    stop: &AtomicBool,
) {
    let copy_probe = class_name == COPY_PROBE_CLASS_NAME;
    let copy_only = copy_probe || class_name == COPY_CLASS_NAME;
    let class_name = wide(&class_name);
    let edit_class = if copy_only {
        class_name.clone()
    } else {
        wide("EDIT")
    };
    let title = wide("Selection fixture");
    let text = wide(&text);
    // SAFETY: the class procedure is static, and these windows are destroyed before return.
    let created =
        unsafe { create_fixture(&class_name, &edit_class, &title, &text, password, copy_only) };
    let Some((top, edit)) = created else {
        let _ = ready.send((0, 0));
        return;
    };
    // SAFETY: both handles belong to this thread.
    unsafe {
        SendMessageW(edit, EM_SETSEL, start as WPARAM, end as LPARAM);
        if copy_probe {
            SetWindowLongPtrW(edit, GWLP_USERDATA, COPY_PROBE_WAITING);
        }
        show_in_front(top, edit);
        pump_once();
    }
    if ready.send((top as isize, edit as isize)).is_err() {
        // SAFETY: this thread created both windows.
        unsafe { destroy_fixture(top, edit, &class_name) };
        return;
    }
    while !stop.load(Ordering::Acquire) {
        // SAFETY: this thread owns the fixture queue.
        unsafe { pump_once() };
        thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: this thread created both windows.
    unsafe { destroy_fixture(top, edit, &class_name) };
}

unsafe fn create_fixture(
    class_name: &[u16],
    edit_class: &[u16],
    title: &[u16],
    text: &[u16],
    password: bool,
    copy_only: bool,
) -> Option<(HWND, HWND)> {
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let class = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(if copy_only {
            copy_fixture_wnd_proc
        } else {
            fixture_wnd_proc
        }),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: ptr::null_mut(),
        hCursor: ptr::null_mut(),
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    // A repeated test in this process may find the class already registered.
    unsafe { RegisterClassW(&class) };
    let top = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            480,
            240,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null_mut(),
        )
    };
    if top.is_null() {
        return None;
    }
    let style = if password {
        WS_CHILD | WS_VISIBLE | ES_PASSWORD as u32
    } else {
        WS_CHILD
            | WS_VISIBLE
            | WS_VSCROLL
            | ES_MULTILINE as u32
            | ES_AUTOVSCROLL as u32
            | ES_WANTRETURN as u32
    };
    let edit = unsafe {
        CreateWindowExW(
            0,
            edit_class.as_ptr(),
            ptr::null(),
            style,
            8,
            8,
            440,
            160,
            top,
            ptr::null_mut(),
            instance,
            ptr::null_mut(),
        )
    };
    if edit.is_null() {
        unsafe { DestroyWindow(top) };
        return None;
    }
    if unsafe { SetWindowTextW(edit, text.as_ptr()) } == 0 {
        unsafe { destroy_fixture(top, edit, class_name) };
        return None;
    }
    Some((top, edit))
}

unsafe fn show_in_front(top: HWND, edit: HWND) {
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
        let current = GetCurrentThreadId();
        let foreign = GetWindowThreadProcessId(GetForegroundWindow(), ptr::null_mut());
        let attached =
            foreign != 0 && foreign != current && AttachThreadInput(foreign, current, 1) != 0;
        ShowWindow(top, SW_SHOWNORMAL);
        SetWindowPos(
            top,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        SetWindowPos(
            top,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        SetForegroundWindow(top);
        SetFocus(edit);
        if attached {
            AttachThreadInput(foreign, current, 0);
        }
    }
}

unsafe fn pump_once() {
    unsafe {
        let mut message = MSG::default();
        while PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            if message.message == WM_QUIT {
                return;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe fn destroy_fixture(top: HWND, edit: HWND, class_name: &[u16]) {
    unsafe {
        DestroyWindow(edit);
        DestroyWindow(top);
        UnregisterClassW(class_name.as_ptr(), GetModuleHandleW(ptr::null()));
    }
}

unsafe extern "system" fn fixture_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

unsafe extern "system" fn copy_fixture_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_KEYDOWN
        && wparam == usize::from(VK_C)
        && unsafe { GetKeyState(i32::from(VK_CONTROL)) } < 0
    {
        if unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } == 0 {
            put_fixture_text_on_clipboard(hwnd);
        } else {
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, COPY_PROBE_SEEN) };
        }
        0
    } else {
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }
}

fn put_fixture_text_on_clipboard(hwnd: HWND) {
    let text = wide(SELECTED_TEXT);
    // SAFETY: the window belongs to this thread. The clipboard takes ownership only on success.
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, text.len() * size_of::<u16>());
        if handle.is_null() {
            return;
        }
        let buffer = GlobalLock(handle).cast::<u16>();
        if !buffer.is_null() {
            ptr::copy_nonoverlapping(text.as_ptr(), buffer, text.len());
            GlobalUnlock(handle);
            if OpenClipboard(hwnd) != 0 {
                let copied = EmptyClipboard() != 0
                    && !SetClipboardData(u32::from(CF_UNICODETEXT), handle).is_null();
                CloseClipboard();
                if copied {
                    return;
                }
            }
        }
        GlobalFree(handle);
    }
}

fn foreground_edit(top: HWND) -> Option<HWND> {
    unsafe {
        if GetForegroundWindow() != top || GetAncestor(top, GA_ROOT) != top {
            return None;
        }
        let thread_id = GetWindowThreadProcessId(top, ptr::null_mut());
        let mut info = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..GUITHREADINFO::default()
        };
        if GetGUIThreadInfo(thread_id, &mut info) == 0 {
            return None;
        }
        let focused = if info.hwndFocus.is_null() {
            GetFocus()
        } else {
            info.hwndFocus
        };
        (!focused.is_null()).then_some(focused)
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[test]
#[ignore = "requires an interactive Windows desktop"]
fn desktop_selection_text_reads_only_the_selected_range() {
    let _fixture = TextFixture::selected_range();
    let target = SelectionTextNative::snapshot().unwrap_or_else(|| {
        panic!("test setup failed: snapshot returned no foreground target");
    });
    let result = read_target(&target, true);
    assert_eq!(
        (result.status, result.text.as_deref()),
        (SelectionTextStatus::Selected, Some(SELECTED_TEXT))
    );
}

#[test]
#[ignore = "requires an interactive Windows desktop"]
fn desktop_selection_text_caret_is_no_selection() {
    let _fixture = TextFixture::caret();
    let result = read_foreground();
    assert_eq!(
        (result.status, result.text.as_deref()),
        (SelectionTextStatus::NoSelection, None)
    );
}

#[test]
#[ignore = "requires an interactive Windows desktop"]
fn desktop_selection_text_password_is_unavailable() {
    let _fixture = TextFixture::password();
    let result = read_foreground();
    assert_eq!(
        (result.status, result.text.as_deref()),
        (SelectionTextStatus::Unavailable, None)
    );
}

#[test]
#[ignore = "requires an interactive Windows desktop"]
fn desktop_selection_text_lost_foreground_is_stale() {
    let fixture = TextFixture::selected_range();
    let target = SelectionTextNative::snapshot().unwrap_or_else(|| {
        panic!("test setup failed: snapshot returned no foreground target");
    });
    let _cover = TextFixture::cover();
    let result = read_target(&target, true);
    assert_eq!(
        (result.status, result.text.as_deref()),
        (SelectionTextStatus::Stale, None)
    );
    drop(fixture);
}

#[test]
#[ignore = "requires an interactive Windows desktop and replaces its clipboard contents"]
fn desktop_selection_falls_back_to_copy_only_when_enabled() {
    let _fixture = TextFixture::open(COPY_CLASS_NAME, "Copy-only fixture", 0, 0, false);
    let target = SelectionTextNative::snapshot().expect("foreground target");
    let before = unsafe { GetClipboardSequenceNumber() };
    let disabled = read_target(&target, false);
    assert_eq!(disabled.status, SelectionTextStatus::Unavailable);
    assert_eq!(unsafe { GetClipboardSequenceNumber() }, before);

    let enabled = read_target(&target, true);
    assert_eq!(
        (enabled.status, enabled.text.as_deref()),
        (SelectionTextStatus::Selected, Some(SELECTED_TEXT)),
    );
    assert_ne!(unsafe { GetClipboardSequenceNumber() }, before);
}

#[test]
#[ignore = "requires an interactive Windows desktop"]
fn desktop_selection_text_does_not_translate_a_copy_without_new_clipboard_text() {
    let fixture = TextFixture::open(COPY_PROBE_CLASS_NAME, "Copy probe", 0, 0, false);
    let target = SelectionTextNative::snapshot().expect("foreground target");
    let before = unsafe { GetClipboardSequenceNumber() };

    let disabled = read_target(&target, false);
    assert_eq!(disabled.status, SelectionTextStatus::Unavailable);
    assert_eq!(
        unsafe { GetWindowLongPtrW(fixture.edit, GWLP_USERDATA) },
        COPY_PROBE_WAITING
    );

    let enabled = read_target(&target, true);
    assert_eq!(
        (enabled.status, enabled.text),
        (SelectionTextStatus::Unavailable, None)
    );
    assert_eq!(
        unsafe { GetWindowLongPtrW(fixture.edit, GWLP_USERDATA) },
        COPY_PROBE_SEEN
    );
    assert_eq!(unsafe { GetClipboardSequenceNumber() }, before);
}

fn read_foreground() -> super::SelectionTextResult {
    let target = SelectionTextNative::snapshot().unwrap_or_else(|| {
        panic!("test setup failed: snapshot returned no foreground target");
    });
    read_target(&target, true)
}
