import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger, setLogLevel, type LogLevel } from "../../services/log";

export const LOG_LEVEL_STORAGE_KEY = "settings.logLevel";

const log = createLogger("settings/log-level");
const saveError = signal<string | null>(null);

export const logLevelError = () => saveError();

function isLogLevel(value: string | null): value is LogLevel {
  return value === "error" || value === "warn" || value === "info";
}

export async function loadLogLevel() {
  try {
    const saved = await Storage.getItem(LOG_LEVEL_STORAGE_KEY);
    setLogLevel(isLogLevel(saved) ? saved : "warn");
  } catch (error) {
    log.warn("Could not load log level settings.", error);
  }
}

export async function selectLogLevel(value: LogLevel) {
  setLogLevel(value);
  saveError.set(null);
  try {
    await Storage.setItem(LOG_LEVEL_STORAGE_KEY, value);
  } catch {
    saveError.set(t("settings.logLevel.saveError"));
  }
}
