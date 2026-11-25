import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { canUseDoubleCopy } from "../../platform/quick-translate";
import { createLogger } from "../../services/log";
import {
  isSourceLanguageId,
  isTargetLanguageId,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
import type { PresetsStoreStatus, TranslationPreset } from "../presets/types";
import { resolvePresetTemplate } from "./translate";

export const QUICK_TRANSLATE_PREFERENCES_KEY = "quickTranslate.preferences.v1";
export const QUICK_TRANSLATE_PREFERENCES_VERSION = 1 as const;

const log = createLogger("quick-translate/preferences");

export interface SavedQuickTranslateCard {
  id: string;
  presetId: string;
  templateId: string | null;
  collapsed: boolean;
}

export interface QuickTranslatePreferences {
  version: typeof QUICK_TRANSLATE_PREFERENCES_VERSION;
  doubleCopyEnabled: boolean;
  autoTranslate: boolean;
  markdownEnabled: boolean;
  sourceLanguage: SourceLanguageId | null;
  targetLanguage: TargetLanguageId | null;
  cards: SavedQuickTranslateCard[];
}

type PopupPreferencesPatch = Partial<
  Pick<
    QuickTranslatePreferences,
    "autoTranslate" | "markdownEnabled" | "sourceLanguage" | "targetLanguage" | "cards"
  >
>;

export interface DoubleCopyRuntimeBinding {
  os: string;
  start: () => () => void;
  onStartupError?: (message: string) => void;
}

export type PreferencesStorage = Pick<typeof Storage, "getItem" | "setItem">;

function defaultPreferences(): QuickTranslatePreferences {
  return {
    version: QUICK_TRANSLATE_PREFERENCES_VERSION,
    doubleCopyEnabled: false,
    autoTranslate: false,
    markdownEnabled: false,
    sourceLanguage: null,
    targetLanguage: null,
    cards: [],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSavedCard(entry: unknown): SavedQuickTranslateCard | null {
  if (!isPlainRecord(entry)) {
    return null;
  }
  if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
    return null;
  }
  if (typeof entry.presetId !== "string" || entry.presetId.trim().length === 0) {
    return null;
  }
  let templateId: string | null = null;
  if (entry.templateId !== undefined && entry.templateId !== null) {
    if (typeof entry.templateId !== "string" || entry.templateId.trim().length === 0) {
      return null;
    }
    templateId = entry.templateId;
  }
  let collapsed = false;
  if (entry.collapsed !== undefined) {
    if (typeof entry.collapsed !== "boolean") {
      return null;
    }
    collapsed = entry.collapsed;
  }
  return {
    id: entry.id,
    presetId: entry.presetId,
    templateId,
    collapsed,
  };
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

  let autoTranslate = false;
  if (parsed.autoTranslate !== undefined) {
    if (typeof parsed.autoTranslate !== "boolean") {
      return null;
    }
    autoTranslate = parsed.autoTranslate;
  }

  const markdownEnabled = parsed.markdownEnabled ?? false;
  if (typeof markdownEnabled !== "boolean") {
    return null;
  }

  let sourceLanguage: SourceLanguageId | null = null;
  if (parsed.sourceLanguage !== undefined && parsed.sourceLanguage !== null) {
    if (!isSourceLanguageId(parsed.sourceLanguage)) {
      return null;
    }
    sourceLanguage = parsed.sourceLanguage;
  }

  let targetLanguage: TargetLanguageId | null = null;
  if (parsed.targetLanguage !== undefined && parsed.targetLanguage !== null) {
    if (!isTargetLanguageId(parsed.targetLanguage)) {
      return null;
    }
    targetLanguage = parsed.targetLanguage;
  }

  const cards: SavedQuickTranslateCard[] = [];
  if (parsed.cards !== undefined) {
    if (!Array.isArray(parsed.cards)) {
      return null;
    }
    const seenIds = new Set<string>();
    for (const item of parsed.cards) {
      const card = parseSavedCard(item);
      if (!card) {
        return null;
      }
      if (seenIds.has(card.id)) {
        return null;
      }
      seenIds.add(card.id);
      cards.push(card);
    }
  }

  return {
    version: QUICK_TRANSLATE_PREFERENCES_VERSION,
    doubleCopyEnabled: parsed.doubleCopyEnabled,
    autoTranslate,
    markdownEnabled,
    sourceLanguage,
    targetLanguage,
    cards,
  };
}

function serializePreferences(prefs: QuickTranslatePreferences): QuickTranslatePreferences {
  return {
    version: QUICK_TRANSLATE_PREFERENCES_VERSION,
    doubleCopyEnabled: prefs.doubleCopyEnabled,
    autoTranslate: prefs.autoTranslate,
    markdownEnabled: prefs.markdownEnabled,
    sourceLanguage: prefs.sourceLanguage,
    targetLanguage: prefs.targetLanguage,
    cards: prefs.cards.map((card) => ({
      id: card.id,
      presetId: card.presetId,
      templateId: card.templateId,
      collapsed: card.collapsed,
    })),
  };
}

/**
 * Filters saved cards only after presets load cleanly; drops missing/disabled presets
 * and resets deleted template overrides to the preset default.
 */
export function resolveQuickTranslateCards(
  savedCards: readonly SavedQuickTranslateCard[],
  presetsStatus: Pick<PresetsStoreStatus, "kind">,
  allPresets: readonly TranslationPreset[],
): SavedQuickTranslateCard[] | null {
  if (presetsStatus.kind !== "ready") {
    return null;
  }
  const enabledById = new Map<string, TranslationPreset>();
  for (const preset of allPresets) {
    if (preset.enabled) {
      enabledById.set(preset.id, preset);
    }
  }

  const resolved: SavedQuickTranslateCard[] = [];
  for (const card of savedCards) {
    const preset = enabledById.get(card.presetId);
    if (!preset) {
      continue;
    }
    const templateMatch = resolvePresetTemplate(preset, card.templateId);
    const nextTemplateId =
      card.templateId && templateMatch && !templateMatch.fellBackToDefault ? card.templateId : null;
    resolved.push({
      id: card.id,
      presetId: preset.id,
      templateId: nextTemplateId,
      collapsed: card.collapsed,
    });
  }
  return resolved;
}

export interface QuickTranslatePreferencesStore {
  preferences: () => QuickTranslatePreferences;
  doubleCopyEnabled: () => boolean;
  doubleCopyError: () => string | null;
  autoTranslate: () => boolean;
  saveError: () => string | null;
  clearSaveError: () => void;
  load: () => Promise<void>;
  registerDoubleCopyRuntime: (runtime: DoubleCopyRuntimeBinding) => () => void;
  selectDoubleCopy: (enabled: boolean) => Promise<boolean>;
  savePopupState: (patch: PopupPreferencesPatch) => Promise<boolean>;
}

/** Creates an isolated Quick Translate preferences store with serialized persistence. */
export function createQuickTranslatePreferencesStore(
  storage: PreferencesStorage = Storage,
): QuickTranslatePreferencesStore {
  const storedPreferencesSignal = signal<QuickTranslatePreferences>(defaultPreferences());
  const doubleCopyActiveSignal = signal(false);
  const doubleCopyErrorSignal = signal<string | null>(null);
  const saveErrorSignal = signal<string | null>(null);

  let activeRuntime: DoubleCopyRuntimeBinding | null = null;
  let activeStop: (() => void) | null = null;
  let operationQueue: Promise<unknown> = Promise.resolve();

  const stopActiveWorker = () => {
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
  };

  const enqueueOperation = <T>(task: () => Promise<T>): Promise<T> => {
    const run = operationQueue.then(task, task);
    operationQueue = run.catch(() => undefined);
    return run;
  };

  const persistSnapshot = async (snapshot: QuickTranslatePreferences): Promise<void> => {
    await storage.setItem(
      QUICK_TRANSLATE_PREFERENCES_KEY,
      JSON.stringify(serializePreferences(snapshot)),
    );
  };

  const load = async () => {
    doubleCopyErrorSignal.set(null);
    saveErrorSignal.set(null);
    try {
      const raw = await storage.getItem(QUICK_TRANSLATE_PREFERENCES_KEY);
      if (raw === null) {
        storedPreferencesSignal.set(defaultPreferences());
        return;
      }
      const valid = parseQuickTranslatePreferences(raw);
      if (!valid) {
        log.warn("Could not parse Quick Translate preferences; retaining defaults.");
        storedPreferencesSignal.set(defaultPreferences());
        return;
      }
      storedPreferencesSignal.set(valid);
    } catch (error) {
      log.warn("Could not load Quick Translate preferences.", error);
      storedPreferencesSignal.set(defaultPreferences());
    }
  };

  const registerRuntime = (runtime: DoubleCopyRuntimeBinding): (() => void) => {
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
  };

  const selectDoubleCopy = (enabled: boolean): Promise<boolean> =>
    enqueueOperation(async () => {
      stopActiveWorker();
      doubleCopyErrorSignal.set(null);

      if (!enabled) {
        const next = serializePreferences({
          ...storedPreferencesSignal(),
          doubleCopyEnabled: false,
        });
        try {
          await persistSnapshot(next);
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

      const next = serializePreferences({
        ...storedPreferencesSignal(),
        doubleCopyEnabled: true,
      });
      try {
        await persistSnapshot(next);
      } catch {
        stopActiveWorker();
        doubleCopyErrorSignal.set(t("settings.doubleCopy.saveError"));
        return false;
      }

      storedPreferencesSignal.set(next);
      doubleCopyActiveSignal.set(true);
      return true;
    });

  const savePopupState = (patch: PopupPreferencesPatch): Promise<boolean> => {
    const next = serializePreferences({
      ...storedPreferencesSignal(),
      ...patch,
    });
    storedPreferencesSignal.set(next);
    saveErrorSignal.set(null);

    return enqueueOperation(async () => {
      saveErrorSignal.set(null);
      try {
        await persistSnapshot(next);
        return true;
      } catch {
        saveErrorSignal.set(t("quickTranslate.error.savePreferences"));
        return false;
      }
    });
  };

  return {
    preferences: () => storedPreferencesSignal(),
    doubleCopyEnabled: () => doubleCopyActiveSignal(),
    doubleCopyError: () => doubleCopyErrorSignal(),
    autoTranslate: () => storedPreferencesSignal().autoTranslate,
    saveError: () => saveErrorSignal(),
    clearSaveError: () => saveErrorSignal.set(null),
    load,
    registerDoubleCopyRuntime: registerRuntime,
    selectDoubleCopy,
    savePopupState,
  };
}

export const quickTranslatePreferencesStore = createQuickTranslatePreferencesStore();

export const doubleCopyEnabled = () => quickTranslatePreferencesStore.doubleCopyEnabled();
export const doubleCopyError = () => quickTranslatePreferencesStore.doubleCopyError();
export const autoTranslatePreference = () => quickTranslatePreferencesStore.autoTranslate();
export const markdownEnabledPreference = () =>
  quickTranslatePreferencesStore.preferences().markdownEnabled;
export const quickTranslatePreferencesError = () => quickTranslatePreferencesStore.saveError();

export const loadQuickTranslatePreferences = () => quickTranslatePreferencesStore.load();
export const registerDoubleCopyRuntime = (runtime: DoubleCopyRuntimeBinding) =>
  quickTranslatePreferencesStore.registerDoubleCopyRuntime(runtime);
export const selectDoubleCopy = (enabled: boolean) =>
  quickTranslatePreferencesStore.selectDoubleCopy(enabled);
export const saveQuickTranslatePopupState = (patch: PopupPreferencesPatch) =>
  quickTranslatePreferencesStore.savePopupState(patch);
