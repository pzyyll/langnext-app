import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";

export const TTS_STORAGE_KEY = "settings.tts.v1";
export const TTS_CREDENTIAL_KEY_PREFIX = "settings.tts.credentials.";
const STORAGE_VERSION = 1;

const log = createLogger("tts/settings");

/** Storage key for one Cloud TTS API key, addressed by its non-secret reference. */
export function ttsCredentialStorageKey(credentialRef: string): string {
  return TTS_CREDENTIAL_KEY_PREFIX + credentialRef;
}

export interface TtsSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Saved Google Cloud channel. The API key lives in a separate storage entry. */
export interface TtsGoogleCloudBinding {
  enabled: boolean;
  credentialRef: string;
}

export type TtsSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "api_key_blank"
  | "channel_unconfigured"
  | "credential_unreadable";

export interface TtsLoadError {
  key: TtsSettingsErrorKey;
  message: string;
}

export type TtsSaveResult =
  | { ok: true; binding: TtsGoogleCloudBinding }
  | { ok: false; key: TtsSettingsErrorKey; message: string };

export type TtsActionResult =
  | { ok: true }
  | { ok: false; key: TtsSettingsErrorKey; message: string };

export interface TtsSettingsStore {
  load(): Promise<void>;
  loadError(): TtsLoadError | null;
  savedBinding(): TtsGoogleCloudBinding | null;
  isEnabled(): boolean;
  saveGoogleCloud(input: { apiKey: string }): Promise<TtsSaveResult>;
  setEnabled(enabled: boolean): Promise<TtsActionResult>;
  /** Reads one stored key. Loading the configuration does not call this. */
  readGoogleCloudKey(ref: string): Promise<string | null>;
}

const ERROR_MESSAGES: Record<TtsSettingsErrorKey, string> = {
  storage_read_failed: "settings.tts.error.storageReadFailed",
  storage_malformed: "settings.tts.error.storageMalformed",
  storage_unsupported_version: "settings.tts.error.storageUnsupportedVersion",
  storage_write_failed: "settings.tts.error.storageWriteFailed",
  api_key_blank: "settings.tts.error.apiKeyBlank",
  channel_unconfigured: "settings.tts.error.channelUnconfigured",
  credential_unreadable: "settings.tts.error.credentialUnreadable",
};

function failure(key: TtsSettingsErrorKey): {
  ok: false;
  key: TtsSettingsErrorKey;
  message: string;
} {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyBinding(binding: TtsGoogleCloudBinding): TtsGoogleCloudBinding {
  return { enabled: binding.enabled, credentialRef: binding.credentialRef };
}

function trimmedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type ParsedStorage =
  | { ok: true; binding: TtsGoogleCloudBinding | null }
  | { ok: false; key: TtsSettingsErrorKey };

function parseStoredSettings(raw: string): ParsedStorage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, key: "storage_malformed" };
  }
  if (!isPlainObject(parsed) || typeof parsed.version !== "number") {
    return { ok: false, key: "storage_malformed" };
  }
  if (parsed.version !== STORAGE_VERSION) return { ok: false, key: "storage_unsupported_version" };
  if (parsed.googleCloud === null) return { ok: true, binding: null };
  if (!isPlainObject(parsed.googleCloud)) return { ok: false, key: "storage_malformed" };
  if (typeof parsed.googleCloud.enabled !== "boolean")
    return { ok: false, key: "storage_malformed" };
  const credentialRef = trimmedSecret(parsed.googleCloud.credentialRef);
  if (credentialRef === null || credentialRef !== parsed.googleCloud.credentialRef) {
    return { ok: false, key: "storage_malformed" };
  }
  return {
    ok: true,
    binding: { enabled: parsed.googleCloud.enabled, credentialRef },
  };
}

function storagePayload(binding: TtsGoogleCloudBinding | null): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    googleCloud:
      binding === null ? null : { enabled: binding.enabled, credentialRef: binding.credentialRef },
  });
}

/** Creates a TTS settings store backed by injected storage. */
export function createTtsSettingsStore(storage: TtsSettingsStorage): TtsSettingsStore {
  const settingsSignal = signal<TtsGoogleCloudBinding | null>(null);
  const loadErrorSignal = signal<TtsLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(task);
    writeQueue = queued.catch(() => undefined);
    return queued;
  }

  async function removeCredentialQuietly(credentialRef: string): Promise<void> {
    try {
      await storage.removeItem(ttsCredentialStorageKey(credentialRef));
    } catch {
      log.warn("Could not remove an unused Cloud TTS credential.");
    }
  }

  async function readStoredKey(credentialRef: string): Promise<string | null> {
    if (credentialRef.trim().length === 0) return null;
    let raw: string | null;
    try {
      raw = await storage.getItem(ttsCredentialStorageKey(credentialRef));
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) return null;
      return trimmedSecret(parsed.apiKey);
    } catch {
      return null;
    }
  }

  async function persistBinding(binding: TtsGoogleCloudBinding | null): Promise<TtsActionResult> {
    try {
      await storage.setItem(TTS_STORAGE_KEY, storagePayload(binding));
    } catch {
      return failure("storage_write_failed");
    }
    settingsSignal.set(binding === null ? null : copyBinding(binding));
    loadErrorSignal.set(null);
    return { ok: true };
  }

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(TTS_STORAGE_KEY);
      } catch {
        settingsSignal.set(null);
        loadErrorSignal.set({
          key: "storage_read_failed",
          message: t(ERROR_MESSAGES.storage_read_failed),
        });
        return;
      }
      if (raw === null) {
        settingsSignal.set(null);
        loadErrorSignal.set(null);
        return;
      }
      const parsed = parseStoredSettings(raw);
      if (!parsed.ok) {
        settingsSignal.set(null);
        loadErrorSignal.set({ key: parsed.key, message: t(ERROR_MESSAGES[parsed.key]) });
        return;
      }
      settingsSignal.set(parsed.binding);
      loadErrorSignal.set(null);
    },
    loadError: () => loadErrorSignal(),
    savedBinding: () => {
      const current = settingsSignal();
      return current === null ? null : copyBinding(current);
    },
    isEnabled: () => {
      const current = settingsSignal();
      return current !== null && current.enabled;
    },
    readGoogleCloudKey: (ref) => readStoredKey(ref),
    saveGoogleCloud: async (input) => {
      const apiKey = trimmedSecret(input.apiKey);
      if (apiKey === null) return failure("api_key_blank");
      return enqueueWrite(async () => {
        const current = settingsSignal();
        const enabled = current === null ? true : current.enabled;
        const credentialRef = crypto.randomUUID();
        try {
          await storage.setItem(ttsCredentialStorageKey(credentialRef), JSON.stringify({ apiKey }));
        } catch {
          return failure("storage_write_failed");
        }
        const written = await persistBinding({ enabled, credentialRef });
        if (!written.ok) {
          await removeCredentialQuietly(credentialRef);
          return written;
        }
        const previousRef = current?.credentialRef ?? null;
        if (previousRef !== null && previousRef !== credentialRef) {
          await removeCredentialQuietly(previousRef);
        }
        return { ok: true as const, binding: { enabled, credentialRef } };
      });
    },
    setEnabled: async (enabled) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (current === null) {
          return enabled ? failure("channel_unconfigured") : { ok: true as const };
        }
        if (current.enabled === enabled) return { ok: true as const };
        if (enabled) {
          const key = await readStoredKey(current.credentialRef);
          if (key === null) return failure("credential_unreadable");
        }
        return persistBinding({ enabled, credentialRef: current.credentialRef });
      }),
  };
}

/** Production TTS settings store backed by NSH Storage. */
export const ttsSettingsStore = createTtsSettingsStore(Storage);
