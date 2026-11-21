import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";

export const OCR_STORAGE_KEY = "settings.ocr.v2";
export const BAIDU_CREDENTIAL_KEY_PREFIX = "settings.ocr.credentials.";
const STORAGE_VERSION = 2;

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

/** OCR service behind screenshot recognition. */
export type OcrServiceKind = "ai" | "baidu";

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

/** Save input. Saving a service stores its configuration and makes it the active service. */
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
  | "baidu_operation_invalid";

export interface OcrLoadError {
  key: OcrSettingsErrorKey;
  message: string;
}

export type OcrSaveResult =
  | { ok: true; binding: OcrServiceBinding }
  | { ok: false; key: OcrSettingsErrorKey; message: string };

export interface OcrSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Every service keeps its own saved configuration; only `active` decides what recognition uses. */
interface OcrSavedSettings {
  active: OcrServiceKind | null;
  ai: OcrAiBinding | null;
  baidu: OcrBaiduBinding | null;
}

const EMPTY_SETTINGS: OcrSavedSettings = { active: null, ai: null, baidu: null };

export interface OcrSettingsStore {
  load(): Promise<void>;
  /** The saved configuration of the active service, or null when no service is active. */
  settings(): OcrServiceBinding | null;
  /** The saved AI configuration, independent of the active service. */
  savedAiBinding(): OcrAiBinding | null;
  /** The saved Baidu configuration, independent of the active service. */
  savedBaiduBinding(): OcrBaiduBinding | null;
  loadError(): OcrLoadError | null;
  save(input: SaveOcrBindingInput): Promise<OcrSaveResult>;
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
};

function failure(key: OcrSettingsErrorKey): OcrSaveResult {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBaiduOcrOperation(value: unknown): value is BaiduOcrOperation {
  return typeof value === "string" && (BAIDU_OCR_OPERATIONS as readonly string[]).includes(value);
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
    active: settings.active,
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

function activeBinding(settings: OcrSavedSettings): OcrServiceBinding | null {
  if (settings.active === "ai") return settings.ai;
  if (settings.active === "baidu") return settings.baidu;
  return null;
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

  const active = parsed.active;
  if (active !== null && active !== "ai" && active !== "baidu") {
    return { ok: false, key: "storage_malformed" };
  }
  const ai = parseAiBinding(parsed.ai);
  const baidu = parseBaiduBinding(parsed.baidu);
  if (ai === undefined || baidu === undefined) return { ok: false, key: "storage_malformed" };
  if ((active === "ai" && ai === null) || (active === "baidu" && baidu === null)) {
    return { ok: false, key: "storage_malformed" };
  }
  return { ok: true, settings: { active, ai, baidu } };
}

function storagePayload(settings: OcrSavedSettings): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    active: settings.active,
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
  const settingsSignal = signal<OcrSavedSettings>(EMPTY_SETTINGS);
  const loadErrorSignal = signal<OcrLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function writeSnapshot(
    settings: OcrSavedSettings,
    saved: OcrServiceBinding,
  ): Promise<OcrSaveResult> {
    try {
      await storage.setItem(OCR_STORAGE_KEY, storagePayload(settings));
    } catch {
      return failure("storage_write_failed");
    }
    settingsSignal.set(copySettings(settings));
    loadErrorSignal.set(null);
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

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(OCR_STORAGE_KEY);
      } catch {
        settingsSignal.set(EMPTY_SETTINGS);
        loadErrorSignal.set({
          key: "storage_read_failed",
          message: t(ERROR_MESSAGES.storage_read_failed),
        });
        return;
      }

      if (raw === null) {
        settingsSignal.set(EMPTY_SETTINGS);
        loadErrorSignal.set(null);
        return;
      }

      const parsed = parseStoredSettings(raw);
      if (!parsed.ok) {
        settingsSignal.set(EMPTY_SETTINGS);
        loadErrorSignal.set({ key: parsed.key, message: t(ERROR_MESSAGES[parsed.key]) });
        return;
      }

      settingsSignal.set(parsed.settings);
      loadErrorSignal.set(null);
    },
    settings: () => {
      const binding = activeBinding(settingsSignal());
      return binding === null ? null : copyBinding(binding);
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
        const queued = writeQueue.then(async (): Promise<OcrSaveResult> => {
          const current = settingsSignal();
          return writeSnapshot(
            { active: "ai", ai: { kind: "ai", modelId }, baidu: current.baidu },
            { kind: "ai", modelId },
          );
        });
        writeQueue = queued.catch(() => undefined);
        return queued;
      }

      if (!isBaiduOcrOperation(input.operation)) return failure("baidu_operation_invalid");
      const operation = input.operation;
      if (input.credentials.kind === "keep") {
        const queued = writeQueue.then(async (): Promise<OcrSaveResult> => {
          const current = settingsSignal();
          const saved = current.baidu;
          if (saved === null) return failure("baidu_keys_required");
          const pair = await readStoredPair(saved.credentialRef);
          if (pair === null) return failure("baidu_keys_required");
          return writeSnapshot(
            {
              active: "baidu",
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
        writeQueue = queued.catch(() => undefined);
        return queued;
      }
      const apiKey = trimmedSecret(input.credentials.apiKey);
      const secretKey = trimmedSecret(input.credentials.secretKey);
      if (apiKey === null || secretKey === null) return failure("baidu_keys_required");

      const queued = writeQueue.then(async (): Promise<OcrSaveResult> => {
        const current = settingsSignal();
        const credentialRef = crypto.randomUUID();
        try {
          await storage.setItem(
            baiduCredentialStorageKey(credentialRef),
            JSON.stringify({ apiKey, secretKey }),
          );
        } catch {
          return failure("storage_write_failed");
        }
        const written = await writeSnapshot(
          {
            active: "baidu",
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
      writeQueue = queued.catch(() => undefined);
      return queued;
    },
  };
}

/** Production OCR settings store backed by NSH Storage. */
export const ocrSettingsStore = createOcrSettingsStore(Storage);
