import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../contracts/errors";
import type {
  ImageTextGenerationRequest,
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  RequestOperation,
  ResolvedRequestTarget,
  StreamContext,
  TextGenerationRequest,
} from "../../contracts/protocol";
import {
  decodeOpenAICatalogPage,
  dedupeRemoteModels,
  resolveOpenAICatalogTarget,
  withBearer,
} from "../openai-common";
import {
  imageDataUrl,
  isPlainObject,
  normalizeRequestRoot,
  parseEventPayload,
  requireCompleteOutput,
  requireGeneratedText,
  requireModelId,
} from "../shared";

/** Collects text parts from Chat `content`, ignoring non-text parts such as reasoning. */
function chatContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function extractChatText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  const firstChoice = payload.choices[0];
  if (!isPlainObject(firstChoice) || !isPlainObject(firstChoice.message)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  return requireGeneratedText([chatContentText(firstChoice.message.content)]);
}

/** Reads one streamed or buffered Chat payload; events without text contribute nothing. */
function extractChatPart(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return "";
  const firstChoice = payload.choices[0];
  if (!isPlainObject(firstChoice)) return "";
  if (isPlainObject(firstChoice.delta)) return chatContentText(firstChoice.delta.content);
  if (isPlainObject(firstChoice.message)) return chatContentText(firstChoice.message.content);
  return "";
}

/** Builds the Chat request body; `stream` selects the delivery mode, not the endpoint. */
function chatBody(request: TextGenerationRequest, stream: boolean): Record<string, unknown> {
  const modelId = requireModelId({ kind: "model", modelId: request.modelId });
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (request.system.trim().length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({ role: "user", content: request.user });

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream,
  };
  if (request.temperature !== null && request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.maxOutputTokens !== null && request.maxOutputTokens !== undefined) {
    body.max_completion_tokens = request.maxOutputTokens;
  }
  if (request.disableReasoning) {
    body.reasoning_effort = "none";
  }
  return body;
}

/** Builds the Chat body for one buffered image; the user message carries the text and the PNG. */
function chatImageBody(request: ImageTextGenerationRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system.trim().length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text: request.user },
      { type: "image_url", image_url: { url: imageDataUrl(request.image) } },
    ],
  });

  return {
    model: requireModelId({ kind: "model", modelId: request.modelId }),
    messages,
    stream: false,
  };
}

/**
 * OpenAI Chat Completions wire API. It knows no provider brand: the host resolves
 * the root and credential before calling it.
 */
export const openAIChatProtocol: ProtocolDefinition = {
  id: "openai-compatible",
  labelKey: "ai.protocol.openaiChat",

  resolveTarget(
    connection: ProtocolConnection,
    operation: RequestOperation,
  ): ResolvedRequestTarget {
    if (operation.kind === "catalog") {
      return resolveOpenAICatalogTarget(connection, operation);
    }
    requireModelId(operation);
    return {
      method: "POST",
      url: `${normalizeRequestRoot(connection.baseUrl)}/chat/completions`,
      headers: withBearer(
        { Accept: "application/json", "Content-Type": "application/json" },
        connection.credential,
      ),
    };
  },

  async listModels(connection: ProtocolConnection, context: ProtocolContext) {
    const target = resolveOpenAICatalogTarget(connection, { kind: "catalog" });
    const payload = await context.http.getJson(target, {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
    });
    return dedupeRemoteModels(decodeOpenAICatalogPage(payload));
  },

  async generateText(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: ProtocolContext,
  ): Promise<string> {
    const target = openAIChatProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
    });
    const payload = await context.http.postJson(target, chatBody(request, false), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    return extractChatText(payload);
  },

  async generateTextFromImage(
    connection: ProtocolConnection,
    request: ImageTextGenerationRequest,
    context: ProtocolContext,
  ): Promise<string> {
    const target = openAIChatProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
    });
    const payload = await context.http.postJson(target, chatImageBody(request), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    const firstChoice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    requireCompleteOutput(isPlainObject(firstChoice) && firstChoice.finish_reason === "length");
    return extractChatText(payload);
  },

  async streamText(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: StreamContext,
  ): Promise<string> {
    const target = openAIChatProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
      stream: true,
    });
    let text = "";
    await context.http.postEventStream(target, chatBody(request, true), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
      onEvent: (data) => {
        const payload = parseEventPayload(data);
        if (!payload) return;
        const part = extractChatPart(payload);
        if (part.length === 0) return;
        text += part;
        context.onText(text);
      },
    });
    return requireGeneratedText([text]);
  },
};
