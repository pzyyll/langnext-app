import { platform, signal, Storage } from "nsh";
import { alignmentModel } from "../quick-translate/alignment-model";

export const SENTENCE_ALIGNMENT_STORAGE_KEY = "settings.quickTranslate.sentenceAlignment";

const enabled = signal(false);
const saving = signal(false);
const saveFailed = signal(false);

export const sentenceAlignmentEnabled = () => enabled();
export const sentenceAlignmentSaving = () => saving();
export const sentenceAlignmentSaveFailed = () => saveFailed();

function apply(value: boolean) {
  enabled.set(value);
  if (value) alignmentModel.ensureInstalled();
  else alignmentModel.cancel();
}

export async function loadSentenceAlignment() {
  if (platform.os !== "windows") return;
  try {
    apply((await Storage.getItem(SENTENCE_ALIGNMENT_STORAGE_KEY)) === "true");
  } catch {
    apply(false);
  }
}

export async function selectSentenceAlignment(value: boolean) {
  if (platform.os !== "windows" || saving() || value === enabled()) return;
  saving.set(true);
  saveFailed.set(false);
  try {
    await Storage.setItem(SENTENCE_ALIGNMENT_STORAGE_KEY, String(value));
    apply(value);
  } catch {
    saveFailed.set(true);
  } finally {
    saving.set(false);
  }
}
