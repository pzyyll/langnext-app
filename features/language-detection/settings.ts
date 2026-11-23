import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";
import { isLanguageId, type LanguageId } from "../presets/languages";

export const LANGUAGE_DETECTION_STORAGE_KEY = "settings.languageDetection.v4";
export const LANGUAGE_GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX =
  "settings.languageDetection.googleCloud.";
const STORAGE_VERSION = 4;

const log = createLogger("language-detection/settings");

/** Detection channels in default priority order. */
export const LANGUAGE_DETECTOR_KINDS = ["ai", "google", "google-cloud"] as const;

/** Service behind automatic language detection. */
export type LanguageDetectorKind = (typeof LANGUAGE_DETECTOR_KINDS)[number];

/**
 * Saved configuration for one detector. AI keeps a model ID; the free Google endpoint needs no
 * configuration; Google Cloud keeps a non-secret reference to its stored API key.
 */
export type LanguageDetectorBinding =
  | { kind: "ai"; modelId: string }
  | { kind: "google" }
  | { kind: "google-cloud"; credentialRef: string };

export type LanguageAiBinding = Extract<LanguageDetectorBinding, { kind: "ai" }>;
export type LanguageGoogleCloudBinding = Extract<LanguageDetectorBinding, { kind: "google-cloud" }>;

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
  | "google_cloud_key_required"
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

export type LanguageGoogleCloudSaveResult =
  | { ok: true; binding: LanguageGoogleCloudBinding }
  | { ok: false; key: LanguageDetectionErrorKey; message: string };

export type LanguageDetectionActionResult =
  | { ok: true }
  | { ok: false; key: LanguageDetectionErrorKey; message: string };

export interface LanguageDetectionSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Storage key for the Google Cloud API key addressed by its non-secret reference. */
export function googleCloudDetectionCredentialStorageKey(credentialRef: string): string {
  return LANGUAGE_GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX + credentialRef;
}

/** Each detector owns its saved config, enabled toggle, and priority position. */
interface LanguageDetectionSavedSettings {
  order: LanguageDetectorKind[];
  enabled: Record<LanguageDetectorKind, boolean>;
  ai: LanguageAiBinding | null;
  googleCloud: LanguageGoogleCloudBinding | null;
  nativeLanguage: LanguageId | null;
  preferredTranslationLanguage: LanguageId | null;
}

const EMPTY_SETTINGS: LanguageDetectionSavedSettings = {
  order: [],
  enabled: { ai: false, google: false, "google-cloud": false },
  ai: null,
  googleCloud: null,
  nativeLanguage: null,
  preferredTranslationLanguage: null,
};

export interface LanguageDetectionSettingsStore {
  load(): Promise<void>;
  /** Added detectors in top-to-bottom priority order. */
  detectorOrder(): readonly LanguageDetectorKind[];
  /** Detectors not yet added to the priority list, in catalog order. */
  availableDetectors(): readonly LanguageDetectorKind[];
  /** Whether one detector is enabled. */
  isEnabled(kind: LanguageDetectorKind): boolean;
  /** The saved AI configuration, independent of enabled state. */
  savedAiBinding(): LanguageAiBinding | null;
  /** The saved Google Cloud configuration, independent of enabled state. */
  savedGoogleCloudBinding(): LanguageGoogleCloudBinding | null;
  /** Enabled detector configurations in top-to-bottom priority order. */
  enabledDetectors(): readonly LanguageDetectorBinding[];
  /** The detector chain and preferences one translation action reads once. */
  snapshot(): LanguageDetectionSnapshot;
  /** The saved Automatic-target language preferences. */
  preferences(): LanguageDetectionPreferences;
  loadError(): LanguageDetectionLoadError | null;
  /** Adds a detector to the list. The free Google detector enables right away. */
  addDetector(kind: LanguageDetectorKind): Promise<LanguageDetectionActionResult>;
  /** Removes a detector from the list and clears any saved binding or credential. */
  removeDetector(kind: LanguageDetectorKind): Promise<LanguageDetectionActionResult>;
  saveAiModel(modelId: string): Promise<LanguageDetectionSaveResult>;
  /** Saves a Google Cloud API key; `null` reuses the saved readable key. */
  saveGoogleCloudKey(apiKey: string | null): Promise<LanguageGoogleCloudSaveResult>;
  /** Reads one stored API key. Loading the configuration does not call this. */
  readGoogleCloudCredential(credentialRef: string): Promise<string | null>;
  setEnabled(kind: LanguageDetectorKind, enabled: boolean): Promise<LanguageDetectionActionResult>;
  /** Moves one detector to a new top-to-bottom priority position, clamped to the list. */
  moveDetectorTo(
    kind: LanguageDetectorKind,
    targetIndex: number,
  ): Promise<LanguageDetectionActionResult>;
  /** Saves one Automatic-target language preference and keeps the other one. */
  setPreference(
    field: keyof LanguageDetectionPreferences,
    value: LanguageId | null,
  ): Promise<LanguageDetectionActionResult>;
}

const ERROR_MESSAGES: Record<LanguageDetectionErrorKey, string> = {
  storage_read_failed: "settings.languageDetection.error.storageReadFailed",
  storage_malformed: "settings.languageDetection.error.storageMalformed",
  storage_unsupported_version: "settings.languageDetection.error.storageUnsupportedVersion",
  storage_write_failed: "settings.languageDetection.error.storageWriteFailed",
  model_id_blank: "settings.languageDetection.error.modelIdBlank",
  google_cloud_key_required: "settings.languageDetection.error.googleCloudKeyRequired",
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
    enabled: {
      ai: settings.enabled.ai,
      google: settings.enabled.google,
      "google-cloud": settings.enabled["google-cloud"],
    },
    ai: settings.ai === null ? null : { kind: "ai", modelId: settings.ai.modelId },
    googleCloud:
      settings.googleCloud === null
        ? null
        : { kind: "google-cloud", credentialRef: settings.googleCloud.credentialRef },
    nativeLanguage: settings.nativeLanguage,
    preferredTranslationLanguage: settings.preferredTranslationLanguage,
  };
}

function copiedWith(
  settings: LanguageDetectionSavedSettings,
  patch: Partial<LanguageDetectionSavedSettings>,
): LanguageDetectionSavedSettings {
  return copySettings({ ...settings, ...patch });
}

function ensureInOrder(
  order: readonly LanguageDetectorKind[],
  kind: LanguageDetectorKind,
): LanguageDetectorKind[] {
  return order.includes(kind) ? [...order] : [...order, kind];
}

/** A missing or null entry means "not saved"; `undefined` means the entry is malformed. */
function parseAiBinding(value: unknown): LanguageAiBinding | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || !isNonblankModelId(value.modelId)) return undefined;
  return { kind: "ai", modelId: value.modelId };
}

function parseGoogleCloudBinding(value: unknown): LanguageGoogleCloudBinding | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  if (typeof value.credentialRef !== "string" || value.credentialRef.trim().length === 0) {
    return undefined;
  }
  return { kind: "google-cloud", credentialRef: value.credentialRef };
}

function parseOrder(value: unknown): LanguageDetectorKind[] | null {
  if (!Array.isArray(value) || value.length > LANGUAGE_DETECTOR_KINDS.length) return null;
  const seen = new Set<LanguageDetectorKind>();
  const order: LanguageDetectorKind[] = [];
  for (const item of value) {
    if (!isLanguageDetectorKind(item) || seen.has(item)) return null;
    seen.add(item);
    order.push(item);
  }
  return order;
}

function parseEnabledMap(value: unknown): Record<LanguageDetectorKind, boolean> | null {
  if (!isPlainObject(value)) return null;
  const enabled = {} as Record<LanguageDetectorKind, boolean>;
  for (const kind of LANGUAGE_DETECTOR_KINDS) {
    const flag = value[kind];
    if (typeof flag !== "boolean") return null;
    enabled[kind] = flag;
  }
  return enabled;
}

/** Whether one detector has the configuration it needs before it can be enabled. */
function isConfiguredIn(
  settings: LanguageDetectionSavedSettings,
  kind: LanguageDetectorKind,
): boolean {
  if (kind === "ai") return settings.ai !== null;
  if (kind === "google-cloud") return settings.googleCloud !== null;
  return true;
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
  const googleCloud = parseGoogleCloudBinding(parsed.googleCloud);
  if (order === null || enabled === null || ai === undefined || googleCloud === undefined) {
    return { ok: false, key: "storage_malformed" };
  }
  if ((enabled.ai && ai === null) || (enabled["google-cloud"] && googleCloud === null)) {
    return { ok: false, key: "storage_malformed" };
  }
  for (const kind of LANGUAGE_DETECTOR_KINDS) {
    if (enabled[kind] && !order.includes(kind)) {
      return { ok: false, key: "storage_malformed" };
    }
  }
  if (
    (ai !== null && !order.includes("ai")) ||
    (googleCloud !== null && !order.includes("google-cloud"))
  ) {
    return { ok: false, key: "storage_malformed" };
  }

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
      googleCloud,
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
    googleCloud:
      settings.googleCloud === null ? null : { credentialRef: settings.googleCloud.credentialRef },
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
    } else if (kind === "ai" && settings.ai !== null) {
      detectors.push({ kind: "ai", modelId: settings.ai.modelId });
    } else if (kind === "google-cloud" && settings.googleCloud !== null) {
      detectors.push({
        kind: "google-cloud",
        credentialRef: settings.googleCloud.credentialRef,
      });
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

  /** Best-effort cleanup. A failure never undoes a committed key or includes the key value. */
  async function removeCredentialQuietly(credentialRef: string): Promise<void> {
    try {
      await storage.removeItem(googleCloudDetectionCredentialStorageKey(credentialRef));
    } catch {
      log.warn("Could not remove an unused Google Cloud API key.");
    }
  }

  async function readStoredGoogleCloudKey(credentialRef: string): Promise<string | null> {
    if (credentialRef.trim().length === 0) return null;
    let raw: string | null;
    try {
      raw = await storage.getItem(googleCloudDetectionCredentialStorageKey(credentialRef));
    } catch {
      return null;
    }
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
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
    availableDetectors: () => {
      const added = new Set(settingsSignal().order);
      return LANGUAGE_DETECTOR_KINDS.filter((kind) => !added.has(kind));
    },
    isEnabled: (kind) => settingsSignal().enabled[kind],
    savedAiBinding: () => {
      const ai = settingsSignal().ai;
      return ai === null ? null : { kind: "ai", modelId: ai.modelId };
    },
    savedGoogleCloudBinding: () => {
      const saved = settingsSignal().googleCloud;
      return saved === null ? null : { kind: "google-cloud", credentialRef: saved.credentialRef };
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
    preferences: () => {
      const current = settingsSignal();
      return {
        nativeLanguage: current.nativeLanguage,
        preferredTranslationLanguage: current.preferredTranslationLanguage,
      };
    },
    loadError: () => loadErrorSignal(),
    readGoogleCloudCredential: (credentialRef) => readStoredGoogleCloudKey(credentialRef),
    addDetector: async (kind) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (current.order.includes(kind)) return { ok: true };
        return persistSnapshot(
          copiedWith(current, {
            order: ensureInOrder(current.order, kind),
            enabled: kind === "google" ? { ...current.enabled, google: true } : current.enabled,
          }),
        );
      }),
    removeDetector: async (kind) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (!current.order.includes(kind)) return { ok: true };
        const previousGoogleCloud = kind === "google-cloud" ? current.googleCloud : null;
        const written = await persistSnapshot(
          copiedWith(current, {
            order: current.order.filter((item) => item !== kind),
            enabled: { ...current.enabled, [kind]: false },
            ai: kind === "ai" ? null : current.ai,
            googleCloud: kind === "google-cloud" ? null : current.googleCloud,
          }),
        );
        if (written.ok && previousGoogleCloud !== null) {
          await removeCredentialQuietly(previousGoogleCloud.credentialRef);
        }
        return written;
      }),
    saveAiModel: async (modelId) => {
      if (!isNonblankModelId(modelId)) return failure("model_id_blank");
      return enqueueWrite(async () => {
        const current = settingsSignal();
        const written = await persistSnapshot(
          copiedWith(current, {
            order: ensureInOrder(current.order, "ai"),
            enabled: { ...current.enabled, ai: current.ai === null ? true : current.enabled.ai },
            ai: { kind: "ai", modelId },
          }),
        );
        return written.ok ? { ok: true, binding: { kind: "ai", modelId } } : written;
      });
    },
    saveGoogleCloudKey: async (apiKey) => {
      const trimmed = apiKey === null ? null : apiKey.trim();
      if (trimmed !== null && trimmed.length === 0) return failure("google_cloud_key_required");

      return enqueueWrite(async () => {
        const current = settingsSignal();
        const saved = current.googleCloud;
        const nextOrder = ensureInOrder(current.order, "google-cloud");

        if (trimmed === null) {
          if (saved === null) return failure("google_cloud_key_required");
          const stored = await readStoredGoogleCloudKey(saved.credentialRef);
          if (stored === null) return failure("google_cloud_key_required");
          const written = await persistSnapshot(
            copiedWith(current, { order: nextOrder, googleCloud: saved }),
          );
          return written.ok ? { ok: true, binding: { ...saved } } : written;
        }

        // The new key is written before its reference, so an interrupted save keeps the old one.
        const credentialRef = crypto.randomUUID();
        try {
          await storage.setItem(googleCloudDetectionCredentialStorageKey(credentialRef), trimmed);
        } catch {
          return failure("storage_write_failed");
        }
        const written = await persistSnapshot(
          copiedWith(current, {
            order: nextOrder,
            enabled: {
              ...current.enabled,
              "google-cloud": saved === null ? true : current.enabled["google-cloud"],
            },
            googleCloud: { kind: "google-cloud", credentialRef },
          }),
        );
        if (!written.ok) {
          await removeCredentialQuietly(credentialRef);
          return written;
        }
        if (saved !== null) await removeCredentialQuietly(saved.credentialRef);
        return { ok: true, binding: { kind: "google-cloud", credentialRef } };
      });
    },
    setEnabled: async (kind, nextEnabled) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (nextEnabled && (!current.order.includes(kind) || !isConfiguredIn(current, kind))) {
          return failure("detector_unconfigured");
        }
        if (current.enabled[kind] === nextEnabled) return { ok: true };
        return persistSnapshot(
          copiedWith(current, { enabled: { ...current.enabled, [kind]: nextEnabled } }),
        );
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
        return persistSnapshot(copiedWith(current, { order: nextOrder }));
      }),
    setPreference: async (field, value) => {
      if (!isPreference(value)) return failure("preference_invalid");
      return enqueueWrite(async () => {
        const current = settingsSignal();
        const preferences: LanguageDetectionPreferences = {
          nativeLanguage: current.nativeLanguage,
          preferredTranslationLanguage: current.preferredTranslationLanguage,
        };
        preferences[field] = value;
        const invalid = validatePreferences(preferences);
        if (invalid !== null) return failure(invalid);
        return persistSnapshot(copiedWith(current, preferences));
      });
    },
  };
}

/** Production Language Detection settings store backed by NSH Storage. */
export const languageDetectionStore = createLanguageDetectionSettingsStore(Storage);
