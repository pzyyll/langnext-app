import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { isLanguageId, type LanguageId } from "../presets/languages";

export const LANGUAGE_DETECTION_STORAGE_KEY = "settings.languageDetection.v2";
const STORAGE_VERSION = 2;

/** Detection channels in default priority order. */
export const LANGUAGE_DETECTOR_KINDS = ["ai", "google"] as const;

/** Service behind automatic language detection. */
export type LanguageDetectorKind = (typeof LANGUAGE_DETECTOR_KINDS)[number];

/**
 * Saved configuration for one detector. AI keeps a model ID; Google needs no
 * configuration, so it stores no binding fields.
 */
export type LanguageDetectorBinding = { kind: "ai"; modelId: string } | { kind: "google" };

export type LanguageAiBinding = Extract<LanguageDetectorBinding, { kind: "ai" }>;

/** One action's immutable detector chain and Automatic-target language preferences. */
export interface LanguageDetectionSnapshot {
  detectors: readonly LanguageDetectorBinding[];
  nativeLanguage: LanguageId | null;
  preferredTranslationLanguage: LanguageId | null;
}

export type LanguageDetectionPreferences = Pick<
  LanguageDetectionSnapshot,
  "nativeLanguage" | "preferredTranslationLanguage"
>;

export type LanguageDetectionErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "model_id_blank"
  | "detector_unconfigured"
  | "preference_invalid"
  | "preferences_identical";

export interface LanguageDetectionLoadError {
  key: LanguageDetectionErrorKey;
  message: string;
}

export type LanguageDetectionSaveResult =
  | { ok: true; binding: LanguageAiBinding }
  | { ok: false; key: LanguageDetectionErrorKey; message: string };

export type LanguageDetectionActionResult =
  | { ok: true }
  | { ok: false; key: LanguageDetectionErrorKey; message: string };

export interface LanguageDetectionSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Each detector owns its saved config, enabled toggle, and priority position. */
interface LanguageDetectionSavedSettings {
  order: LanguageDetectorKind[];
  enabled: Record<LanguageDetectorKind, boolean>;
  ai: LanguageAiBinding | null;
  nativeLanguage: LanguageId | null;
  preferredTranslationLanguage: LanguageId | null;
}

const EMPTY_SETTINGS: LanguageDetectionSavedSettings = {
  order: [...LANGUAGE_DETECTOR_KINDS],
  enabled: { ai: false, google: false },
  ai: null,
  nativeLanguage: null,
  preferredTranslationLanguage: null,
};

export interface LanguageDetectionSettingsStore {
  load(): Promise<void>;
  /** Detectors in top-to-bottom priority order. */
  detectorOrder(): readonly LanguageDetectorKind[];
  /** Whether one detector is enabled. */
  isEnabled(kind: LanguageDetectorKind): boolean;
  /** The saved AI configuration, independent of enabled state. */
  savedAiBinding(): LanguageAiBinding | null;
  /** Enabled detector configurations in top-to-bottom priority order. */
  enabledDetectors(): readonly LanguageDetectorBinding[];
  /** The detector chain and preferences one translation action reads once. */
  snapshot(): LanguageDetectionSnapshot;
  loadError(): LanguageDetectionLoadError | null;
  saveAiModel(modelId: string): Promise<LanguageDetectionSaveResult>;
  setEnabled(kind: LanguageDetectorKind, enabled: boolean): Promise<LanguageDetectionActionResult>;
  /** Moves one detector to a new top-to-bottom priority position, clamped to the list. */
  moveDetectorTo(
    kind: LanguageDetectorKind,
    targetIndex: number,
  ): Promise<LanguageDetectionActionResult>;
  savePreferences(
    preferences: LanguageDetectionPreferences,
  ): Promise<LanguageDetectionActionResult>;
}

const ERROR_MESSAGES: Record<LanguageDetectionErrorKey, string> = {
  storage_read_failed: "settings.languageDetection.error.storageReadFailed",
  storage_malformed: "settings.languageDetection.error.storageMalformed",
  storage_unsupported_version: "settings.languageDetection.error.storageUnsupportedVersion",
  storage_write_failed: "settings.languageDetection.error.storageWriteFailed",
  model_id_blank: "settings.languageDetection.error.modelIdBlank",
  detector_unconfigured: "settings.languageDetection.error.detectorUnconfigured",
  preference_invalid: "settings.languageDetection.error.preferenceInvalid",
  preferences_identical: "settings.languageDetection.error.preferencesIdentical",
};

function failure(key: LanguageDetectionErrorKey): {
  ok: false;
  key: LanguageDetectionErrorKey;
  message: string;
} {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLanguageDetectorKind(value: unknown): value is LanguageDetectorKind {
  return (
    typeof value === "string" && (LANGUAGE_DETECTOR_KINDS as readonly string[]).includes(value)
  );
}

function isNonblankModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPreference(value: unknown): value is LanguageId | null {
  return value === null || isLanguageId(value);
}

function validatePreferences(
  preferences: LanguageDetectionPreferences,
): LanguageDetectionErrorKey | null {
  if (!isPreference(preferences.nativeLanguage)) return "preference_invalid";
  if (!isPreference(preferences.preferredTranslationLanguage)) return "preference_invalid";
  if (
    preferences.nativeLanguage !== null &&
    preferences.nativeLanguage === preferences.preferredTranslationLanguage
  ) {
    return "preferences_identical";
  }
  return null;
}

function copySettings(settings: LanguageDetectionSavedSettings): LanguageDetectionSavedSettings {
  return {
    order: [...settings.order],
    enabled: { ai: settings.enabled.ai, google: settings.enabled.google },
    ai: settings.ai === null ? null : { kind: "ai", modelId: settings.ai.modelId },
    nativeLanguage: settings.nativeLanguage,
    preferredTranslationLanguage: settings.preferredTranslationLanguage,
  };
}

/** A missing or null entry means "not saved"; `undefined` means the entry is malformed. */
function parseAiBinding(value: unknown): LanguageAiBinding | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || !isNonblankModelId(value.modelId)) return undefined;
  return { kind: "ai", modelId: value.modelId };
}

function parseOrder(value: unknown): LanguageDetectorKind[] | null {
  if (!Array.isArray(value) || value.length !== LANGUAGE_DETECTOR_KINDS.length) return null;
  const seen = new Set<LanguageDetectorKind>();
  const order: LanguageDetectorKind[] = [];
  for (const item of value) {
    if (!isLanguageDetectorKind(item) || seen.has(item)) return null;
    seen.add(item);
    order.push(item);
  }
  return seen.size === LANGUAGE_DETECTOR_KINDS.length ? order : null;
}

function parseEnabledMap(value: unknown): Record<LanguageDetectorKind, boolean> | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.ai !== "boolean" || typeof value.google !== "boolean") return null;
  return { ai: value.ai, google: value.google };
}

type ParsedStorage =
  | { ok: true; settings: LanguageDetectionSavedSettings }
  | { ok: false; key: LanguageDetectionErrorKey };

function parseStoredSettings(raw: string): ParsedStorage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, key: "storage_malformed" };
  }
  if (!isPlainObject(parsed)) return { ok: false, key: "storage_malformed" };
  if (typeof parsed.version !== "number") return { ok: false, key: "storage_malformed" };
  if (parsed.version !== STORAGE_VERSION) {
    return { ok: false, key: "storage_unsupported_version" };
  }

  const order = parseOrder(parsed.order);
  const enabled = parseEnabledMap(parsed.enabled);
  const ai = parseAiBinding(parsed.ai);
  if (order === null || enabled === null || ai === undefined) {
    return { ok: false, key: "storage_malformed" };
  }
  if (enabled.ai && ai === null) return { ok: false, key: "storage_malformed" };

  const preferences: LanguageDetectionPreferences = {
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  };
  if (!isPreference(parsed.nativeLanguage)) return { ok: false, key: "storage_malformed" };
  if (!isPreference(parsed.preferredTranslationLanguage)) {
    return { ok: false, key: "storage_malformed" };
  }
  preferences.nativeLanguage = parsed.nativeLanguage;
  preferences.preferredTranslationLanguage = parsed.preferredTranslationLanguage;
  if (validatePreferences(preferences) !== null) return { ok: false, key: "storage_malformed" };

  return {
    ok: true,
    settings: {
      order,
      enabled,
      ai,
      nativeLanguage: preferences.nativeLanguage,
      preferredTranslationLanguage: preferences.preferredTranslationLanguage,
    },
  };
}

function storagePayload(settings: LanguageDetectionSavedSettings): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    order: settings.order,
    enabled: settings.enabled,
    ai: settings.ai === null ? null : { modelId: settings.ai.modelId },
    nativeLanguage: settings.nativeLanguage,
    preferredTranslationLanguage: settings.preferredTranslationLanguage,
  });
}

function enabledDetectorsOf(settings: LanguageDetectionSavedSettings): LanguageDetectorBinding[] {
  const detectors: LanguageDetectorBinding[] = [];
  for (const kind of settings.order) {
    if (!settings.enabled[kind]) continue;
    if (kind === "google") {
      detectors.push({ kind: "google" });
    } else if (settings.ai !== null) {
      detectors.push({ kind: "ai", modelId: settings.ai.modelId });
    }
  }
  return detectors;
}

/** Creates a language detection settings store backed by injected storage. */
export function createLanguageDetectionSettingsStore(
  storage: LanguageDetectionSettingsStorage,
): LanguageDetectionSettingsStore {
  const settingsSignal = signal<LanguageDetectionSavedSettings>(copySettings(EMPTY_SETTINGS));
  const loadErrorSignal = signal<LanguageDetectionLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function persistSnapshot(
    settings: LanguageDetectionSavedSettings,
  ): Promise<LanguageDetectionActionResult> {
    try {
      await storage.setItem(LANGUAGE_DETECTION_STORAGE_KEY, storagePayload(settings));
    } catch {
      return failure("storage_write_failed");
    }
    settingsSignal.set(copySettings(settings));
    loadErrorSignal.set(null);
    return { ok: true };
  }

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(task);
    writeQueue = queued.catch(() => undefined);
    return queued;
  }

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(LANGUAGE_DETECTION_STORAGE_KEY);
      } catch {
        settingsSignal.set(copySettings(EMPTY_SETTINGS));
        loadErrorSignal.set({
          key: "storage_read_failed",
          message: t(ERROR_MESSAGES.storage_read_failed),
        });
        return;
      }

      if (raw === null) {
        settingsSignal.set(copySettings(EMPTY_SETTINGS));
        loadErrorSignal.set(null);
        return;
      }

      const parsed = parseStoredSettings(raw);
      if (!parsed.ok) {
        settingsSignal.set(copySettings(EMPTY_SETTINGS));
        loadErrorSignal.set({ key: parsed.key, message: t(ERROR_MESSAGES[parsed.key]) });
        return;
      }

      settingsSignal.set(parsed.settings);
      loadErrorSignal.set(null);
    },
    detectorOrder: () => [...settingsSignal().order],
    isEnabled: (kind) => settingsSignal().enabled[kind],
    savedAiBinding: () => {
      const ai = settingsSignal().ai;
      return ai === null ? null : { kind: "ai", modelId: ai.modelId };
    },
    enabledDetectors: () => enabledDetectorsOf(settingsSignal()),
    snapshot: () => {
      const current = settingsSignal();
      return {
        detectors: enabledDetectorsOf(current),
        nativeLanguage: current.nativeLanguage,
        preferredTranslationLanguage: current.preferredTranslationLanguage,
      };
    },
    loadError: () => loadErrorSignal(),
    saveAiModel: async (modelId) => {
      if (!isNonblankModelId(modelId)) return failure("model_id_blank");
      return enqueueWrite(async () => {
        const current = settingsSignal();
        const written = await persistSnapshot({
          order: [...current.order],
          enabled: { ...current.enabled, ai: current.ai === null ? true : current.enabled.ai },
          ai: { kind: "ai", modelId },
          nativeLanguage: current.nativeLanguage,
          preferredTranslationLanguage: current.preferredTranslationLanguage,
        });
        return written.ok ? { ok: true, binding: { kind: "ai", modelId } } : written;
      });
    },
    setEnabled: async (kind, nextEnabled) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (nextEnabled && kind === "ai" && current.ai === null) {
          return failure("detector_unconfigured");
        }
        if (current.enabled[kind] === nextEnabled) return { ok: true };
        return persistSnapshot({
          order: [...current.order],
          enabled: { ...current.enabled, [kind]: nextEnabled },
          ai: current.ai,
          nativeLanguage: current.nativeLanguage,
          preferredTranslationLanguage: current.preferredTranslationLanguage,
        });
      }),
    moveDetectorTo: async (kind, targetIndex) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        const index = current.order.indexOf(kind);
        if (index === -1) return { ok: true };
        const requested = Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : index;
        const target = Math.min(Math.max(requested, 0), current.order.length - 1);
        if (target === index) return { ok: true };
        const nextOrder = [...current.order];
        nextOrder.splice(index, 1);
        nextOrder.splice(target, 0, kind);
        return persistSnapshot({
          order: nextOrder,
          enabled: { ...current.enabled },
          ai: current.ai,
          nativeLanguage: current.nativeLanguage,
          preferredTranslationLanguage: current.preferredTranslationLanguage,
        });
      }),
    savePreferences: async (preferences) => {
      const invalid = validatePreferences(preferences);
      if (invalid !== null) return failure(invalid);
      const snapshot = {
        nativeLanguage: preferences.nativeLanguage,
        preferredTranslationLanguage: preferences.preferredTranslationLanguage,
      };
      return enqueueWrite(async () => {
        const current = settingsSignal();
        return persistSnapshot({
          order: [...current.order],
          enabled: { ...current.enabled },
          ai: current.ai,
          nativeLanguage: snapshot.nativeLanguage,
          preferredTranslationLanguage: snapshot.preferredTranslationLanguage,
        });
      });
    },
  };
}

/** Production Language Detection settings store backed by NSH Storage. */
export const languageDetectionStore = createLanguageDetectionSettingsStore(Storage);
