// ABOUTME: Shared constants for window labels, app display name, and storage paths.
// ABOUTME: Used by window builders, tray setup, SQLite, device state, and credentials.
#![allow(unused)]

pub const WIN_LABEL_MAIN: &str = "main";
pub const WIN_LABEL_QUICK_TRANSLATE: &str = "quick-translate";
pub const APP_NAME: &str = "langnext-app";
pub const TRAY_ID: &str = "main";

/// Event carrying clipboard text to the Quick Translate window on double Ctrl+C.
pub const QUICK_TRANSLATE_CLIPBOARD_EVENT: &str = "quick-translate://clipboard-text";

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
