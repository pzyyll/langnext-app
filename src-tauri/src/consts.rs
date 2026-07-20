// ABOUTME: Shared constants for window labels, app display name, and storage paths.
// ABOUTME: Used by window builders, tray setup, SQLite, device state, and credentials.
#![allow(unused)]

pub const WIN_LABEL_MAIN: &str = "main";
pub const WIN_LABEL_QUICK_TRANSLATE: &str = "quick-translate";
pub const APP_NAME: &str = "langnext-app";
pub const TRAY_ID: &str = "main";

/// Event carrying clipboard text to the Quick Translate window on double Ctrl+C.
pub const QUICK_TRANSLATE_CLIPBOARD_EVENT: &str = "quick-translate://clipboard-text";

/// Settings id for the rebindable global open-Quick-Translate shortcut.
pub const SHORTCUT_OPEN_QUICK_TRANSLATE: &str = "open-quick-translate";
/// Settings id for the fixed double Ctrl+C trigger (enable/disable only).
pub const SHORTCUT_DOUBLE_CTRL_C: &str = "double-ctrl-c";
/// Default binding for open-Quick-Translate (global-hotkey parse format).
pub const DEFAULT_OPEN_QUICK_TRANSLATE_BINDING: &str = "Ctrl+Shift+T";
/// Fixed binding label for double Ctrl+C (trigger is always two presses).
pub const DOUBLE_CTRL_C_BINDING: &str = "Ctrl+C";

/// SQLite database filename under app data.
pub const DB_FILENAME: &str = "langnext.sqlite3";
/// Rotating pre-migration snapshot directory under app data.
pub const BACKUP_DIRNAME: &str = "backups";
/// Machine-specific state filename under app data.
pub const DEVICE_STATE_FILENAME: &str = "device-state.json";
/// Native OS credential store service name (matches tauri identifier).
pub const CREDENTIAL_SERVICE_NAME: &str = "com.balaenis.langnext-app";
/// Maximum migration recovery snapshots to retain.
pub const MAX_BACKUP_SNAPSHOTS: usize = 3;
/// SQLite busy timeout in milliseconds.
pub const SQLITE_BUSY_TIMEOUT_MS: u32 = 5_000;

pub const MAIN_WINDOW_DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
