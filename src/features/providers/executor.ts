// ABOUTME: Semantic provider executor contract shared by legacy and runtime adapters.
// ABOUTME: Callers pass model/message/image semantics; wire/SSE/plugin details stay inside adapters.
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import type { ProviderInstanceDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";
import { newClientRequestId } from "../translate/newClientRequestId";
import { DEFAULT_DETECT_MAX_TOKENS } from "./errors";
import { providerFetch, providerFetchStream } from "./providerFetch";
import { requireProviderPlugin } from "./registry";
import { RuntimeProviderExecutor } from "./runtimeExecutor";
import { SseEventDecoder, Utf8StreamDecoder } from "./sse";
import type { StreamParseResult } from "./types";

/** Maximum model-list pages the legacy adapter traverses before failing closed. */
export const LEGACY_MODELS_MAX_PAGES = 100;
/** Maximum aggregate models the legacy adapter collects before failing closed. */
export const LEGACY_MODELS_MAX_TOTAL = 2000;

/** Semantic chat operation; provider protocol details never reach executor callers. */
export type ExecutorChatOperation = "translate" | "detect" | "ocr";

/** Host-owned provider runtime executor kind (matches ProviderRuntimeKindDto). */
export type ExecutorRuntimeKind = "legacy-frontend-provider" | "wasm-component";

/** One complete bounded model descriptor (no provider wire fields). */
export interface ExecutorModelsListItem {
  modelKey: string;
  remoteDisplayName: string | null;
  remoteMetadataJson: unknown | null;
}

/** Complete bounded model set returned by an executor. */
export interface ExecutorModelsListResult {
  models: ExecutorModelsListItem[];
}

/** Semantic chat input: prompts, model key, image bytes, and host-selected options. */
export interface ExecutorChatInput {
  operation: ExecutorChatOperation;
  stream: boolean;
  modelKey: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  thinking: boolean | null;
  imagePngBase64: string | null;
}

/** Bounded unary chat completion. */
export interface ExecutorUnaryChatResult {
  text: string;
}

/** Ordered streaming callbacks: text is user-visible; errors are provider-reported. */
export interface ExecutorStreamHandlers {
  onDelta: (text: string) => void;
  /** Provider-reported stream error (e.g. a Responses `error` event); optional per adapter. */
  onProviderError?: (message: string) => void;
}

/** Capability metadata every executor exposes without leaking plugin manifests. */
export interface ExecutorCapabilities {
  modelListing: boolean;
  streaming: boolean;
  textGeneration: boolean;
  imageInput: boolean;
}

/** Non-2xx provider HTTP status surfaced by an executor; status preserved for workflow retry mapping. */
export class ExecutorHttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message = `Provider HTTP ${status}`) {
    super(message);
    this.name = "ExecutorHttpStatusError";
    this.status = status;
  }
}

/** Malformed or empty provider response with a bounded message. */
export class ExecutorProtocolError extends Error {
  readonly code = "invalid_response" as const;

  constructor(message = "Invalid provider response") {
    super(message);
    this.name = "ExecutorProtocolError";
  }
}

export interface ExecutorModelsListInput {
  requestId?: string;
  signal?: AbortSignal;
}

export interface ExecutorChatContext {
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Semantic provider executor contract: complete Models List, unary Chat, streaming Chat,
 * capability metadata, and best-effort cancellation. Callers pass model/message/image
 * semantics — never `ProviderWireRequest`, SSE events, or `ProviderPlugin` instances.
 */
export interface ProviderExecutor {
  readonly kind: ExecutorRuntimeKind;
  readonly capabilities: ExecutorCapabilities;
  modelsList(input: ExecutorModelsListInput): Promise<ExecutorModelsListResult>;
  chat(input: ExecutorChatInput & ExecutorChatContext): Promise<ExecutorUnaryChatResult>;
  chatStream(input: ExecutorChatInput & ExecutorChatContext, handlers: ExecutorStreamHandlers): Promise<void>;
  /** Best-effort idempotent cancellation by request id. */
  cancel(requestId: string): Promise<void>;
}

/**
 * Active/non-active runtime binding that cannot execute (missing or revoked package or an
 * unavailable interface). Fail-closed before either transport; never replays through legacy.
 */
export class ProviderRuntimeUnavailableError extends Error {
  readonly code = "plugin_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderRuntimeUnavailableError";
  }
}

/** Project executor capability metadata from a sanitized catalog entry. */
function capabilitiesFromCatalogEntry(entry: ProviderRuntimeCatalogEntryDto): ExecutorCapabilities {
  const capabilityIds = new Set(entry.capabilities.map((capability) => capability.capabilityId));
  const chatCapable = capabilityIds.has("llm.chat@1");
  return {
    modelListing: capabilityIds.has("llm.models.list@1"),
    streaming: chatCapable,
    textGeneration: chatCapable,
    imageInput: chatCapable,
  };
}

/** Host-owned language-detection policy selected before any Chat call. */
export interface HostDetectPolicy {
  thinking: boolean | null;
  maxTokens: number;
}

/**
 * Persisted effective API type for one Provider/model pair: the explicit model override
 * wins, then the discovery source interface, then the Provider default API type. Every
 * executor/policy resolver and compatibility check derives from this single rule so a
 * synced model discovered on a non-default interface never falls back to the default type.
 */
export function resolveEffectiveAdapterId(input: {
  modelAdapterId: string | null;
  modelSourceAdapterId: string | null;
  providerAdapterId: string;
}): string {
  return input.modelAdapterId?.trim() || input.modelSourceAdapterId?.trim() || input.providerAdapterId;
}

/**
 * Resolve the host-owned detection policy from provider catalog metadata. Legacy
 * registrations expose the same data through `getDetectPolicy`; signed runtime manifests
 * declare bounded metadata the host validates and projects. The guest receives
 * already-selected Chat options, never workflow-policy authority.
 */
export function resolveHostDetectPolicy(input: {
  provider: Pick<ProviderInstanceDto, "adapterId" | "runtimeBindings">;
  modelAdapterId: string | null;
  /** Discovery provenance of the persisted model; ignored when the override is set. */
  modelSourceAdapterId?: string | null;
  catalogEntry: ProviderRuntimeCatalogEntryDto | null;
  modelKey: string;
  baseUrl: string;
}): HostDetectPolicy {
  const effectiveAdapterId = resolveEffectiveAdapterId({
    modelAdapterId: input.modelAdapterId,
    modelSourceAdapterId: input.modelSourceAdapterId ?? null,
    providerAdapterId: input.provider.adapterId,
  });
  const binding = input.provider.runtimeBindings.find((candidate) => candidate.adapterId === effectiveAdapterId);
  if (binding?.runtimeKind === "wasm-component") {
    const detection = input.catalogEntry?.detection;
    if (detection) {
      return { thinking: detection.thinking, maxTokens: detection.maxTokens };
    }
    return { thinking: null, maxTokens: DEFAULT_DETECT_MAX_TOKENS };
  }
  // Legacy registrations keep sourcing policy from the effective model API Type plugin.
  const pluginId = effectiveAdapterId.trim();
  const plugin = requireProviderPlugin(pluginId);
  return plugin.getDetectPolicy({ modelKey: input.modelKey, baseUrl: input.baseUrl });
}

/**
 * Effective-adapter resolver: selects the persisted executor for one Provider/model pair.
 * A matching active Wasm interface binding selects `RuntimeProviderExecutor`; a Wasm binding
 * that is unavailable/revoked/missing fails closed as `plugin_unavailable`; an unbound API
 * type (including the Provider default and any legacy override) keeps the existing legacy
 * executor with its endpoint/auth compatibility checks. A runtime failure never replays the
 * same request through legacy.
 */
export function resolveProviderExecutor(input: {
  provider: Pick<ProviderInstanceDto, "id" | "adapterId" | "runtimeBindings">;
  modelAdapterId: string | null;
  /** Discovery provenance of the persisted model; ignored when the override is set. */
  modelSourceAdapterId?: string | null;
  /** Persisted model id; required for runtime Chat, ignored for legacy models. */
  modelId?: string | null;
  catalog: readonly ProviderRuntimeCatalogEntryDto[];
}): ProviderExecutor {
  const { provider, modelAdapterId, catalog } = input;
  const effectiveAdapterId = resolveEffectiveAdapterId({
    modelAdapterId,
    modelSourceAdapterId: input.modelSourceAdapterId ?? null,
    providerAdapterId: provider.adapterId,
  });
  const binding = provider.runtimeBindings.find((candidate) => candidate.adapterId === effectiveAdapterId);
  if (binding?.runtimeKind === "wasm-component") {
    if (binding.state !== "active") {
      throw new ProviderRuntimeUnavailableError(
        `provider runtime binding for API type '${effectiveAdapterId}' is not active`,
      );
    }
    const entry = catalog.find((candidate) => candidate.packageDigest === binding.packageDigest);
    if (!entry) {
      throw new ProviderRuntimeUnavailableError("provider runtime package is not in the catalog");
    }
    return new RuntimeProviderExecutor(
      provider.id,
      input.modelId ?? null,
      effectiveAdapterId,
      capabilitiesFromCatalogEntry(entry),
    );
  }
  return new LegacyFrontendProviderExecutor(provider.id, effectiveAdapterId);
}

/**
 * Legacy frontend provider executor: composes the current TypeScript plugin registry,
 * `providerFetch`/`providerFetchStream`, and the SSE decoder. Retains the existing
 * malformed-response/error normalization behavior; every TypeScript `ProviderPlugin`
 * implementation stays unchanged behind this seam.
 */
export class LegacyFrontendProviderExecutor implements ProviderExecutor {
  readonly kind = "legacy-frontend-provider" as const;

  constructor(
    private readonly providerId: string,
    private readonly pluginId: string,
  ) {}

  get capabilities(): ExecutorCapabilities {
    const plugin = requireProviderPlugin(this.pluginId);
    return { ...plugin.manifest.capabilities };
  }

  async modelsList(input: ExecutorModelsListInput = {}): Promise<ExecutorModelsListResult> {
    const plugin = requireProviderPlugin(this.pluginId);
    let continuation: string | null = null;
    const seenCursors = new Set<string>();
    const seenKeys = new Set<string>();
    const models: ExecutorModelsListItem[] = [];
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > LEGACY_MODELS_MAX_PAGES) {
        throw new ExecutorProtocolError("Model list exceeded page limit");
      }
      if (continuation) {
        if (seenCursors.has(continuation)) {
          throw new ExecutorProtocolError("Model list cursor repeated");
        }
        seenCursors.add(continuation);
      }
      const wire = plugin.buildModelListRequest({ continuation });
      const response = await providerFetch({
        requestId: input.requestId ?? newClientRequestId("mll"),
        providerInstanceId: this.providerId,
        wire,
        signal: input.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new ExecutorHttpStatusError(response.status);
      }
      const page = plugin.parseModelListPage(response);
      for (const item of page.items) {
        if (seenKeys.has(item.modelKey)) {
          continue;
        }
        seenKeys.add(item.modelKey);
        models.push({
          modelKey: item.modelKey,
          remoteDisplayName: item.remoteDisplayName ?? null,
          remoteMetadataJson: item.remoteMetadataJson ?? null,
        });
        if (models.length > LEGACY_MODELS_MAX_TOTAL) {
          throw new ExecutorProtocolError("Model list exceeded total model limit");
        }
      }
      if (!page.continuation) {
        break;
      }
      continuation = page.continuation;
    }
    return { models };
  }

  async chat(input: ExecutorChatInput & ExecutorChatContext): Promise<ExecutorUnaryChatResult> {
    const plugin = requireProviderPlugin(this.pluginId);
    const wire = plugin.buildChatRequest({
      operation: input.operation,
      stream: false,
      modelKey: input.modelKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      thinking: input.thinking,
      imagePngBase64: input.imagePngBase64,
    });
    const response = await providerFetch({
      requestId: input.requestId,
      providerInstanceId: this.providerId,
      wire,
      signal: input.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ExecutorHttpStatusError(response.status);
    }
    return { text: plugin.parseChatResponse(response) };
  }

  async chatStream(input: ExecutorChatInput & ExecutorChatContext, handlers: ExecutorStreamHandlers): Promise<void> {
    const plugin = requireProviderPlugin(this.pluginId);
    const wire = plugin.buildChatRequest({
      operation: input.operation,
      stream: true,
      modelKey: input.modelKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      thinking: input.thinking,
      imagePngBase64: input.imagePngBase64,
    });
    const utf8 = new Utf8StreamDecoder();
    const sse = new SseEventDecoder();
    let accumulated = "";
    let httpStatus = 200;
    let providerErrorMessage: string | null = null;

    const applyStreamEvent = (parsed: StreamParseResult): void => {
      if (parsed.kind === "delta") {
        accumulated += parsed.text;
        handlers.onDelta(parsed.text);
        return;
      }
      if (parsed.kind === "error" && providerErrorMessage == null) {
        providerErrorMessage = parsed.message;
      }
    };

    await providerFetchStream(
      {
        requestId: input.requestId,
        providerInstanceId: this.providerId,
        wire,
        signal: input.signal,
      },
      {
        onStarted: (status) => {
          httpStatus = status;
        },
        onChunk: (bytes) => {
          if (httpStatus < 200 || httpStatus >= 300 || providerErrorMessage != null) {
            return;
          }
          const text = utf8.push(bytes);
          const events = sse.push(text);
          for (const event of events) {
            applyStreamEvent(plugin.parseStreamEvent(event));
            if (providerErrorMessage != null) {
              break;
            }
          }
        },
      },
    );
    if (providerErrorMessage == null) {
      const tailText = utf8.finish();
      if (tailText) {
        for (const event of sse.push(tailText)) {
          applyStreamEvent(plugin.parseStreamEvent(event));
          if (providerErrorMessage != null) {
            break;
          }
        }
      }
    }
    if (providerErrorMessage == null) {
      for (const event of sse.finish()) {
        applyStreamEvent(plugin.parseStreamEvent(event));
        if (providerErrorMessage != null) {
          break;
        }
      }
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      throw new ExecutorHttpStatusError(httpStatus);
    }
    if (providerErrorMessage != null) {
      handlers.onProviderError?.(providerErrorMessage);
      return;
    }
    if (!accumulated.trim()) {
      throw new ExecutorProtocolError("Empty stream content");
    }
  }

  async cancel(requestId: string): Promise<void> {
    try {
      await runStorage(invokeEffect<boolean>("cancel_provider_http", { requestId }));
    } catch {
      // Cancellation is best-effort and idempotent.
    }
  }
}
