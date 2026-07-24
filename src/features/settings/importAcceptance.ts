// ABOUTME: Pure helpers for post-import Query invalidation and re-auth warnings.
// ABOUTME: Keeps settings route free of import acceptance branching logic.
import type { QueryClient } from "@tanstack/react-query";
import { integrationKeys, modelKeys, ocrKeys, profileKeys, providerKeys, settingsKeys } from "../../query/keys";
import type { ImportPreview } from "../../storage/types";

/** Query prefixes that must refresh after a successful configuration import. */
export const IMPORT_INVALIDATION_KEYS = [
  providerKeys.all,
  modelKeys.all,
  profileKeys.all,
  integrationKeys.all,
  ocrKeys.all,
  settingsKeys.all,
] as const;

/** Invalidate provider/model/profile/integration/OCR Query prefixes after import. */
export function invalidateAfterConfigurationImport(queryClient: QueryClient): void {
  for (const queryKey of IMPORT_INVALIDATION_KEYS) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** True when imported providers or integration instances need credential re-entry. */
export function importRequiresAuthentication(
  preview: Pick<
    ImportPreview,
    | "requiresAuthentication"
    | "integrationRequiresAuthentication"
    | "ocrRequiresAuthentication"
    | "proxyRequiresAuthentication"
  >,
): boolean {
  const integrationNeedsAuth = (preview.integrationRequiresAuthentication ?? []).length > 0;
  const ocrNeedsAuth = (preview.ocrRequiresAuthentication ?? []).length > 0;
  return (
    preview.requiresAuthentication.length > 0 ||
    integrationNeedsAuth ||
    ocrNeedsAuth ||
    preview.proxyRequiresAuthentication
  );
}

/**
 * Choose the safe re-auth toast description after import.
 * Prefer the integration-specific copy when only integrations need credentials.
 */
export function importAuthWarningKind(
  preview: Pick<
    ImportPreview,
    | "requiresAuthentication"
    | "integrationRequiresAuthentication"
    | "ocrRequiresAuthentication"
    | "proxyRequiresAuthentication"
  >,
): "none" | "providers" | "integrations" | "ocr" | "mixed" {
  const providersNeedAuth = preview.requiresAuthentication.length > 0 || preview.proxyRequiresAuthentication;
  const integrationsNeedAuth = (preview.integrationRequiresAuthentication ?? []).length > 0;
  const ocrNeedsAuth = (preview.ocrRequiresAuthentication ?? []).length > 0;
  const kindCount = [providersNeedAuth, integrationsNeedAuth, ocrNeedsAuth].filter(Boolean).length;
  if (kindCount > 1) {
    return "mixed";
  }
  if (integrationsNeedAuth) {
    return "integrations";
  }
  if (ocrNeedsAuth) {
    return "ocr";
  }
  if (providersNeedAuth) {
    return "providers";
  }
  return "none";
}
