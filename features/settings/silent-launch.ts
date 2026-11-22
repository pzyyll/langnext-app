import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";

export const SILENT_LAUNCH_STORAGE_KEY = "settings.silentLaunch";

const log = createLogger("settings/silent-launch");

const enabled = signal(false);
const saveError = signal<string | null>(null);

export const silentLaunch = () => enabled();
export const silentLaunchError = () => saveError();

export async function loadSilentLaunch() {
  try {
    enabled.set((await Storage.getItem(SILENT_LAUNCH_STORAGE_KEY)) === "true");
  } catch (error) {
    log.warn("Could not load silent launch settings.", error);
  }
}

/** The switch shows what the next launch reads, so only a saved value moves it. */
export async function selectSilentLaunch(value: boolean) {
  if (value === enabled()) return;
  saveError.set(null);
  try {
    await Storage.setItem(SILENT_LAUNCH_STORAGE_KEY, String(value));
    enabled.set(value);
  } catch {
    saveError.set(t("settings.silentLaunch.error"));
  }
}
