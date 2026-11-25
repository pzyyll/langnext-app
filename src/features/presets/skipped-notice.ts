import { signal, Storage } from "nsh";

const STORAGE_KEY = "presets.skippedNoticeDismissed";
const dismissed = signal(false);

export const skippedNoticeDismissed = () => dismissed();

export async function loadSkippedNoticeDismissal() {
  try {
    dismissed.set((await Storage.getItem(STORAGE_KEY)) === "true");
  } catch {
    // An unreadable preference must not prevent startup or hide the notice.
  }
}

export async function dismissSkippedNotice(): Promise<boolean> {
  if (dismissed()) return true;
  dismissed.set(true);
  try {
    await Storage.setItem(STORAGE_KEY, "true");
    return true;
  } catch {
    dismissed.set(false);
    return false;
  }
}
