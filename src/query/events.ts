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

/** Coarse notification after OCR service create/update/delete. */
export const DATA_OCR_SERVICES_CHANGED = "data://ocr-services-changed";

/** Coarse notification after Speech service create/update/delete. */
export const DATA_SPEECH_SERVICES_CHANGED = "data://speech-services-changed";

/** Coarse notification after service-integration instance create/update/enable/validate/delete. */
export const DATA_SERVICE_INTEGRATIONS_CHANGED = "data://service-integrations-changed";

/** Coarse notification after app settings import or multi-window settings mutations. */
export const DATA_APP_SETTINGS_CHANGED = "data://app-settings-changed";

/** Clipboard text emitted to the Quick Translate window on double Ctrl+C / OCR delivery. */
export const QUICK_TRANSLATE_CLIPBOARD_TEXT = "quick-translate://clipboard-text";

/** Captured PNG for frontend OCR; payload is QuickTranslateOcrRequest. */
export const QUICK_TRANSLATE_OCR_REQUEST = "quick-translate://ocr-request";

/** Region screenshot finished; payload is RegionScreenshotResult. */
export const REGION_SCREENSHOT_CAPTURED = "screenshot://region-captured";

/** Region screenshot cancelled by the user or overlay close. */
export const REGION_SCREENSHOT_CANCELLED = "screenshot://region-cancelled";

/** Active session ready; payload is RegionScreenshotBackdrop (load then reveal). */
export const REGION_SCREENSHOT_SESSION_READY = "screenshot://session-ready";
