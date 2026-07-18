// ABOUTME: i18next singleton setup for the React app.
// ABOUTME: Uses bundled resources only; language persistence lives in settings/cache helpers.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import {
  DEFAULT_LANGUAGE,
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  applyLanguageToDom,
  normalizeLanguage,
  readLanguageCache,
  type AppLanguage,
} from "./languages";

export const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
} as const;

let initPromise: Promise<typeof i18n> | null = null;
let languageSyncInstalled = false;

/** Resolve the language implied by a peer-window storage event, or null if unrelated. */
export function resolveLanguageFromStorageEvent(event: Pick<StorageEvent, "key" | "newValue">): AppLanguage | null {
  if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) {
    return null;
  }
  if (event.key === null || event.newValue == null) {
    return readLanguageCache();
  }
  return normalizeLanguage(event.newValue);
}

/** Apply a peer-window language cache change to this webview's i18n + DOM. */
export async function handleLanguageStorageEvent(event: Pick<StorageEvent, "key" | "newValue">): Promise<void> {
  const next = resolveLanguageFromStorageEvent(event);
  if (next == null) {
    return;
  }
  // Idempotent: no-ops when already active; applyLanguageToDom skips setItem if cache matches.
  await applyAppLanguage(next);
}

/**
 * Keep secondary Tauri webviews (e.g. Quick Translate) in sync when another
 * window updates the shared localStorage language cache.
 * Same-window updates use LANGUAGE_CHANGE_EVENT / i18n.languageChanged instead.
 */
export function installLanguageCrossWindowSync(): void {
  if (typeof window === "undefined" || languageSyncInstalled) {
    return;
  }
  languageSyncInstalled = true;

  window.addEventListener("storage", (event: StorageEvent) => {
    void handleLanguageStorageEvent(event);
  });
}

/**
 * Initialize i18next once. Safe to call multiple times.
 * @param language Optional authoritative language (e.g. from AppSettings).
 */
export async function initI18n(language?: string | null): Promise<typeof i18n> {
  // Install before any await so early storage events are not dropped after mount.
  installLanguageCrossWindowSync();
  const resolved = normalizeLanguage(language ?? readLanguageCache());

  if (i18n.isInitialized) {
    if (i18n.language !== resolved) {
      await i18n.changeLanguage(resolved);
    }
    applyLanguageToDom(resolved);
    return i18n;
  }

  if (!initPromise) {
    initPromise = i18n
      .use(initReactI18next)
      .init({
        resources,
        lng: resolved,
        fallbackLng: FALLBACK_LANGUAGE,
        defaultNS: "translation",
        ns: ["translation"],
        interpolation: {
          escapeValue: false,
        },
        returnNull: false,
      })
      .then(() => {
        applyLanguageToDom(resolved);
        return i18n;
      });
  }

  const instance = await initPromise;
  if (instance.language !== resolved) {
    await instance.changeLanguage(resolved);
    applyLanguageToDom(resolved);
  }
  return instance;
}

/** Apply language in i18n + DOM/cache without persisting to SQLite. */
export async function applyAppLanguage(language: AppLanguage): Promise<void> {
  const resolved = normalizeLanguage(language);
  if (!i18n.isInitialized) {
    await initI18n(resolved);
    return;
  }
  if (i18n.language !== resolved) {
    await i18n.changeLanguage(resolved);
  }
  applyLanguageToDom(resolved);
}

export function getAppLanguage(): AppLanguage {
  if (!i18n.isInitialized) {
    return readLanguageCache();
  }
  return normalizeLanguage(i18n.language);
}

export { DEFAULT_LANGUAGE, FALLBACK_LANGUAGE };
export type { AppLanguage };
export default i18n;
