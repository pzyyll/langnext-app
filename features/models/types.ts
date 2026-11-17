import type { CredentialUpdate } from "../../modules/ai/contracts/channel";
import type {
  CapabilityOverrides,
  ModelFacts,
  ProviderModel,
} from "../../modules/ai/contracts/model";
import type { ProviderPresetId } from "../../services/protocols/presets";
import type { AdapterId } from "../../services/protocols/types";

export type {
  ConnectionCredentialInput,
  ConnectionSnapshot,
  CredentialUpdate,
  ProviderChannel,
  ProviderTypeId,
} from "../../modules/ai/contracts/channel";
export type {
  CapabilityFlags,
  CapabilityOverrides,
  ModelFacts,
  ProviderModel,
  ProviderModelOrigin,
  ProviderModelSyncStatus,
  SyncModelsResult,
} from "../../modules/ai/contracts/model";

export type ModelsEnabledFilter = "all" | "enabled" | "disabled";

export interface PersistedDraftScopes {
  channel: boolean;
  credential: boolean;
  models: boolean;
}

export interface SaveChannelDraftInput {
  id: string;
  presetId: ProviderPresetId;
  displayName: string;
  adapterId: AdapterId;
  baseUrl: string | null;
  credential: string | null;
  enabled: boolean;
  allowInsecureHttp: boolean;
  models?: ProviderModel[];
  modelsLastSyncedAt?: string | null;
  modelsLastSyncError?: string | null;
  persistedScopes?: Partial<PersistedDraftScopes>;
  clearStaleCredential?: boolean;
}

export interface UpdateChannelInput {
  id: string;
  expectedRevision: number;
  displayName: string;
  adapterId: AdapterId;
  baseUrl: string | null;
  credentialUpdate: CredentialUpdate;
  enabled: boolean;
  allowInsecureHttp: boolean;
}

export interface CreateManualModelInput {
  providerId: string;
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  enabled: boolean;
  facts?: ModelFacts | null;
}

export interface UpdateModelConfigInput {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}
