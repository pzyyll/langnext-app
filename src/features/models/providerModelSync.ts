// ABOUTME: Frontend paginated model sync workflow with transactional persistence IPC.
// ABOUTME: All pages complete before merge; page failures leave existing model rows unchanged.
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import type {
  ProviderInstanceDto,
  ProviderModelDto,
  SyncModelsResult,
  SyncModelsResultCode,
} from "../../storage/types";
import { mapHttpStatus, normalizeProviderError } from "../providers/errors";
import { providerFetch } from "../providers/providerFetch";
import { requireProviderPlugin } from "../providers/registry";
import { newClientRequestId } from "../translate/newClientRequestId";

const MAX_PAGES = 100;
const MAX_TOTAL_MODELS = 2000;

export type RemoteModelSyncItem = {
  modelKey: string;
  remoteDisplayName: string | null;
  remoteMetadataJson: unknown | null;
  capabilityOverridesJson?: unknown | null;
};

async function applyProviderModelSync(
  providerInstanceId: string,
  expectedUpdatedAt: string,
  remoteModels: RemoteModelSyncItem[],
): Promise<SyncModelsResult> {
  return runStorage(
    invokeEffect<SyncModelsResult>("apply_provider_model_sync", {
      providerInstanceId,
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

export async function syncProviderModelsFrontend(
  provider: ProviderInstanceDto,
  currentModels: ProviderModelDto[] = [],
): Promise<SyncModelsResult> {
  const expectedUpdatedAt = provider.updatedAt;
  try {
    const plugin = requireProviderPlugin(provider.adapterId);
    let continuation: string | null = null;
    const seenCursors = new Set<string>();
    const seenKeys = new Set<string>();
    const remoteModels: RemoteModelSyncItem[] = [];
    let pages = 0;

    while (true) {
      pages += 1;
      if (pages > MAX_PAGES) {
        return applyProviderModelSyncFailure(provider.id, expectedUpdatedAt, "invalid_response");
      }
      if (continuation) {
        if (seenCursors.has(continuation)) {
          return applyProviderModelSyncFailure(provider.id, expectedUpdatedAt, "invalid_response");
        }
        seenCursors.add(continuation);
      }

      const wire = plugin.buildModelListRequest({ continuation });
      const response = await providerFetch({
        requestId: newClientRequestId("sync"),
        providerInstanceId: provider.id,
        wire,
      });
      if (response.status < 200 || response.status >= 300) {
        const code = mapHttpStatus(response.status);
        return applyProviderModelSyncFailure(provider.id, expectedUpdatedAt, code);
      }
      const page = plugin.parseModelListPage(response);
      for (const item of page.items) {
        if (seenKeys.has(item.modelKey)) {
          continue;
        }
        seenKeys.add(item.modelKey);
        remoteModels.push({
          modelKey: item.modelKey,
          remoteDisplayName: item.remoteDisplayName ?? null,
          remoteMetadataJson: item.remoteMetadataJson ?? null,
        });
        if (remoteModels.length > MAX_TOTAL_MODELS) {
          return applyProviderModelSyncFailure(provider.id, expectedUpdatedAt, "invalid_response");
        }
      }
      if (!page.continuation) {
        break;
      }
      continuation = page.continuation;
    }

    return await applyProviderModelSync(provider.id, expectedUpdatedAt, remoteModels);
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
