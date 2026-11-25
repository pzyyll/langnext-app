import { batch, signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { DiscoveredRemoteModel } from "../../modules/ai/contracts/model";
import { aiClient, type AiClientInput } from "../../modules/ai/runtime/client";
import { aiRegistry } from "../../modules/ai/runtime/registry";
import { createLogger } from "../../services/log";
import { inspectBaseUrl } from "./connection";
import {
  isEffectiveProtocolSupported,
  resolveEffectiveApiType,
  resolveEffectiveCapabilities,
  type ModelPurpose,
} from "./model-helpers";
import {
  applyModelConfigUpdate,
  createManualProviderModel,
  mergeDiscoveredCatalog,
} from "./model-collection";
import type { ConnectionSnapshot, ProviderChannel } from "../../modules/ai/contracts/channel";
import type { ProviderModel, SyncModelsResult } from "../../modules/ai/contracts/model";
import type {
  CreateManualModelInput,
  ModelsEnabledFilter,
  PersistedDraftScopes,
  SaveChannelDraftInput,
  UpdateChannelInput,
  UpdateModelConfigInput,
} from "./types";

export const PROVIDERS_STORAGE_KEY = "models.v2.providers";
export const MODELS_STORAGE_KEY = "models.v2.items";
export const CREDENTIAL_KEY_PREFIX = "models.v2.credentials.";
const FILTER_KEY = "models.enabledFilter";

const log = createLogger("models/store");

export function credentialStorageKey(providerId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${providerId}`;
}

export class RevisionConflictError extends Error {
  constructor() {
    super(t("models.error.revisionConflict"));
    this.name = "RevisionConflictError";
  }
}

export class PartialDraftSaveError extends Error {
  readonly persisted: PersistedDraftScopes;
  readonly savedChannel: ProviderChannel | null;

  constructor(
    message: string,
    persisted: PersistedDraftScopes,
    savedChannel: ProviderChannel | null,
  ) {
    super(message);
    this.name = "PartialDraftSaveError";
    this.persisted = persisted;
    this.savedChannel = savedChannel;
  }
}

const channelsSignal = signal<ProviderChannel[]>([]);
const modelsSignal = signal<ProviderModel[]>([]);
const selectedIdSignal = signal<string | null>(null);
const loadingSignal = signal<boolean>(false);
const errorSignal = signal<string | null>(null);
const enabledFilterSignal = signal<ModelsEnabledFilter>("all");

let writeQueue: Promise<void> = Promise.resolve();

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isEnabledFilter(value: string | null): value is ModelsEnabledFilter {
  return value === "all" || value === "enabled" || value === "disabled";
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function sortChannels(list: ProviderChannel[]): ProviderChannel[] {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder);
}

async function persistProviders(next: ProviderChannel[]): Promise<void> {
  const sanitized = next.map((item) => ({ ...item }));
  await Storage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(sanitized));
}

async function persistModels(next: ProviderModel[]): Promise<void> {
  await Storage.setItem(MODELS_STORAGE_KEY, JSON.stringify(next));
}

async function readSecret(providerId: string): Promise<string | null> {
  const value = await Storage.getItem(credentialStorageKey(providerId));
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function writeSecret(providerId: string, secret: string | null): Promise<void> {
  if (secret && secret.trim().length > 0) {
    await Storage.setItem(credentialStorageKey(providerId), secret.trim());
  } else {
    await Storage.removeItem(credentialStorageKey(providerId));
  }
}

/** Reactive read accessors for UI components. */
export const modelsStore = {
  channels: () => channelsSignal(),
  models: () => modelsSignal(),
  selectedChannelId: () => selectedIdSignal(),
  selectedChannel: () => {
    const id = selectedIdSignal();
    if (!id) return null;
    return channelsSignal().find((ch) => ch.id === id) ?? null;
  },
  modelsForSelectedChannel: () => {
    const id = selectedIdSignal();
    if (!id) return [];
    return modelsSignal().filter((m) => m.providerId === id);
  },
  channelsLoading: () => loadingSignal(),
  channelsError: () => errorSignal(),
  enabledFilter: () => enabledFilterSignal(),
};

/** Loads persisted channels, models, and list filter from NSH Storage. */
export async function loadModelsState(): Promise<void> {
  loadingSignal.set(true);
  errorSignal.set(null);

  try {
    const [providersRaw, modelsRaw, filterRaw] = await Promise.all([
      Storage.getItem(PROVIDERS_STORAGE_KEY),
      Storage.getItem(MODELS_STORAGE_KEY),
      Storage.getItem(FILTER_KEY),
    ]);

    const sortedProviders = sortChannels(parseJsonArray<ProviderChannel>(providersRaw));
    const loadedModels = parseJsonArray<ProviderModel>(modelsRaw);
    const filterValue = isEnabledFilter(filterRaw) ? filterRaw : "all";

    batch(() => {
      channelsSignal.set(sortedProviders);
      modelsSignal.set(loadedModels);
      enabledFilterSignal.set(filterValue);

      const currentSelected = selectedIdSignal();
      const stillPresent =
        currentSelected !== null && sortedProviders.some((ch) => ch.id === currentSelected);
      selectedIdSignal.set(stillPresent ? currentSelected : (sortedProviders[0]?.id ?? null));
      loadingSignal.set(false);
    });
  } catch (error) {
    batch(() => {
      loadingSignal.set(false);
      errorSignal.set(error instanceof Error ? error.message : t("models.error.loadChannels"));
    });
  }
}

export function selectChannel(id: string | null): void {
  selectedIdSignal.set(id);
}

export async function setEnabledFilter(filter: ModelsEnabledFilter): Promise<void> {
  enabledFilterSignal.set(filter);
  try {
    await Storage.setItem(FILTER_KEY, filter);
  } catch (error) {
    log.warn("Could not persist model filter.", error);
  }
}

export async function saveChannelDraft(input: SaveChannelDraftInput): Promise<ProviderChannel> {
  return withWriteLock(async () => {
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error(t("models.error.displayNameRequired"));
    }
    if (!aiRegistry.isProtocolAllowed(input.presetId, input.adapterId)) {
      throw new Error(t("models.error.unsupportedProtocol"));
    }

    const urlCheck = inspectBaseUrl(input.baseUrl ?? "");
    if (!urlCheck.ok) {
      throw new Error(urlCheck.error ?? t("models.error.invalidBaseUrl"));
    }
    if (urlCheck.isInsecureHttp && !input.allowInsecureHttp) {
      throw new Error(t("models.error.confirmInsecureSave"));
    }

    const inputModels = input.models ?? [];
    for (const model of inputModels) {
      if (
        model.apiTypeOverride !== null &&
        !aiRegistry.isProtocolAllowed(input.presetId, model.apiTypeOverride)
      ) {
        throw new Error(t("models.error.unsupportedProtocol"));
      }
    }

    const existing = channelsSignal();
    const alreadySaved = existing.find((ch) => ch.id === input.id) ?? null;
    const tokenValue = input.credential?.trim() || null;

    let channelPersisted = alreadySaved !== null || Boolean(input.persistedScopes?.channel);
    let credentialPersisted = Boolean(input.persistedScopes?.credential);
    let savedChannel: ProviderChannel | null = alreadySaved;

    if (tokenValue !== null && !credentialPersisted) {
      try {
        await writeSecret(input.id, tokenValue);
        credentialPersisted = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : t("models.error.saveChannel");
        throw new PartialDraftSaveError(
          t("models.error.savePartialCredentialFailed", { detail }),
          { channel: channelPersisted, credential: credentialPersisted, models: false },
          savedChannel,
        );
      }
    } else if (tokenValue === null && input.clearStaleCredential) {
      await writeSecret(input.id, null);
      credentialPersisted = false;
    }

    const timestamp = nowIso();
    const maxSortOrder = existing.reduce((max, ch) => Math.max(max, ch.sortOrder), -1);
    const channelRecord: ProviderChannel = alreadySaved
      ? {
          ...alreadySaved,
          displayName,
          adapterId: input.adapterId,
          baseUrl: urlCheck.normalizedBaseUrl,
          hasCredential:
            tokenValue !== null
              ? true
              : input.clearStaleCredential
                ? false
                : alreadySaved.hasCredential,
          enabled: input.enabled,
          insecureHttpConfirmedAt: urlCheck.isInsecureHttp
            ? (alreadySaved.insecureHttpConfirmedAt ?? timestamp)
            : null,
          modelsLastSyncedAt: input.modelsLastSyncedAt ?? alreadySaved.modelsLastSyncedAt,
          modelsLastSyncError:
            input.modelsLastSyncError !== undefined
              ? input.modelsLastSyncError
              : alreadySaved.modelsLastSyncError,
          updatedAt: timestamp,
        }
      : {
          id: input.id,
          presetId: input.presetId,
          displayName,
          adapterId: input.adapterId,
          baseUrl: urlCheck.normalizedBaseUrl,
          hasCredential: tokenValue !== null,
          enabled: input.enabled,
          sortOrder: maxSortOrder + 1,
          revision: 1,
          insecureHttpConfirmedAt: urlCheck.isInsecureHttp ? timestamp : null,
          modelsLastSyncedAt: input.modelsLastSyncedAt ?? null,
          modelsLastSyncError: input.modelsLastSyncError ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    const channelNeedsWrite =
      alreadySaved === null ||
      alreadySaved.displayName !== displayName ||
      alreadySaved.adapterId !== input.adapterId ||
      alreadySaved.baseUrl !== urlCheck.normalizedBaseUrl ||
      alreadySaved.enabled !== input.enabled ||
      alreadySaved.hasCredential !== channelRecord.hasCredential ||
      (alreadySaved.insecureHttpConfirmedAt !== null) !== urlCheck.isInsecureHttp ||
      alreadySaved.modelsLastSyncedAt !== channelRecord.modelsLastSyncedAt ||
      alreadySaved.modelsLastSyncError !== channelRecord.modelsLastSyncError;

    const nextChannels = alreadySaved
      ? existing.map((ch) => (ch.id === alreadySaved.id ? channelRecord : ch))
      : sortChannels([...existing, channelRecord]);

    try {
      if (channelNeedsWrite) {
        await persistProviders(nextChannels);
      }
      channelPersisted = true;
      savedChannel = channelRecord;
      if (channelNeedsWrite) {
        channelsSignal.set(nextChannels);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : t("models.error.saveChannel");
      const message = credentialPersisted
        ? t("models.error.savePartialChannelWithCredential", { detail })
        : t("models.error.saveChannel");
      throw new PartialDraftSaveError(
        message,
        { channel: channelPersisted, credential: credentialPersisted, models: false },
        savedChannel,
      );
    }

    const existingModels = modelsSignal();
    const existingIds = new Set(existingModels.map((m) => m.id));
    const existingChannelKeys = new Set(
      existingModels.filter((m) => m.providerId === channelRecord.id).map((m) => m.modelKey),
    );
    const seenKeys = new Set<string>();
    const appendedModels: ProviderModel[] = [];
    for (const model of inputModels) {
      if (
        existingIds.has(model.id) ||
        existingChannelKeys.has(model.modelKey) ||
        seenKeys.has(model.modelKey)
      ) {
        continue;
      }
      seenKeys.add(model.modelKey);
      appendedModels.push({
        ...model,
        providerId: channelRecord.id,
      });
    }
    const nextModels =
      appendedModels.length > 0 ? [...existingModels, ...appendedModels] : existingModels;

    if (appendedModels.length > 0) {
      try {
        await persistModels(nextModels);
      } catch (error) {
        const detail = error instanceof Error ? error.message : t("models.error.saveChannel");
        selectedIdSignal.set(channelRecord.id);
        throw new PartialDraftSaveError(
          t("models.error.savePartialModelsFailed", { detail }),
          { channel: true, credential: credentialPersisted, models: false },
          savedChannel,
        );
      }
    }

    batch(() => {
      if (appendedModels.length > 0) {
        modelsSignal.set(nextModels);
      }
      selectedIdSignal.set(channelRecord.id);
    });
    return channelRecord;
  });
}

export async function updateChannel(input: UpdateChannelInput): Promise<ProviderChannel> {
  return withWriteLock(async () => {
    const existing = channelsSignal();
    const index = existing.findIndex((ch) => ch.id === input.id);
    if (index === -1) {
      throw new Error(t("models.error.channelGone"));
    }
    const current = existing[index]!;
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError();
    }

    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error(t("models.error.displayNameRequired"));
    }
    if (!aiRegistry.isProtocolAllowed(current.presetId, input.adapterId)) {
      throw new Error(t("models.error.unsupportedProtocol"));
    }

    const urlCheck = inspectBaseUrl(input.baseUrl ?? "");
    if (!urlCheck.ok) {
      throw new Error(urlCheck.error ?? t("models.error.invalidBaseUrl"));
    }
    if (urlCheck.isInsecureHttp && !input.allowInsecureHttp) {
      throw new Error(t("models.error.confirmInsecureFormSave"));
    }

    const timestamp = nowIso();
    let hasCredential = current.hasCredential;

    if (input.credentialUpdate.mode === "clear") {
      await writeSecret(current.id, null);
      hasCredential = false;
    } else if (input.credentialUpdate.mode === "replace") {
      const nextSecret = input.credentialUpdate.value.trim();
      if (!nextSecret) {
        throw new Error(t("models.error.tokenRequired"));
      }
      await writeSecret(current.id, nextSecret);
      hasCredential = true;
    }

    const sameInsecureHost =
      urlCheck.isInsecureHttp &&
      current.baseUrl === urlCheck.normalizedBaseUrl &&
      current.insecureHttpConfirmedAt !== null;

    const updated: ProviderChannel = {
      ...current,
      displayName,
      adapterId: input.adapterId,
      baseUrl: urlCheck.normalizedBaseUrl,
      hasCredential,
      enabled: input.enabled,
      revision: current.revision + 1,
      insecureHttpConfirmedAt: urlCheck.isInsecureHttp
        ? sameInsecureHost
          ? current.insecureHttpConfirmedAt
          : timestamp
        : null,
      updatedAt: timestamp,
    };

    const nextChannels = existing.map((ch) => (ch.id === updated.id ? updated : ch));
    await persistProviders(nextChannels);
    channelsSignal.set(nextChannels);
    return updated;
  });
}

export async function toggleChannelEnabled(id: string, enabled: boolean): Promise<ProviderChannel> {
  return withWriteLock(async () => {
    const existing = channelsSignal();
    const current = existing.find((ch) => ch.id === id);
    if (!current) {
      throw new Error(t("models.error.channelGone"));
    }
    const updated: ProviderChannel = {
      ...current,
      enabled,
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    const nextChannels = existing.map((ch) => (ch.id === id ? updated : ch));
    await persistProviders(nextChannels);
    channelsSignal.set(nextChannels);
    return updated;
  });
}

export async function renameChannel(id: string, nextName: string): Promise<ProviderChannel> {
  return withWriteLock(async () => {
    const trimmed = nextName.trim();
    if (!trimmed) {
      throw new Error(t("models.error.channelNameEmpty"));
    }
    const existing = channelsSignal();
    const current = existing.find((ch) => ch.id === id);
    if (!current) {
      throw new Error(t("models.error.channelGone"));
    }
    if (current.displayName === trimmed) {
      return current;
    }
    const updated: ProviderChannel = {
      ...current,
      displayName: trimmed,
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    const nextChannels = existing.map((ch) => (ch.id === id ? updated : ch));
    await persistProviders(nextChannels);
    channelsSignal.set(nextChannels);
    return updated;
  });
}

/** Moves a channel to a slot of the current order and persists that order. */
export async function moveChannelTo(id: string, target: number): Promise<void> {
  return withWriteLock(async () => {
    const list = sortChannels(channelsSignal());
    const index = list.findIndex((ch) => ch.id === id);
    if (index === -1) return;
    const targetIndex = Math.min(Math.max(target, 0), list.length - 1);
    if (targetIndex === index) return;

    const reordered = [...list];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved!);

    const timestamp = nowIso();
    const normalized = reordered.map((ch, idx) => ({
      ...ch,
      sortOrder: idx,
      updatedAt: ch.sortOrder === idx ? ch.updatedAt : timestamp,
    }));

    await persistProviders(normalized);
    channelsSignal.set(normalized);
  });
}

export async function deleteChannel(id: string): Promise<void> {
  return withWriteLock(async () => {
    const remainingChannels = sortChannels(channelsSignal().filter((ch) => ch.id !== id)).map(
      (ch, idx) => ({
        ...ch,
        sortOrder: idx,
      }),
    );
    const remainingModels = modelsSignal().filter((m) => m.providerId !== id);

    await Promise.all([
      persistProviders(remainingChannels),
      persistModels(remainingModels),
      writeSecret(id, null),
    ]);

    batch(() => {
      channelsSignal.set(remainingChannels);
      modelsSignal.set(remainingModels);
      if (selectedIdSignal() === id) {
        selectedIdSignal.set(remainingChannels[0]?.id ?? null);
      }
    });
  });
}

async function readSavedChannelCredential(channelId: string): Promise<string | null> {
  const targetChannel = channelsSignal().find((item) => item.id === channelId);
  return targetChannel && !targetChannel.hasCredential ? null : await readSecret(channelId);
}

/**
 * Applies the host's URL consent and saved-secret policy, then hands the client
 * a resolved connection snapshot. Provider policy stays in the client.
 */
async function resolveConnectionRequestParams(
  snapshot: ConnectionSnapshot,
  action: "test" | "fetch",
): Promise<AiClientInput> {
  const provider = aiRegistry.getProvider(snapshot.presetId);
  if (!provider.allowedProtocolIds.includes(snapshot.adapterId)) {
    throw new Error(t("models.error.unsupportedProtocol"));
  }

  const urlCheck = inspectBaseUrl(snapshot.baseUrl ?? "");
  if (!urlCheck.ok) {
    throw new Error(urlCheck.error ?? t("models.error.invalidBaseUrl"));
  }
  if (!urlCheck.normalizedBaseUrl && !provider.defaultBaseUrl) {
    throw new Error(t("models.error.baseUrlRequired"));
  }
  if (urlCheck.isInsecureHttp && !snapshot.allowInsecureHttp) {
    throw new Error(
      action === "test"
        ? t("models.error.confirmInsecureTest")
        : t("models.error.confirmInsecureFetch"),
    );
  }

  let credential: string | null = null;
  if (snapshot.credentialInput.mode === "inline") {
    credential = snapshot.credentialInput.value?.trim() || null;
  } else {
    const { channelId, update } = snapshot.credentialInput;
    if (update.mode === "keep") {
      credential = await readSavedChannelCredential(channelId);
    } else if (update.mode === "replace") {
      credential = update.value.trim() || null;
    } else {
      credential = null;
    }
  }

  return {
    providerTypeId: snapshot.presetId,
    protocolId: snapshot.adapterId,
    baseUrl: urlCheck.normalizedBaseUrl,
    credential,
  };
}

export async function testConnectionSnapshot(
  snapshot: ConnectionSnapshot,
  abortSignal?: AbortSignal,
): Promise<{ modelCount: number }> {
  const input = await resolveConnectionRequestParams(snapshot, "test");
  return aiClient.testConnection(input, { signal: abortSignal });
}

export async function discoverModelsSnapshot(
  snapshot: ConnectionSnapshot,
  abortSignal?: AbortSignal,
): Promise<DiscoveredRemoteModel[]> {
  const input = await resolveConnectionRequestParams(snapshot, "fetch");
  return aiClient.discoverModels(input, { signal: abortSignal });
}

export async function syncChannelModels(
  providerId: string,
  snapshot: ConnectionSnapshot,
  abortSignal?: AbortSignal,
): Promise<SyncModelsResult> {
  const channel = channelsSignal().find((ch) => ch.id === providerId);
  if (!channel) {
    throw new Error(t("models.error.channelGone"));
  }

  const input = await resolveConnectionRequestParams(snapshot, "fetch");
  const syncAdapterId = input.protocolId;

  let discovered;
  try {
    discovered = await aiClient.discoverModels(input, { signal: abortSignal });
  } catch (error) {
    const message = error instanceof Error ? error.message : t("models.error.fetchModels");
    if (!abortSignal?.aborted && (error as { kind?: string } | null)?.kind !== "cancelled") {
      await withWriteLock(async () => {
        const exists = channelsSignal().some((ch) => ch.id === providerId);
        if (!exists || abortSignal?.aborted) return;
        const currentChannels = channelsSignal().map((ch) =>
          ch.id === providerId ? { ...ch, modelsLastSyncError: message, updatedAt: nowIso() } : ch,
        );
        await persistProviders(currentChannels);
        channelsSignal.set(currentChannels);
      });
    }
    throw error;
  }

  if (abortSignal?.aborted) {
    throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
  }

  const enriched = discovered;

  return withWriteLock(async () => {
    if (abortSignal?.aborted) {
      throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
    }
    const targetExists = channelsSignal().some((ch) => ch.id === providerId);
    if (!targetExists) {
      throw new Error(t("models.error.channelGone"));
    }
    const timestamp = nowIso();
    const allModels = modelsSignal();
    const otherModels = allModels.filter((m) => m.providerId !== providerId);
    const channelModels = allModels.filter((m) => m.providerId === providerId);
    const merged = mergeDiscoveredCatalog({
      existingChannelModels: channelModels,
      providerId,
      sourceAdapterId: syncAdapterId,
      discovered: enriched,
      timestamp,
    });

    const nextAllModels = [...otherModels, ...merged.models];
    const nextChannels = channelsSignal().map((ch) =>
      ch.id === providerId
        ? {
            ...ch,
            modelsLastSyncedAt: timestamp,
            modelsLastSyncError: null,
            updatedAt: timestamp,
          }
        : ch,
    );

    await Promise.all([persistModels(nextAllModels), persistProviders(nextChannels)]);

    batch(() => {
      modelsSignal.set(nextAllModels);
      channelsSignal.set(nextChannels);
    });

    return merged.summary;
  });
}

export async function setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
  return withWriteLock(async () => {
    const timestamp = nowIso();
    const nextModels = modelsSignal().map((m) =>
      m.id === modelId ? { ...m, enabled, updatedAt: timestamp } : m,
    );
    await persistModels(nextModels);
    modelsSignal.set(nextModels);
  });
}

export async function createManualModel(input: CreateManualModelInput): Promise<ProviderModel> {
  return withWriteLock(async () => {
    const channel = channelsSignal().find((ch) => ch.id === input.providerId);
    if (!channel) {
      throw new Error(t("models.error.channelGone"));
    }

    const existing = modelsSignal();
    const channelModels = existing.filter((m) => m.providerId === input.providerId);
    const created = createManualProviderModel(
      channelModels,
      {
        providerId: input.providerId,
        presetId: channel.presetId,
        defaultAdapterId: channel.adapterId,
        modelKey: input.modelKey,
        displayNameOverride: input.displayNameOverride ?? null,
        apiTypeOverride: input.apiTypeOverride,
        enabled: input.enabled,
        facts: input.facts ?? null,
      },
      nowIso(),
    );

    const nextModels = [...existing, created];
    await persistModels(nextModels);
    modelsSignal.set(nextModels);
    return created;
  });
}

export async function updateModelConfig(input: UpdateModelConfigInput): Promise<ProviderModel> {
  return withWriteLock(async () => {
    const existing = modelsSignal();
    const target = existing.find((m) => m.id === input.id);
    if (!target) {
      throw new Error(t("models.error.modelGone"));
    }
    const channel = channelsSignal().find((ch) => ch.id === target.providerId);
    if (!channel) {
      throw new Error(t("models.error.channelGone"));
    }

    const { updated, nextModels } = applyModelConfigUpdate(
      existing,
      {
        id: input.id,
        presetId: channel.presetId,
        displayNameOverride: input.displayNameOverride ?? null,
        apiTypeOverride: input.apiTypeOverride,
        capabilitiesOverride: input.capabilitiesOverride,
        contextLimit: input.contextLimit,
        maxTokens: input.maxTokens,
      },
      nowIso(),
    );
    await persistModels(nextModels);
    modelsSignal.set(nextModels);
    return updated;
  });
}

export async function deleteModelsBulk(providerId: string, modelIds: string[]): Promise<number> {
  return withWriteLock(async () => {
    const idSet = new Set(modelIds);
    const prev = modelsSignal();
    const nextModels = prev.filter((m) => !(m.providerId === providerId && idSet.has(m.id)));
    const deletedCount = prev.length - nextModels.length;
    await persistModels(nextModels);
    modelsSignal.set(nextModels);
    return deletedCount;
  });
}

export type SavedModelRequestResolution =
  | {
      ok: true;
      modelId: string;
      modelKey: string;
      connection: AiClientInput;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * Resolves the effective protocol route and saved credential for a model UUID
 * when a request runs, enforcing availability, the purpose, and HTTP consent.
 */
export async function resolveSavedModelRequest(
  modelId: string,
  purpose: ModelPurpose = "text",
): Promise<SavedModelRequestResolution> {
  if (errorSignal() !== null) {
    return { ok: false, reason: t("presets.model.reasonCatalogLoadFailed") };
  }

  const model = modelsSignal().find((entry) => entry.id === modelId);
  if (!model) {
    return { ok: false, reason: t("presets.model.reasonDeleted") };
  }
  if (!model.enabled) {
    return { ok: false, reason: t("presets.model.reasonModelDisabled") };
  }
  if (model.syncStatus === "missing") {
    return { ok: false, reason: t("presets.model.reasonMissing") };
  }
  if (!model.modelKey.trim()) {
    return { ok: false, reason: t("presets.model.reasonUnsupported") };
  }
  if (!resolveEffectiveCapabilities(model)[purpose]) {
    return {
      ok: false,
      reason:
        purpose === "image"
          ? t("presets.model.reasonNotImageCapable")
          : t("presets.model.reasonNotTextCapable"),
    };
  }

  const channel = channelsSignal().find((entry) => entry.id === model.providerId);
  if (!channel) {
    return { ok: false, reason: t("presets.model.reasonDeleted") };
  }
  if (!channel.enabled) {
    return { ok: false, reason: t("presets.model.reasonChannelDisabled") };
  }

  const effectiveProtocol = resolveEffectiveApiType(model, channel.adapterId);
  if (!isEffectiveProtocolSupported(channel, model, purpose)) {
    return { ok: false, reason: t("presets.model.reasonUnsupported") };
  }
  let providerDefaultBaseUrl: string | null = null;
  try {
    providerDefaultBaseUrl = aiRegistry.getProvider(channel.presetId).defaultBaseUrl;
  } catch {
    return { ok: false, reason: t("presets.model.reasonUnsupported") };
  }

  const urlCheck = inspectBaseUrl(channel.baseUrl ?? "");
  if (!urlCheck.ok) {
    return { ok: false, reason: urlCheck.error ?? t("models.error.invalidBaseUrl") };
  }
  if (!urlCheck.normalizedBaseUrl && !providerDefaultBaseUrl) {
    return { ok: false, reason: t("models.error.baseUrlRequired") };
  }
  if (urlCheck.isInsecureHttp && channel.insecureHttpConfirmedAt === null) {
    return { ok: false, reason: t("models.error.confirmInsecureRequest") };
  }

  const credential = await readSavedChannelCredential(channel.id);

  return {
    ok: true,
    modelId: model.id,
    modelKey: model.modelKey,
    connection: {
      providerTypeId: channel.presetId,
      protocolId: effectiveProtocol,
      baseUrl: urlCheck.normalizedBaseUrl,
      credential,
    },
  };
}
