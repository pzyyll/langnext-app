// ABOUTME: Automatic-target language preferences and the combined detection snapshot.
// ABOUTME: Preferences load independently; snapshot() reads the saved preferences and enabled channels.
import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import type { ChannelBinding, Result } from "../../framework/integrations";
import { isLanguageId, type LanguageId } from "../../framework/languages";
import { detectChannels } from "./store";

export const LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY =
  "settings.languageDetection.preferences.v1";
const STORAGE_VERSION = 1;

/** The Automatic-target language choices one translation action reads. */
export interface LanguageDetectionPreferences {
  nativeLanguage: LanguageId | null;
  preferredTranslationLanguage: LanguageId | null;
}

/** One enabled detection channel with the binding its definition runs against. */
export interface EnabledDetectionChannel {
  id: string;
  binding: ChannelBinding;
}

/** One action's immutable detector chain and Automatic-target language preferences. */
export interface LanguageDetectionSnapshot extends LanguageDetectionPreferences {
  detectors: readonly EnabledDetectionChannel[];
}

export type LanguageDetectionPreferencesErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "preference_invalid"
  | "preferences_identical";

export interface LanguageDetectionPreferencesError {
  key: LanguageDetectionPreferencesErrorKey;
  message: string;
}

export interface LanguageDetectionPreferencesStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** The read-only slice of a detector collection the snapshot needs. */
export interface DetectionChannelSource {
  order(): readonly string[];
  binding(id: string): ChannelBinding | null;
}

export interface LanguageDetectionPreferencesOptions {
  /** Detector collection the snapshot reads; defaults to the production collection. */
  channels?: DetectionChannelSource;
}

export interface LanguageDetectionPreferencesStore {
  load(): Promise<void>;
  /** The saved preferences, whether or not the detectors are loaded. */
  preferences(): LanguageDetectionPreferences;
  /** Enabled detectors in priority order plus the saved preferences. */
  snapshot(): LanguageDetectionSnapshot;
  loadError(): LanguageDetectionPreferencesError | null;
  /** The message of the last failed save; `null` after a successful one. */
  saveError(): string | null;
  setPreference(
    field: keyof LanguageDetectionPreferences,
    value: LanguageId | null,
  ): Promise<Result>;
}

const ERROR_MESSAGE_KEYS: Record<LanguageDetectionPreferencesErrorKey, string> = {
  storage_read_failed: "settings.languageDetection.error.storageReadFailed",
  storage_malformed: "settings.languageDetection.error.storageMalformed",
  storage_unsupported_version: "settings.languageDetection.error.storageUnsupportedVersion",
  storage_write_failed: "settings.languageDetection.error.storageWriteFailed",
  preference_invalid: "settings.languageDetection.error.preferenceInvalid",
  preferences_identical: "settings.languageDetection.error.preferencesIdentical",
};

function failure(key: LanguageDetectionPreferencesErrorKey): {
  ok: false;
  key: string;
  message: string;
} {
  return { ok: false, key, message: t(ERROR_MESSAGE_KEYS[key]) };
}

function errorOf(key: LanguageDetectionPreferencesErrorKey): LanguageDetectionPreferencesError {
  return { key, message: t(ERROR_MESSAGE_KEYS[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreference(value: unknown): value is LanguageId | null {
  return value === null || isLanguageId(value);
}

/** Both values must be supported and, when both are set, must differ. */
function validatePreferences(
  preferences: LanguageDetectionPreferences,
): LanguageDetectionPreferencesErrorKey | null {
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

function emptyPreferences(): LanguageDetectionPreferences {
  return { nativeLanguage: null, preferredTranslationLanguage: null };
}

type ParsedPreferences =
  | { ok: true; preferences: LanguageDetectionPreferences }
  | { ok: false; key: LanguageDetectionPreferencesErrorKey };

function parseStoredPreferences(raw: string): ParsedPreferences {
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
  if (!isPreference(parsed.nativeLanguage)) return { ok: false, key: "storage_malformed" };
  if (!isPreference(parsed.preferredTranslationLanguage)) {
    return { ok: false, key: "storage_malformed" };
  }
  const preferences: LanguageDetectionPreferences = {
    nativeLanguage: parsed.nativeLanguage,
    preferredTranslationLanguage: parsed.preferredTranslationLanguage,
  };
  if (validatePreferences(preferences) !== null) return { ok: false, key: "storage_malformed" };
  return { ok: true, preferences };
}

function serializePreferences(preferences: LanguageDetectionPreferences): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    nativeLanguage: preferences.nativeLanguage,
    preferredTranslationLanguage: preferences.preferredTranslationLanguage,
  });
}

function enabledDetectors(channels: DetectionChannelSource): EnabledDetectionChannel[] {
  const detectors: EnabledDetectionChannel[] = [];
  for (const id of channels.order()) {
    const binding = channels.binding(id);
    if (binding === null || !binding.enabled) continue;
    detectors.push({ id, binding });
  }
  return detectors;
}

/** Creates the preferences store over injected storage; the detector collection is optional. */
export function createLanguageDetectionPreferencesStore(
  storage: LanguageDetectionPreferencesStorage,
  options: LanguageDetectionPreferencesOptions = {},
): LanguageDetectionPreferencesStore {
  const channels = options.channels ?? detectChannels;
  const preferencesSignal = signal<LanguageDetectionPreferences>(emptyPreferences());
  const loadErrorSignal = signal<LanguageDetectionPreferencesError | null>(null);
  const saveErrorSignal = signal<string | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  /** Refuses every write while a load error is outstanding; only load() clears it. */
  function enqueueWrite<T extends Result>(task: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(() => {
      const outstanding = loadErrorSignal();
      if (outstanding !== null) {
        return {
          ok: false,
          key: outstanding.key,
          message: outstanding.message,
        } as T;
      }
      return task();
    });
    writeQueue = queued.catch(() => undefined);
    return queued;
  }

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY);
      } catch {
        preferencesSignal.set(emptyPreferences());
        saveErrorSignal.set(null);
        loadErrorSignal.set(errorOf("storage_read_failed"));
        return;
      }
      if (raw === null) {
        preferencesSignal.set(emptyPreferences());
        saveErrorSignal.set(null);
        loadErrorSignal.set(null);
        return;
      }
      const parsed = parseStoredPreferences(raw);
      if (!parsed.ok) {
        preferencesSignal.set(emptyPreferences());
        saveErrorSignal.set(null);
        loadErrorSignal.set(errorOf(parsed.key));
        return;
      }
      preferencesSignal.set(parsed.preferences);
      saveErrorSignal.set(null);
      loadErrorSignal.set(null);
    },
    preferences: () => ({ ...preferencesSignal() }),
    snapshot: () => ({
      detectors: enabledDetectors(channels),
      ...preferencesSignal(),
    }),
    loadError: () => loadErrorSignal(),
    saveError: () => saveErrorSignal(),
    setPreference: async (field, value) => {
      if (!isPreference(value)) return failure("preference_invalid");
      return enqueueWrite(async () => {
        const current = preferencesSignal();
        const next: LanguageDetectionPreferences = { ...current, [field]: value };
        const invalid = validatePreferences(next);
        if (invalid !== null) {
          const failed = failure(invalid);
          saveErrorSignal.set(failed.message);
          return failed;
        }
        try {
          await storage.setItem(
            LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY,
            serializePreferences(next),
          );
        } catch {
          const failed = failure("storage_write_failed");
          saveErrorSignal.set(failed.message);
          return failed;
        }
        preferencesSignal.set(next);
        saveErrorSignal.set(null);
        return { ok: true };
      });
    },
  };
}

/** Production Automatic-target preferences backed by NSH Storage. */
export const languageDetectionPreferences = createLanguageDetectionPreferencesStore(Storage);
