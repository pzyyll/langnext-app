import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";

export const OCR_STORAGE_KEY = "settings.ocr.v3";
export const BAIDU_CREDENTIAL_KEY_PREFIX = "settings.ocr.credentials.";
const STORAGE_VERSION = 3;

/** Storage key for one Baidu credential pair, addressed by its non-secret reference. */
export function baiduCredentialStorageKey(credentialRef: string): string {
  return BAIDU_CREDENTIAL_KEY_PREFIX + credentialRef;
}

/** Baidu OCR recognition modes. `accurate` is the default. */
export const BAIDU_OCR_OPERATIONS = [
  "general_basic",
  "accurate_basic",
  "general",
  "accurate",
] as const;

export type BaiduOcrOperation = (typeof BAIDU_OCR_OPERATIONS)[number];

/** Supported OCR channels in default priority order. */
export const OCR_SERVICE_KINDS = ["ai", "baidu"] as const;

/** OCR service behind screenshot recognition. */
export type OcrServiceKind = (typeof OCR_SERVICE_KINDS)[number];

/**
 * Saved configuration for one OCR service. AI keeps a model ID; Baidu keeps a mode and a
 * credential reference. Key values never live on the binding.
 */
export type OcrServiceBinding =
  | { kind: "ai"; modelId: string }
  | { kind: "baidu"; operation: BaiduOcrOperation; credentialRef: string };

export type OcrAiBinding = Extract<OcrServiceBinding, { kind: "ai" }>;
export type OcrBaiduBinding = Extract<OcrServiceBinding, { kind: "baidu" }>;

/** API Key and Secret Key pair stored apart from the binding. */
export interface BaiduCredentialPair {
  apiKey: string;
  secretKey: string;
}

/** `keep` reuses the stored pair; `replace` writes a new pair. */
export type BaiduCredentialUpdate =
  | { kind: "keep" }
  | { kind: "replace"; apiKey: string; secretKey: string };

/** Save input. First-time save enables the channel; subsequent saves preserve its enabled state. */
export type SaveOcrBindingInput =
  | { kind: "ai"; modelId: string }
  | { kind: "baidu"; operation: BaiduOcrOperation; credentials: BaiduCredentialUpdate };

export type OcrSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "model_id_blank"
  | "baidu_keys_required"
  | "baidu_operation_invalid"
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
}

const EMPTY_SETTINGS: OcrSavedSettings = {
  order: [...OCR_SERVICE_KINDS],
  enabled: { ai: false, baidu: false },
  ai: null,
  baidu: null,
};

export interface OcrSettingsStore {
  load(): Promise<void>;
  /** Channels in top-to-bottom priority order. */
  channelOrder(): readonly OcrServiceKind[];
  /** Whether one channel is enabled. */
  isEnabled(kind: OcrServiceKind): boolean;
  /** Enabled configured bindings in top-to-bottom priority order. */
  enabledBindings(): readonly OcrServiceBinding[];
  /** The saved AI configuration, independent of enabled state. */
  savedAiBinding(): OcrAiBinding | null;
  /** The saved Baidu configuration, independent of enabled state. */
  savedBaiduBinding(): OcrBaiduBinding | null;
  loadError(): OcrLoadError | null;
  save(input: SaveOcrBindingInput): Promise<OcrSaveResult>;
  setEnabled(kind: OcrServiceKind, enabled: boolean): Promise<OcrActionResult>;
  moveChannel(kind: OcrServiceKind, direction: "up" | "down"): Promise<OcrActionResult>;
  /** Reads one stored pair. Loading the configuration does not call this. */
  readBaiduCredentials(credentialRef: string): Promise<BaiduCredentialPair | null>;
}

const ERROR_MESSAGES: Record<OcrSettingsErrorKey, string> = {
  storage_read_failed: "settings.ocr.error.storageReadFailed",
  storage_malformed: "settings.ocr.error.storageMalformed",
  storage_unsupported_version: "settings.ocr.error.storageUnsupportedVersion",
  storage_write_failed: "settings.ocr.error.storageWriteFailed",
  model_id_blank: "settings.ocr.error.modelIdBlank",
  baidu_keys_required: "settings.ocr.error.baiduKeysRequired",
  baidu_operation_invalid: "settings.ocr.error.baiduOperationInvalid",
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
  return {
    kind: "baidu",
    operation: binding.operation,
    credentialRef: binding.credentialRef,
  };
}

function copySettings(settings: OcrSavedSettings): OcrSavedSettings {
  return {
    order: [...settings.order],
    enabled: { ai: settings.enabled.ai, baidu: settings.enabled.baidu },
    ai: settings.ai === null ? null : { kind: "ai", modelId: settings.ai.modelId },
    baidu:
      settings.baidu === null
        ? null
        : {
            kind: "baidu",
            operation: settings.baidu.operation,
            credentialRef: settings.baidu.credentialRef,
          },
  };
}

function bindingForKind(
  settings: OcrSavedSettings,
  kind: OcrServiceKind,
): OcrServiceBinding | null {
  return kind === "ai" ? settings.ai : settings.baidu;
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
  if (!Array.isArray(value) || value.length !== OCR_SERVICE_KINDS.length) return null;
  const seen = new Set<OcrServiceKind>();
  const order: OcrServiceKind[] = [];
  for (const item of value) {
    if (!isOcrServiceKind(item) || seen.has(item)) return null;
    seen.add(item);
    order.push(item);
  }
  return seen.size === OCR_SERVICE_KINDS.length ? order : null;
}

function parseEnabledMap(value: unknown): Record<OcrServiceKind, boolean> | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.ai !== "boolean" || typeof value.baidu !== "boolean") return null;
  return { ai: value.ai, baidu: value.baidu };
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
  if (order === null || enabled === null || ai === undefined || baidu === undefined) {
    return { ok: false, key: "storage_malformed" };
  }
  if ((enabled.ai && ai === null) || (enabled.baidu && baidu === null)) {
    return { ok: false, key: "storage_malformed" };
  }
  return { ok: true, settings: { order, enabled, ai, baidu } };
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
  });
}

function trimmedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
      console.warn("Could not remove an unused Baidu OCR credential.");
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
    loadError: () => loadErrorSignal(),
    readBaiduCredentials: (credentialRef) => readStoredPair(credentialRef),
    save: async (input) => {
      if (input.kind === "ai") {
        if (!isNonblankModelId(input.modelId)) return failure("model_id_blank");
        const modelId = input.modelId;
        return enqueueWrite(async () => {
          const current = settingsSignal();
          const nextEnabled = current.ai === null ? true : current.enabled.ai;
          return writeBindingSnapshot(
            {
              order: [...current.order],
              enabled: { ...current.enabled, ai: nextEnabled },
              ai: { kind: "ai", modelId },
              baidu: current.baidu,
            },
            { kind: "ai", modelId },
          );
        });
      }

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
              order: [...current.order],
              enabled: { ...current.enabled },
              ai: current.ai,
              baidu: {
                kind: "baidu",
                operation,
                credentialRef: saved.credentialRef,
              },
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
            order: [...current.order],
            enabled: { ...current.enabled, baidu: nextEnabled },
            ai: current.ai,
            baidu: { kind: "baidu", operation, credentialRef },
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
    },
    setEnabled: async (kind, nextEnabled) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        if (nextEnabled && bindingForKind(current, kind) === null) {
          return failure("channel_unconfigured");
        }
        if (current.enabled[kind] === nextEnabled) return { ok: true };
        return persistSnapshot({
          order: [...current.order],
          enabled: { ...current.enabled, [kind]: nextEnabled },
          ai: current.ai,
          baidu: current.baidu,
        });
      }),
    moveChannel: async (kind, direction) =>
      enqueueWrite(async () => {
        const current = settingsSignal();
        const index = current.order.indexOf(kind);
        if (index === -1) return { ok: true };
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= current.order.length) return { ok: true };
        const nextOrder = [...current.order];
        const moving = nextOrder[index]!;
        nextOrder[index] = nextOrder[targetIndex]!;
        nextOrder[targetIndex] = moving;
        return persistSnapshot({
          order: nextOrder,
          enabled: { ...current.enabled },
          ai: current.ai,
          baidu: current.baidu,
        });
      }),
  };
}

/** Production OCR settings store backed by NSH Storage. */
export const ocrSettingsStore = createOcrSettingsStore(Storage);
