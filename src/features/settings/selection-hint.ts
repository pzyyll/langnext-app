import { Storage, signal } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";
import { canDetectSelectionDrag } from "../../platform/quick-translate";

const log = createLogger("settings/selection-hint");

export const SELECTION_HINT_STORAGE_KEY = "settings.shortcuts.selectionHint";

/** The Windows-only listener that reports presses and possible text drags. */
export interface SelectionHintRuntimeBinding {
  os: string;
  /** Starts the listener and returns its stop handle; throws when the system refuses it. */
  start: () => () => void;
}

const enabled = signal(false);
const active = signal(false);
const saving = signal(false);
const error = signal<string | null>(null);

let runtime: SelectionHintRuntimeBinding | null = null;
let activeStop: (() => void) | null = null;

/** The saved choice: whether the user asked for the drag button. */
export const selectionHintEnabled = () => enabled();
/** Whether the listener actually runs; false while the chooser is off or an opt-in failed. */
export const selectionHintActive = () => active();
export const selectionHintSaving = () => saving();
export const selectionHintError = () => error();

function stopActive() {
  const stop = activeStop;
  activeStop = null;
  if (stop !== null) {
    try {
      stop();
    } catch (cause) {
      log.warn("Could not stop the selection hint listener.", cause);
    }
  }
  active.set(false);
}

/** Loads the saved choice; a missing or unreadable value leaves the feature off. */
export async function loadSelectionHint() {
  try {
    enabled.set((await Storage.getItem(SELECTION_HINT_STORAGE_KEY)) === "true");
  } catch (cause) {
    log.warn("Could not load the selection hint setting.", cause);
    enabled.set(false);
  }
}

/**
 * Connects the platform listener to the saved choice and starts it when both allow it.
 * Returns a release that stops a running listener for shell disposal.
 */
export function registerSelectionHintRuntime(binding: SelectionHintRuntimeBinding): () => void {
  stopActive();
  runtime = binding;
  error.set(null);

  if (enabled() && canDetectSelectionDrag(binding.os)) {
    try {
      activeStop = binding.start();
      active.set(true);
    } catch (cause) {
      activeStop = null;
      active.set(false);
      log.warn("Could not start the selection hint listener.", cause);
      error.set(t("settings.selectionHint.enableError"));
    }
  }

  return () => {
    if (runtime !== binding) return;
    runtime = null;
    stopActive();
  };
}

/**
 * Saves the choice and starts or stops the listener. A failed start or write keeps the previous
 * confirmed setting and whatever listener it ran.
 */
export async function selectSelectionHint(value: boolean): Promise<boolean> {
  if (saving() || value === enabled()) return true;
  saving.set(true);
  error.set(null);

  try {
    if (!value) {
      await Storage.setItem(SELECTION_HINT_STORAGE_KEY, "false");
      stopActive();
      enabled.set(false);
      return true;
    }

    const binding = runtime;
    if (binding === null || !canDetectSelectionDrag(binding.os)) {
      error.set(t("settings.selectionHint.enableError"));
      return false;
    }
    stopActive();
    let stop: () => void;
    try {
      stop = binding.start();
    } catch (cause) {
      log.warn("Could not start the selection hint listener.", cause);
      error.set(t("settings.selectionHint.enableError"));
      return false;
    }
    try {
      await Storage.setItem(SELECTION_HINT_STORAGE_KEY, "true");
    } catch (cause) {
      log.warn("Could not save the selection hint setting.", cause);
      try {
        stop();
      } catch (stopCause) {
        log.warn("Could not stop the selection hint listener.", stopCause);
      }
      error.set(t("settings.selectionHint.saveError"));
      return false;
    }
    activeStop = stop;
    active.set(true);
    enabled.set(true);
    return true;
  } catch (cause) {
    log.warn("Could not save the selection hint setting.", cause);
    error.set(t("settings.selectionHint.saveError"));
    return false;
  } finally {
    saving.set(false);
  }
}
