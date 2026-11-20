import { t } from "nsh/i18n";
import { loadCatalog, type CatalogIndex } from "../../../services/models-dev/catalog";
import type { ProviderTypeId } from "../contracts/channel";
import { ProviderProtocolError } from "../contracts/errors";
import type { DiscoveredRemoteModel, ModelFacts } from "../contracts/model";
import type {
  ImageTextGenerationRequest,
  JsonHttpClient,
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  ProtocolId,
  ResolvedRequestTarget,
  RequestOperation,
  TextGenerationRequest,
} from "../contracts/protocol";
import type { ProviderDefinition } from "../contracts/provider";
import { jsonHttp } from "./http";
import { enrichDiscoveredModels, lookupModelFacts } from "./model-metadata";
import { aiRegistry, type AiRegistry } from "./registry";

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

/** Streaming call options; `onText` receives the complete text generated so far. */
export interface AiClientStreamOptions extends AiClientCallOptions {
  onText: (text: string) => void;
}

export interface AiClientOptions {
  registry: AiRegistry;
  http: JsonHttpClient;
  /** Best-effort models.dev boundary; injected in isolated tests. */
  loadCatalog?: () => Promise<CatalogIndex | null>;
}

export interface AiClient {
  resolveRequestTarget(input: AiClientInput, operation: RequestOperation): ResolvedRequestTarget;
  testConnection(
    input: AiClientInput,
    options?: AiClientCallOptions,
  ): Promise<{ modelCount: number }>;
  discoverModels(
    input: AiClientInput,
    options?: AiClientCallOptions,
  ): Promise<DiscoveredRemoteModel[]>;
  resolveModelFacts(input: {
    providerTypeId: ProviderTypeId;
    modelKey: string;
  }): Promise<ModelFacts | null>;
  generateText(
    input: AiClientInput,
    request: TextGenerationRequest,
    options?: AiClientCallOptions,
  ): Promise<string>;
  /**
   * Sends one buffered image and resolves with the answer text. A protocol that cannot read
   * images is rejected before any request.
   */
  generateTextFromImage(
    input: AiClientInput,
    request: ImageTextGenerationRequest,
    options?: AiClientCallOptions,
  ): Promise<string>;
  /** Streams one generation, reports progress through `options.onText`, and resolves with the full text. */
  streamText(
    input: AiClientInput,
    request: TextGenerationRequest,
    options: AiClientStreamOptions,
  ): Promise<string>;
}

interface ResolvedOperation {
  provider: ProviderDefinition;
  protocol: ProtocolDefinition;
  connection: ProtocolConnection;
  operation: RequestOperation;
}

function unsupportedProtocol(): ProviderProtocolError {
  return new ProviderProtocolError("invalid_request", t("models.error.unsupportedProtocol"));
}

function cancelledError(): ProviderProtocolError {
  return new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
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
    provider,
    protocol,
    connection: {
      baseUrl,
      credential: input.credential?.trim() || null,
    },
    operation,
  };
}

/**
 * Runs one generation. When the provider rejects the reasoning hint with a bad-request status
 * before any text arrived, it retries once without the hint, so unsupported models still work.
 */
async function runWithReasoningFallback(
  request: TextGenerationRequest,
  run: (request: TextGenerationRequest) => Promise<string>,
  delivered: () => boolean,
): Promise<string> {
  try {
    return await run(request);
  } catch (error) {
    const retryable =
      request.disableReasoning === true &&
      error instanceof ProviderProtocolError &&
      error.kind === "invalid_request" &&
      !delivered();
    if (!retryable) throw error;
    return run({ ...request, disableReasoning: false });
  }
}

/** Creates an AI client over explicit registries and an HTTP boundary. */
export function createAiClient(options: AiClientOptions): AiClient {
  const { registry, http } = options;

  function callContext(callOptions: AiClientCallOptions): ProtocolContext {
    return {
      http,
      signal: callOptions.signal,
      timeoutMs: callOptions.timeoutMs,
    };
  }

  async function loadCatalogSafely(): Promise<CatalogIndex | null> {
    if (!options.loadCatalog) return null;
    try {
      return await options.loadCatalog();
    } catch {
      return null;
    }
  }

  return {
    resolveRequestTarget(input, operation) {
      const resolved = resolveOperation(registry, input, operation);
      return resolved.protocol.resolveTarget(resolved.connection, resolved.operation);
    },

    async testConnection(input, callOptions = {}) {
      const resolved = resolveOperation(registry, input, { kind: "catalog" });
      const models = await resolved.protocol.listModels(
        resolved.connection,
        callContext(callOptions),
      );
      return { modelCount: models.length };
    },

    async discoverModels(input, callOptions = {}) {
      const resolved = resolveOperation(registry, input, { kind: "catalog" });
      // Start the catalog lookup and the listing together so neither waits.
      const catalogPromise = loadCatalogSafely();
      const records = await resolved.protocol.listModels(
        resolved.connection,
        callContext(callOptions),
      );
      if (callOptions.signal?.aborted) throw cancelledError();
      const index = await catalogPromise;
      if (callOptions.signal?.aborted) throw cancelledError();
      return enrichDiscoveredModels(records, index, resolved.provider.catalogProviderId);
    },

    async resolveModelFacts(input) {
      const provider = registry.getProvider(input.providerTypeId);
      const index = await loadCatalogSafely();
      return lookupModelFacts(index, input.modelKey, provider.catalogProviderId);
    },

    async generateText(input, request, callOptions = {}) {
      const resolved = resolveOperation(registry, input, {
        kind: "model",
        modelId: request.modelId,
      });
      if (!resolved.protocol.generateText) {
        throw unsupportedProtocol();
      }
      return runWithReasoningFallback(
        request,
        (next) =>
          resolved.protocol.generateText!(resolved.connection, next, callContext(callOptions)),
        () => false,
      );
    },

    async generateTextFromImage(input, request, callOptions = {}) {
      const resolved = resolveOperation(registry, input, {
        kind: "model",
        modelId: request.modelId,
      });
      if (!resolved.protocol.generateTextFromImage) {
        throw unsupportedProtocol();
      }
      return resolved.protocol.generateTextFromImage(
        resolved.connection,
        request,
        callContext(callOptions),
      );
    },

    async streamText(input, request, callOptions) {      const resolved = resolveOperation(registry, input, {
        kind: "model",
        modelId: request.modelId,
      });
      if (!resolved.protocol.streamText) {
        throw unsupportedProtocol();
      }
      let delivered = false;
      return runWithReasoningFallback(
        request,
        (next) =>
          resolved.protocol.streamText!(resolved.connection, next, {
            ...callContext(callOptions),
            onText: (text) => {
              delivered = true;
              callOptions.onText(text);
            },
          }),
        () => delivered,
      );
    },
  };
}

/** The production client: built-in registry, real HTTP, and the models.dev catalog. */
export const aiClient = createAiClient({
  registry: aiRegistry,
  http: jsonHttp,
  loadCatalog,
});
