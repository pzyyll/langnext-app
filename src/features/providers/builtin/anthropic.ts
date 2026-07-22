// ABOUTME: Anthropic Messages API provider plugin.
// ABOUTME: Owns non-secret version header, models pagination, and stream deltas.
import type { AuthSchemeV1, CredentialKind } from "../../../storage/types";
import { DEFAULT_DETECT_MAX_TOKENS } from "../errors";
import type {
  ChatBuildInput,
  DetectPolicy,
  DetectPolicyInput,
  ModelListBuildInput,
  ProviderHttpResponse,
  ProviderPlugin,
  ProviderPluginManifest,
  ProviderWireRequest,
  SseEvent,
  StreamParseResult,
} from "../types";
import { ProviderProtocolError } from "../types";
import { normalizeModelKey } from "./openaiShared";

const MAX_MODELS_PER_PAGE = 500;
const DEFAULT_MAX_TOKENS = 32768;
const ANTHROPIC_VERSION = "2023-06-01";

const MANIFEST: ProviderPluginManifest = {
  id: "anthropic",
  label: "Anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  supportedCredentialKinds: ["api_key", "bearer"],
  capabilities: {
    modelListing: true,
    streaming: true,
    textGeneration: true,
    imageInput: true,
  },
};

function anthropicUserContent(userPrompt: string, imagePngBase64: string | null): unknown {
  if (imagePngBase64) {
    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imagePngBase64,
        },
      },
      { type: "text", text: userPrompt },
    ];
  }
  return userPrompt;
}

export const anthropicPlugin: ProviderPlugin = {
  manifest: MANIFEST,

  resolveAuthScheme(credentialKind: CredentialKind): AuthSchemeV1 {
    void credentialKind;
    return { schemaVersion: 1, type: "header", name: "x-api-key" };
  },

  buildModelListRequest(input: ModelListBuildInput): ProviderWireRequest {
    const query: [string, string][] = [];
    if (input.continuation) {
      query.push(["after_id", input.continuation]);
    }
    return {
      method: "GET",
      relativePath: "v1/models",
      query,
      headers: { "anthropic-version": ANTHROPIC_VERSION },
      body: null,
    };
  },

  parseModelListPage(response: ProviderHttpResponse) {
    let value: unknown;
    try {
      value = JSON.parse(response.body) as unknown;
    } catch {
      throw new ProviderProtocolError("anthropic model list is not JSON");
    }
    if (!value || typeof value !== "object") {
      throw new ProviderProtocolError("invalid anthropic model list");
    }
    const data = (value as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new ProviderProtocolError("anthropic model list missing data");
    }
    if (data.length > MAX_MODELS_PER_PAGE) {
      throw new ProviderProtocolError("anthropic model list page too large");
    }
    const items = data.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new ProviderProtocolError("invalid anthropic model entry");
      }
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string") {
        throw new ProviderProtocolError("anthropic model missing id");
      }
      const displayName = (entry as { display_name?: unknown }).display_name;
      return {
        modelKey: normalizeModelKey(id),
        remoteDisplayName: typeof displayName === "string" ? displayName : null,
        remoteMetadataJson: null,
      };
    });
    const hasMore = (value as { has_more?: unknown }).has_more;
    if (typeof hasMore !== "boolean") {
      throw new ProviderProtocolError("anthropic model list missing has_more");
    }
    const lastIdRaw = (value as { last_id?: unknown }).last_id;
    let continuation: string | null = null;
    if (hasMore) {
      if (typeof lastIdRaw !== "string" || !lastIdRaw) {
        throw new ProviderProtocolError("anthropic continuation missing last_id");
      }
      continuation = lastIdRaw;
    }
    return { items, continuation };
  },

  buildChatRequest(input: ChatBuildInput): ProviderWireRequest {
    const payload: Record<string, unknown> = {
      model: input.modelKey,
      system: input.systemPrompt,
      messages: [
        {
          role: "user",
          content: anthropicUserContent(input.userPrompt, input.imagePngBase64),
        },
      ],
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (input.stream) {
      payload.stream = true;
    }
    if (input.temperature != null) {
      payload.temperature = input.temperature;
    }
    return {
      method: "POST",
      relativePath: "v1/messages",
      query: [],
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    };
  },

  parseChatResponse(response: ProviderHttpResponse): string {
    let value: unknown;
    try {
      value = JSON.parse(response.body) as unknown;
    } catch {
      throw new ProviderProtocolError("anthropic response is not JSON");
    }
    if (!value || typeof value !== "object") {
      throw new ProviderProtocolError("invalid anthropic response");
    }
    const content = (value as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      throw new ProviderProtocolError("anthropic response missing content");
    }
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const blockType = (block as { type?: unknown }).type ?? "text";
      if (blockType === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(text);
        }
      }
    }
    const joined = parts.join("").trim();
    if (!joined) {
      throw new ProviderProtocolError("anthropic content is empty");
    }
    return joined;
  },

  parseStreamEvent(event: SseEvent): StreamParseResult {
    if (!event.data) {
      return { kind: "ignore" };
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      throw new ProviderProtocolError("stream event is not JSON");
    }
    if (!value || typeof value !== "object") {
      return { kind: "ignore" };
    }
    const ty =
      (typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type : null) ??
      event.event ??
      "";
    if (ty !== "content_block_delta") {
      return { kind: "ignore" };
    }
    const delta = (value as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") {
      return { kind: "ignore" };
    }
    const deltaType = (delta as { type?: unknown }).type ?? "text_delta";
    if (deltaType !== "text_delta" && deltaType !== "text") {
      return { kind: "ignore" };
    }
    const text = (delta as { text?: unknown }).text;
    if (typeof text !== "string" || text.length === 0) {
      return { kind: "ignore" };
    }
    return { kind: "delta", text };
  },

  getDetectPolicy(input: DetectPolicyInput): DetectPolicy {
    void input;
    return { thinking: null, maxTokens: DEFAULT_DETECT_MAX_TOKENS };
  },
};
