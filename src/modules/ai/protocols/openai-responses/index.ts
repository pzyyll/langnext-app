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

/** Collects `output_text` parts, ignoring reasoning, refusals, and tool items. */
function responsesTextParts(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.output)) return [];
  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isPlainObject(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isPlainObject(part) && part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts;
}

function extractResponsesText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.output)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  return requireGeneratedText(responsesTextParts(payload));
}

/** Builds the Responses request body; `stream` selects the delivery mode. */
function responsesBody(request: TextGenerationRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: requireModelId({ kind: "model", modelId: request.modelId }),
    input: request.user,
    stream,
  };
  if (request.system.trim().length > 0) {
    body.instructions = request.system;
  }
  if (request.temperature !== null && request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.maxOutputTokens !== null && request.maxOutputTokens !== undefined) {
    body.max_output_tokens = request.maxOutputTokens;
  }
  if (request.disableReasoning) {
    body.reasoning = { effort: "none" };
  }
  return body;
}

/** Builds the Responses body for one buffered image; the user input carries text and PNG content. */
function responsesImageBody(request: ImageTextGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: requireModelId({ kind: "model", modelId: request.modelId }),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: request.user },
          { type: "input_image", image_url: imageDataUrl(request.image) },
        ],
      },
    ],
    stream: false,
  };
  if (request.system.trim().length > 0) {
    body.instructions = request.system;
  }
  return body;
}

/**
 * OpenAI Responses wire API. It shares catalog decoding and Bearer
 * authentication with Chat Completions but owns its model endpoint.
 */
export const openAIResponsesProtocol: ProtocolDefinition = {
  id: "openai-responses",
  labelKey: "ai.protocol.openaiResponses",

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
      url: `${normalizeRequestRoot(connection.baseUrl)}/responses`,
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
    const target = openAIResponsesProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
    });
    const payload = await context.http.postJson(target, responsesBody(request, false), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    return extractResponsesText(payload);
  },

  async generateTextFromImage(
    connection: ProtocolConnection,
    request: ImageTextGenerationRequest,
    context: ProtocolContext,
  ): Promise<string> {
    const target = openAIResponsesProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
    });
    const payload = await context.http.postJson(target, responsesImageBody(request), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    requireCompleteOutput(payload.status === "incomplete");
    return extractResponsesText(payload);
  },

  async streamText(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: StreamContext,
  ): Promise<string> {
    const target = openAIResponsesProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
      stream: true,
    });
    let text = "";
    await context.http.postEventStream(target, responsesBody(request, true), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
      onEvent: (data) => {
        const payload = parseEventPayload(data);
        if (!payload) return;
        let part = "";
        if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
          part = payload.delta;
        } else if (payload.type === "response.failed" || payload.type === "error") {
          throw new ProviderProtocolError(
            "invalid_response",
            t("protocol.error.streamInterrupted"),
          );
        } else if (Array.isArray(payload.output)) {
          // A gateway that ignored the stream flag sends the complete response at once.
          part = responsesTextParts(payload).join("");
        }
        if (part.length === 0) return;
        text += part;
        context.onText(text);
      },
    });
    return requireGeneratedText([text]);
  },
};
