// ABOUTME: OpenAI-compatible chat.completions provider plugin.
// ABOUTME: Owns auth resolution and standard chat/stream wire format only.
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
import {
  buildOpenAiChatCompletions,
  parseOpenAiChatContent,
  parseOpenAiPage,
  parseOpenAiStreamDelta,
} from "./openaiShared";

const MANIFEST: ProviderPluginManifest = {
  id: "openai-compatible",
  label: "OpenAI Compatible",
  defaultBaseUrl: "https://api.openai.com/v1",
  supportedCredentialKinds: ["none", "api_key", "bearer"],
  capabilities: {
    modelListing: true,
    streaming: true,
    textGeneration: true,
    imageInput: true,
  },
};

export const openaiCompatiblePlugin: ProviderPlugin = {
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
    return buildOpenAiChatCompletions({
      modelKey: input.modelKey,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      imagePngBase64: input.imagePngBase64,
      stream: input.stream,
    });
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
    return { thinking: null, maxTokens: DEFAULT_DETECT_MAX_TOKENS };
  },
};
