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

function extractChatText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  const firstChoice = payload.choices[0];
  if (!isPlainObject(firstChoice) || !isPlainObject(firstChoice.message)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
  }
  const content = firstChoice.message.content;
  if (typeof content === "string") {
    return requireGeneratedText([content]);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return requireGeneratedText(parts);
  }
  throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
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
    const modelId = requireModelId({ kind: "model", modelId: request.modelId });
    const target = openAIChatProtocol.resolveTarget(connection, { kind: "model", modelId });
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (request.system.trim().length > 0) {
      messages.push({ role: "system", content: request.system });
    }
    messages.push({ role: "user", content: request.user });

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: false,
    };
    if (request.temperature !== null && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== null && request.maxOutputTokens !== undefined) {
      body.max_completion_tokens = request.maxOutputTokens;
    }

    const payload = await context.http.postJson(target, body, {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    return extractChatText(payload);
  },
};
