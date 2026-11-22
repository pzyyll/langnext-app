import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { parseAzureSpeechRegion } from "./azure-regions";
import type { TtsChannelId } from "./synthesis";

export const TTS_STORAGE_KEY = "settings.tts.v1";
export const TTS_CREDENTIAL_KEY_PREFIX = "settings.tts.credentials.";
const STORAGE_VERSION = 1;

/** Storage key for one TTS API key, addressed by its non-secret reference. */
export function ttsCredentialStorageKey(credentialRef: string): string {
  return TTS_CREDENTIAL_KEY_PREFIX + credentialRef;
}

export interface TtsSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Saved channel. The API key lives in a separate storage entry. */
export type TtsChannelBinding =
  | { channel: "google-cloud"; enabled: boolean; credentialRef: string }
  | { channel: "azure"; enabled: boolean; credentialRef: string; region: string };

export type TtsSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "api_key_blank"
  | "invalid_region"
  | "channel_unconfigured"
  | "credential_unreadable";

export interface TtsLoadError {
  key: TtsSettingsErrorKey;
  message: string;
}

export type TtsSaveResult =
  | { ok: true; binding: TtsChannelBinding }
  | { ok: false; key: TtsSettingsErrorKey; message: string };

export type TtsActionResult =
  | { ok: true }
  | { ok: false; key: TtsSettingsErrorKey; message: string };

export type TtsSaveChannelInput =
  | { channel: "google-cloud"; apiKey: string }
  | { channel: "azure"; apiKey: string; region: string };

export interface TtsSettingsStore {
  load(): Promise<void>;
  loadError(): TtsLoadError | null;
  savedBinding(channel: TtsChannelId): TtsChannelBinding | null;
  activeBinding(): TtsChannelBinding | null;
  saveChannel(input: TtsSaveChannelInput): Promise<TtsSaveResult>;
  setEnabled(channel: TtsChannelId, enabled: boolean): Promise<TtsActionResult>;
  /** Reads one stored key. Loading the configuration does not call this. */
  readKey(ref: string): Promise<string | null>;
}

const ERROR_MESSAGES: Record<TtsSettingsErrorKey, string> = {
  storage_read_failed: "settings.tts.error.storageReadFailed",
  storage_malformed: "settings.tts.error.storageMalformed",
  storage_unsupported_version: "settings.tts.error.storageUnsupportedVersion",
  storage_write_failed: "settings.tts.error.storageWriteFailed",
  api_key_blank: "settings.tts.error.apiKeyBlank",
  invalid_region: "settings.tts.error.invalidRegion",
  channel_unconfigured: "settings.tts.error.channelUnconfigured",
  credential_unreadable: "settings.tts.error.credentialUnreadable",
};

interface GoogleStored {
  enabled: boolean;
  credentialRef: string;
}

interface AzureStored {
  enabled: boolean;
  credentialRef: string;
  region: string;
}

interface ChannelRecord {
  googleCloud: GoogleStored | null;
  azure: AzureStored | null;
}

const EMPTY_RECORD: ChannelRecord = { googleCloud: null, azure: null };

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

function trimmedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(record: ChannelRecord): ChannelRecord {
  return {
    googleCloud: record.googleCloud === null ? null : { ...record.googleCloud },
    azure: record.azure === null ? null : { ...record.azure },
  };
}

function bindingFor(record: ChannelRecord, channel: TtsChannelId): TtsChannelBinding | null {
  if (channel === "google-cloud") {
    const google = record.googleCloud;
    if (google === null) return null;
    return { channel, enabled: google.enabled, credentialRef: google.credentialRef };
  }
  const azure = record.azure;
  if (azure === null) return null;
  return {
    channel,
    enabled: azure.enabled,
    credentialRef: azure.credentialRef,
    region: azure.region,
  };
}

function activeFrom(record: ChannelRecord): TtsChannelBinding | null {
  if (record.googleCloud?.enabled) return bindingFor(record, "google-cloud");
  if (record.azure?.enabled) return bindingFor(record, "azure");
  return null;
}

function parseGoogle(value: unknown): GoogleStored | null | "malformed" {
  if (value === null) return null;
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") return "malformed";
  const credentialRef = trimmedSecret(value.credentialRef);
  if (credentialRef === null || credentialRef !== value.credentialRef) return "malformed";
  return { enabled: value.enabled, credentialRef };
}

function parseAzure(value: unknown): AzureStored | null | "malformed" {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") return "malformed";
  const credentialRef = trimmedSecret(value.credentialRef);
  if (credentialRef === null || credentialRef !== value.credentialRef) return "malformed";
  if (typeof value.region !== "string" || parseAzureSpeechRegion(value.region) !== value.region) {
    return "malformed";
  }
  return { enabled: value.enabled, credentialRef, region: value.region };
}

type ParsedStorage = { ok: true; record: ChannelRecord } | { ok: false; key: TtsSettingsErrorKey };

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
  if (!("googleCloud" in parsed)) return { ok: false, key: "storage_malformed" };
  const googleCloud = parseGoogle(parsed.googleCloud);
  if (googleCloud === "malformed") return { ok: false, key: "storage_malformed" };
  const azure = parseAzure("azure" in parsed ? parsed.azure : undefined);
  if (azure === "malformed") return { ok: false, key: "storage_malformed" };
  if (googleCloud?.enabled && azure?.enabled) return { ok: false, key: "storage_malformed" };
  return { ok: true, record: { googleCloud, azure } };
}

function storagePayload(record: ChannelRecord): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    googleCloud:
      record.googleCloud === null
        ? null
        : { enabled: record.googleCloud.enabled, credentialRef: record.googleCloud.credentialRef },
    azure:
      record.azure === null
        ? null
        : {
            enabled: record.azure.enabled,
            credentialRef: record.azure.credentialRef,
            region: record.azure.region,
          },
  });
}

/** Creates a TTS settings store backed by injected storage. */
export function createTtsSettingsStore(storage: TtsSettingsStorage): TtsSettingsStore {
  const settingsSignal = signal<ChannelRecord>(EMPTY_RECORD);
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
      console.warn("Could not remove an unused text-to-speech credential.");
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

  async function persistRecord(record: ChannelRecord): Promise<TtsActionResult> {
    try {
      await storage.setItem(TTS_STORAGE_KEY, storagePayload(record));
    } catch {
      return failure("storage_write_failed");
    }
    settingsSignal.set(cloneRecord(record));
    loadErrorSignal.set(null);
    return { ok: true };
  }

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(TTS_STORAGE_KEY);
      } catch {
        settingsSignal.set(EMPTY_RECORD);
        loadErrorSignal.set({
          key: "storage_read_failed",
          message: t(ERROR_MESSAGES.storage_read_failed),
        });
        return;
      }
      if (raw === null) {
        settingsSignal.set(EMPTY_RECORD);
        loadErrorSignal.set(null);
        return;
      }
      const parsed = parseStoredSettings(raw);
      if (!parsed.ok) {
        settingsSignal.set(EMPTY_RECORD);
        loadErrorSignal.set({ key: parsed.key, message: t(ERROR_MESSAGES[parsed.key]) });
        return;
      }
      settingsSignal.set(cloneRecord(parsed.record));
      loadErrorSignal.set(null);
    },
    loadError: () => loadErrorSignal(),
    savedBinding: (channel) => bindingFor(settingsSignal(), channel),
    activeBinding: () => activeFrom(settingsSignal()),
    readKey: (ref) => readStoredKey(ref),
    saveChannel: async (input) => {
      const apiKey = trimmedSecret(input.apiKey);
      if (apiKey === null) return failure("api_key_blank");
      let azureRegion: string | null = null;
      if (input.channel === "azure") {
        azureRegion = parseAzureSpeechRegion(input.region);
        if (azureRegion === null) return failure("invalid_region");
      }
      return enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        const existing = input.channel === "azure" ? current.azure : current.googleCloud;
        const otherActive =
          input.channel === "azure"
            ? current.googleCloud?.enabled === true
            : current.azure?.enabled === true;
        const enabled = existing === null ? !otherActive : existing.enabled;
        const credentialRef = crypto.randomUUID();
        try {
          await storage.setItem(ttsCredentialStorageKey(credentialRef), JSON.stringify({ apiKey }));
        } catch {
          return failure("storage_write_failed");
        }
        const next = cloneRecord(current);
        if (input.channel === "azure" && azureRegion !== null) {
          next.azure = { enabled, credentialRef, region: azureRegion };
        } else {
          next.googleCloud = { enabled, credentialRef };
        }
        const written = await persistRecord(next);
        if (!written.ok) {
          await removeCredentialQuietly(credentialRef);
          return written;
        }
        const previousRef = existing?.credentialRef ?? null;
        if (previousRef !== null && previousRef !== credentialRef) {
          await removeCredentialQuietly(previousRef);
        }
        const binding = bindingFor(next, input.channel);
        if (binding === null) return failure("storage_write_failed");
        return { ok: true as const, binding };
      });
    },
    setEnabled: async (channel, enabled) =>
      enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        const target = channel === "azure" ? current.azure : current.googleCloud;
        if (target === null)
          return enabled ? failure("channel_unconfigured") : { ok: true as const };
        if (target.enabled === enabled) return { ok: true as const };
        if (enabled) {
          const key = await readStoredKey(target.credentialRef);
          if (key === null) return failure("credential_unreadable");
          if (channel === "azure" && current.googleCloud?.enabled) {
            current.googleCloud = { ...current.googleCloud, enabled: false };
          }
          if (channel === "google-cloud" && current.azure?.enabled) {
            current.azure = { ...current.azure, enabled: false };
          }
        }
        if (channel === "azure") {
          if (current.azure === null) return failure("storage_write_failed");
          current.azure = { ...current.azure, enabled };
        } else if (current.googleCloud === null) {
          return failure("storage_write_failed");
        } else {
          current.googleCloud = { ...current.googleCloud, enabled };
        }
        return persistRecord(current);
      }),
  };
}

/** Production TTS settings store backed by NSH Storage. */
export const ttsSettingsStore = createTtsSettingsStore(Storage);
