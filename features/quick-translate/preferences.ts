import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { canUseDoubleCopy } from "../../platform/quick-translate";

export const QUICK_TRANSLATE_PREFERENCES_KEY = "quickTranslate.preferences.v1";
export const QUICK_TRANSLATE_PREFERENCES_VERSION = 1 as const;

export interface QuickTranslatePreferences {
  version: typeof QUICK_TRANSLATE_PREFERENCES_VERSION;
  doubleCopyEnabled: boolean;
}

export interface DoubleCopyRuntimeBinding {
  os: string;
  start: () => () => void;
  onStartupError?: (message: string) => void;
}

function defaultPreferences(): QuickTranslatePreferences {
  return {
    version: QUICK_TRANSLATE_PREFERENCES_VERSION,
    doubleCopyEnabled: false,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates the versioned Quick Translate preferences payload. */
export function parseQuickTranslatePreferences(raw: string): QuickTranslatePreferences | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) {
    return null;
  }
  if (parsed.version !== QUICK_TRANSLATE_PREFERENCES_VERSION) {
    return null;
  }
  if (typeof parsed.doubleCopyEnabled !== "boolean") {
    return null;
  }
  return {
    version: QUICK_TRANSLATE_PREFERENCES_VERSION,
    doubleCopyEnabled: parsed.doubleCopyEnabled,
  };
}

const storedPreferencesSignal = signal<QuickTranslatePreferences>(defaultPreferences());
const doubleCopyActiveSignal = signal(false);
const doubleCopyErrorSignal = signal<string | null>(null);

let activeRuntime: DoubleCopyRuntimeBinding | null = null;
let activeStop: (() => void) | null = null;
let operationQueue: Promise<unknown> = Promise.resolve();

function stopActiveWorker(): void {
  const stop = activeStop;
  activeStop = null;
  if (stop) {
    try {
      stop();
    } catch {
      // Ignore cleanup errors when tearing down a listener.
    }
  }
  doubleCopyActiveSignal.set(false);
}

function enqueueOperation<T>(task: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(task, task);
  operationQueue = run.catch(() => undefined);
  return run;
}

async function persistPreferences(next: QuickTranslatePreferences): Promise<void> {
  await Storage.setItem(QUICK_TRANSLATE_PREFERENCES_KEY, JSON.stringify(next));
}

export const doubleCopyEnabled = () => doubleCopyActiveSignal();
export const doubleCopyError = () => doubleCopyErrorSignal();

/** Loads saved Quick Translate preferences once at startup without throwing on unreadable storage. */
export async function loadQuickTranslatePreferences(): Promise<void> {
  doubleCopyErrorSignal.set(null);
  try {
    const raw = await Storage.getItem(QUICK_TRANSLATE_PREFERENCES_KEY);
    if (raw === null) {
      storedPreferencesSignal.set(defaultPreferences());
      return;
    }
    const valid = parseQuickTranslatePreferences(raw);
    if (!valid) {
      console.warn("Could not parse Quick Translate preferences; retaining defaults.");
      storedPreferencesSignal.set(defaultPreferences());
      return;
    }
    storedPreferencesSignal.set(valid);
  } catch (error) {
    console.warn("Could not load Quick Translate preferences.", error);
    storedPreferencesSignal.set(defaultPreferences());
  }
}

/** Attaches the shell's OS double-copy listener coordinator and starts if opted in on Windows. */
export function registerDoubleCopyRuntime(runtime: DoubleCopyRuntimeBinding): () => void {
  stopActiveWorker();
  activeRuntime = runtime;
  doubleCopyErrorSignal.set(null);

  const wantsDoubleCopy = storedPreferencesSignal().doubleCopyEnabled;
  if (wantsDoubleCopy && canUseDoubleCopy(runtime.os)) {
    try {
      activeStop = runtime.start();
      doubleCopyActiveSignal.set(true);
    } catch {
      activeStop = null;
      doubleCopyActiveSignal.set(false);
      const message = t("settings.doubleCopy.enableError");
      doubleCopyErrorSignal.set(message);
      runtime.onStartupError?.(message);
    }
  }

  return () => {
    if (activeRuntime === runtime) {
      activeRuntime = null;
      stopActiveWorker();
    }
  };
}

/** Toggles double-Ctrl+C listening, verifying worker startup before reporting or persisting enabled. */
export function selectDoubleCopy(enabled: boolean): Promise<boolean> {
  return enqueueOperation(async () => {
    stopActiveWorker();
    doubleCopyErrorSignal.set(null);

    if (!enabled) {
      const next: QuickTranslatePreferences = {
        ...storedPreferencesSignal(),
        doubleCopyEnabled: false,
      };
      try {
        await persistPreferences(next);
      } catch {
        doubleCopyErrorSignal.set(t("settings.doubleCopy.saveError"));
        return false;
      }
      storedPreferencesSignal.set(next);
      return true;
    }

    const runtime = activeRuntime;
    if (!runtime || !canUseDoubleCopy(runtime.os)) {
      doubleCopyErrorSignal.set(t("settings.doubleCopy.enableError"));
      return false;
    }

    try {
      activeStop = runtime.start();
    } catch {
      activeStop = null;
      doubleCopyActiveSignal.set(false);
      doubleCopyErrorSignal.set(t("settings.doubleCopy.enableError"));
      return false;
    }

    const next: QuickTranslatePreferences = {
      ...storedPreferencesSignal(),
      doubleCopyEnabled: true,
    };
    try {
      await persistPreferences(next);
    } catch {
      stopActiveWorker();
      doubleCopyErrorSignal.set(t("settings.doubleCopy.saveError"));
      return false;
    }

    storedPreferencesSignal.set(next);
    doubleCopyActiveSignal.set(true);
    return true;
  });
}
