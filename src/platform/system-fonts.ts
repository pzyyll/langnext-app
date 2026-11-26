import { SystemFontsNative } from "langnext-native";
import { createLogger } from "../services/log";

const log = createLogger("platform/system-fonts");

/** Where the system lists its own fonts: Windows only, where the renderer reads DirectWrite. */
export function canListSystemFonts(os: string): boolean {
  return os === "windows";
}

/** The family names of the fonts installed on this system; empty where it cannot list them. */
export async function systemFontFamilies(): Promise<string[]> {
  try {
    return await SystemFontsNative.systemFontFamilies();
  } catch (error) {
    log.warn("Could not list the system fonts.", error);
    return [];
  }
}
