import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { isLanguageId, type LanguageId } from "../presets/languages";

export const LANGUAGE_DETECTION_STORAGE_KEY = "settings.languageDetection.v1";
const STORAGE_VERSION = 1;

export type LanguageDetectionMode = "off" | "ai" | "google";

/** Detector behind automatic source detection; `off` leaves every automatic source unresolved. */

/** Saved detection configuration. Detection stays off until a mode, its settings, and save exist. */
export interface LanguageDetectionSettings {
  mode: LanguageDetectionMode;
  /** Ordered AI detector chain used in `ai` mode: the primary model first, then its backups. */
  modelIds: readonly string[];
  nativeLanguage: LanguageId | null;
  preferredTranslationLanguage: LanguageId | null;
}

export const DEFAULT_LANGUAGE_DETECTION_SETTINGS: LanguageDetectionSettings = {
  mode: "off",
  modelIds: [],
  nativeLanguage: null,
  preferredTranslationLanguage: null,
};

export type LanguageDetectionErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "model_id_blank"
  | "model_id_duplicate"
  | "primary_model_required"
  | "preference_invalid"
  | "preferences_identical";

export interface LanguageDetectionLoadError {
  key: LanguageDetectionErrorKey;
  message: string;
}

export type LanguageDetectionSaveResult =
  | { ok: true; settings: LanguageDetectionSettings }
  | { ok: false; key: LanguageDetectionErrorKey; message: string };

export interface LanguageDetectionSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface LanguageDetectionSettingsStore {
  load(): Promise<void>;
  settings(): LanguageDetectionSettings;
  loadError(): LanguageDetectionLoadError | null;
  save(settings: LanguageDetectionSettings): Promise<LanguageDetectionSaveResult>;
}

const ERROR_MESSAGES: Record<LanguageDetectionErrorKey, string> = {
  storage_read_failed: "settings.languageDetection.error.storageReadFailed",
  storage_malformed: "settings.languageDetection.error.storageMalformed",
  storage_unsupported_version: "settings.languageDetection.error.storageUnsupportedVersion",
  storage_write_failed: "settings.languageDetection.error.storageWriteFailed",
  model_id_blank: "settings.languageDetection.error.modelIdBlank",
  model_id_duplicate: "settings.languageDetection.error.modelIdDuplicate",
  primary_model_required: "settings.languageDetection.error.primaryModelRequired",
  preference_invalid: "settings.languageDetection.error.preferenceInvalid",
  preferences_identical: "settings.languageDetection.error.preferencesIdentical",
};

function failure(key: LanguageDetectionErrorKey): LanguageDetectionSaveResult {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is LanguageDetectionMode {
  return value === "off" || value === "ai" || value === "google";
}

function isPreference(value: unknown): value is LanguageId | null {
  return value === null || isLanguageId(value);
}

/** Returns the first validation error key, or `null` for a saveable configuration. */
export function validateLanguageDetectionSettings(
  settings: LanguageDetectionSettings,
): LanguageDetectionErrorKey | null {
  if (!isMode(settings.mode)) return "storage_malformed";

  const modelIds = settings.modelIds;
  if (!Array.isArray(modelIds)) return "storage_malformed";
  const seen = new Set<string>();
  for (const modelId of modelIds) {
    if (typeof modelId !== "string" || modelId.trim().length === 0) return "model_id_blank";
    if (seen.has(modelId)) return "model_id_duplicate";
    seen.add(modelId);
  }
  if (settings.mode === "ai" && modelIds.length === 0) return "primary_model_required";

  if (!isPreference(settings.nativeLanguage)) return "preference_invalid";
  if (!isPreference(settings.preferredTranslationLanguage)) return "preference_invalid";
  if (
    settings.nativeLanguage !== null &&
    settings.nativeLanguage === settings.preferredTranslationLanguage
  ) {
    return "preferences_identical";
  }

  return null;
}

function copySettings(settings: LanguageDetectionSettings): LanguageDetectionSettings {
  return {
    mode: settings.mode,
    modelIds: [...settings.modelIds],
    nativeLanguage: settings.nativeLanguage,
    preferredTranslationLanguage: settings.preferredTranslationLanguage,
  };
}

type ParsedStorage =
  | { ok: true; settings: LanguageDetectionSettings }
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

  const { mode, modelIds, nativeLanguage, preferredTranslationLanguage } = parsed;
  if (
    !isMode(mode) ||
    !Array.isArray(modelIds) ||
    !modelIds.every((id): id is string => typeof id === "string") ||
    !isPreference(nativeLanguage) ||
    !isPreference(preferredTranslationLanguage)
  ) {
    return { ok: false, key: "storage_malformed" };
  }
  const settings: LanguageDetectionSettings = {
    mode,
    modelIds,
    nativeLanguage,
    preferredTranslationLanguage,
  };
  if (validateLanguageDetectionSettings(settings) !== null) {
    return { ok: false, key: "storage_malformed" };
  }

  return { ok: true, settings };
}

/** Creates a language detection settings store backed by injected storage. */
export function createLanguageDetectionSettingsStore(
  storage: LanguageDetectionSettingsStorage,
): LanguageDetectionSettingsStore {
  const settingsSignal = signal<LanguageDetectionSettings>(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
  const loadErrorSignal = signal<LanguageDetectionLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function writeSnapshot(
    settings: LanguageDetectionSettings,
  ): Promise<LanguageDetectionSaveResult> {
    const payload = JSON.stringify({
      version: STORAGE_VERSION,
      mode: settings.mode,
      modelIds: settings.modelIds,
      nativeLanguage: settings.nativeLanguage,
      preferredTranslationLanguage: settings.preferredTranslationLanguage,
    });
    try {
      await storage.setItem(LANGUAGE_DETECTION_STORAGE_KEY, payload);
    } catch {
      return failure("storage_write_failed");
    }
    const snapshot = copySettings(settings);
    settingsSignal.set(snapshot);
    loadErrorSignal.set(null);
    return { ok: true, settings: snapshot };
  }

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(LANGUAGE_DETECTION_STORAGE_KEY);
      } catch {
        settingsSignal.set(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
        loadErrorSignal.set({
          key: "storage_read_failed",
          message: t(ERROR_MESSAGES.storage_read_failed),
        });
        return;
      }

      if (raw === null) {
        settingsSignal.set(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
        loadErrorSignal.set(null);
        return;
      }

      const parsed = parseStoredSettings(raw);
      if (!parsed.ok) {
        settingsSignal.set(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
        loadErrorSignal.set({ key: parsed.key, message: t(ERROR_MESSAGES[parsed.key]) });
        return;
      }

      settingsSignal.set(parsed.settings);
      loadErrorSignal.set(null);
    },
    settings: () => settingsSignal(),
    loadError: () => loadErrorSignal(),
    save: async (settings) => {
      const invalid = validateLanguageDetectionSettings(settings);
      if (invalid !== null) {
        return failure(invalid);
      }

      const snapshot = copySettings(settings);
      const queued = writeQueue.then(() => writeSnapshot(snapshot));
      writeQueue = queued.catch(() => undefined);
      return queued;
    },
  };
}

/** Production Language Detection settings store backed by NSH Storage. */
export const languageDetectionStore = createLanguageDetectionSettingsStore(Storage);
