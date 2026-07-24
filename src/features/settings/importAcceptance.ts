// ABOUTME: Pure helpers for post-import Query invalidation and re-auth warnings.
// ABOUTME: Keeps settings route free of import acceptance branching logic.
import type { QueryClient } from "@tanstack/react-query";
import { integrationKeys, modelKeys, profileKeys, providerKeys } from "../../query/keys";
import type { ImportPreview } from "../../storage/types";

/** Query prefixes that must refresh after a successful configuration import. */
export const IMPORT_INVALIDATION_KEYS = [
  providerKeys.all,
  modelKeys.all,
  profileKeys.all,
  integrationKeys.all,
] as const;

/** Invalidate provider/model/profile/integration Query prefixes after import. */
export function invalidateAfterConfigurationImport(queryClient: QueryClient): void {
  for (const queryKey of IMPORT_INVALIDATION_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** True when imported providers or integration instances need credential re-entry. */
export function importRequiresAuthentication(
  preview: Pick<
    ImportPreview,
    "requiresAuthentication" | "integrationRequiresAuthentication" | "proxyRequiresAuthentication"
  >,
): boolean {
  const integrationNeedsAuth = (preview.integrationRequiresAuthentication ?? []).length > 0;
  return preview.requiresAuthentication.length > 0 || integrationNeedsAuth || preview.proxyRequiresAuthentication;
}

/**
 * Choose the safe re-auth toast description after import.
 * Prefer the integration-specific copy when only integrations need credentials.
 */
export function importAuthWarningKind(
  preview: Pick<
    ImportPreview,
    "requiresAuthentication" | "integrationRequiresAuthentication" | "proxyRequiresAuthentication"
  >,
): "none" | "providers" | "integrations" | "both" {
  const providersNeedAuth = preview.requiresAuthentication.length > 0 || preview.proxyRequiresAuthentication;
  const integrationsNeedAuth = (preview.integrationRequiresAuthentication ?? []).length > 0;
  if (providersNeedAuth && integrationsNeedAuth) {
    return "both";
  }
  if (integrationsNeedAuth) {
    return "integrations";
  }
  if (providersNeedAuth) {
    return "providers";
  }
  return "none";
}
