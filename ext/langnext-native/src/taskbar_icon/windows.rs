//! Win32: the icon each of the process's top-level windows shows.

use std::cell::RefCell;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_LOADFROMFILE,
    LoadIconW, LoadImageW, SM_CXICON, SM_CXSMICON, SYSTEM_METRICS_INDEX, SendMessageW, WM_GETICON,
    WM_SETICON,
};

/// The icon resource `nsh package` writes into an executable: the one its
/// windows show without an icon of their own.
const APP_ICON_RESOURCE: usize = 1;

/// Where the app's icon is.
enum Source {
    /// Resource [`APP_ICON_RESOURCE`] of the executable.
    Resource,
    /// An `.ico` file.
    File(PathBuf),
}

thread_local! {
    /// The icons loaded from files, kept for the windows that show them.
    static LOADED: RefCell<Vec<(PathBuf, i32, isize)>> = const { RefCell::new(Vec::new()) };
}

pub(super) fn apply() -> bool {
    let Some(source) = source() else {
        log::debug!("window icon: the app ships no icon this run can use.");
        return false;
    };
    let mut windows: Vec<HWND> = Vec::new();
    // SAFETY: the callback pushes into `windows`, which outlives the call.
    unsafe { EnumWindows(Some(collect), &mut windows as *mut Vec<HWND> as LPARAM) };
    for window in &windows {
        dress(*window, &source);
    }
    !windows.is_empty()
}

/// Collects the windows the calling process owns.
unsafe extern "system" fn collect(window: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
    // SAFETY: `lparam` is the vector `apply` hands to `EnumWindows`.
    let windows = unsafe { &mut *(lparam as *mut Vec<HWND>) };
    let mut process = 0;
    // SAFETY: a plain query with a local out value.
    unsafe { GetWindowThreadProcessId(window, &mut process) };
    if process == std::process::id() {
        windows.push(window);
    }
    1
}

/// Gives `window` the app's icon, large and small, unless it has one.
fn dress(window: HWND, source: &Source) {
    if big_icon(window) {
        return;
    }
    match source {
        Source::Resource => {
            let Some(icon) = resource() else { return };
            put(window, ICON_BIG, icon);
            put(window, ICON_SMALL, icon);
        }
        Source::File(path) => {
            let dpi = dpi(window);
            for (which, measured) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
                let side = side_of(measured, dpi);
                if let Some(icon) = file_icon(path, side) {
                    put(window, which, icon);
                }
            }
        }
    }
}

/// Whether `window` already shows a large icon of its own (the host's, set
/// when it was made).
fn big_icon(window: HWND) -> bool {
    // SAFETY: a plain query of a window of this thread.
    let icon = unsafe { SendMessageW(window, WM_GETICON, ICON_BIG as usize, 0) };
    icon != 0
}

/// Makes `icon` the icon `window` shows for `which`.
fn put(window: HWND, which: u32, icon: isize) {
    // SAFETY: a message to a window of this thread, with an icon kept for the process.
    unsafe { SendMessageW(window, WM_SETICON, which as usize, icon) };
}

/// The window's DPI (96 at 100%).
fn dpi(window: HWND) -> u32 {
    // SAFETY: a plain query; 0 for a window that has none.
    let dpi = unsafe { GetDpiForWindow(window) };
    if dpi == 0 { 96 } else { dpi }
}

/// The system metric `measured` at `dpi`, at least one pixel.
fn side_of(measured: SYSTEM_METRICS_INDEX, dpi: u32) -> i32 {
    // SAFETY: a plain query.
    unsafe { GetSystemMetricsForDpi(measured, dpi) }.max(1)
}

/// The executable's own icon, which its windows show without one set.
fn resource() -> Option<isize> {
    // SAFETY: a plain lookup of a resource icon, shared and never destroyed here.
    let icon = unsafe { LoadIconW(module(), APP_ICON_RESOURCE as *const u16) };
    (!icon.is_null()).then_some(icon as isize)
}

/// The icon of `path` at `side` pixels, loaded once per file and size.
fn file_icon(path: &Path, side: i32) -> Option<isize> {
    let loaded = LOADED.with(|icons| {
        icons
            .borrow()
            .iter()
            .find(|(file, size, _)| file == path && *size == side)
            .map(|(_, _, icon)| *icon)
    });
    if loaded.is_some() {
        return loaded;
    }
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: a NUL-terminated path that outlives the call; the icon is kept for the process.
    let icon = unsafe {
        LoadImageW(
            ptr::null_mut(),
            name.as_ptr(),
            IMAGE_ICON,
            side,
            side,
            LR_LOADFROMFILE,
        )
    };
    if icon.is_null() {
        log::warn!(
            "window icon: cannot load `{}`: {}",
            path.display(),
            std::io::Error::last_os_error()
        );
        return None;
    }
    let icon = icon as isize;
    LOADED.with(|icons| icons.borrow_mut().push((path.to_path_buf(), side, icon)));
    Some(icon)
}

/// The icon this run shows, where it is.
fn source() -> Option<Source> {
    if resource().is_some() {
        return Some(Source::Resource);
    }
    if let Some(path) = icon_option() {
        return Some(Source::File(path));
    }
    let beside = std::env::current_exe()
        .ok()?
        .parent()?
        .join("nsh")
        .join("icon.ico");
    beside.is_file().then_some(Source::File(beside))
}

/// The `.ico` the development host takes with `--icon`.
fn icon_option() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--icon" {
            return args.next().map(PathBuf::from).filter(|path| path.is_file());
        }
    }
    None
}

/// The module this process runs.
fn module() -> *mut c_void {
    // SAFETY: the module handle of this executable.
    unsafe { GetModuleHandleW(ptr::null()) }
}
