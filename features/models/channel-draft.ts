import { signal } from "nsh";
import {
  getProviderPreset,
  getProviderPresetLabel,
  type ProviderPresetId,
} from "../../services/protocols/presets";
import type { AdapterId, DiscoveredRemoteModel } from "../../services/protocols/types";
import { isInsecureHttpConfirmed, resolveConfirmedInsecureUrl } from "./connection";
import {
  applyModelConfigUpdate,
  createManualProviderModel,
  mergeDiscoveredCatalog,
} from "./model-collection";
import type {
  CapabilityOverrides,
  PersistedDraftScopes,
  ProviderModel,
  SyncModelsResult,
} from "./types";

export interface AddModelDraftInput {
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  enabled: boolean;
}

export interface UpdateModelDraftInput {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}

/** Page-owned transient state for creating a new provider channel before first save. */
export interface ChannelDraft {
  readonly id: string;
  readonly presetId: ProviderPresetId;
  displayName: () => string;
  setDisplayName: (value: string) => void;
  adapterId: () => AdapterId;
  setAdapterId: (value: AdapterId) => void;
  baseUrl: () => string;
  setBaseUrl: (value: string) => void;
  credential: () => string;
  setCredential: (value: string) => void;
  allowInsecureHttp: () => boolean;
  setAllowInsecureHttp: (value: boolean) => void;
  enabled: () => boolean;
  setEnabled: (value: boolean) => void;
  models: () => ProviderModel[];
  modelsLastSyncedAt: () => string | null;
  modelsLastSyncError: () => string | null;
  setSyncError: (message: string | null) => void;
  applyDiscoveredModels: (
    discovered: DiscoveredRemoteModel[],
    sourceAdapterId: AdapterId,
  ) => SyncModelsResult;
  addManualModel: (input: AddModelDraftInput) => ProviderModel;
  updateModel: (input: UpdateModelDraftInput) => ProviderModel;
  setModelEnabled: (modelId: string, enabled: boolean) => void;
  deleteModels: (modelIds: string[]) => number;
  persistedScopes: () => PersistedDraftScopes;
  markPersistedScopes: (scopes: Partial<PersistedDraftScopes>) => void;
  dispose: () => void;
}

/** Allocates a fresh in-memory channel draft prefilled from the chosen preset. */
export function createChannelDraft(presetId: ProviderPresetId): ChannelDraft {
  const preset = getProviderPreset(presetId);
  const id = crypto.randomUUID();
  let disposed = false;
  const persisted = signal<PersistedDraftScopes>({
    channel: false,
    credential: false,
    models: false,
  });
  const displayName = signal(getProviderPresetLabel(presetId));
  const adapterId = signal<AdapterId>(preset.defaultAdapterId);
  const baseUrl = signal(preset.defaultBaseUrl ?? "");
  const credential = signal("");
  const confirmedInsecureUrl = signal<string | null>(null);
  const enabled = signal(true);
  const models = signal<ProviderModel[]>([]);
  const modelsLastSyncedAt = signal<string | null>(null);
  const modelsLastSyncError = signal<string | null>(null);

  return {
    id,
    presetId,
    displayName: () => displayName(),
    setDisplayName: (value) => displayName.set(value),
    adapterId: () => adapterId(),
    setAdapterId: (value) => adapterId.set(value),
    baseUrl: () => baseUrl(),
    setBaseUrl: (value) => {
      baseUrl.set(value);
      if (!isInsecureHttpConfirmed(value, confirmedInsecureUrl())) {
        confirmedInsecureUrl.set(null);
      }
    },
    credential: () => credential(),
    setCredential: (value) => {
      credential.set(value);
      if (persisted().credential) {
        persisted.set({ ...persisted(), credential: false });
      }
    },
    allowInsecureHttp: () => isInsecureHttpConfirmed(baseUrl(), confirmedInsecureUrl()),
    setAllowInsecureHttp: (value) => {
      confirmedInsecureUrl.set(resolveConfirmedInsecureUrl(baseUrl(), value));
    },
    enabled: () => enabled(),
    setEnabled: (value) => enabled.set(value),
    models: () => models(),
    modelsLastSyncedAt: () => modelsLastSyncedAt(),
    modelsLastSyncError: () => modelsLastSyncError(),
    setSyncError: (message) => {
      if (disposed) return;
      modelsLastSyncError.set(message);
    },
    applyDiscoveredModels: (discovered, sourceAdapterId) => {
      if (disposed) {
        return { discoveredCount: 0, addedCount: 0, updatedCount: 0, missingCount: 0 };
      }
      const timestamp = new Date().toISOString();
      const result = mergeDiscoveredCatalog({
        existingChannelModels: models(),
        providerId: id,
        sourceAdapterId,
        discovered,
        timestamp,
      });
      models.set(result.models);
      modelsLastSyncedAt.set(timestamp);
      modelsLastSyncError.set(null);
      return result.summary;
    },
    addManualModel: (input) => {
      const created = createManualProviderModel(
        models(),
        {
          providerId: id,
          presetId,
          defaultAdapterId: adapterId(),
          modelKey: input.modelKey,
          displayNameOverride: input.displayNameOverride,
          apiTypeOverride: input.apiTypeOverride,
          enabled: input.enabled,
        },
        new Date().toISOString(),
      );
      models.set([...models(), created]);
      return created;
    },
    updateModel: (input) => {
      const { updated, nextModels } = applyModelConfigUpdate(
        models(),
        {
          id: input.id,
          presetId,
          displayNameOverride: input.displayNameOverride,
          apiTypeOverride: input.apiTypeOverride,
          capabilitiesOverride: input.capabilitiesOverride,
          contextLimit: input.contextLimit,
          maxTokens: input.maxTokens,
        },
        new Date().toISOString(),
      );
      models.set(nextModels);
      return updated;
    },
    setModelEnabled: (modelId, nextEnabled) => {
      const timestamp = new Date().toISOString();
      models.set(
        models().map((m) =>
          m.id === modelId ? { ...m, enabled: nextEnabled, updatedAt: timestamp } : m,
        ),
      );
    },
    deleteModels: (modelIds) => {
      const idSet = new Set(modelIds);
      const prev = models();
      const next = prev.filter((m) => !idSet.has(m.id));
      models.set(next);
      return prev.length - next.length;
    },
    persistedScopes: () => persisted(),
    markPersistedScopes: (scopes) => {
      if (disposed) return;
      persisted.set({ ...persisted(), ...scopes });
    },
    dispose: () => {
      disposed = true;
    },
  };
}
