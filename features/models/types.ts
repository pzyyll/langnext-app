import type { CredentialUpdate, ProviderTypeId } from "../../modules/ai/contracts/channel";
import type {
  CapabilityOverrides,
  ModelFacts,
  ProviderModel,
} from "../../modules/ai/contracts/model";
import type { ProtocolId } from "../../modules/ai/contracts/protocol";

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
export type { ProtocolId } from "../../modules/ai/contracts/protocol";

export type ModelsEnabledFilter = "all" | "enabled" | "disabled";

export interface PersistedDraftScopes {
  channel: boolean;
  credential: boolean;
  models: boolean;
}

export interface SaveChannelDraftInput {
  id: string;
  presetId: ProviderTypeId;
  displayName: string;
  adapterId: ProtocolId;
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
  adapterId: ProtocolId;
  baseUrl: string | null;
  credentialUpdate: CredentialUpdate;
  enabled: boolean;
  allowInsecureHttp: boolean;
}

export interface CreateManualModelInput {
  providerId: string;
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: ProtocolId | null;
  enabled: boolean;
  facts?: ModelFacts | null;
}

export interface UpdateModelConfigInput {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: ProtocolId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}
