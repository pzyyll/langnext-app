// ABOUTME: Frontend constants for Tauri data-change events used by Query sync.
// ABOUTME: Names must match src-tauri/src/events.rs exactly.
/** Coarse notification after translation profile create/update/enable/delete. */
export const DATA_TRANSLATION_PROFILES_CHANGED = "data://translation-profiles-changed";

/** Coarse notification after provider create/update/enable/delete/reorder. */
export const DATA_PROVIDERS_CHANGED = "data://providers-changed";

/** Coarse notification after model create/update/enable/delete/sync. */
export const DATA_MODELS_CHANGED = "data://models-changed";
