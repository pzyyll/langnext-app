// ABOUTME: Semantic provider executor contract shared by runtime adapters.
// ABOUTME: Callers pass model/message/image semantics; wire/SSE/plugin details stay in packages.
import { RuntimeProviderExecutor } from "./runtimeExecutor";
import type { ProviderInstanceDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";
import { DEFAULT_DETECT_MAX_TOKENS } from "./errors";

/** Semantic chat operation; provider protocol details never reach executor callers. */
export type ExecutorChatOperation = "translate" | "detect" | "ocr";

/** Host-owned provider runtime executor kind (matches ProviderRuntimeKindDto). */
export type ExecutorRuntimeKind = "wasm-component";

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
  /** Provider-reported stream error (e.g. a Responses `error` event); optional per package. */
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
 * semantics — never provider wire requests, SSE events, or plugin instances.
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
 * Missing/inactive provider runtime binding that cannot execute (package absent, revoked, or
 * not yet active). Fail-closed before any transport; there is no legacy executor to replay.
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
 * executor/policy resolver derives from this single rule so a synced model discovered on a
 * non-default interface never falls back to the default type.
 */
export function resolveEffectiveAdapterId(input: {
  modelAdapterId: string | null;
  modelSourceAdapterId: string | null;
  providerAdapterId: string;
}): string {
  return input.modelAdapterId?.trim() || input.modelSourceAdapterId?.trim() || input.providerAdapterId;
}

/**
 * Resolve the host-owned detection policy from provider catalog metadata. Signed runtime
 * manifests declare bounded metadata the host validates and projects; the guest receives
 * already-selected Chat options, never workflow-policy authority. Without an active Wasm
 * binding, the host applies the bounded default policy; there is no legacy plugin policy.
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
  }
  return { thinking: null, maxTokens: DEFAULT_DETECT_MAX_TOKENS };
}

/**
 * Effective-adapter resolver: selects the persisted executor for one Provider/model pair.
 * A matching active Wasm interface binding selects `RuntimeProviderExecutor`; a Wasm binding
 * that is unavailable/revoked/missing fails closed as `plugin_unavailable`. No legacy
 * frontend executor exists, so an unbound API type is never silently executed.
 */
export function resolveProviderExecutor(input: {
  provider: Pick<ProviderInstanceDto, "id" | "adapterId" | "runtimeBindings">;
  modelAdapterId: string | null;
  /** Discovery provenance of the persisted model; ignored when the override is set. */
  modelSourceAdapterId?: string | null;
  /** Persisted model id; required for runtime Chat. */
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
  if (binding?.runtimeKind !== "wasm-component") {
    throw new ProviderRuntimeUnavailableError(
      `provider runtime binding for API type '${effectiveAdapterId}' does not exist; install and authorize a package`,
    );
  }
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
