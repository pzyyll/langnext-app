// ABOUTME: Frontend model sync workflow through the persisted provider executor.
// ABOUTME: All remote models complete before merge; failures leave existing model rows unchanged.
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import type {
  ProviderInstanceDto,
  ProviderModelDto,
  ProviderRuntimeCatalogEntryDto,
  SyncModelsResult,
  SyncModelsResultCode,
} from "../../storage/types";
import { resolveProviderExecutor } from "../providers/executor";
import { normalizeProviderError } from "../providers/errors";
import { newClientRequestId } from "../translate/newClientRequestId";

export type RemoteModelSyncItem = {
  modelKey: string;
  remoteDisplayName: string | null;
  remoteMetadataJson: unknown | null;
  capabilityOverridesJson?: unknown | null;
};

async function applyProviderModelSync(
  providerInstanceId: string,
  adapterId: string,
  expectedUpdatedAt: string,
  remoteModels: RemoteModelSyncItem[],
): Promise<SyncModelsResult> {
  return runStorage(
    invokeEffect<SyncModelsResult>("apply_provider_model_sync", {
      providerInstanceId,
      adapterId,
      expectedUpdatedAt,
      remoteModels,
    }),
  );
}

async function applyProviderModelSyncFailure(
  providerInstanceId: string,
  expectedUpdatedAt: string,
  errorCode: string,
): Promise<SyncModelsResult> {
  return runStorage(
    invokeEffect<SyncModelsResult>("apply_provider_model_sync_failure", {
      providerInstanceId,
      expectedUpdatedAt,
      errorCode,
    }),
  );
}

/**
 * Sync remote models through the persisted provider executor for ONE selected API type.
 * Legacy providers keep the current frontend pagination loop; runtime providers consume the
 * guest's bounded aggregate list. All pages/models complete before the transactional Rust
 * persistence seam merges; the dedupe/caps/version-race/no-partial-merge semantics live in
 * that seam. A per-interface sync never marks another interface's models missing.
 */
export async function syncProviderModelsFrontend(
  provider: ProviderInstanceDto,
  currentModels: ProviderModelDto[] = [],
  runtimeCatalog: readonly ProviderRuntimeCatalogEntryDto[] = [],
  adapterId?: string,
): Promise<SyncModelsResult> {
  const expectedUpdatedAt = provider.updatedAt;
  const selectedAdapterId = (adapterId?.trim() || provider.adapterId).trim();
  try {
    const executor = resolveProviderExecutor({
      provider,
      modelAdapterId: selectedAdapterId,
      catalog: runtimeCatalog,
    });
    const result = await executor.modelsList({ requestId: newClientRequestId("sync") });
    const seenKeys = new Set<string>();
    const remoteModels: RemoteModelSyncItem[] = [];
    for (const item of result.models) {
      if (seenKeys.has(item.modelKey)) {
        continue;
      }
      seenKeys.add(item.modelKey);
      remoteModels.push({
        modelKey: item.modelKey,
        remoteDisplayName: item.remoteDisplayName ?? null,
        remoteMetadataJson: item.remoteMetadataJson ?? null,
      });
    }
    return await applyProviderModelSync(provider.id, selectedAdapterId, expectedUpdatedAt, remoteModels);
  } catch (error) {
    const normalized = normalizeProviderError(error);
    const code: SyncModelsResultCode =
      normalized.code === "auth" ||
      normalized.code === "rate_limited" ||
      normalized.code === "network" ||
      normalized.code === "timeout" ||
      normalized.code === "server" ||
      normalized.code === "invalid_response" ||
      normalized.code === "credential_unavailable"
        ? normalized.code
        : "invalid_response";
    try {
      return await applyProviderModelSyncFailure(provider.id, expectedUpdatedAt, code);
    } catch {
      return {
        ok: false,
        errorCode: code,
        message: normalized.message,
        models: currentModels,
        provider,
      };
    }
  }
}
