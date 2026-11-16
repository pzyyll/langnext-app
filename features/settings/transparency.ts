import { signal, Storage } from "nsh";

const TRANSPARENCY_STORAGE_KEY = "settings.transparency";
const preference = signal(true);
const saveError = signal<string | null>(null);

export const transparency = () => preference();
export const transparencyError = () => saveError();

export async function loadTransparency() {
  try {
    const saved = await Storage.getItem(TRANSPARENCY_STORAGE_KEY);
    preference.set(saved !== "false");
  } catch (error) {
    console.warn("Could not load transparency settings.", error);
  }
}

export async function selectTransparency(value: boolean) {
  preference.set(value);
  saveError.set(null);
  try {
    await Storage.setItem(TRANSPARENCY_STORAGE_KEY, String(value));
  } catch {
    saveError.set("Could not save transparency. Your choice will apply until you close the app.");
  }
}
