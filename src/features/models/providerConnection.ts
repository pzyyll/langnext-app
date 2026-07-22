// ABOUTME: Frontend connection-test workflow using provider plugins and raw HTTP.
// ABOUTME: Does not persist model rows; preserves bounded error codes and version race guard.
import { newClientRequestId } from "../translate/newClientRequestId";
import { mapHttpStatus, normalizeProviderError } from "../providers/errors";
import { providerFetch } from "../providers/providerFetch";
import { requireProviderPlugin } from "../providers/registry";
import type { ConnectionTestResult, ModelsSyncErrorCode, ProviderInstanceDto } from "../../storage/types";

const MAX_PAGES = 100;
const MAX_TOTAL_MODELS = 2000;

export async function testProviderConnectionFrontend(provider: ProviderInstanceDto): Promise<ConnectionTestResult> {
  const providerUpdatedAt = provider.updatedAt;
  try {
    const plugin = requireProviderPlugin(provider.adapterId);
    let continuation: string | null = null;
    const seenCursors = new Set<string>();
    const seenKeys = new Set<string>();
    let pages = 0;
    let modelCount = 0;

    while (true) {
      pages += 1;
      if (pages > MAX_PAGES) {
        return {
          ok: false,
          errorCode: "invalid_response",
          message: "Too many model list pages",
          modelCount: null,
          providerUpdatedAt,
        };
      }
      if (continuation) {
        if (seenCursors.has(continuation)) {
          return {
            ok: false,
            errorCode: "invalid_response",
            message: "Repeated model list cursor",
            modelCount: null,
            providerUpdatedAt,
          };
        }
        seenCursors.add(continuation);
      }

      const wire = plugin.buildModelListRequest({ continuation });
      const response = await providerFetch({
        requestId: newClientRequestId("conn"),
        providerInstanceId: provider.id,
        wire,
      });
      if (response.status < 200 || response.status >= 300) {
        const code = mapHttpStatus(response.status) as ModelsSyncErrorCode;
        return {
          ok: false,
          errorCode: code,
          message: `Connection failed (${response.status})`,
          modelCount: null,
          providerUpdatedAt,
        };
      }
      const page = plugin.parseModelListPage(response);
      for (const item of page.items) {
        if (seenKeys.has(item.modelKey)) {
          continue;
        }
        seenKeys.add(item.modelKey);
        modelCount += 1;
        if (modelCount > MAX_TOTAL_MODELS) {
          return {
            ok: false,
            errorCode: "invalid_response",
            message: "Too many models",
            modelCount: null,
            providerUpdatedAt,
          };
        }
      }
      if (!page.continuation) {
        break;
      }
      continuation = page.continuation;
    }

    return {
      ok: true,
      errorCode: null,
      message: `Connection OK (${modelCount} models)`,
      modelCount,
      providerUpdatedAt,
    };
  } catch (error) {
    const normalized = normalizeProviderError(error);
    const bounded =
      normalized.code === "auth" ||
      normalized.code === "rate_limited" ||
      normalized.code === "network" ||
      normalized.code === "timeout" ||
      normalized.code === "server" ||
      normalized.code === "invalid_response" ||
      normalized.code === "credential_unavailable"
        ? normalized.code
        : "invalid_response";
    return {
      ok: false,
      errorCode: bounded,
      message: normalized.message,
      modelCount: null,
      providerUpdatedAt,
    };
  }
}
