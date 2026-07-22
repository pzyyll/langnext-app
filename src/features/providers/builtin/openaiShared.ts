// ABOUTME: Shared OpenAI chat.completions / models wire helpers for TypeScript plugins.
// ABOUTME: Used by openai-compatible, deepseek, and related OpenAI-shaped plugins.
import {
  ProviderProtocolError,
  type ParsedModelPage,
  type ProviderHttpResponse,
  type ProviderWireRequest,
} from "../types";

const MAX_MODEL_KEY_LEN = 256;
const MAX_MODELS_PER_PAGE = 500;

export function normalizeModelKey(raw: string): string {
  const key = raw.trim();
  if (!key || key.length > MAX_MODEL_KEY_LEN) {
    throw new ProviderProtocolError("invalid model key");
  }
  return key;
}

export function parseOpenAiPage(response: ProviderHttpResponse): ParsedModelPage {
  let value: unknown;
  try {
    value = JSON.parse(response.body) as unknown;
  } catch {
    throw new ProviderProtocolError("model list is not JSON");
  }
  if (!value || typeof value !== "object") {
    throw new ProviderProtocolError("invalid model list page");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new ProviderProtocolError("model list missing data array");
  }
  if (data.length > MAX_MODELS_PER_PAGE) {
    throw new ProviderProtocolError("model list page too large");
  }
  const items = data.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new ProviderProtocolError("invalid model list entry");
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") {
      throw new ProviderProtocolError("model list entry missing id");
    }
    return {
      modelKey: normalizeModelKey(id),
      remoteDisplayName: null,
      remoteMetadataJson: null,
    };
  });
  return { items, continuation: null };
}

export function openaiUserContent(userPrompt: string, imagePngBase64: string | null): unknown {
  if (imagePngBase64) {
    return [
      { type: "text", text: userPrompt },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imagePngBase64}` },
      },
    ];
  }
  return userPrompt;
}

export function buildOpenAiChatCompletions(input: {
  modelKey: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  imagePngBase64: string | null;
  stream: boolean;
}): ProviderWireRequest {
  const payload: Record<string, unknown> = {
    model: input.modelKey,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: openaiUserContent(input.userPrompt, input.imagePngBase64) },
    ],
    stream: input.stream,
  };
  if (input.temperature != null) {
    payload.temperature = input.temperature;
  }
  if (input.maxTokens != null) {
    payload.max_tokens = input.maxTokens;
  }
  return {
    method: "POST",
    relativePath: "chat/completions",
    query: [],
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export function parseOpenAiChatContent(response: ProviderHttpResponse): string {
  let value: unknown;
  try {
    value = JSON.parse(response.body) as unknown;
  } catch {
    throw new ProviderProtocolError("chat response is not JSON");
  }
  if (!value || typeof value !== "object") {
    throw new ProviderProtocolError("invalid chat response");
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderProtocolError("chat response missing choices");
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new ProviderProtocolError("chat response missing message");
  }
  const content = (message as { content?: unknown }).content;
  if (content == null) {
    throw new ProviderProtocolError("chat response missing content");
  }
  if (typeof content !== "string") {
    throw new ProviderProtocolError("chat content is not a string");
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new ProviderProtocolError("chat content is empty");
  }
  return trimmed;
}

export function parseOpenAiStreamDelta(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") {
    return null;
  }
  const content = (delta as { content?: unknown }).content;
  if (typeof content !== "string" || content.length === 0) {
    return null;
  }
  return content;
}
