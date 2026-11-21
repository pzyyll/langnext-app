import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";

export const OCR_STORAGE_KEY = "settings.ocr.v1";
export const BAIDU_CREDENTIAL_KEY_PREFIX = "settings.ocr.credentials.";
const STORAGE_VERSION = 1;

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
 * Saved OCR service. AI keeps a model ID; Baidu keeps a mode and a credential reference.
 * Key values never live on the binding.
 */
export type OcrServiceBinding =
  | { kind: "ai"; modelId: string }
  | { kind: "baidu"; operation: BaiduOcrOperation; credentialRef: string };

/** API Key and Secret Key pair stored apart from the binding. */
export interface BaiduCredentialPair {
  apiKey: string;
  secretKey: string;
}

/** `keep` reuses the stored pair; `replace` writes a new pair. */
export type BaiduCredentialUpdate =
  | { kind: "keep" }
  | { kind: "replace"; apiKey: string; secretKey: string };

/** Save input. The returned binding is never this object for Baidu. */
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

export interface OcrSettingsStore {
  load(): Promise<void>;
  settings(): OcrServiceBinding | null;
  loadError(): OcrLoadError | null;
  save(input: SaveOcrBindingInput): Promise<OcrSaveResult>;
  /** Reads one stored pair. Loading the binding does not call this. */
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

type ParsedStorage =
  | { ok: true; binding: OcrServiceBinding }
  | { ok: false; key: OcrSettingsErrorKey };

function parseStoredBinding(raw: string): ParsedStorage {
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

  if (parsed.kind === "ai") {
    if (!isNonblankModelId(parsed.modelId)) return { ok: false, key: "storage_malformed" };
    return { ok: true, binding: { kind: "ai", modelId: parsed.modelId } };
  }
  if (parsed.kind === "baidu") {
    if (!isBaiduOcrOperation(parsed.operation)) return { ok: false, key: "storage_malformed" };
    if (typeof parsed.credentialRef !== "string" || parsed.credentialRef.trim().length === 0) {
      return { ok: false, key: "storage_malformed" };
    }
    return {
      ok: true,
      binding: {
        kind: "baidu",
        operation: parsed.operation,
        credentialRef: parsed.credentialRef,
      },
    };
  }
  return { ok: false, key: "storage_malformed" };
}

function trimmedSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Creates an OCR settings store backed by injected storage. */
export function createOcrSettingsStore(storage: OcrSettingsStorage): OcrSettingsStore {
  const bindingSignal = signal<OcrServiceBinding | null>(null);
  const loadErrorSignal = signal<OcrLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function writeSnapshot(binding: OcrServiceBinding): Promise<OcrSaveResult> {
    const payload = JSON.stringify(
      binding.kind === "ai"
        ? { version: STORAGE_VERSION, kind: binding.kind, modelId: binding.modelId }
        : {
            version: STORAGE_VERSION,
            kind: binding.kind,
            operation: binding.operation,
            credentialRef: binding.credentialRef,
          },
    );
    try {
      await storage.setItem(OCR_STORAGE_KEY, payload);
    } catch {
      return failure("storage_write_failed");
    }
    const snapshot = copyBinding(binding);
    bindingSignal.set(snapshot);
    loadErrorSignal.set(null);
    return { ok: true, binding: snapshot };
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
        bindingSignal.set(null);
        loadErrorSignal.set({
          key: "storage_read_failed",
          message: t(ERROR_MESSAGES.storage_read_failed),
        });
        return;
      }

      if (raw === null) {
        bindingSignal.set(null);
        loadErrorSignal.set(null);
        return;
      }

      const parsed = parseStoredBinding(raw);
      if (!parsed.ok) {
        bindingSignal.set(null);
        loadErrorSignal.set({ key: parsed.key, message: t(ERROR_MESSAGES[parsed.key]) });
        return;
      }

      bindingSignal.set(parsed.binding);
      loadErrorSignal.set(null);
    },
    settings: () => bindingSignal(),
    loadError: () => loadErrorSignal(),
    readBaiduCredentials: (credentialRef) => readStoredPair(credentialRef),
    save: async (input) => {
      if (input.kind === "ai") {
        if (!isNonblankModelId(input.modelId)) return failure("model_id_blank");
        const modelId = input.modelId;
        const queued = writeQueue.then(async (): Promise<OcrSaveResult> => {
          const previous = bindingSignal();
          const written = await writeSnapshot({ kind: "ai", modelId });
          if (written.ok && previous?.kind === "baidu") {
            await removeCredentialQuietly(previous.credentialRef);
          }
          return written;
        });
        writeQueue = queued.catch(() => undefined);
        return queued;
      }

      if (!isBaiduOcrOperation(input.operation)) return failure("baidu_operation_invalid");
      const operation = input.operation;
      if (input.credentials.kind === "keep") {
        const queued = writeQueue.then(async (): Promise<OcrSaveResult> => {
          const current = bindingSignal();
          if (current?.kind !== "baidu") return failure("baidu_keys_required");
          const pair = await readStoredPair(current.credentialRef);
          if (pair === null) return failure("baidu_keys_required");
          return writeSnapshot({
            kind: "baidu",
            operation,
            credentialRef: current.credentialRef,
          });
        });
        writeQueue = queued.catch(() => undefined);
        return queued;
      }
      const apiKey = trimmedSecret(input.credentials.apiKey);
      const secretKey = trimmedSecret(input.credentials.secretKey);
      if (apiKey === null || secretKey === null) return failure("baidu_keys_required");

      const queued = writeQueue.then(async (): Promise<OcrSaveResult> => {
        const previous = bindingSignal();
        const previousRef = previous?.kind === "baidu" ? previous.credentialRef : null;
        const credentialRef = crypto.randomUUID();
        try {
          await storage.setItem(
            baiduCredentialStorageKey(credentialRef),
            JSON.stringify({ apiKey, secretKey }),
          );
        } catch {
          return failure("storage_write_failed");
        }
        const written = await writeSnapshot({ kind: "baidu", operation, credentialRef });
        if (!written.ok) {
          await removeCredentialQuietly(credentialRef);
          return written;
        }
        if (previousRef !== null) await removeCredentialQuietly(previousRef);
        return written;
      });
      writeQueue = queued.catch(() => undefined);
      return queued;
    },
  };
}

/** Production OCR settings store backed by NSH Storage. */
export const ocrSettingsStore = createOcrSettingsStore(Storage);
