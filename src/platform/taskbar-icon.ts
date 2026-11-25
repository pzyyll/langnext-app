import { TaskbarIconNative } from "langnext-native";
import { createLogger } from "../services/log";

const log = createLogger("platform/taskbar-icon");

/** Puts the app's icon on the windows it declares: Windows draws a
 * placeholder on a window's taskbar button without one. */
export async function applyTaskbarIcon(): Promise<void> {
  try {
    await TaskbarIconNative.apply();
  } catch (error) {
    log.warn("Could not put the app icon on the window.", error);
  }
}
