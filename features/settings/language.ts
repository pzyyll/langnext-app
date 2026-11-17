import { signal, Storage } from "nsh";
import { setLocale, t } from "nsh/i18n";

export type LanguagePreference = "system" | "en" | "zh-CN";

const LANGUAGE_STORAGE_KEY = "settings.language";
const preference = signal<LanguagePreference>("system");
const saveError = signal<string | null>(null);

export const language = () => preference();
export const languageError = () => saveError();

function isLanguagePreference(value: string | null): value is LanguagePreference {
  return value === "system" || value === "en" || value === "zh-CN";
}

/** Applies the whole preference: `setLocale(null)` follows the user's own language. */
function applyPreference(value: LanguagePreference) {
  setLocale(value === "system" ? null : value);
}

export async function loadLanguage() {
  try {
    const saved = await Storage.getItem(LANGUAGE_STORAGE_KEY);
    const value = isLanguagePreference(saved) ? saved : "system";
    preference.set(value);
    applyPreference(value);
  } catch (error) {
    console.warn("Could not load language settings.", error);
  }
}

export async function selectLanguage(value: LanguagePreference) {
  preference.set(value);
  applyPreference(value);
  saveError.set(null);
  try {
    await Storage.setItem(LANGUAGE_STORAGE_KEY, value);
  } catch {
    saveError.set(t("settings.language.error"));
  }
}
