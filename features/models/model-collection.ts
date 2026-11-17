import { t } from "nsh/i18n";
import {
  isProtocolAllowedForPreset,
  type ProviderPresetId,
} from "../../services/protocols/presets";
import type { AdapterId, DiscoveredRemoteModel } from "../../services/protocols/types";
import type {
  CapabilityFlags,
  CapabilityOverrides,
  ModelFacts,
  ProviderModel,
  SyncModelsResult,
} from "./types";

function defaultCapabilities(): CapabilityFlags {
  return { text: true, image: false, pdf: false, video: false };
}

export interface AddChannelModelInput {
  providerId: string;
  presetId: ProviderPresetId;
  defaultAdapterId: AdapterId;
  modelKey: string;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  enabled: boolean;
  /** Catalog capability and token facts when the model is known to models.dev. */
  facts?: ModelFacts | null;
}

export interface UpdateChannelModelInput {
  id: string;
  presetId: ProviderPresetId;
  displayNameOverride: string | null;
  apiTypeOverride: AdapterId | null;
  capabilitiesOverride: CapabilityOverrides | null;
  contextLimit: number | null;
  maxTokens: number | null;
}

/** Creates a manual model entry enforcing channel-wide `providerId + modelKey` uniqueness. */
export function createManualProviderModel(
  existingChannelModels: readonly ProviderModel[],
  input: AddChannelModelInput,
  timestamp: string,
): ProviderModel {
  const modelKey = input.modelKey.trim();
  if (!modelKey) {
    throw new Error(t("models.error.modelIdRequired"));
  }
  if (
    input.apiTypeOverride !== null &&
    !isProtocolAllowedForPreset(input.presetId, input.apiTypeOverride)
  ) {
    throw new Error(t("models.error.unsupportedProtocol"));
  }
  if (existingChannelModels.some((m) => m.modelKey === modelKey)) {
    throw new Error(t("models.error.modelDuplicate", { key: modelKey }));
  }

  return {
    id: crypto.randomUUID(),
    providerId: input.providerId,
    modelKey,
    sourceAdapterId: input.apiTypeOverride ?? input.defaultAdapterId,
    origin: "manual",
    syncStatus: "active",
    enabled: input.enabled,
    displayName: null,
    displayNameOverride: input.displayNameOverride?.trim() || null,
    apiTypeOverride: input.apiTypeOverride,
    capabilities: input.facts?.capabilities ?? defaultCapabilities(),
    capabilitiesOverride: null,
    contextLimit: input.facts?.contextLimit ?? null,
    maxTokens: input.facts?.maxTokens ?? null,
    lastSeenAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Applies user configuration edits to an existing channel model record. */
export function applyModelConfigUpdate(
  models: readonly ProviderModel[],
  input: UpdateChannelModelInput,
  timestamp: string,
): { updated: ProviderModel; nextModels: ProviderModel[] } {
  const target = models.find((m) => m.id === input.id);
  if (!target) {
    throw new Error(t("models.error.modelGone"));
  }
  if (
    input.apiTypeOverride !== null &&
    !isProtocolAllowedForPreset(input.presetId, input.apiTypeOverride)
  ) {
    throw new Error(t("models.error.unsupportedProtocol"));
  }

  const updated: ProviderModel = {
    ...target,
    displayNameOverride: input.displayNameOverride?.trim() || null,
    apiTypeOverride: input.apiTypeOverride,
    capabilitiesOverride: input.capabilitiesOverride,
    contextLimit: input.contextLimit,
    maxTokens: input.maxTokens,
    updatedAt: timestamp,
  };

  return {
    updated,
    nextModels: models.map((m) => (m.id === input.id ? updated : m)),
  };
}

/**
 * Merges a fetched remote catalog into a channel's models keyed solely by
 * `channelId + modelKey`, preserving user configuration and local identity.
 */
export function mergeDiscoveredCatalog(params: {
  existingChannelModels: readonly ProviderModel[];
  providerId: string;
  sourceAdapterId: AdapterId;
  discovered: readonly DiscoveredRemoteModel[];
  timestamp: string;
}): { models: ProviderModel[]; summary: SyncModelsResult } {
  const { existingChannelModels, providerId, sourceAdapterId, discovered, timestamp } = params;
  const existingByKey = new Map<string, ProviderModel>();
  for (const model of existingChannelModels) {
    if (!existingByKey.has(model.modelKey)) {
      existingByKey.set(model.modelKey, model);
    }
  }

  const seenKeys = new Set<string>();
  const merged: ProviderModel[] = [];
  let addedCount = 0;
  let updatedCount = 0;

  for (const remote of discovered) {
    if (seenKeys.has(remote.modelKey)) continue;
    seenKeys.add(remote.modelKey);

    const prev = existingByKey.get(remote.modelKey);
    if (prev) {
      updatedCount += 1;
      merged.push({
        ...prev,
        sourceAdapterId,
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
      merged.push({
        id: crypto.randomUUID(),
        providerId,
        modelKey: remote.modelKey,
        sourceAdapterId,
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
  for (const prev of existingChannelModels) {
    if (seenKeys.has(prev.modelKey)) continue;
    if (prev.origin === "manual") {
      merged.push(prev);
    } else {
      missingCount += 1;
      merged.push({
        ...prev,
        syncStatus: "missing",
        updatedAt: timestamp,
      });
    }
  }

  return {
    models: merged,
    summary: {
      discoveredCount: discovered.length,
      addedCount,
      updatedCount,
      missingCount,
    },
  };
}
