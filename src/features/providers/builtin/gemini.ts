// ABOUTME: Google Gemini generateContent provider plugin.
// ABOUTME: Owns model resource paths, pagination, alt=sse, and content parsing.
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
const MAX_MODEL_KEY_LEN = 256;
const MAX_REMOTE_METADATA_BYTES = 2048;
const MAX_GEMINI_METHODS = 32;
const MAX_GEMINI_METHOD_LEN = 128;

const MANIFEST: ProviderPluginManifest = {
  id: "gemini",
  label: "Gemini",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  supportedCredentialKinds: ["api_key", "bearer"],
  capabilities: {
    modelListing: true,
    streaming: true,
    textGeneration: true,
    imageInput: true,
  },
};

function geminiModelResource(modelKey: string): string {
  const key = modelKey.trim();
  if (!key || key.length > MAX_MODEL_KEY_LEN) {
    throw new ProviderProtocolError("invalid gemini model key");
  }
  if (key.includes("://") || key.includes("?") || key.includes("#")) {
    throw new ProviderProtocolError("invalid gemini model key");
  }
  return key.startsWith("models/") ? key : `models/${key}`;
}

function geminiUserParts(userPrompt: string, imagePngBase64: string | null): unknown[] {
  if (imagePngBase64) {
    return [
      { text: userPrompt },
      {
        inline_data: {
          mime_type: "image/png",
          data: imagePngBase64,
        },
      },
    ];
  }
  return [{ text: userPrompt }];
}

function extractGeminiTexts(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }
  const content = (candidates[0] as { content?: unknown }).content;
  if (!content || typeof content !== "object") {
    return [];
  }
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    return [];
  }
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

export const geminiPlugin: ProviderPlugin = {
  manifest: MANIFEST,

  resolveAuthScheme(credentialKind: CredentialKind): AuthSchemeV1 {
    void credentialKind;
    return { schemaVersion: 1, type: "query", name: "key" };
  },

  buildModelListRequest(input: ModelListBuildInput): ProviderWireRequest {
    const query: [string, string][] = [];
    if (input.continuation) {
      query.push(["pageToken", input.continuation]);
    }
    return {
      method: "GET",
      relativePath: "v1beta/models",
      query,
      headers: {},
      body: null,
    };
  },

  parseModelListPage(response: ProviderHttpResponse) {
    let value: unknown;
    try {
      value = JSON.parse(response.body) as unknown;
    } catch {
      throw new ProviderProtocolError("gemini model list is not JSON");
    }
    if (!value || typeof value !== "object") {
      throw new ProviderProtocolError("invalid gemini model list");
    }
    const models = (value as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      throw new ProviderProtocolError("gemini model list missing models");
    }
    if (models.length > MAX_MODELS_PER_PAGE) {
      throw new ProviderProtocolError("gemini model list page too large");
    }
    const items = models.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new ProviderProtocolError("invalid gemini model entry");
      }
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== "string") {
        throw new ProviderProtocolError("gemini model missing name");
      }
      const stripped = name.startsWith("models/") ? name.slice("models/".length) : name;
      const displayName = (entry as { displayName?: unknown }).displayName;
      let remoteMetadataJson: unknown = null;
      const methodsVal = (entry as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
      if (methodsVal != null) {
        if (!Array.isArray(methodsVal) || methodsVal.length > MAX_GEMINI_METHODS) {
          throw new ProviderProtocolError("invalid gemini methods metadata");
        }
        const methods: string[] = [];
        for (const method of methodsVal) {
          if (typeof method !== "string" || !method || method.length > MAX_GEMINI_METHOD_LEN) {
            throw new ProviderProtocolError("invalid gemini method name");
          }
          methods.push(method);
        }
        const meta = { supportedGenerationMethods: methods };
        if (JSON.stringify(meta).length > MAX_REMOTE_METADATA_BYTES) {
          throw new ProviderProtocolError("gemini metadata too large");
        }
        remoteMetadataJson = meta;
      }
      return {
        modelKey: normalizeModelKey(stripped),
        remoteDisplayName: typeof displayName === "string" ? displayName : null,
        remoteMetadataJson,
      };
    });
    const token = (value as { nextPageToken?: unknown }).nextPageToken;
    let continuation: string | null = null;
    if (token != null) {
      if (typeof token !== "string") {
        throw new ProviderProtocolError("invalid gemini nextPageToken");
      }
      continuation = token || null;
    }
    return { items, continuation };
  },

  buildChatRequest(input: ChatBuildInput): ProviderWireRequest {
    const resource = geminiModelResource(input.modelKey);
    const relativePath = input.stream
      ? `v1beta/${resource}:streamGenerateContent`
      : `v1beta/${resource}:generateContent`;
    const generationConfig: Record<string, unknown> = {};
    if (input.temperature != null) {
      generationConfig.temperature = input.temperature;
    }
    if (input.maxTokens != null) {
      generationConfig.maxOutputTokens = input.maxTokens;
    }
    const payload: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: input.systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: geminiUserParts(input.userPrompt, input.imagePngBase64),
        },
      ],
    };
    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }
    const query: [string, string][] = input.stream ? [["alt", "sse"]] : [];
    return {
      method: "POST",
      relativePath,
      query,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
  },

  parseChatResponse(response: ProviderHttpResponse): string {
    let value: unknown;
    try {
      value = JSON.parse(response.body) as unknown;
    } catch {
      throw new ProviderProtocolError("gemini response is not JSON");
    }
    const texts = extractGeminiTexts(value);
    const joined = texts.join("").trim();
    if (!joined) {
      throw new ProviderProtocolError("gemini content is empty");
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
    const texts = extractGeminiTexts(value);
    if (texts.length === 0) {
      return { kind: "ignore" };
    }
    return { kind: "delta", text: texts.join("") };
  },

  getDetectPolicy(input: DetectPolicyInput): DetectPolicy {
    void input;
    return { thinking: null, maxTokens: DEFAULT_DETECT_MAX_TOKENS };
  },
};
