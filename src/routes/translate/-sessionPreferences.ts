// ABOUTME: Translate page session preferences (profile, model, languages).
// ABOUTME: Persists to localStorage with safe parse/validation so restarts and navigation restore cleanly.
import { isSelectableLanguageId, type SelectableLanguageId, type SourceLanguageId } from "./-languages";

/** Namespaced key for translate toolbar session preferences. */
export const TRANSLATE_SESSION_PREFERENCES_KEY = "langnext-translate-session";

export interface TranslateSessionPreferences {
  profileId: string;
  modelId: string;
  sourceLang: SourceLanguageId;
  targetLang: SelectableLanguageId;
}

export const DEFAULT_TRANSLATE_SESSION_PREFERENCES: TranslateSessionPreferences = {
  profileId: "",
  modelId: "",
  sourceLang: "auto",
  targetLang: "en",
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Normalize a raw stored object into a full preferences record.
 * Invalid or partial fields fall back to defaults without throwing.
 */
export function normalizeTranslateSessionPreferences(raw: unknown): TranslateSessionPreferences {
  if (raw == null || typeof raw !== "object") {
    return { ...DEFAULT_TRANSLATE_SESSION_PREFERENCES };
  }

  const record = raw as Record<string, unknown>;
  const profileId = isNonEmptyString(record.profileId) ? record.profileId : "";
  const modelId = isNonEmptyString(record.modelId) ? record.modelId : "";
  const sourceLang = isSelectableLanguageId(typeof record.sourceLang === "string" ? record.sourceLang : null)
    ? record.sourceLang
    : DEFAULT_TRANSLATE_SESSION_PREFERENCES.sourceLang;
  const targetLang = isSelectableLanguageId(typeof record.targetLang === "string" ? record.targetLang : null)
    ? record.targetLang
    : DEFAULT_TRANSLATE_SESSION_PREFERENCES.targetLang;

  return {
    profileId,
    modelId,
    sourceLang: sourceLang as SourceLanguageId,
    targetLang: targetLang as SelectableLanguageId,
  };
}

/** Read preferences from localStorage; invalid JSON or values fall back to defaults. */
export function getTranslateSessionPreferences(): TranslateSessionPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_TRANSLATE_SESSION_PREFERENCES };
  }

  try {
    const stored = localStorage.getItem(TRANSLATE_SESSION_PREFERENCES_KEY);
    if (stored == null || stored === "") {
      return { ...DEFAULT_TRANSLATE_SESSION_PREFERENCES };
    }
    return normalizeTranslateSessionPreferences(JSON.parse(stored) as unknown);
  } catch {
    return { ...DEFAULT_TRANSLATE_SESSION_PREFERENCES };
  }
}

/** Persist preferences (browser + Tauri webview localStorage). Swallows storage errors. */
export function setTranslateSessionPreferences(prefs: TranslateSessionPreferences): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = normalizeTranslateSessionPreferences(prefs);
    localStorage.setItem(TRANSLATE_SESSION_PREFERENCES_KEY, JSON.stringify(normalized));
  } catch {
    // Quota or private-mode failures must not break the page.
  }
}
