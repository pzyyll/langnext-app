// ABOUTME: Frontend constants for Tauri events used by Query sync and Quick Translate.
// ABOUTME: Names must match src-tauri constants (events.rs / consts.rs) exactly.
/** Coarse notification after translation profile create/update/enable/delete. */
export const DATA_TRANSLATION_PROFILES_CHANGED = "data://translation-profiles-changed";

/** Coarse notification after provider create/update/enable/delete/reorder. */
export const DATA_PROVIDERS_CHANGED = "data://providers-changed";

/** Coarse notification after model create/update/enable/delete/sync. */
export const DATA_MODELS_CHANGED = "data://models-changed";

/** Coarse notification after translation history delete or clear-all (not after each write). */
export const DATA_TRANSLATION_HISTORY_CHANGED = "data://translation-history-changed";

/** Clipboard text emitted to the Quick Translate window on double Ctrl+C. */
export const QUICK_TRANSLATE_CLIPBOARD_TEXT = "quick-translate://clipboard-text";
