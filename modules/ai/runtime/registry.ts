import { t } from "nsh/i18n";
import type { ProviderTypeId } from "../contracts/channel";
import { ProviderProtocolError } from "../contracts/errors";
import type { ProtocolDefinition, ProtocolId } from "../contracts/protocol";
import type { ProviderDefinition } from "../contracts/provider";

/** Explicit module lookup and validation over registered AI contributions. */
export interface AiRegistry {
  registerProtocol(definition: ProtocolDefinition): void;
  registerProvider(definition: ProviderDefinition): void;
  getProtocol(id: ProtocolId): ProtocolDefinition;
  getProvider(id: ProviderTypeId): ProviderDefinition;
  listProtocols(): ProtocolDefinition[];
  listProviders(): ProviderDefinition[];
  isProtocolAllowed(providerTypeId: ProviderTypeId, protocolId: ProtocolId): boolean;
}

function invalidRequest(message: string): ProviderProtocolError {
  return new ProviderProtocolError("invalid_request", message);
}

function isBlankId(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Creates an isolated registry. Callers register contributions explicitly;
 * factories never import or register built-in modules themselves.
 */
export function createAiRegistry(): AiRegistry {
  const protocols = new Map<ProtocolId, ProtocolDefinition>();
  const providers = new Map<ProviderTypeId, ProviderDefinition>();

  function getProtocol(id: ProtocolId): ProtocolDefinition {
    const found = protocols.get(id);
    if (!found) {
      throw invalidRequest(t("ai.error.unknownProtocol", { id }));
    }
    return found;
  }

  function getProvider(id: ProviderTypeId): ProviderDefinition {
    const found = providers.get(id);
    if (!found) {
      throw invalidRequest(t("ai.error.unknownProvider", { id }));
    }
    return found;
  }

  function registerProtocol(definition: ProtocolDefinition): void {
    const id = definition.id;
    if (isBlankId(id)) {
      throw invalidRequest(t("ai.error.unknownProtocol", { id: String(id) }));
    }
    if (protocols.has(id)) {
      throw invalidRequest(t("ai.error.duplicateModule", { id }));
    }
    protocols.set(id, definition);
  }

  function invalidProvider(id: ProviderTypeId): ProviderProtocolError {
    return invalidRequest(t("ai.error.invalidProvider", { id }));
  }

  function registerProvider(definition: ProviderDefinition): void {
    const id = definition.id;
    if (isBlankId(id)) {
      throw invalidProvider(String(id));
    }
    if (providers.has(id)) {
      throw invalidRequest(t("ai.error.duplicateModule", { id }));
    }

    const allowed = definition.allowedProtocolIds;
    if (!Array.isArray(allowed) || allowed.length === 0) {
      throw invalidProvider(id);
    }
    for (const protocolId of allowed) {
      if (!protocols.has(protocolId)) {
        throw invalidRequest(t("ai.error.unknownProtocol", { id: protocolId }));
      }
    }
    if (!allowed.includes(definition.defaultProtocolId)) {
      throw invalidProvider(id);
    }
    const catalogProtocolId = definition.catalogProtocolId;
    if (catalogProtocolId != null && !protocols.has(catalogProtocolId)) {
      throw invalidRequest(t("ai.error.unknownProtocol", { id: catalogProtocolId }));
    }

    providers.set(id, definition);
  }

  function isProtocolAllowed(providerTypeId: ProviderTypeId, protocolId: ProtocolId): boolean {
    return getProvider(providerTypeId).allowedProtocolIds.includes(protocolId);
  }

  return {
    registerProtocol,
    registerProvider,
    getProtocol,
    getProvider,
    listProtocols: () => Array.from(protocols.values()),
    listProviders: () => Array.from(providers.values()),
    isProtocolAllowed,
  };
}

/** The production runtime registry. `app/ai-setup.ts` is its only assembly entry. */
export const aiRegistry = createAiRegistry();
