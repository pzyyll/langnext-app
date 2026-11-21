//! Foreground selection reader. The shortcut asks for the current selection; nothing is watched.

use nsh_core::prelude::*;

#[cfg(windows)]
mod windows;

#[cfg(all(windows, test))]
mod desktop_tests;

/// How one selection read ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum SelectionTextStatus {
    /// The target still has a nonblank selection in `text`.
    Selected,
    /// The target is current and has no nonblank selection.
    NoSelection,
    /// The target is current, but the control is protected, unsupported, or did not answer.
    Unavailable,
    /// The foreground window or its focused control changed before the read finished.
    Stale,
}

/// One selection answer. Only [`SelectionTextStatus::Selected`] carries `text`.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct SelectionTextResult {
    /// How the read ended.
    pub status: SelectionTextStatus,
    /// The selected text, present only for [`SelectionTextStatus::Selected`].
    pub text: Option<String>,
}

impl SelectionTextResult {
    /// A nonblank selection.
    pub fn selected(text: String) -> Self {
        Self {
            status: SelectionTextStatus::Selected,
            text: Some(text),
        }
    }

    /// The current target has a caret or blank selection.
    pub fn no_selection() -> Self {
        Self {
            status: SelectionTextStatus::NoSelection,
            text: None,
        }
    }

    /// The current target cannot be read.
    pub fn unavailable() -> Self {
        Self {
            status: SelectionTextStatus::Unavailable,
            text: None,
        }
    }

    /// The captured target is no longer the foreground focus.
    pub fn stale() -> Self {
        Self {
            status: SelectionTextStatus::Stale,
            text: None,
        }
    }
}

/// Native selection reader: one on-demand read of the foreground control.
#[module]
pub struct SelectionTextNative;

#[module]
impl SelectionTextNative {
    /// Opaque foreground target, or `null` when no window is in front.
    ///
    /// # Rust
    ///
    /// The string identifies the top-level window and its focused control. It is not a
    /// numeric handle. Outside Windows there is never a target.
    pub fn snapshot() -> Option<String> {
        platform_snapshot()
    }

    /// Whether `target` still names the foreground window and its focused control.
    pub fn is_current(target: String) -> bool {
        platform_is_current(&target)
    }

    /// Reads the selection captured in `target`.
    ///
    /// # Rust
    ///
    /// The read runs on a blocking worker so UI Automation stays off the engine thread.
    /// A worker failure is `unavailable`.
    pub async fn read(target: String) -> SelectionTextResult {
        let joined = blocking(move || read_target(&target)).await;
        joined.unwrap_or_else(|_| SelectionTextResult::unavailable())
    }
}

fn platform_snapshot() -> Option<String> {
    #[cfg(windows)]
    {
        windows::snapshot()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn platform_is_current(target: &str) -> bool {
    #[cfg(windows)]
    {
        windows::is_current(target)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        false
    }
}

pub(crate) fn read_target(target: &str) -> SelectionTextResult {
    #[cfg(windows)]
    {
        windows::read_target(target)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        SelectionTextResult::unavailable()
    }
}
