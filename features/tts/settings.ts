import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";
import { parseAzureSpeechRegion } from "./azure-regions";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  normalizeGoogleVoicePreferences,
  parseGoogleVoicePreferences,
  type GoogleVoicePreferences,
} from "./google-preferences";
import type { TtsChannelId } from "./synthesis";

/** Current settings record. Version 1 records stay untouched and do not load. */
export const TTS_STORAGE_KEY = "settings.tts.v3";
export const TTS_LEGACY_STORAGE_KEY = "settings.tts.v1";
export const TTS_CREDENTIAL_KEY_PREFIX = "settings.tts.credentials.";
const STORAGE_VERSION = 3;

const log = createLogger("tts/settings");

/** Supported text-to-speech channels in catalog order. */
export const TTS_CHANNELS = ["google-cloud", "azure"] as const satisfies readonly TtsChannelId[];

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
  | {
      channel: "google-cloud";
      enabled: boolean;
      credentialRef: string;
      preferences: GoogleVoicePreferences;
    }
  | { channel: "azure"; enabled: boolean; credentialRef: string; region: string };

export type TtsSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "api_key_blank"
  | "api_key_required"
  | "invalid_region"
  | "invalid_voice_tier"
  | "invalid_voice_gender"
  | "invalid_voice_override"
  | "invalid_speaking_rate"
  | "invalid_pitch"
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

/**
 * A Google save may omit the key to reuse the readable saved one, and may omit
 * the preferences to keep the saved ones. An Azure save still needs its key.
 */
export type TtsSaveChannelInput =
  | { channel: "google-cloud"; apiKey?: string; preferences?: GoogleVoicePreferences }
  | { channel: "azure"; apiKey: string; region: string };

export interface TtsSettingsStore {
  load(): Promise<void>;
  loadError(): TtsLoadError | null;
  /** Added channels in top-to-bottom priority order. */
  channelOrder(): readonly TtsChannelId[];
  /** Channels not yet added to the priority list, in catalog order. */
  availableChannels(): readonly TtsChannelId[];
  isEnabled(channel: TtsChannelId): boolean;
  savedBinding(channel: TtsChannelId): TtsChannelBinding | null;
  /** The first enabled channel in priority order, or null when both are off. */
  activeBinding(): TtsChannelBinding | null;
  /** Adds a channel to the list; it stays off until it is configured and switched on. */
  addChannel(channel: TtsChannelId): Promise<TtsActionResult>;
  /** Removes a channel from the list and clears its saved binding and key. */
  removeChannel(channel: TtsChannelId): Promise<TtsActionResult>;
  saveChannel(input: TtsSaveChannelInput): Promise<TtsSaveResult>;
  setEnabled(channel: TtsChannelId, enabled: boolean): Promise<TtsActionResult>;
  /** Moves one channel to a new top-to-bottom priority position, clamped to the list. */
  moveChannelTo(channel: TtsChannelId, targetIndex: number): Promise<TtsActionResult>;
  /** Reads one stored key. Loading the configuration does not call this. */
  readKey(ref: string): Promise<string | null>;
}

const ERROR_MESSAGES: Record<TtsSettingsErrorKey, string> = {
  storage_read_failed: "settings.tts.error.storageReadFailed",
  storage_malformed: "settings.tts.error.storageMalformed",
  storage_unsupported_version: "settings.tts.error.storageUnsupportedVersion",
  storage_write_failed: "settings.tts.error.storageWriteFailed",
  api_key_blank: "settings.tts.error.apiKeyBlank",
  api_key_required: "settings.tts.error.apiKeyRequired",
  invalid_region: "settings.tts.error.invalidRegion",
  invalid_voice_tier: "settings.tts.error.invalidVoiceTier",
  invalid_voice_gender: "settings.tts.error.invalidVoiceGender",
  invalid_voice_override: "settings.tts.error.invalidVoiceOverride",
  invalid_speaking_rate: "settings.tts.error.invalidSpeakingRate",
  invalid_pitch: "settings.tts.error.invalidPitch",
  channel_unconfigured: "settings.tts.error.channelUnconfigured",
  credential_unreadable: "settings.tts.error.credentialUnreadable",
};

interface GoogleStored {
  enabled: boolean;
  credentialRef: string;
  preferences: GoogleVoicePreferences;
}

interface AzureStored {
  enabled: boolean;
  credentialRef: string;
  region: string;
}

interface ChannelRecord {
  order: TtsChannelId[];
  googleCloud: GoogleStored | null;
  azure: AzureStored | null;
}

const EMPTY_RECORD: ChannelRecord = {
  order: [],
  googleCloud: null,
  azure: null,
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

function trimmedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(record: ChannelRecord): ChannelRecord {
  return {
    order: [...record.order],
    googleCloud:
      record.googleCloud === null
        ? null
        : {
            ...record.googleCloud,
            preferences: normalizeGoogleVoicePreferences(record.googleCloud.preferences),
          },
    azure: record.azure === null ? null : { ...record.azure },
  };
}

function bindingFor(record: ChannelRecord, channel: TtsChannelId): TtsChannelBinding | null {
  if (channel === "google-cloud") {
    const google = record.googleCloud;
    if (google === null) return null;
    return {
      channel,
      enabled: google.enabled,
      credentialRef: google.credentialRef,
      preferences: normalizeGoogleVoicePreferences(google.preferences),
    };
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
  for (const channel of record.order) {
    if (!isEnabledIn(record, channel)) continue;
    const binding = bindingFor(record, channel);
    if (binding !== null) return binding;
  }
  return null;
}

function isEnabledIn(record: ChannelRecord, channel: TtsChannelId): boolean {
  return channel === "azure"
    ? record.azure?.enabled === true
    : record.googleCloud?.enabled === true;
}

function ensureInOrder(order: readonly TtsChannelId[], channel: TtsChannelId): TtsChannelId[] {
  return order.includes(channel) ? [...order] : [...order, channel];
}

function parseGoogle(value: unknown): GoogleStored | null | "malformed" {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") return "malformed";
  const credentialRef = trimmedSecret(value.credentialRef);
  if (credentialRef === null || credentialRef !== value.credentialRef) return "malformed";
  const preferences = parseGoogleVoicePreferences(value.preferences, { mode: "load" });
  if (!preferences.ok) return "malformed";
  return { enabled: value.enabled, credentialRef, preferences: preferences.preferences };
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
  const order = parseOrder("order" in parsed ? parsed.order : undefined);
  if (order === null) return { ok: false, key: "storage_malformed" };
  if (
    (googleCloud !== null && !order.includes("google-cloud")) ||
    (azure !== null && !order.includes("azure"))
  ) {
    return { ok: false, key: "storage_malformed" };
  }
  return { ok: true, record: { order, googleCloud, azure } };
}

/** A missing order means no channels were added; anything else lists each added channel once. */
function parseOrder(value: unknown): TtsChannelId[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TTS_CHANNELS.length) return null;
  const seen = new Set<TtsChannelId>();
  const order: TtsChannelId[] = [];
  for (const item of value) {
    if (!(TTS_CHANNELS as readonly unknown[]).includes(item) || seen.has(item as TtsChannelId)) {
      return null;
    }
    seen.add(item as TtsChannelId);
    order.push(item as TtsChannelId);
  }
  return order;
}

function storagePayload(record: ChannelRecord): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    order: record.order,
    googleCloud:
      record.googleCloud === null
        ? null
        : {
            enabled: record.googleCloud.enabled,
            credentialRef: record.googleCloud.credentialRef,
            preferences: normalizeGoogleVoicePreferences(record.googleCloud.preferences),
          },
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
      log.warn("Could not remove an unused text-to-speech credential.");
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
      if (input.channel === "azure") {
        const apiKey = trimmedSecret(input.apiKey);
        if (apiKey === null) return failure("api_key_blank");
        const azureRegion = parseAzureSpeechRegion(input.region);
        if (azureRegion === null) return failure("invalid_region");
        return enqueueWrite(async () => {
          const current = cloneRecord(settingsSignal());
          const existing = current.azure;
          const enabled = existing?.enabled ?? false;
          const credentialRef = crypto.randomUUID();
          try {
            await storage.setItem(
              ttsCredentialStorageKey(credentialRef),
              JSON.stringify({ apiKey }),
            );
          } catch {
            return failure("storage_write_failed");
          }
          const next = cloneRecord(current);
          next.order = ensureInOrder(current.order, "azure");
          next.azure = { enabled, credentialRef, region: azureRegion };
          const written = await persistRecord(next);
          if (!written.ok) {
            await removeCredentialQuietly(credentialRef);
            return written;
          }
          const previousRef = existing?.credentialRef ?? null;
          if (previousRef !== null && previousRef !== credentialRef) {
            await removeCredentialQuietly(previousRef);
          }
          const binding = bindingFor(next, "azure");
          if (binding === null) return failure("storage_write_failed");
          return { ok: true as const, binding };
        });
      }

      if (input.apiKey !== undefined && trimmedSecret(input.apiKey) === null) {
        return failure("api_key_blank");
      }
      return enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        const existing = current.googleCloud;
        let preferences: GoogleVoicePreferences;
        if (input.preferences === undefined) {
          preferences =
            existing?.preferences ??
            normalizeGoogleVoicePreferences(DEFAULT_GOOGLE_VOICE_PREFERENCES);
        } else {
          const parsed = parseGoogleVoicePreferences(input.preferences, {
            mode: "save",
            current: existing?.preferences ?? null,
          });
          if (!parsed.ok) return failure(parsed.key);
          preferences = parsed.preferences;
        }
        const proposedKey = input.apiKey === undefined ? null : trimmedSecret(input.apiKey);
        let credentialRef: string;
        let wroteCredential = false;
        if (proposedKey !== null) {
          credentialRef = crypto.randomUUID();
          try {
            await storage.setItem(
              ttsCredentialStorageKey(credentialRef),
              JSON.stringify({ apiKey: proposedKey }),
            );
          } catch {
            return failure("storage_write_failed");
          }
          wroteCredential = true;
        } else {
          if (existing === null) return failure("api_key_required");
          const readable = await readStoredKey(existing.credentialRef);
          if (readable === null) return failure("credential_unreadable");
          credentialRef = existing.credentialRef;
        }
        const next = cloneRecord(current);
        next.order = ensureInOrder(current.order, "google-cloud");
        next.googleCloud = { enabled: existing?.enabled ?? false, credentialRef, preferences };
        const written = await persistRecord(next);
        if (!written.ok) {
          if (wroteCredential) await removeCredentialQuietly(credentialRef);
          return written;
        }
        const previousRef = existing?.credentialRef ?? null;
        if (wroteCredential && previousRef !== null && previousRef !== credentialRef) {
          await removeCredentialQuietly(previousRef);
        }
        const binding = bindingFor(next, "google-cloud");
        if (binding === null) return failure("storage_write_failed");
        return { ok: true as const, binding };
      });
    },
    setEnabled: async (channel, enabled) =>
      enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        const target = channel === "azure" ? current.azure : current.googleCloud;
        if (enabled && !current.order.includes(channel)) {
          return failure("channel_unconfigured");
        }
        if (target === null)
          return enabled ? failure("channel_unconfigured") : { ok: true as const };
        if (target.enabled === enabled) return { ok: true as const };
        if (enabled) {
          const key = await readStoredKey(target.credentialRef);
          if (key === null) return failure("credential_unreadable");
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
    channelOrder: () => [...settingsSignal().order],
    availableChannels: () => {
      const added = new Set(settingsSignal().order);
      return TTS_CHANNELS.filter((channel) => !added.has(channel));
    },
    isEnabled: (channel) => isEnabledIn(settingsSignal(), channel),
    addChannel: async (channel) =>
      enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        if (current.order.includes(channel)) return { ok: true as const };
        current.order = [...current.order, channel];
        return persistRecord(current);
      }),
    removeChannel: async (channel) =>
      enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        if (!current.order.includes(channel)) return { ok: true as const };
        const target = channel === "azure" ? current.azure : current.googleCloud;
        const next = cloneRecord(current);
        next.order = current.order.filter((item) => item !== channel);
        if (channel === "azure") next.azure = null;
        else next.googleCloud = null;
        const written = await persistRecord(next);
        if (written.ok && target !== null) {
          await removeCredentialQuietly(target.credentialRef);
        }
        return written;
      }),

    moveChannelTo: async (channel, targetIndex) =>
      enqueueWrite(async () => {
        const current = cloneRecord(settingsSignal());
        const index = current.order.indexOf(channel);
        if (index === -1) return { ok: true as const };
        const requested = Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : index;
        const target = Math.min(Math.max(requested, 0), current.order.length - 1);
        if (target === index) return { ok: true as const };
        const order = [...current.order];
        order.splice(index, 1);
        order.splice(target, 0, channel);
        current.order = order;
        return persistRecord(current);
      }),
  };
}

/** Production TTS settings store backed by NSH Storage. */
export const ttsSettingsStore = createTtsSettingsStore(Storage);
