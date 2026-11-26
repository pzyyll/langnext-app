import { platform, signal, Storage, type TextStyle } from "nsh";
import { t } from "nsh/i18n";
import { BUNDLED_FONTS } from "../../fonts";
import { canListSystemFonts, systemFontFamilies } from "../../platform/system-fonts";
import { createLogger } from "../../services/log";

export const FONT_STORAGE_KEY = "settings.font";

/** The stored value that leaves every text in the platform's own font. */
export const SYSTEM_FONT = "system";

/**
 * Families text falls back to for the characters the chosen font lacks: the Windows UI font
 * carries the interface's Chinese, and the generic family ends the list on every platform.
 */
const FALLBACK_FAMILIES = ["'Microsoft YaHei UI'", "'Segoe UI'", "sans-serif"];

const log = createLogger("settings/font");
const preference = signal<string>(SYSTEM_FONT);
const installed = signal<readonly string[]>([]);
const saveError = signal<string | null>(null);
let listed = false;

export const fontPreference = () => preference();
export const installedFonts = () => installed();
export const fontError = () => saveError();

/** Whether the app can draw with `family` now: a font it ships, or one this system has. */
export function isKnownFontFamily(family: string): boolean {
  return BUNDLED_FONTS.some((font) => font.family === family) || installed().includes(family);
}

/** The `fontFamily` list the whole app is drawn with, or undefined for the system font. */
export function appFontFamily(): string | undefined {
  const chosen = preference();
  if (chosen === SYSTEM_FONT) return undefined;
  return [quoteFamily(chosen), ...FALLBACK_FAMILIES].join(", ");
}

/** The text style a window carries, so every text inside it inherits the chosen font. */
export function appFontStyle(): TextStyle | undefined {
  const family = appFontFamily();
  return family === undefined ? undefined : { fontFamily: family };
}

/** Reads the saved font, then the fonts this system can offer, and drops a font that is gone. */
export async function loadFontSettings(): Promise<void> {
  await loadFont();
  await listInstalledFonts();
}

/** Puts `family` in effect and saves it: `SYSTEM_FONT`, a shipped family or an installed one. */
export async function selectFont(family: string): Promise<void> {
  preference.set(family);
  saveError.set(null);
  try {
    await Storage.setItem(FONT_STORAGE_KEY, family);
  } catch {
    saveError.set(t("settings.font.saveError"));
  }
}

async function loadFont(): Promise<void> {
  try {
    const saved = await Storage.getItem(FONT_STORAGE_KEY);
    preference.set(saved === null || saved.trim() === "" ? SYSTEM_FONT : saved);
  } catch (error) {
    log.warn("Could not load the font setting.", error);
  }
}

/** Lists the system's fonts once, then replaces a chosen font this system no longer has. */
async function listInstalledFonts(): Promise<void> {
  if (listed || !canListSystemFonts(platform.os)) return;
  listed = true;
  const families = await systemFontFamilies();
  if (families.length === 0) {
    // Listing can fail transiently; the next launch tries again.
    listed = false;
    return;
  }
  installed.set(families);
  const chosen = preference();
  if (chosen !== SYSTEM_FONT && !isKnownFontFamily(chosen)) {
    log.warn(`The font "${chosen}" is no longer installed; using the system font.`);
    await selectFont(SYSTEM_FONT);
  }
}

/** Quotes a family whose name holds a comma, which would otherwise split the list. */
function quoteFamily(family: string): string {
  if (family.indexOf(",") === -1) return family;
  return `'${family.split("'").join("")}'`;
}
