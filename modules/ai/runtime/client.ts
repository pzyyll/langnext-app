import { t } from "nsh/i18n";
import type { ProviderTypeId } from "../contracts/channel";
import { ProviderProtocolError } from "../contracts/errors";
import type {
  JsonHttpClient,
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  ProtocolId,
  ResolvedRequestTarget,
  RequestOperation,
} from "../contracts/protocol";
import type { ProviderDefinition } from "../contracts/provider";
import type { AiRegistry } from "./registry";

/** The current connection snapshot the host hands to the client. */
export interface AiClientInput {
  providerTypeId: ProviderTypeId;
  protocolId: ProtocolId;
  baseUrl: string | null;
  credential: string | null;
}

export interface AiClientCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AiClientOptions {
  registry: AiRegistry;
  http: JsonHttpClient;
}

export interface AiClient {
  resolveRequestTarget(input: AiClientInput, operation: RequestOperation): ResolvedRequestTarget;
  testConnection(
    input: AiClientInput,
    options?: AiClientCallOptions,
  ): Promise<{ modelCount: number }>;
}

interface ResolvedOperation {
  protocol: ProtocolDefinition;
  connection: ProtocolConnection;
  operation: RequestOperation;
}

function unsupportedProtocol(): ProviderProtocolError {
  return new ProviderProtocolError("invalid_request", t("models.error.unsupportedProtocol"));
}

function normalizedRoot(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

function assertSameOrigin(configuredRoot: string, adjustedRoot: string): void {
  let base: URL;
  let next: URL;
  try {
    base = new URL(configuredRoot);
    next = new URL(adjustedRoot);
  } catch {
    throw new ProviderProtocolError("invalid_request", t("ai.error.providerOriginChanged"));
  }
  if (base.origin !== next.origin) {
    throw new ProviderProtocolError("invalid_request", t("ai.error.providerOriginChanged"));
  }
}

/**
 * Resolves the provider policy before calling a protocol: validate the selected
 * protocol, pick the catalog protocol for discovery, and apply the root policy.
 */
function resolveOperation(
  registry: AiRegistry,
  input: AiClientInput,
  operation: RequestOperation,
): ResolvedOperation {
  const provider: ProviderDefinition = registry.getProvider(input.providerTypeId);
  if (!provider.allowedProtocolIds.includes(input.protocolId)) {
    throw unsupportedProtocol();
  }

  const protocolId =
    operation.kind === "catalog" && provider.catalogProtocolId
      ? provider.catalogProtocolId
      : input.protocolId;
  const protocol = registry.getProtocol(protocolId);

  const root = normalizedRoot(input.baseUrl) ?? normalizedRoot(provider.defaultBaseUrl);
  if (!root) {
    throw new ProviderProtocolError("invalid_request", t("models.error.baseUrlRequired"));
  }

  let baseUrl = root;
  if (provider.resolveBaseUrl) {
    const adjusted = provider.resolveBaseUrl({ baseUrl: root, protocolId, operation });
    assertSameOrigin(root, adjusted);
    baseUrl = normalizedRoot(adjusted) ?? root;
  }

  return {
    protocol,
    connection: {
      baseUrl,
      credential: input.credential?.trim() || null,
    },
    operation,
  };
}

/** Creates an AI client over explicit registries and an HTTP boundary. */
export function createAiClient(options: AiClientOptions): AiClient {
  const { registry, http } = options;

  return {
    resolveRequestTarget(input, operation) {
      const resolved = resolveOperation(registry, input, operation);
      return resolved.protocol.resolveTarget(resolved.connection, resolved.operation);
    },

    async testConnection(input, callOptions = {}) {
      const resolved = resolveOperation(registry, input, { kind: "catalog" });
      const context: ProtocolContext = {
        http,
        signal: callOptions.signal,
        timeoutMs: callOptions.timeoutMs,
      };
      const models = await resolved.protocol.listModels(resolved.connection, context);
      return { modelCount: models.length };
    },
  };
}
