import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { isSourceLanguageId, isTargetLanguageId } from "./languages";
import { readAvailableModelChoices } from "./model-choices";
import { isTemperature } from "./temperature";
import {
  PresetsStoreError,
  type ModelChoiceId,
  type PresetsStorage,
  type PresetsStore,
  type PresetsStoreStatus,
  type SavePresetInput,
  type TranslationPreset,
} from "./types";
import { validatePresetForSave } from "./validation";

export const PRESETS_STORAGE_KEY = "presets.v1.items";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidStoredPreset(value: unknown): value is TranslationPreset {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (!isSourceLanguageId(value.sourceLanguage)) return false;
  if (!isTargetLanguageId(value.targetLanguage)) return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;

  if (!isPlainObject(value.engine) || value.engine.kind !== "ai") return false;
  const engine = value.engine;
  if (!Array.isArray(engine.modelIds) || engine.modelIds.length === 0) return false;
  if (engine.modelIds.some((id) => typeof id !== "string" || id.trim().length === 0)) return false;

  if (
    engine.temperature !== null &&
    (typeof engine.temperature !== "number" || !isTemperature(engine.temperature))
  ) {
    return false;
  }
  if (
    engine.maxOutputTokens !== null &&
    (typeof engine.maxOutputTokens !== "number" ||
      !Number.isSafeInteger(engine.maxOutputTokens) ||
      engine.maxOutputTokens <= 0)
  ) {
    return false;
  }

  if (!Array.isArray(engine.templates) || engine.templates.length === 0) return false;
  const tplIds = new Set<string>();
  for (const tpl of engine.templates) {
    if (!isPlainObject(tpl)) return false;
    if (typeof tpl.id !== "string" || tpl.id.trim().length === 0) return false;
    if (tplIds.has(tpl.id)) return false;
    if (typeof tpl.name !== "string" || tpl.name.trim().length === 0) return false;
    if (typeof tpl.systemTemplate !== "string" || typeof tpl.userTemplate !== "string") {
      return false;
    }
    tplIds.add(tpl.id);
  }
  if (typeof engine.defaultTemplateId !== "string" || !tplIds.has(engine.defaultTemplateId)) {
    return false;
  }
  return true;
}

function parseStoredPresets(raw: string): TranslationPreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PresetsStoreError("storage_malformed", t("presets.error.storageMalformed"), {
      cause: error,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new PresetsStoreError("storage_malformed", t("presets.error.storageMalformed"));
  }
  if (typeof parsed.version !== "number") {
    throw new PresetsStoreError("storage_malformed", t("presets.error.storageMalformed"));
  }
  if (parsed.version !== 1) {
    throw new PresetsStoreError(
      "storage_unsupported_version",
      t("presets.error.storageUnsupportedVersion"),
    );
  }
  if (!Array.isArray(parsed.items)) {
    throw new PresetsStoreError("storage_malformed", t("presets.error.storageMalformed"));
  }
  for (const item of parsed.items) {
    if (!isValidStoredPreset(item)) {
      throw new PresetsStoreError("storage_malformed", t("presets.error.storageMalformed"));
    }
  }
  return parsed.items;
}

async function writePresets(storage: PresetsStorage, items: TranslationPreset[]): Promise<void> {
  try {
    await storage.setItem(PRESETS_STORAGE_KEY, JSON.stringify({ version: 1, items }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PresetsStoreError(
      "storage_write_failed",
      t("presets.error.storageWriteFailed", { detail }),
      { cause: error },
    );
  }
}

/** Creates a presets store backed by injected storage and model-choice snapshot reader. */
export function createPresetsStore(
  storage: PresetsStorage,
  readModelChoices: () => readonly ModelChoiceId[],
): PresetsStore {
  const recordsSignal = signal<TranslationPreset[]>([]);
  const statusSignal = signal<PresetsStoreStatus>({ kind: "idle" });
  const mutatingSignal = signal<boolean>(false);

  function assertReadyForMutation(): void {
    if (statusSignal().kind !== "ready") {
      throw new PresetsStoreError("storage_unreadable", t("presets.error.storageUnreadable"));
    }
    if (mutatingSignal()) {
      throw new PresetsStoreError("mutation_in_progress", t("presets.error.mutationInProgress"));
    }
  }

  return {
    load: async () => {
      statusSignal.set({ kind: "loading" });
      let raw: string | null;
      try {
        raw = await storage.getItem(PRESETS_STORAGE_KEY);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        recordsSignal.set([]);
        statusSignal.set({
          kind: "error",
          key: "storage_read_failed",
          message: t("presets.error.storageReadFailed", { detail }),
        });
        return;
      }

      if (raw === null) {
        recordsSignal.set([]);
        statusSignal.set({ kind: "ready" });
        return;
      }

      try {
        const items = parseStoredPresets(raw);
        recordsSignal.set(items);
        statusSignal.set({ kind: "ready" });
      } catch (error) {
        recordsSignal.set([]);
        if (error instanceof PresetsStoreError) {
          statusSignal.set({ kind: "error", key: error.key, message: error.message });
        } else {
          statusSignal.set({
            kind: "error",
            key: "storage_malformed",
            message: t("presets.error.storageMalformed"),
          });
        }
      }
    },
    records: () => recordsSignal(),
    status: () => statusSignal(),
    mutating: () => mutatingSignal(),
    save: async (input: SavePresetInput) => {
      assertReadyForMutation();

      const current = recordsSignal();
      const existing = input.id ? (current.find((item) => item.id === input.id) ?? null) : null;
      if (input.id && !existing) {
        throw new PresetsStoreError("not_found", t("presets.error.notFound"));
      }

      const availableIds = new Set(readModelChoices().map((choice) => choice.id));
      const validated = validatePresetForSave(input, availableIds, existing);
      const now = new Date().toISOString();
      const record: TranslationPreset = existing
        ? {
            ...existing,
            ...validated,
            updatedAt: now,
          }
        : {
            id: crypto.randomUUID(),
            ...validated,
            createdAt: now,
            updatedAt: now,
          };

      const next = existing
        ? current.map((item) => (item.id === record.id ? record : item))
        : [...current, record];

      mutatingSignal.set(true);
      try {
        await writePresets(storage, next);
        recordsSignal.set(next);
        return record;
      } finally {
        mutatingSignal.set(false);
      }
    },
    remove: async (id: string) => {
      assertReadyForMutation();

      const current = recordsSignal();
      if (!current.some((item) => item.id === id)) {
        throw new PresetsStoreError("not_found", t("presets.error.notFound"));
      }
      const next = current.filter((item) => item.id !== id);

      mutatingSignal.set(true);
      try {
        await writePresets(storage, next);
        recordsSignal.set(next);
      } finally {
        mutatingSignal.set(false);
      }
    },
  };
}

/** Production Presets Store backed by NSH Storage and live Models state. */
export const presetsStore = createPresetsStore(Storage, readAvailableModelChoices);
