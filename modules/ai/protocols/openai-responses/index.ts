import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../contracts/errors";
import type {
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  RequestOperation,
  ResolvedRequestTarget,
  TextGenerationRequest,
} from "../../contracts/protocol";
import {
  decodeOpenAICatalogPage,
  dedupeRemoteModels,
  resolveOpenAICatalogTarget,
  withBearer,
} from "../openai-common";
import {
  isPlainObject,
  normalizeRequestRoot,
  requireGeneratedText,
  requireModelId,
} from "../shared";

function extractResponsesText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.output)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
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
  return requireGeneratedText(parts);
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
    const modelId = requireModelId({ kind: "model", modelId: request.modelId });
    const target = openAIResponsesProtocol.resolveTarget(connection, { kind: "model", modelId });
    const body: Record<string, unknown> = {
      model: modelId,
      input: request.user,
      stream: false,
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

    const payload = await context.http.postJson(target, body, {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    return extractResponsesText(payload);
  },
};
