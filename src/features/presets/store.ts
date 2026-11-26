import { computed, signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";
import { googleCloudUsageStorageKey } from "./google-cloud-usage";
import { readAvailableModelChoices } from "./model-choices";
import { isTemperature } from "./temperature";
import {
  PresetsStoreError,
  type DeepLPresetEngine,
  type GoogleCloudPresetEngine,
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
export const GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX = "presets.v1.googleCloudKeys.";

const log = createLogger("presets/store");

/** Storage key for one DeepL preset's key, addressed by its non-secret reference. */
export function deepLCredentialStorageKey(ref: string): string {
  return `${DEEPL_CREDENTIAL_KEY_PREFIX}${ref}`;
}

/** Storage key for one Google Cloud preset's key, addressed by its non-secret reference. */
export function googleCloudCredentialStorageKey(ref: string): string {
  return `${GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX}${ref}`;
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

type CredentialEngineKind = "deepl" | "google-cloud";

function isValidCredentialEngine(
  engine: Record<string, unknown>,
  kind: CredentialEngineKind,
): boolean {
  return (
    engine.kind === kind &&
    typeof engine.credentialRef === "string" &&
    engine.credentialRef.trim().length > 0
  );
}

function isValidStoredPreset(value: unknown): value is TranslationPreset {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (!isPlainObject(value.engine)) return false;
  if (value.engine.kind === "ai") return isValidAiEngine(value.engine);
  if (value.engine.kind === "deepl") return isValidCredentialEngine(value.engine, "deepl");
  if (value.engine.kind === "google-cloud") {
    return isValidCredentialEngine(value.engine, "google-cloud");
  }
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

/** Storage key for one engine's credential, addressed by its non-secret reference. */
function credentialStorageKey(kind: CredentialEngineKind, ref: string): string {
  return kind === "deepl" ? deepLCredentialStorageKey(ref) : googleCloudCredentialStorageKey(ref);
}

function credentialEngine(
  kind: CredentialEngineKind,
  credentialRef: string,
): DeepLPresetEngine | GoogleCloudPresetEngine {
  return kind === "deepl"
    ? { kind: "deepl", credentialRef }
    : { kind: "google-cloud", credentialRef };
}

/** Removes a deleted preset's monthly usage; it is a local counter, not preset data. */
async function removeUsageQuietly(storage: PresetsStorage, presetId: string): Promise<void> {
  try {
    await storage.removeItem(googleCloudUsageStorageKey(presetId));
  } catch {
    log.warn("Could not remove a deleted Google Cloud preset's character usage.");
  }
}

/** Removes an orphaned key without undoing a committed record or leaking the secret. */
async function removeSecretQuietly(
  storage: PresetsStorage,
  kind: CredentialEngineKind,
  ref: string,
): Promise<void> {
  try {
    await storage.removeItem(credentialStorageKey(kind, ref));
  } catch {
    log.warn(
      kind === "deepl"
        ? "Could not remove an unused DeepL API key."
        : "Could not remove an unused Google Cloud API key.",
    );
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
  const saveCredentialPreset = async (
    existing: TranslationPreset | null,
    meta: Pick<ValidatedPresetPayload, "name" | "enabled">,
    engine: { kind: CredentialEngineKind; apiKey: string | null },
    now: string,
  ): Promise<TranslationPreset> => {
    const previousRef =
      existing !== null && existing.engine.kind === engine.kind
        ? existing.engine.credentialRef
        : null;
    let nextRef = previousRef;
    let wroteSecret = false;

    if (engine.apiKey !== null) {
      nextRef = crypto.randomUUID();
      try {
        await storage.setItem(credentialStorageKey(engine.kind, nextRef), engine.apiKey);
      } catch (error) {
        throw writeFailure(error);
      }
      wroteSecret = true;
    }
    if (nextRef === null) {
      throw engine.kind === "deepl"
        ? new PresetsStoreError("deepl_key_required", t("presets.error.deeplKeyRequired"), {
            field: "deeplKey",
          })
        : new PresetsStoreError(
            "google_cloud_key_required",
            t("presets.error.googleCloudKeyRequired"),
            { field: "googleCloudKey" },
          );
    }

    const record: TranslationPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name: meta.name,
      enabled: meta.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      engine: credentialEngine(engine.kind, nextRef),
    };
    const next = replaceItems(existing, record);

    try {
      await writePresets(storage, next);
    } catch (error) {
      if (wroteSecret) await removeSecretQuietly(storage, engine.kind, nextRef);
      throw error;
    }
    itemsSignal.set(next);

    // The record now points at the new key; the replaced one is removable.
    if (wroteSecret && previousRef !== null) {
      await removeSecretQuietly(storage, engine.kind, previousRef);
    }
    return record;
  };

  const readCredential = async (
    presetId: string,
    kind: CredentialEngineKind,
  ): Promise<string | null> => {
    const record = records().find((item) => item.id === presetId);
    if (!record || record.engine.kind !== kind) return null;
    let raw: string | null;
    try {
      raw = await storage.getItem(credentialStorageKey(kind, record.engine.credentialRef));
    } catch (error) {
      if (kind === "deepl") {
        const detail = error instanceof Error ? error.message : String(error);
        throw new PresetsStoreError(
          "storage_read_failed",
          t("presets.error.storageReadFailed", { detail }),
          { cause: error },
        );
      }
      throw new PresetsStoreError(
        "storage_read_failed",
        t("presets.error.googleCloudKeyUnreadable"),
        { cause: error },
      );
    }
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
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
        if (validated.engine.kind === "deepl" || validated.engine.kind === "google-cloud") {
          return await saveCredentialPreset(existing, validated, validated.engine, now);
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
        if (existing.engine.kind === "deepl" || existing.engine.kind === "google-cloud") {
          await removeSecretQuietly(storage, existing.engine.kind, existing.engine.credentialRef);
        }
        if (existing.engine.kind === "google-cloud") {
          await removeUsageQuietly(storage, existing.id);
        }
      } finally {
        mutatingSignal.set(false);
      }
    },
    readDeepLCredential: (presetId: string) => readCredential(presetId, "deepl"),
    readGoogleCloudCredential: (presetId: string) => readCredential(presetId, "google-cloud"),
  };
}

/** Production Presets Store backed by NSH Storage and live Models state. */
export const presetsStore = createPresetsStore(Storage, readAvailableModelChoices);
