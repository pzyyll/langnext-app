// ABOUTME: Frontend connection-test workflow through the persisted provider executor.
// ABOUTME: Does not persist model rows; preserves bounded error codes and version race guard.
import type { ConnectionTestResult, ProviderInstanceDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";
import { resolveProviderExecutor } from "../providers/executor";
import { normalizeProviderError } from "../providers/errors";
import { newClientRequestId } from "../translate/newClientRequestId";

/**
 * Test one provider's saved connection by enumerating remote models through the persisted
 * executor for ONE selected API type. Legacy providers keep the current frontend pagination
 * loop; runtime providers consume the guest's bounded aggregate list. Never writes model rows.
 */
export async function testProviderConnectionFrontend(
  provider: ProviderInstanceDto,
  runtimeCatalog: readonly ProviderRuntimeCatalogEntryDto[] = [],
  adapterId?: string,
): Promise<ConnectionTestResult> {
  const providerUpdatedAt = provider.updatedAt;
  const selectedAdapterId = (adapterId?.trim() || provider.adapterId).trim();
  try {
    const executor = resolveProviderExecutor({
      provider,
      modelAdapterId: selectedAdapterId,
      catalog: runtimeCatalog,
    });
    const result = await executor.modelsList({ requestId: newClientRequestId("conn") });
    const seenKeys = new Set<string>();
    let modelCount = 0;
    for (const item of result.models) {
      if (seenKeys.has(item.modelKey)) {
        continue;
      }
      seenKeys.add(item.modelKey);
      modelCount += 1;
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
