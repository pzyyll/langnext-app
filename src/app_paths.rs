//! The app's own folders, as the interface opens them.

use nsh_core::prelude::*;

/// Native actions on the files the app keeps.
#[module]
pub struct AppPathsNative;

#[module]
impl AppPathsNative {
    /// Opens the folder holding the app's log files in the system's file manager.
    ///
    /// # Rust
    ///
    /// Takes the folder of the file the app's logger writes (`log_file`), making it when the
    /// logger has written nothing there yet. Resolves false when the app writes no log file or
    /// the file manager could not open the folder.
    pub fn open_logs_folder() -> bool {
        let Some(folder) = logs_folder() else {
            log::warn!("There is no logs folder to open: the app writes no log file.");
            return false;
        };
        if let Err(error) = std::fs::create_dir_all(&folder) {
            log::warn!(
                "Could not make the logs folder `{}`: {error}",
                folder.display()
            );
            return false;
        }
        match platform_open_folder(&folder) {
            Ok(()) => true,
            Err(error) => {
                log::warn!(
                    "Could not open the logs folder `{}`: {error}",
                    folder.display()
                );
                false
            }
        }
    }
}

/// The folder of the app's log files, `None` where the logger writes no file.
fn logs_folder() -> Option<std::path::PathBuf> {
    log_file().and_then(|file| file.parent().map(std::path::Path::to_path_buf))
}

/// Opens `folder` in the system's file manager.
#[cfg(windows)]
fn platform_open_folder(folder: &std::path::Path) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR, w};

    // SAFETY: plain call with NUL-terminated strings that stay alive during it.
    let instance = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(folder.as_os_str()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // Above 32 is success; the rest are error codes.
    if instance.0 as isize > 32 {
        Ok(())
    } else {
        Err(windows::core::Error::from_thread().to_string())
    }
}

#[cfg(not(windows))]
fn platform_open_folder(_folder: &std::path::Path) -> Result<(), String> {
    Err("Only Windows opens the logs folder.".to_owned())
}
