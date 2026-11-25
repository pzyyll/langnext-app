import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";

export const OCR_STORAGE_KEY = "settings.ocr.v4";
export const BAIDU_CREDENTIAL_KEY_PREFIX = "settings.ocr.credentials.";
export const GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX = "settings.ocr.googleCloudKeys.";
const STORAGE_VERSION = 4;

const log = createLogger("ocr/settings");

/** Storage key for one Baidu credential pair, addressed by its non-secret reference. */
export function baiduCredentialStorageKey(credentialRef: string): string {
  return BAIDU_CREDENTIAL_KEY_PREFIX + credentialRef;
}

/** Storage key for one Google Cloud Vision API key, addressed by its non-secret reference. */
export function googleCloudCredentialStorageKey(credentialRef: string): string {
  return GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX + credentialRef;
}

/** Baidu OCR recognition modes. `accurate` is the default. */
export const BAIDU_OCR_OPERATIONS = [
  "general_basic",
  "accurate_basic",
  "general",
  "accurate",
] as const;

export type BaiduOcrOperation = (typeof BAIDU_OCR_OPERATIONS)[number];

/** Supported OCR channels in catalog order. Added channels keep their own priority. */
export const OCR_SERVICE_KINDS = ["ai", "baidu", "google-cloud"] as const;

/** OCR service behind screenshot recognition. */
export type OcrServiceKind = (typeof OCR_SERVICE_KINDS)[number];

/**
 * Saved configuration for one OCR service. AI keeps a model ID. Baidu keeps a mode and a
 * credential reference. Google Cloud Vision keeps a credential reference. Key values never
 * live on the binding.
 */
export type OcrServiceBinding =
  | { kind: "ai"; modelId: string }
  | { kind: "baidu"; operation: BaiduOcrOperation; credentialRef: string }
  | { kind: "google-cloud"; credentialRef: string };

export type OcrAiBinding = Extract<OcrServiceBinding, { kind: "ai" }>;
export type OcrBaiduBinding = Extract<OcrServiceBinding, { kind: "baidu" }>;
export type OcrGoogleCloudBinding = Extract<OcrServiceBinding, { kind: "google-cloud" }>;

/** API Key and Secret Key pair stored apart from the binding. */
export interface BaiduCredentialPair {
  apiKey: string;
  secretKey: string;
}

/** `keep` reuses the stored pair; `replace` writes a new pair. */
export type BaiduCredentialUpdate =
  | { kind: "keep" }
  | { kind: "replace"; apiKey: string; secretKey: string };

/** `keep` reuses the stored Vision key; `replace` writes a new key. */
export type GoogleCloudCredentialUpdate = { kind: "keep" } | { kind: "replace"; apiKey: string };

/** Save input. First-time save enables the channel; subsequent saves preserve its enabled state. */
export type SaveOcrBindingInput =
  | { kind: "ai"; modelId: string }
  | { kind: "baidu"; operation: BaiduOcrOperation; credentials: BaiduCredentialUpdate }
  | { kind: "google-cloud"; credentials: GoogleCloudCredentialUpdate };

export type OcrSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "model_id_blank"
  | "baidu_keys_required"
  | "baidu_operation_invalid"
  | "google_cloud_key_required"
  | "channel_unconfigured";

export interface OcrLoadError {
  key: OcrSettingsErrorKey;
  message: string;
}

export type OcrSaveResult =
  | { ok: true; binding: OcrServiceBinding }
  | { ok: false; key: OcrSettingsErrorKey; message: string };

export type OcrActionResult =
  | { ok: true }
  | { ok: false; key: OcrSettingsErrorKey; message: string };

export interface OcrSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Each channel owns its saved config, enabled toggle, and priority position. */
interface OcrSavedSettings {
  order: OcrServiceKind[];
  enabled: Record<OcrServiceKind, boolean>;
  ai: OcrAiBinding | null;
  baidu: OcrBaiduBinding | null;
  googleCloud: OcrGoogleCloudBinding | null;
}

const EMPTY_SETTINGS: OcrSavedSettings = {
  order: [],
  enabled: { ai: false, baidu: false, "google-cloud": false },
  ai: null,
  baidu: null,
  googleCloud: null,
};

export interface OcrSettingsStore {
  load(): Promise<void>;
  /** Added channels in top-to-bottom priority order. */
  channelOrder(): readonly OcrServiceKind[];
  /** Channels not yet added to the priority list, in catalog order. */
  availableChannels(): readonly OcrServiceKind[];
  /** Whether one channel is enabled. */
  isEnabled(kind: OcrServiceKind): boolean;
  /** Enabled configured bindings in top-to-bottom priority order. */
  enabledBindings(): readonly OcrServiceBinding[];
  /** The saved AI configuration, independent of enabled state. */
  savedAiBinding(): OcrAiBinding | null;
  /** The saved Baidu configuration, independent of enabled state. */
  savedBaiduBinding(): OcrBaiduBinding | null;
  /** The saved Google Cloud Vision configuration, independent of enabled state. */
  savedGoogleCloudBinding(): OcrGoogleCloudBinding | null;
  loadError(): OcrLoadError | null;
  /** Adds a channel to the list, left off until it is configured. */
  addChannel(kind: OcrServiceKind): Promise<OcrActionResult>;
  /** Removes a channel from the list and clears its saved binding or credentials. */
  removeChannel(kind: OcrServiceKind): Promise<OcrActionResult>;
  save(input: SaveOcrBindingInput): Promise<OcrSaveResult>;
  setEnabled(kind: OcrServiceKind, enabled: boolean): Promise<OcrActionResult>;
  /** Moves one channel to a new top-to-bottom priority position, clamped to the list. */
  moveChannelTo(kind: OcrServiceKind, targetIndex: number): Promise<OcrActionResult>;
  /** Reads one stored pair. Loading the configuration does not call this. */
  readBaiduCredentials(credentialRef: string): Promise<BaiduCredentialPair | null>;
  /** Reads one stored Vision key. Loading the configuration does not call this. */
  readGoogleCloudCredential(credentialRef: string): Promise<string | null>;
}

const ERROR_MESSAGES: Record<OcrSettingsErrorKey, string> = {
  storage_read_failed: "settings.ocr.error.storageReadFailed",
  storage_malformed: "settings.ocr.error.storageMalformed",
  storage_unsupported_version: "settings.ocr.error.storageUnsupportedVersion",
  storage_write_failed: "settings.ocr.error.storageWriteFailed",
  model_id_blank: "settings.ocr.error.modelIdBlank",
  baidu_keys_required: "settings.ocr.error.baiduKeysRequired",
  baidu_operation_invalid: "settings.ocr.error.baiduOperationInvalid",
  google_cloud_key_required: "settings.ocr.error.googleCloudKeyRequired",
  channel_unconfigured: "settings.ocr.error.channelUnconfigured",
};

function failure(key: OcrSettingsErrorKey): {
  ok: false;
  key: OcrSettingsErrorKey;
  message: string;
} {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBaiduOcrOperation(value: unknown): value is BaiduOcrOperation {
  return typeof value === "string" && (BAIDU_OCR_OPERATIONS as readonly string[]).includes(value);
}

function isOcrServiceKind(value: unknown): value is OcrServiceKind {
  return typeof value === "string" && (OCR_SERVICE_KINDS as readonly string[]).includes(value);
}

function isNonblankModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function copyBinding(binding: OcrServiceBinding): OcrServiceBinding {
  if (binding.kind === "ai") return { kind: "ai", modelId: binding.modelId };
  if (binding.kind === "baidu") {
    return {
      kind: "baidu",
      operation: binding.operation,
      credentialRef: binding.credentialRef,
    };
  }
  return { kind: "google-cloud", credentialRef: binding.credentialRef };
}

function copyGoogleCloud(binding: OcrGoogleCloudBinding | null): OcrGoogleCloudBinding | null {
  return binding === null ? null : { kind: "google-cloud", credentialRef: binding.credentialRef };
}

function copySettings(settings: OcrSavedSettings): OcrSavedSettings {
  return {
    order: [...settings.order],
    enabled: {
      ai: settings.enabled.ai,
      baidu: settings.enabled.baidu,
      "google-cloud": settings.enabled["google-cloud"],
    },
    ai: settings.ai === null ? null : { kind: "ai", modelId: settings.ai.modelId },
    baidu:
      settings.baidu === null
        ? null
        : {
            kind: "baidu",
            operation: settings.baidu.operation,
            credentialRef: settings.baidu.credentialRef,
          },
    googleCloud: copyGoogleCloud(settings.googleCloud),
  };
}

function bindingForKind(
  settings: OcrSavedSettings,
  kind: OcrServiceKind,
): OcrServiceBinding | null {
  if (kind === "ai") return settings.ai;
  if (kind === "baidu") return settings.baidu;
  return settings.googleCloud;
}

function ensureInOrder(order: readonly OcrServiceKind[], kind: OcrServiceKind): OcrServiceKind[] {
  return order.includes(kind) ? [...order] : [...order, kind];
}

/** A missing or null entry means "not saved"; `undefined` means the entry is malformed. */
function parseAiBinding(value: unknown): OcrAiBinding | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || !isNonblankModelId(value.modelId)) return undefined;
  return { kind: "ai", modelId: value.modelId };
}

function parseBaiduBinding(value: unknown): OcrBaiduBinding | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  if (!isBaiduOcrOperation(value.operation)) return undefined;
  if (typeof value.credentialRef !== "string" || value.credentialRef.trim().length === 0) {
    return undefined;
  }
  return { kind: "baidu", operation: value.operation, credentialRef: value.credentialRef };
}

function parseOrder(value: unknown): OcrServiceKind[] | null {
  if (!Array.isArray(value) || value.length > OCR_SERVICE_KINDS.length) return null;
  const seen = new Set<OcrServiceKind>();
  const order: OcrServiceKind[] = [];
  for (const item of value) {
    if (!isOcrServiceKind(item) || seen.has(item)) return null;
    seen.add(item);
    order.push(item);
  }
  return order;
}

function parseGoogleCloudBinding(value: unknown): OcrGoogleCloudBinding | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  if (typeof value.credentialRef !== "string" || value.credentialRef.trim().length === 0) {
    return undefined;
  }
  return { kind: "google-cloud", credentialRef: value.credentialRef };
}

function parseEnabledMap(value: unknown): Record<OcrServiceKind, boolean> | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.ai !== "boolean" || typeof value.baidu !== "boolean") return null;
  const googleCloud = value["google-cloud"];
  if (googleCloud !== undefined && typeof googleCloud !== "boolean") return null;
  return {
    ai: value.ai,
    baidu: value.baidu,
    "google-cloud": googleCloud === true,
  };
}

type ParsedStorage =
  | { ok: true; settings: OcrSavedSettings }
  | { ok: false; key: OcrSettingsErrorKey };

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
  const baidu = parseBaiduBinding(parsed.baidu);
  const googleCloud = parseGoogleCloudBinding(parsed["google-cloud"]);
  if (
    order === null ||
    enabled === null ||
    ai === undefined ||
    baidu === undefined ||
    googleCloud === undefined
  ) {
    return { ok: false, key: "storage_malformed" };
  }
  if (
    (enabled.ai && ai === null) ||
    (enabled.baidu && baidu === null) ||
    (enabled["google-cloud"] && googleCloud === null)
  ) {
    return { ok: false, key: "storage_malformed" };
  }
  for (const kind of OCR_SERVICE_KINDS) {
    if (enabled[kind] && !order.includes(kind)) {
      return { ok: false, key: "storage_malformed" };
    }
  }
  if (
    (ai !== null && !order.includes("ai")) ||
    (baidu !== null && !order.includes("baidu")) ||
    (googleCloud !== null && !order.includes("google-cloud"))
  ) {
    return { ok: false, key: "storage_malformed" };
  }
  return { ok: true, settings: { order, enabled, ai, baidu, googleCloud } };
}

function storagePayload(settings: OcrSavedSettings): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    order: settings.order,
    enabled: settings.enabled,
    ai: settings.ai === null ? null : { modelId: settings.ai.modelId },
    baidu:
      settings.baidu === null
        ? null
        : {
            operation: settings.baidu.operation,
            credentialRef: settings.baidu.credentialRef,
          },
    "google-cloud":
      settings.googleCloud === null ? null : { credentialRef: settings.googleCloud.credentialRef },
  });
}

function trimmedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Trims a Vision key and rejects a blank value or any remaining whitespace. */
function googleCloudApiKey(value: unknown): string | null {
  const trimmed = trimmedSecret(value);
  if (trimmed === null || /\s/.test(trimmed)) return null;
  return trimmed;
}

/** Creates an OCR settings store backed by injected storage. */
export function createOcrSettingsStore(storage: OcrSettingsStorage): OcrSettingsStore {
  const settingsSignal = signal<OcrSavedSettings>(copySettings(EMPTY_SETTINGS));
  const loadErrorSignal = signal<OcrLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function persistSnapshot(settings: OcrSavedSettings): Promise<OcrActionResult> {
    try {
      await storage.setItem(OCR_STORAGE_KEY, storagePayload(settings));
    } catch {
      return failure("storage_write_failed");
    }
    settingsSignal.set(copySettings(settings));
    loadErrorSignal.set(null);
    return { ok: true };
  }

  async function writeBindingSnapshot(
    settings: OcrSavedSettings,
    saved: OcrServiceBinding,
  ): Promise<OcrSaveResult> {
    const written = await persistSnapshot(settings);
    if (!written.ok) return written;
    return { ok: true, binding: copyBinding(saved) };
  }

  /** Best-effort cleanup. A failure never undoes a committed binding or includes secret values. */
  async function removeCredentialQuietly(credentialRef: string): Promise<void> {
    try {
      await storage.removeItem(baiduCredentialStorageKey(credentialRef));
    } catch {
      log.warn("Could not remove an unused Baidu OCR credential.");
    }
  }

  async function removeGoogleCredentialQuietly(credentialRef: string): Promise<void> {
    try {
      await storage.removeItem(googleCloudCredentialStorageKey(credentialRef));
    } catch {
      log.warn("Could not remove an unused Google Cloud Vision OCR credential.");
    }
  }

  async function readStoredGoogleKey(credentialRef: string): Promise<string | null> {
    if (credentialRef.trim().length === 0) return null;
    let raw: string | null;
    try {
      raw = await storage.getItem(googleCloudCredentialStorageKey(credentialRef));
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) return null;
      return googleCloudApiKey(parsed.apiKey);
    } catch {
      return null;
    }
  }

  async function readStoredPair(credentialRef: string): Promise<BaiduCredentialPair | null> {
    if (credentialRef.trim().length === 0) return null;
    let raw: string | null;
    try {
      raw = await storage.getItem(baiduCredentialStorageKey(credentialRef));
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) return null;
      const apiKey = trimmedSecret(parsed.apiKey);
      const secretKey = trimmedSecret(parsed.secretKey);
      if (apiKey === null || secretKey === null) return null;
      return { apiKey, secretKey };
    } catch {
      return null;
    }
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
        raw = await storage.getItem(OCR_STORAGE_KEY);
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
    channelOrder: () => [...settingsSignal().order],
    availableChannels: () => {
      const added = new Set(settingsSignal().order);
      return OCR_SERVICE_KINDS.filter((kind) => !added.has(kind));
    },
    isEnabled: (kind) => settingsSignal().enabled[kind],
    enabledBindings: () => {
      const current = settingsSignal();
      const result: OcrServiceBinding[] = [];
      for (const kind of current.order) {
        if (!current.enabled[kind]) continue;
        const binding = bindingForKind(current, kind);
        if (binding !== null) result.push(copyBinding(binding));
      }
      return result;
    },
    savedAiBinding: () => {
      const ai = settingsSignal().ai;
      return ai === null ? null : { kind: "ai", modelId: ai.modelId };
    },
    savedBaiduBinding: () => {
      const baidu = settingsSignal().baidu;
      return baidu === null
        ? null
        : {
            kind: "baidu",
            operation: baidu.operation,
            credentialRef: baidu.credentialRef,
          };
    },
    savedGoogleCloudBinding: () => copyGoogleCloud(settingsSignal().googleCloud),
    loadError: () => loadErrorSignal(),
    readBaiduCredentials: (credentialRef) => readStoredPair(credentialRef),
    readGoogleCloudCredential: (credentialRef) => readStoredGoogleKey(credentialRef),
    addChannel: async (kind) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (current.order.includes(kind)) return { ok: true };
        return persistSnapshot({
          order: ensureInOrder(current.order, kind),
          enabled: { ...current.enabled },
          ai: current.ai,
          baidu: current.baidu,
          googleCloud: current.googleCloud,
        });
      }),
    removeChannel: async (kind) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (!current.order.includes(kind)) return { ok: true };
        const previousBaidu = kind === "baidu" ? current.baidu : null;
        const previousGoogle = kind === "google-cloud" ? current.googleCloud : null;
        const written = await persistSnapshot({
          order: current.order.filter((item) => item !== kind),
          enabled: { ...current.enabled, [kind]: false },
          ai: kind === "ai" ? null : current.ai,
          baidu: kind === "baidu" ? null : current.baidu,
          googleCloud: kind === "google-cloud" ? null : current.googleCloud,
        });
        if (written.ok && previousBaidu !== null) {
          await removeCredentialQuietly(previousBaidu.credentialRef);
        }
        if (written.ok && previousGoogle !== null) {
          await removeGoogleCredentialQuietly(previousGoogle.credentialRef);
        }
        return written;
      }),
    save: async (input) => {
      if (input.kind === "ai") {
        if (!isNonblankModelId(input.modelId)) return failure("model_id_blank");
        const modelId = input.modelId;
        return enqueueWrite(async () => {
          const current = settingsSignal();
          const nextEnabled = current.ai === null ? true : current.enabled.ai;
          return writeBindingSnapshot(
            {
              order: ensureInOrder(current.order, "ai"),
              enabled: { ...current.enabled, ai: nextEnabled },
              ai: { kind: "ai", modelId },
              baidu: current.baidu,
              googleCloud: current.googleCloud,
            },
            { kind: "ai", modelId },
          );
        });
      }

      if (input.kind === "baidu") {
        if (!isBaiduOcrOperation(input.operation)) return failure("baidu_operation_invalid");
        const operation = input.operation;
        if (input.credentials.kind === "keep") {
          return enqueueWrite(async () => {
            const current = settingsSignal();
            const saved = current.baidu;
            if (saved === null) return failure("baidu_keys_required");
            const pair = await readStoredPair(saved.credentialRef);
            if (pair === null) return failure("baidu_keys_required");
            return writeBindingSnapshot(
              {
                order: ensureInOrder(current.order, "baidu"),
                enabled: { ...current.enabled },
                ai: current.ai,
                baidu: {
                  kind: "baidu",
                  operation,
                  credentialRef: saved.credentialRef,
                },
                googleCloud: current.googleCloud,
              },
              { kind: "baidu", operation, credentialRef: saved.credentialRef },
            );
          });
        }
        const apiKey = trimmedSecret(input.credentials.apiKey);
        const secretKey = trimmedSecret(input.credentials.secretKey);
        if (apiKey === null || secretKey === null) return failure("baidu_keys_required");

        return enqueueWrite(async () => {
          const current = settingsSignal();
          const nextEnabled = current.baidu === null ? true : current.enabled.baidu;
          const credentialRef = crypto.randomUUID();
          try {
            await storage.setItem(
              baiduCredentialStorageKey(credentialRef),
              JSON.stringify({ apiKey, secretKey }),
            );
          } catch {
            return failure("storage_write_failed");
          }
          const written = await writeBindingSnapshot(
            {
              order: ensureInOrder(current.order, "baidu"),
              enabled: { ...current.enabled, baidu: nextEnabled },
              ai: current.ai,
              baidu: { kind: "baidu", operation, credentialRef },
              googleCloud: current.googleCloud,
            },
            { kind: "baidu", operation, credentialRef },
          );
          if (!written.ok) {
            await removeCredentialQuietly(credentialRef);
            return written;
          }
          const previousRef = current.baidu?.credentialRef ?? null;
          if (previousRef !== null && previousRef !== credentialRef) {
            await removeCredentialQuietly(previousRef);
          }
          return written;
        });
      }

      if (input.credentials.kind === "keep") {
        return enqueueWrite(async () => {
          const current = settingsSignal();
          const saved = current.googleCloud;
          if (saved === null) return failure("google_cloud_key_required");
          const apiKey = await readStoredGoogleKey(saved.credentialRef);
          if (apiKey === null) return failure("google_cloud_key_required");
          return writeBindingSnapshot(
            {
              order: ensureInOrder(current.order, "google-cloud"),
              enabled: { ...current.enabled },
              ai: current.ai,
              baidu: current.baidu,
              googleCloud: { kind: "google-cloud", credentialRef: saved.credentialRef },
            },
            { kind: "google-cloud", credentialRef: saved.credentialRef },
          );
        });
      }

      const apiKey = googleCloudApiKey(input.credentials.apiKey);
      if (apiKey === null) return failure("google_cloud_key_required");
      return enqueueWrite(async () => {
        const current = settingsSignal();
        const nextEnabled = current.googleCloud === null ? true : current.enabled["google-cloud"];
        const credentialRef = crypto.randomUUID();
        try {
          await storage.setItem(
            googleCloudCredentialStorageKey(credentialRef),
            JSON.stringify({ apiKey }),
          );
        } catch {
          return failure("storage_write_failed");
        }
        const written = await writeBindingSnapshot(
          {
            order: ensureInOrder(current.order, "google-cloud"),
            enabled: { ...current.enabled, "google-cloud": nextEnabled },
            ai: current.ai,
            baidu: current.baidu,
            googleCloud: { kind: "google-cloud", credentialRef },
          },
          { kind: "google-cloud", credentialRef },
        );
        if (!written.ok) {
          await removeGoogleCredentialQuietly(credentialRef);
          return written;
        }
        const previousRef = current.googleCloud?.credentialRef ?? null;
        if (previousRef !== null && previousRef !== credentialRef) {
          await removeGoogleCredentialQuietly(previousRef);
        }
        return written;
      });
    },
    setEnabled: async (kind, nextEnabled) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (
          nextEnabled &&
          (!current.order.includes(kind) || bindingForKind(current, kind) === null)
        ) {
          return failure("channel_unconfigured");
        }
        if (current.enabled[kind] === nextEnabled) return { ok: true };
        return persistSnapshot({
          order: [...current.order],
          enabled: { ...current.enabled, [kind]: nextEnabled },
          ai: current.ai,
          baidu: current.baidu,
          googleCloud: current.googleCloud,
        });
      }),
    moveChannelTo: async (kind, targetIndex) =>
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
          baidu: current.baidu,
          googleCloud: current.googleCloud,
        });
      }),
  };
}

/** Production OCR settings store backed by NSH Storage. */
export const ocrSettingsStore = createOcrSettingsStore(Storage);
