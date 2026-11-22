import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";

const TRANSPARENCY_STORAGE_KEY = "settings.transparency";

const log = createLogger("settings/transparency");
const preference = signal(true);
const saveError = signal<string | null>(null);

export const transparency = () => preference();
export const transparencyError = () => saveError();

export async function loadTransparency() {
  try {
    const saved = await Storage.getItem(TRANSPARENCY_STORAGE_KEY);
    preference.set(saved !== "false");
  } catch (error) {
    log.warn("Could not load transparency settings.", error);
  }
}

export async function selectTransparency(value: boolean) {
  preference.set(value);
  saveError.set(null);
  try {
    await Storage.setItem(TRANSPARENCY_STORAGE_KEY, String(value));
  } catch {
    saveError.set(t("settings.transparency.error"));
  }
}
