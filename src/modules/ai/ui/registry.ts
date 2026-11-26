import { t } from "nsh/i18n";
import { getContributionRegistry } from "../../../framework/contributions/registry";
import type { ProviderTypeId } from "../contracts/channel";
import { ProviderProtocolError } from "../contracts/errors";
import type { AiRegistry } from "../runtime/registry";
import type { ProviderPresentation } from "./contracts";

/** Presentation registry: one settings view and mark per registered provider. */
export interface ProviderSettingsRegistry {
  register(presentation: ProviderPresentation): void;
  get(providerTypeId: ProviderTypeId): ProviderPresentation;
  /** Returns `null` instead of throwing, for stored records this build cannot render. */
  find(providerTypeId: ProviderTypeId): ProviderPresentation | null;
  list(): ProviderPresentation[];
}

function invalidRequest(message: string): ProviderProtocolError {
  return new ProviderProtocolError("invalid_request", message);
}

/** Creates a presentation registry over a runtime registry; built-ins stay outside. */
export function createProviderSettingsRegistry(
  runtimeRegistry: AiRegistry,
): ProviderSettingsRegistry {
  const presentations = new Map<ProviderTypeId, ProviderPresentation>();

  function register(presentation: ProviderPresentation): void {
    const providerTypeId = presentation.providerTypeId;
    if (typeof providerTypeId !== "string" || providerTypeId.trim().length === 0) {
      throw invalidRequest(t("ai.error.unknownProvider", { id: String(providerTypeId) }));
    }
    if (presentations.has(providerTypeId)) {
      throw invalidRequest(t("ai.error.duplicateModule", { id: providerTypeId }));
    }
    // A presentation must reference a provider this runtime already knows.
    runtimeRegistry.getProvider(providerTypeId);
    presentations.set(providerTypeId, presentation);
  }

  function get(providerTypeId: ProviderTypeId): ProviderPresentation {
    const found = presentations.get(providerTypeId);
    if (!found) {
      throw invalidRequest(t("ai.error.unknownPresentation", { id: providerTypeId }));
    }
    return found;
  }

  return {
    register,
    get,
    find: (providerTypeId) => presentations.get(providerTypeId) ?? null,
    list: () => Array.from(presentations.values()),
  };
}

/**
 * The production presentation registry. It is a thin view over the shared
 * contribution registry, so presentations live beside the other axes.
 */
export const providerSettingsRegistry: ProviderSettingsRegistry = {
  register: (presentation) => {
    const registry = getContributionRegistry();
    const providerTypeId = presentation.providerTypeId;
    if (typeof providerTypeId !== "string" || providerTypeId.trim().length === 0) {
      throw invalidRequest(t("ai.error.unknownProvider", { id: String(providerTypeId) }));
    }
    if (registry.find("provider-presentation", providerTypeId) !== null) {
      throw invalidRequest(t("ai.error.duplicateModule", { id: providerTypeId }));
    }
    // A presentation must reference a provider this runtime already knows.
    if (registry.find("provider", providerTypeId) === null) {
      throw invalidRequest(t("ai.error.unknownProvider", { id: providerTypeId }));
    }
    registry.registerPresentation(presentation);
  },
  get: (providerTypeId) => {
    const found = getContributionRegistry().find("provider-presentation", providerTypeId);
    if (found === null)
      throw invalidRequest(t("ai.error.unknownPresentation", { id: providerTypeId }));
    return found;
  },
  find: (providerTypeId) => getContributionRegistry().find("provider-presentation", providerTypeId),
  list: () => getContributionRegistry().list("provider-presentation"),
};
