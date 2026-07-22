// ABOUTME: DeepSeek OpenAI-compatible plugin with first-class thinking policy.
// ABOUTME: Reuses chat.completions wire format; owns detect thinking defaults.
import type { AuthSchemeV1, CredentialKind } from "../../../storage/types";
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
import {
  buildOpenAiChatCompletions,
  parseOpenAiChatContent,
  parseOpenAiPage,
  parseOpenAiStreamDelta,
} from "./openaiShared";

const DETECT_MAX_TOKENS_THINKING = 2048;

const MANIFEST: ProviderPluginManifest = {
  id: "deepseek",
  label: "DeepSeek",
  defaultBaseUrl: "https://api.deepseek.com",
  supportedCredentialKinds: ["none", "api_key", "bearer"],
  capabilities: {
    modelListing: true,
    streaming: true,
    textGeneration: true,
    imageInput: true,
  },
};

export const deepseekPlugin: ProviderPlugin = {
  manifest: MANIFEST,

  resolveAuthScheme(credentialKind: CredentialKind): AuthSchemeV1 {
    if (credentialKind === "none") {
      return { schemaVersion: 1, type: "none" };
    }
    return { schemaVersion: 1, type: "bearer" };
  },

  buildModelListRequest(input: ModelListBuildInput): ProviderWireRequest {
    void input;
    return {
      method: "GET",
      relativePath: "models",
      query: [],
      headers: {},
      body: null,
    };
  },

  parseModelListPage(response: ProviderHttpResponse) {
    return parseOpenAiPage(response);
  },

  buildChatRequest(input: ChatBuildInput): ProviderWireRequest {
    const wire = buildOpenAiChatCompletions({
      modelKey: input.modelKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      imagePngBase64: input.imagePngBase64,
      stream: input.stream,
    });
    if (input.thinking != null && wire.body) {
      const payload = JSON.parse(wire.body) as Record<string, unknown>;
      payload.thinking = { type: input.thinking ? "enabled" : "disabled" };
      return { ...wire, body: JSON.stringify(payload) };
    }
    return wire;
  },

  parseChatResponse(response: ProviderHttpResponse): string {
    return parseOpenAiChatContent(response);
  },

  parseStreamEvent(event: SseEvent): StreamParseResult {
    if (!event.data || event.data === "[DONE]") {
      return { kind: "ignore" };
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      throw new ProviderProtocolError("stream event is not JSON");
    }
    const delta = parseOpenAiStreamDelta(value);
    if (delta == null) {
      return { kind: "ignore" };
    }
    return { kind: "delta", text: delta };
  },

  getDetectPolicy(input: DetectPolicyInput): DetectPolicy {
    void input;
    return { thinking: false, maxTokens: DETECT_MAX_TOKENS_THINKING };
  },
};
