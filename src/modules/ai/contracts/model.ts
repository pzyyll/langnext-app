import type { ProtocolId } from "./protocol";

/** Capability facts reported for a model. */
export interface CapabilityFlags {
  text: boolean;
  image: boolean;
  pdf: boolean;
  video: boolean;
}

/** Per-model capability overrides; `null` explicitly clears a flag. */
export interface CapabilityOverrides {
  text?: boolean | null;
  image?: boolean | null;
  pdf?: boolean | null;
  video?: boolean | null;
}

/** Capabilities and token limits resolved from the models.dev catalog. */
export interface ModelFacts {
  capabilities: CapabilityFlags;
  contextLimit: number | null;
  maxTokens: number | null;
}

export type ProviderModelOrigin = "remote" | "manual";
export type ProviderModelSyncStatus = "active" | "missing";

/** Persisted model record under a provider channel. */
export interface ProviderModel {
  id: string;
  providerId: string;
  modelKey: string;
  sourceAdapterId: ProtocolId;
  origin: ProviderModelOrigin;
  syncStatus: ProviderModelSyncStatus;
  enabled: boolean;
  displayName: string | null;
  displayNameOverride: string | null;
  apiTypeOverride: ProtocolId | null;
  capabilities: CapabilityFlags;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Raw catalog record returned by a protocol module. Capabilities stay nullable
 * because no listing endpoint reports them; enrichment fills them later.
 */
export interface RemoteModelRecord {
  modelKey: string;
  displayName: string | null;
  contextLimit: number | null;
  maxTokens: number | null;
  capabilities: CapabilityFlags | null;
}

/** Normalized remote model returned by the AI client after metadata enrichment. */
export interface DiscoveredRemoteModel {
  modelKey: string;
  displayName: string | null;
  contextLimit: number | null;
  maxTokens: number | null;
  capabilities: CapabilityFlags;
}

/** Summary of merging a fetched remote catalog into a channel's model collection. */
export interface SyncModelsResult {
  discoveredCount: number;
  addedCount: number;
  updatedCount: number;
  missingCount: number;
}
