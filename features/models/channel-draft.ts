import { signal } from "nsh";
import { t } from "nsh/i18n";
import type { ProviderTypeId } from "../../modules/ai/contracts/channel";
import type {
  CapabilityOverrides,
  DiscoveredRemoteModel,
  ModelFacts,
  ProviderModel,
  SyncModelsResult,
} from "../../modules/ai/contracts/model";
import type { ProtocolId } from "../../modules/ai/contracts/protocol";
import { aiRegistry } from "../../modules/ai/runtime/registry";
import { isInsecureHttpConfirmed, resolveConfirmedInsecureUrl } from "./connection";
import {
  applyModelConfigUpdate,
  createManualProviderModel,
  mergeDiscoveredCatalog,
} from "./model-collection";
import type { PersistedDraftScopes } from "./types";

export interface AddModelDraftInput {
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: ProtocolId | null;
  enabled: boolean;
  /** Catalog capability and token facts when the model is known to models.dev. */
  facts?: ModelFacts | null;
}

export interface UpdateModelDraftInput {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: ProtocolId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}

/** Page-owned transient state for creating a new provider channel before first save. */
export interface ChannelDraft {
  readonly id: string;
  readonly presetId: ProviderTypeId;
  displayName: () => string;
  setDisplayName: (value: string) => void;
  adapterId: () => ProtocolId;
  setAdapterId: (value: ProtocolId) => void;
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
    sourceAdapterId: ProtocolId,
  ) => SyncModelsResult;
  addManualModel: (input: AddModelDraftInput) => ProviderModel;
  updateModel: (input: UpdateModelDraftInput) => ProviderModel;
  setModelEnabled: (modelId: string, enabled: boolean) => void;
  deleteModels: (modelIds: string[]) => number;
  persistedScopes: () => PersistedDraftScopes;
  hadPersistedCredential: () => boolean;
  markPersistedScopes: (scopes: Partial<PersistedDraftScopes>) => void;
  dispose: () => void;
}

/** Allocates a fresh in-memory channel draft prefilled from the registered provider. */
export function createChannelDraft(presetId: ProviderTypeId): ChannelDraft {
  const provider = aiRegistry.getProvider(presetId);
  const id = crypto.randomUUID();
  let disposed = false;
  let hadCredentialWrite = false;
  const persisted = signal<PersistedDraftScopes>({
    channel: false,
    credential: false,
    models: false,
  });
  const displayName = signal(t(provider.labelKey));
  const adapterId = signal<ProtocolId>(provider.defaultProtocolId);
  const baseUrl = signal(provider.defaultBaseUrl ?? "");
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
          facts: input.facts ?? null,
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
    hadPersistedCredential: () => hadCredentialWrite,
    markPersistedScopes: (scopes) => {
      if (disposed) return;
      if (scopes.credential) {
        hadCredentialWrite = true;
      } else if (scopes.credential === false) {
        hadCredentialWrite = false;
      }
      persisted.set({ ...persisted(), ...scopes });
    },
    dispose: () => {
      disposed = true;
    },
  };
}
