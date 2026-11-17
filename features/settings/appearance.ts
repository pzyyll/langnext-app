import { setColorScheme, signal, Storage } from "nsh";
import { t } from "nsh/i18n";

export type Appearance = "light" | "dark" | "system";

const APPEARANCE_STORAGE_KEY = "settings.appearance";
const preference = signal<Appearance>("system");
const saveError = signal<string | null>(null);

export const appearance = () => preference();
export const appearanceError = () => saveError();

function isAppearance(value: string | null): value is Appearance {
  return value === "light" || value === "dark" || value === "system";
}

export async function loadAppearance() {
  try {
    const saved = await Storage.getItem(APPEARANCE_STORAGE_KEY);
    const value = isAppearance(saved) ? saved : "system";
    preference.set(value);
    setColorScheme(value);
  } catch (error) {
    console.warn("Could not load appearance settings.", error);
  }
}

export async function selectAppearance(value: Appearance) {
  preference.set(value);
  setColorScheme(value);
  saveError.set(null);
  try {
    await Storage.setItem(APPEARANCE_STORAGE_KEY, value);
  } catch {
    saveError.set(t("settings.appearance.error"));
  }
}
