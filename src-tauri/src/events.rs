// ABOUTME: Global Tauri event name constants for cross-window data invalidation.
// ABOUTME: Frontend mirrors these strings in src/query/events.ts.
use tauri::{AppHandle, Emitter};

/// Emitted after translation profile create, update, enable/disable, or delete.
pub const TRANSLATION_PROFILES_CHANGED: &str = "data://translation-profiles-changed";

/// Emitted after provider create, update, enable/disable, delete, or reorder.
pub const PROVIDERS_CHANGED: &str = "data://providers-changed";

/// Emitted after model create, update, enable/disable, delete, or successful sync.
pub const MODELS_CHANGED: &str = "data://models-changed";

/// Broadcast a coarse data-change notification; log emit failures for observability.
pub fn emit_data_changed(app: &AppHandle, event: &str) {
	if let Err(error) = app.emit(event, serde_json::json!({})) {
		eprintln!("data_change_emit_failed event={event} error={error}");
	}
}
