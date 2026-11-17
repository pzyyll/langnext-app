import { batch, signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { listRemoteModels, testAdapterConnection } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import { inspectBaseUrl } from "./connection";
import type {
  CapabilityFlags,
  CreateManualModelInput,
  ModelsEnabledFilter,
  ProviderChannel,
  ProviderModel,
  SaveChannelDraftInput,
  SyncModelsResult,
  UpdateChannelInput,
  UpdateModelConfigInput,
} from "./types";

export const PROVIDERS_STORAGE_KEY = "models.v2.providers";
export const MODELS_STORAGE_KEY = "models.v2.items";
export const CREDENTIAL_KEY_PREFIX = "models.v2.credentials.";
const FILTER_KEY = "models.enabledFilter";

export function credentialStorageKey(providerId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${providerId}`;
}

export class RevisionConflictError extends Error {
  constructor() {
    super(t("models.error.revisionConflict"));
    this.name = "RevisionConflictError";
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

function defaultCapabilities(): CapabilityFlags {
  return { text: true, image: false, pdf: false, video: false };
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
    console.warn("Could not persist model filter.", error);
  }
}

export async function saveChannelDraft(input: SaveChannelDraftInput): Promise<ProviderChannel> {
  return withWriteLock(async () => {
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error(t("models.error.displayNameRequired"));
    }

    const urlCheck = inspectBaseUrl(input.baseUrl ?? "");
    if (!urlCheck.ok) {
      throw new Error(urlCheck.error ?? t("models.error.invalidBaseUrl"));
    }
    if (urlCheck.isInsecureHttp && !input.allowInsecureHttp) {
      throw new Error(t("models.error.confirmInsecureSave"));
    }

    const existing = channelsSignal();
    const alreadySaved = existing.find((ch) => ch.id === input.id);
    if (alreadySaved) {
      selectedIdSignal.set(alreadySaved.id);
      return alreadySaved;
    }

    const tokenValue = input.credential?.trim() || null;
    const timestamp = nowIso();
    const maxSortOrder = existing.reduce((max, ch) => Math.max(max, ch.sortOrder), -1);

    const created: ProviderChannel = {
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
      modelsLastSyncedAt: null,
      modelsLastSyncError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextChannels = sortChannels([...existing, created]);
    if (tokenValue !== null) {
      await writeSecret(created.id, tokenValue);
    }
    await persistProviders(nextChannels);

    batch(() => {
      channelsSignal.set(nextChannels);
      selectedIdSignal.set(created.id);
    });
    return created;
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

export async function moveChannel(id: string, direction: "up" | "down"): Promise<void> {
  return withWriteLock(async () => {
    const list = sortChannels(channelsSignal());
    const index = list.findIndex((ch) => ch.id === id);
    if (index === -1) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;

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

export async function testChannelConnection(
  providerId: string,
  adapterIdOverride?: AdapterId,
  abortSignal?: AbortSignal,
): Promise<{ modelCount: number }> {
  const channel = channelsSignal().find((ch) => ch.id === providerId);
  if (!channel) {
    throw new Error(t("models.error.channelGone"));
  }

  const urlCheck = inspectBaseUrl(channel.baseUrl ?? "");
  if (!urlCheck.ok) {
    throw new Error(urlCheck.error ?? t("models.error.invalidBaseUrl"));
  }
  if (urlCheck.isInsecureHttp && !channel.insecureHttpConfirmedAt) {
    throw new Error(t("models.error.confirmInsecureTest"));
  }

  const secret = await readSecret(channel.id);
  return testAdapterConnection({
    adapterId: adapterIdOverride ?? channel.adapterId,
    baseUrl: urlCheck.normalizedBaseUrl,
    credential: secret,
    signal: abortSignal,
  });
}

export async function syncChannelModels(
  providerId: string,
  syncAdapterId: AdapterId,
  abortSignal?: AbortSignal,
): Promise<SyncModelsResult> {
  const channel = channelsSignal().find((ch) => ch.id === providerId);
  if (!channel) {
    throw new Error(t("models.error.channelGone"));
  }

  const urlCheck = inspectBaseUrl(channel.baseUrl ?? "");
  if (!urlCheck.ok) {
    throw new Error(urlCheck.error ?? t("models.error.invalidBaseUrl"));
  }
  if (urlCheck.isInsecureHttp && !channel.insecureHttpConfirmedAt) {
    throw new Error(t("models.error.confirmInsecureFetch"));
  }

  const secret = await readSecret(channel.id);

  let discovered;
  try {
    discovered = await listRemoteModels({
      adapterId: syncAdapterId,
      baseUrl: urlCheck.normalizedBaseUrl,
      credential: secret,
      signal: abortSignal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : t("models.error.fetchModels");
    if ((error as { kind?: string } | null)?.kind !== "cancelled") {
      await withWriteLock(async () => {
        const currentChannels = channelsSignal().map((ch) =>
          ch.id === providerId ? { ...ch, modelsLastSyncError: message, updatedAt: nowIso() } : ch,
        );
        await persistProviders(currentChannels);
        channelsSignal.set(currentChannels);
      });
    }
    throw error;
  }

  return withWriteLock(async () => {
    const timestamp = nowIso();
    const allModels = modelsSignal();
    const otherModels = allModels.filter(
      (m) => !(m.providerId === providerId && m.sourceAdapterId === syncAdapterId),
    );
    const targetModels = allModels.filter(
      (m) => m.providerId === providerId && m.sourceAdapterId === syncAdapterId,
    );

    const existingByKey = new Map<string, ProviderModel>();
    for (const model of targetModels) {
      existingByKey.set(model.modelKey, model);
    }

    const seenKeys = new Set<string>();
    const mergedTargetModels: ProviderModel[] = [];
    let addedCount = 0;
    let updatedCount = 0;

    for (const remote of discovered) {
      seenKeys.add(remote.modelKey);
      const prev = existingByKey.get(remote.modelKey);
      if (prev) {
        updatedCount += 1;
        mergedTargetModels.push({
          ...prev,
          displayName: remote.displayName ?? prev.displayName,
          capabilities: remote.capabilities,
          contextLimit: prev.contextLimit ?? remote.contextLimit,
          maxTokens: prev.maxTokens ?? remote.maxTokens,
          syncStatus: "active",
          lastSeenAt: timestamp,
          updatedAt: timestamp,
        });
      } else {
        addedCount += 1;
        mergedTargetModels.push({
          id: crypto.randomUUID(),
          providerId,
          modelKey: remote.modelKey,
          sourceAdapterId: syncAdapterId,
          origin: "remote",
          syncStatus: "active",
          enabled: false,
          displayName: remote.displayName,
          displayNameOverride: null,
          apiTypeOverride: null,
          capabilities: remote.capabilities,
          capabilitiesOverride: null,
          contextLimit: remote.contextLimit,
          maxTokens: remote.maxTokens,
          lastSeenAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }

    let missingCount = 0;
    for (const prev of targetModels) {
      if (seenKeys.has(prev.modelKey)) continue;
      if (prev.origin === "manual") {
        mergedTargetModels.push(prev);
      } else {
        missingCount += 1;
        mergedTargetModels.push({
          ...prev,
          syncStatus: "missing",
          updatedAt: timestamp,
        });
      }
    }

    const nextAllModels = [...otherModels, ...mergedTargetModels];
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

    return {
      discoveredCount: discovered.length,
      addedCount,
      updatedCount,
      missingCount,
    };
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
    const modelKey = input.modelKey.trim();
    if (!modelKey) {
      throw new Error(t("models.error.modelIdRequired"));
    }

    const channel = channelsSignal().find((ch) => ch.id === input.providerId);
    if (!channel) {
      throw new Error(t("models.error.channelGone"));
    }

    const sourceAdapterId = input.apiTypeOverride ?? channel.adapterId;
    const duplicate = modelsSignal().some(
      (m) =>
        m.providerId === input.providerId &&
        m.modelKey === modelKey &&
        m.sourceAdapterId === sourceAdapterId,
    );
    if (duplicate) {
      throw new Error(t("models.error.modelDuplicate", { key: modelKey }));
    }

    const timestamp = nowIso();
    const created: ProviderModel = {
      id: crypto.randomUUID(),
      providerId: input.providerId,
      modelKey,
      sourceAdapterId,
      origin: "manual",
      syncStatus: "active",
      enabled: input.enabled,
      displayName: null,
      displayNameOverride: input.displayNameOverride?.trim() || null,
      apiTypeOverride: input.apiTypeOverride,
      capabilities: defaultCapabilities(),
      capabilitiesOverride: null,
      contextLimit: null,
      maxTokens: null,
      lastSeenAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const nextModels = [...modelsSignal(), created];
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

    const updated: ProviderModel = {
      ...target,
      displayNameOverride: input.displayNameOverride?.trim() || null,
      apiTypeOverride: input.apiTypeOverride,
      capabilitiesOverride: input.capabilitiesOverride,
      contextLimit: input.contextLimit,
      maxTokens: input.maxTokens,
      updatedAt: nowIso(),
    };

    const nextModels = existing.map((m) => (m.id === input.id ? updated : m));
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
