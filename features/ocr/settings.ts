import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";

export const OCR_STORAGE_KEY = "settings.ocr.v1";
const STORAGE_VERSION = 1;

/** OCR service behind screenshot recognition; AI is the only service in this release. */
export type OcrServiceKind = "ai";

/**
 * Saved OCR service. The model ID is validated for shape here only; whether the model is still
 * eligible for image input stays a runtime concern, so a removed model does not erase the binding.
 */
export interface OcrServiceBinding {
  kind: OcrServiceKind;
  modelId: string;
}

export type OcrSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "model_id_blank";

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
}

export interface OcrSettingsStore {
  load(): Promise<void>;
  settings(): OcrServiceBinding | null;
  loadError(): OcrLoadError | null;
  save(binding: OcrServiceBinding): Promise<OcrSaveResult>;
}

const ERROR_MESSAGES: Record<OcrSettingsErrorKey, string> = {
  storage_read_failed: "settings.ocr.error.storageReadFailed",
  storage_malformed: "settings.ocr.error.storageMalformed",
  storage_unsupported_version: "settings.ocr.error.storageUnsupportedVersion",
  storage_write_failed: "settings.ocr.error.storageWriteFailed",
  model_id_blank: "settings.ocr.error.modelIdBlank",
};

function failure(key: OcrSettingsErrorKey): OcrSaveResult {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServiceKind(value: unknown): value is OcrServiceKind {
  return value === "ai";
}

function isNonblankModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the first validation error key, or `null` for a saveable binding. */
export function validateOcrBinding(binding: OcrServiceBinding): OcrSettingsErrorKey | null {
  if (!isPlainObject(binding) || !isServiceKind(binding.kind)) return "storage_malformed";
  if (!isNonblankModelId(binding.modelId)) return "model_id_blank";
  return null;
}

function copyBinding(binding: OcrServiceBinding): OcrServiceBinding {
  return { kind: binding.kind, modelId: binding.modelId };
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

  const { kind, modelId } = parsed;
  if (!isServiceKind(kind) || !isNonblankModelId(modelId)) {
    return { ok: false, key: "storage_malformed" };
  }
  return { ok: true, binding: { kind, modelId } };
}

/** Creates an OCR settings store backed by injected storage. */
export function createOcrSettingsStore(storage: OcrSettingsStorage): OcrSettingsStore {
  const bindingSignal = signal<OcrServiceBinding | null>(null);
  const loadErrorSignal = signal<OcrLoadError | null>(null);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function writeSnapshot(binding: OcrServiceBinding): Promise<OcrSaveResult> {
    const payload = JSON.stringify({
      version: STORAGE_VERSION,
      kind: binding.kind,
      modelId: binding.modelId,
    });
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
    save: async (binding) => {
      const invalid = validateOcrBinding(binding);
      if (invalid !== null) {
        return failure(invalid);
      }

      const snapshot = copyBinding(binding);
      const queued = writeQueue.then(() => writeSnapshot(snapshot));
      writeQueue = queued.catch(() => undefined);
      return queued;
    },
  };
}

/** Production OCR settings store backed by NSH Storage. */
export const ocrSettingsStore = createOcrSettingsStore(Storage);
