// ABOUTME: Centralized Tauri log plugin configuration for the desktop process.
// ABOUTME: Builds stdout, rotating LogDir, and (debug-only) Webview targets with profile-aware levels.
use tauri::Runtime;
use tauri_plugin_log::{Builder, FileOpenStrategy, RotationStrategy, Target, TargetKind};

/// Stable log basename (plugin appends `.log`) under the OS app log directory.
const LOG_FILE_NAME: &str = "langnext-app";
/// Rotate when the active log file reaches this many bytes.
const MAX_FILE_SIZE_BYTES: u128 = 5 * 1024 * 1024;
/// Keep this many archived rotated files (plus the active file).
const KEEP_ROTATED_FILES: usize = 5;

/// Build the configured log plugin for the application.
///
/// Uses explicit `.targets([...])` so default Stdout+LogDir are replaced, not duplicated.
/// Timezone stays the plugin default (UTC). Format stays the plugin default.
/// Webview broadcast is debug-only; release writes Stdout + LogDir only.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  let level = if cfg!(debug_assertions) {
    log::LevelFilter::Debug
  } else {
    log::LevelFilter::Info
  };

  let mut targets = vec![
    Target::new(TargetKind::Stdout),
    Target::new(TargetKind::LogDir {
      file_name: Some(LOG_FILE_NAME.into()),
    }),
  ];

  // Rust log events reach the frontend console only in debug builds.
  // Frontend plugin log commands still write through Stdout/LogDir in release.
  if cfg!(debug_assertions) {
    targets.push(Target::new(TargetKind::Webview));
  }

  Builder::new()
    .level(level)
    // HTTP and windowing stacks flood Debug; keep warnings and above only.
    .level_for("hyper", log::LevelFilter::Warn)
    .level_for("hyper_util", log::LevelFilter::Warn)
    .level_for("reqwest", log::LevelFilter::Warn)
    .level_for("tao", log::LevelFilter::Warn)
    .level_for("wry", log::LevelFilter::Warn)
    .rotation_strategy(RotationStrategy::KeepSome(KEEP_ROTATED_FILES))
    .file_open_strategy(FileOpenStrategy::Append)
    .max_file_size(MAX_FILE_SIZE_BYTES)
    .targets(targets)
    .build()
}

/// Emit one-time startup facts once the global logger is registered.
///
/// Safe to call from app setup after plugin setup has installed the logger.
/// Does not log tokens, credentials, or user content.
pub fn log_startup() {
  log::info!(
    "app_initialized name={} version={} profile={}",
    env!("CARGO_PKG_NAME"),
    env!("CARGO_PKG_VERSION"),
    if cfg!(debug_assertions) { "debug" } else { "release" }
  );
}
