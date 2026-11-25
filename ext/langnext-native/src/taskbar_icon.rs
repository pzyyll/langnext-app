//! The app's icon on its windows, which Windows shows them by.
//!
//! NSH gives `nsh.json`'s icon to the hidden host window a 0.7 app runs in;
//! a window the app declares opens with none, and Windows then draws its
//! placeholder on the window's taskbar button. These exports put the icon
//! the runner resolves onto the app's windows.

use nsh_core::prelude::*;

#[cfg(windows)]
mod windows;

/// The app's icon on its windows.
#[module]
pub struct TaskbarIconNative;

#[module]
impl TaskbarIconNative {
    /// Gives the app's windows the app's icon, on their taskbar buttons and in the window switcher.
    ///
    /// # Rust
    ///
    /// Resolves the icon as the runner does: the executable's own icon resource (a packaged app), else the `.ico` the development host takes with `--icon`, else `nsh\icon.ico` beside the executable. Returns whether an icon reached a window: false where it finds none, and on platforms that give their windows the app's icon themselves.
    pub fn apply() -> bool {
        apply_to_windows()
    }
}

#[cfg(windows)]
use windows::apply as apply_to_windows;

/// Off Windows the platform puts the app's icon on its windows itself.
#[cfg(not(windows))]
fn apply_to_windows() -> bool {
    false
}
