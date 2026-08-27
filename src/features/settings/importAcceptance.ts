// ABOUTME: Pure helpers for post-import Query invalidation keys and re-auth warnings.
// ABOUTME: The route workflow seam owns gating; this module only defines the data.
import {
  integrationKeys,
  modelKeys,
  ocrKeys,
  profileKeys,
  providerKeys,
  settingsKeys,
  speechKeys,
} from "../../query/keys";
import type { ImportPreview } from "../../storage/types";

/** Query prefixes that must refresh after a successful configuration import. */
export const IMPORT_INVALIDATION_KEYS = [
  providerKeys.all,
  modelKeys.all,
  profileKeys.all,
  integrationKeys.all,
  ocrKeys.all,
  speechKeys.all,
  settingsKeys.all,
] as const;

type ImportAuthPreview = Pick<
  ImportPreview,
  "requiresAuthentication" | "integrationRequiresAuthentication" | "proxyRequiresAuthentication"
>;

/** True when imported providers or integration instances need credential re-entry. */
export function importRequiresAuthentication(preview: ImportAuthPreview): boolean {
  const integrationNeedsAuth = (preview.integrationRequiresAuthentication ?? []).length > 0;
  return preview.requiresAuthentication.length > 0 || integrationNeedsAuth || preview.proxyRequiresAuthentication;
}

/**
 * Choose the safe re-auth toast description after import.
 * Prefer the integration-specific copy when only integrations need credentials.
 */
export function importAuthWarningKind(preview: ImportAuthPreview): "none" | "providers" | "integrations" | "mixed" {
  const providersNeedAuth = preview.requiresAuthentication.length > 0 || preview.proxyRequiresAuthentication;
  const integrationsNeedAuth = (preview.integrationRequiresAuthentication ?? []).length > 0;
  if (providersNeedAuth && integrationsNeedAuth) {
    return "mixed";
  }
  if (integrationsNeedAuth) {
    return "integrations";
  }
  if (providersNeedAuth) {
    return "providers";
  }
  return "none";
}
