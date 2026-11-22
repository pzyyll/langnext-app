import { AppPathsNative } from "my-translator/native";
import { createLogger } from "../services/log";

const log = createLogger("platform/logs");

/** The logs folder opens on Windows only. */
export function canOpenLogsFolder(os: string): boolean {
  return os === "windows";
}

/** Opens the folder holding the app's log files in File Explorer; false when it could not. */
export async function openLogsFolder(): Promise<boolean> {
  try {
    return await AppPathsNative.openLogsFolder();
  } catch (error) {
    log.warn("Could not open the logs folder.", error);
    return false;
  }
}
