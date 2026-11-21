import { signal, Storage } from "nsh";

export const SELECTION_COPY_STORAGE_KEY = "settings.shortcuts.selectionCopyFallback";
const enabled = signal(false);
const saving = signal(false);
const saveFailed = signal(false);

export const selectionCopyEnabled = () => enabled();
export const selectionCopySaving = () => saving();
export const selectionCopySaveFailed = () => saveFailed();

export async function loadSelectionCopy() {
  try {
    enabled.set((await Storage.getItem(SELECTION_COPY_STORAGE_KEY)) === "true");
  } catch {
    enabled.set(false);
  }
}

export async function selectSelectionCopy(value: boolean) {
  if (saving() || value === enabled()) return;
  saving.set(true);
  saveFailed.set(false);
  try {
    await Storage.setItem(SELECTION_COPY_STORAGE_KEY, String(value));
    enabled.set(value);
  } catch {
    saveFailed.set(true);
  } finally {
    saving.set(false);
  }
}
