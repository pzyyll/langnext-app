import { computed, signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { readAvailableModelChoices } from "./model-choices";
import { isTemperature } from "./temperature";
import {
  PresetsStoreError,
  type SavePresetInput,
  type ModelChoiceId,
  type PresetsStorage,
  type PresetsStore,
  type PresetsStoreStatus,
  type TranslationPreset,
} from "./types";
import { validatePresetForSave, type ValidatedPresetPayload } from "./validation";

export const PRESETS_STORAGE_KEY = "presets.v1.items";
export const DEEPL_CREDENTIAL_KEY_PREFIX = "presets.v1.deeplKeys.";

/** Storage key for one DeepL preset's key, addressed by its non-secret reference. */
export function deepLCredentialStorageKey(ref: string): string {
  return `${DEEPL_CREDENTIAL_KEY_PREFIX}${ref}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidAiEngine(engine: Record<string, unknown>): boolean {
  if (engine.kind !== "ai") return false;
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
  if (typeof engine.disableReasoning !== "boolean") return false;

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

function isValidDeepLEngine(engine: Record<string, unknown>): boolean {
  if (engine.kind !== "deepl") return false;
  return typeof engine.credentialRef === "string" && engine.credentialRef.trim().length > 0;
}

function isValidStoredPreset(value: unknown): value is TranslationPreset {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (!isPlainObject(value.engine)) return false;
  if (value.engine.kind === "ai") return isValidAiEngine(value.engine);
  if (value.engine.kind === "deepl") return isValidDeepLEngine(value.engine);
  return false;
}

function parseStoredPresets(raw: string): unknown[] {
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
  return parsed.items;
}

function writeFailure(error: unknown): PresetsStoreError {
  const detail = error instanceof Error ? error.message : String(error);
  return new PresetsStoreError(
    "storage_write_failed",
    t("presets.error.storageWriteFailed", { detail }),
    { cause: error },
  );
}

async function writePresets(storage: PresetsStorage, items: unknown[]): Promise<void> {
  try {
    await storage.setItem(PRESETS_STORAGE_KEY, JSON.stringify({ version: 1, items }));
  } catch (error) {
    throw writeFailure(error);
  }
}

/** Removes an orphaned key without undoing a committed record or leaking the secret. */
async function removeSecretQuietly(storage: PresetsStorage, ref: string): Promise<void> {
  try {
    await storage.removeItem(deepLCredentialStorageKey(ref));
  } catch {
    console.warn("Could not remove an unused DeepL API key.");
  }
}

/** Creates a presets store backed by injected storage and model-choice snapshot reader. */
export function createPresetsStore(
  storage: PresetsStorage,
  readModelChoices: () => readonly ModelChoiceId[],
): PresetsStore {
  // Keep skipped entries in storage even when the user changes a readable preset.
  const itemsSignal = signal<unknown[]>([]);
  const records = computed(() => itemsSignal().filter(isValidStoredPreset));
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

  const replaceItems = (existing: TranslationPreset | null, record: TranslationPreset) => {
    const items = itemsSignal();
    return existing ? items.map((item) => (item === existing ? record : item)) : [...items, record];
  };

  // The new key is written before its record, so an interrupted replacement never breaks a preset.
  const saveDeepL = async (
    existing: TranslationPreset | null,
    meta: Pick<ValidatedPresetPayload, "name" | "enabled">,
    engine: { kind: "deepl"; apiKey: string | null },
    now: string,
  ): Promise<TranslationPreset> => {
    const previousRef =
      existing !== null && existing.engine.kind === "deepl" ? existing.engine.credentialRef : null;
    let nextRef = previousRef;
    let wroteSecret = false;

    if (engine.apiKey !== null) {
      nextRef = crypto.randomUUID();
      try {
        await storage.setItem(deepLCredentialStorageKey(nextRef), engine.apiKey);
      } catch (error) {
        throw writeFailure(error);
      }
      wroteSecret = true;
    }
    if (nextRef === null) {
      throw new PresetsStoreError("deepl_key_required", t("presets.error.deeplKeyRequired"), {
        field: "deeplKey",
      });
    }

    const record: TranslationPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name: meta.name,
      enabled: meta.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      engine: { kind: "deepl", credentialRef: nextRef },
    };
    const next = replaceItems(existing, record);

    try {
      await writePresets(storage, next);
    } catch (error) {
      if (wroteSecret) await removeSecretQuietly(storage, nextRef);
      throw error;
    }
    itemsSignal.set(next);

    // The record now points at the new key; the replaced one is removable.
    if (wroteSecret && previousRef !== null) {
      await removeSecretQuietly(storage, previousRef);
    }
    return record;
  };

  return {
    load: async () => {
      statusSignal.set({ kind: "loading" });
      let raw: string | null;
      try {
        raw = await storage.getItem(PRESETS_STORAGE_KEY);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        itemsSignal.set([]);
        statusSignal.set({
          kind: "error",
          key: "storage_read_failed",
          message: t("presets.error.storageReadFailed", { detail }),
        });
        return;
      }

      try {
        const items = raw === null ? [] : parseStoredPresets(raw);
        itemsSignal.set(items);
        statusSignal.set({ kind: "ready", skippedCount: items.length - records().length });
      } catch (error) {
        itemsSignal.set([]);
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
    records,
    status: () => statusSignal(),
    mutating: () => mutatingSignal(),
    save: async (input: SavePresetInput) => {
      assertReadyForMutation();

      const existing = input.id ? (records().find((item) => item.id === input.id) ?? null) : null;
      if (input.id && !existing) {
        throw new PresetsStoreError("not_found", t("presets.error.notFound"));
      }

      // DeepL presets never consult the Models snapshot.
      const availableIds =
        input.engine?.kind === "ai"
          ? new Set(readModelChoices().map((choice) => choice.id))
          : new Set<string>();
      const validated = validatePresetForSave(input, availableIds, existing);
      const now = new Date().toISOString();

      mutatingSignal.set(true);
      try {
        if (validated.engine.kind === "deepl") {
          return await saveDeepL(existing, validated, validated.engine, now);
        }

        const record: TranslationPreset = {
          id: existing?.id ?? crypto.randomUUID(),
          name: validated.name,
          enabled: validated.enabled,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          engine: validated.engine.engine,
        };
        const next = replaceItems(existing, record);
        await writePresets(storage, next);
        itemsSignal.set(next);
        return record;
      } finally {
        mutatingSignal.set(false);
      }
    },
    remove: async (id: string) => {
      assertReadyForMutation();

      const existing = records().find((item) => item.id === id);
      if (!existing) {
        throw new PresetsStoreError("not_found", t("presets.error.notFound"));
      }
      const next = itemsSignal().filter((item) => item !== existing);

      mutatingSignal.set(true);
      try {
        await writePresets(storage, next);
        itemsSignal.set(next);
        if (existing.engine.kind === "deepl") {
          await removeSecretQuietly(storage, existing.engine.credentialRef);
        }
      } finally {
        mutatingSignal.set(false);
      }
    },
    readDeepLCredential: async (presetId: string) => {
      const record = records().find((item) => item.id === presetId);
      if (!record || record.engine.kind !== "deepl") return null;
      let raw: string | null;
      try {
        raw = await storage.getItem(deepLCredentialStorageKey(record.engine.credentialRef));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new PresetsStoreError(
          "storage_read_failed",
          t("presets.error.storageReadFailed", { detail }),
          { cause: error },
        );
      }
      const trimmed = raw?.trim();
      return trimmed ? trimmed : null;
    },
  };
}

/** Production Presets Store backed by NSH Storage and live Models state. */
export const presetsStore = createPresetsStore(Storage, readAvailableModelChoices);
