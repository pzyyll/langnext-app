// ABOUTME: Tauri runtime provider executor over provider_runtime_* commands and typed Chat events.
// ABOUTME: Runtime failures never fall back to legacy provider HTTP transport.
import { Channel } from "@tauri-apps/api/core";
import { cancelProviderRuntime, listRuntimeProviderModels, runProviderRuntimeChat } from "../../storage/client";
import type { LlmChatPreferencesV1, LlmChatRequest, ProviderRuntimeChatEvent } from "../../storage/types";
import { newClientRequestId } from "../translate/newClientRequestId";
import { attachRequestCancellation } from "./attachRequestCancellation";
import type {
  ExecutorCapabilities,
  ExecutorChatContext,
  ExecutorChatInput,
  ExecutorModelsListInput,
  ExecutorModelsListResult,
  ExecutorStreamHandlers,
  ExecutorUnaryChatResult,
  ProviderExecutor,
} from "./executor";
import { ExecutorProtocolError } from "./executor";

/** Host-selected non-secret provider config; empty until a provider config schema exists. */
const EMPTY_PROVIDER_CONFIG: number[] = [];

/** Decode a base64 PNG payload into a byte array for the host-owned Blob path. */
function pngBase64ToBytes(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return Array.from(bytes);
}

function toLlmChatRequest(input: ExecutorChatInput): LlmChatRequest {
  const preferences: LlmChatPreferencesV1 = {
    stream: input.stream,
    temperature: input.temperature ?? undefined,
    maxTokens: input.maxTokens ?? undefined,
    thinking: input.thinking ?? false,
  };
  return {
    model: input.modelKey,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    images: input.imagePngBase64 ? [pngBase64ToBytes(input.imagePngBase64)] : [],
    preferences,
  };
}

/**
 * Runtime provider executor over the typed Tauri commands/channels from Phase 8 Tasks 1–8.
 * Model enumeration consumes the guest's bounded aggregate list for ONE selected API type;
 * unary/streaming Chat resolves the exact binding server-side from the persisted model id.
 * A runtime error never retries the same request through `LegacyFrontendProviderExecutor`.
 */
export class RuntimeProviderExecutor implements ProviderExecutor {
  readonly kind = "wasm-component" as const;

  constructor(
    private readonly providerId: string,
    private readonly modelId: string | null,
    private readonly adapterId: string,
    private readonly capabilitiesValue: ExecutorCapabilities,
  ) {}

  get capabilities(): ExecutorCapabilities {
    return this.capabilitiesValue;
  }

  async modelsList(input: ExecutorModelsListInput = {}): Promise<ExecutorModelsListResult> {
    const result = await listRuntimeProviderModels(
      this.providerId,
      this.adapterId,
      input.requestId ?? newClientRequestId("mlr"),
    );
    return {
      models: result.models.map((descriptor) => ({
        modelKey: descriptor.id,
        remoteDisplayName: descriptor.label ?? null,
        remoteMetadataJson: null,
      })),
    };
  }

  async chat(input: ExecutorChatInput & ExecutorChatContext): Promise<ExecutorUnaryChatResult> {
    const detach = attachRequestCancellation(input.requestId, input.signal, cancelProviderRuntime);
    try {
      if (input.signal?.aborted) {
        throw new Error("request cancelled");
      }
      const complete = await runProviderRuntimeChat({
        requestId: input.requestId,
        providerModelId: this.requireModelId(),
        config: EMPTY_PROVIDER_CONFIG,
        request: toLlmChatRequest({ ...input, stream: false }),
      });
      if (complete == null) {
        throw new ExecutorProtocolError("unexpected streaming result under a non-stream preference");
      }
      return { text: complete.content };
    } finally {
      detach();
    }
  }

  async chatStream(input: ExecutorChatInput & ExecutorChatContext, handlers: ExecutorStreamHandlers): Promise<void> {
    const channel = new Channel<ProviderRuntimeChatEvent>();
    channel.onmessage = (event) => {
      if (event.event === "text") {
        handlers.onDelta(event.text);
      }
      // Reasoning/tool/complete frames remain typed inside the host bridge; only text is
      // user-visible and none of it is reparsed as opaque bytes.
    };
    const detach = attachRequestCancellation(input.requestId, input.signal, cancelProviderRuntime);
    try {
      if (input.signal?.aborted) {
        throw new Error("request cancelled");
      }
      const complete = await runProviderRuntimeChat(
        {
          requestId: input.requestId,
          providerModelId: this.requireModelId(),
          config: EMPTY_PROVIDER_CONFIG,
          request: toLlmChatRequest({ ...input, stream: true }),
        },
        channel,
      );
      if (complete != null) {
        throw new ExecutorProtocolError("unexpected complete result under a streaming preference");
      }
    } finally {
      detach();
    }
  }

  /** Runtime Chat resolves the exact binding from the persisted model; never a package digest. */
  private requireModelId(): string {
    if (!this.modelId) {
      throw new Error("runtime chat requires a persisted model id");
    }
    return this.modelId;
  }

  async cancel(requestId: string): Promise<void> {
    try {
      await cancelProviderRuntime(requestId);
    } catch {
      // Cancellation is best-effort and idempotent.
    }
  }
}
