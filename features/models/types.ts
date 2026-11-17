import type { ProviderPresetId } from "../../services/protocols/presets";
import type { AdapterId } from "../../services/protocols/types";

export interface CapabilityFlags {
  text: boolean;
  image: boolean;
  pdf: boolean;
  video: boolean;
}

export interface CapabilityOverrides {
  text?: boolean | null;
  image?: boolean | null;
  pdf?: boolean | null;
  video?: boolean | null;
}

export type CredentialUpdate =
  | { mode: "keep" }
  | { mode: "replace"; value: string }
  | { mode: "clear" };

export type ModelsEnabledFilter = "all" | "enabled" | "disabled";

export type ProviderModelOrigin = "remote" | "manual";
export type ProviderModelSyncStatus = "active" | "missing";

/** Persisted provider channel configuration (never holds raw secret tokens). */
export interface ProviderChannel {
  id: string;
  presetId: ProviderPresetId;
  displayName: string;
  adapterId: AdapterId;
  baseUrl: string | null;
  hasCredential: boolean;
  enabled: boolean;
  sortOrder: number;
  revision: number;
  insecureHttpConfirmedAt: string | null;
  modelsLastSyncedAt: string | null;
  modelsLastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Persisted model record under a provider channel. */
export interface ProviderModel {
  id: string;
  providerId: string;
  modelKey: string;
  sourceAdapterId: AdapterId;
  origin: ProviderModelOrigin;
  syncStatus: ProviderModelSyncStatus;
  enabled: boolean;
  displayName: string | null;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilities: CapabilityFlags;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
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
}

export interface UpdateModelConfigInput {
  id: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}

export interface SyncModelsResult {
  discoveredCount: number;
  addedCount: number;
  updatedCount: number;
  missingCount: number;
}
