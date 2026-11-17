import type {
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  RequestOperation,
  ResolvedRequestTarget,
} from "../../contracts/protocol";
import {
  decodeOpenAICatalogPage,
  dedupeRemoteModels,
  resolveOpenAICatalogTarget,
  withBearer,
} from "../openai-common";
import { normalizeRequestRoot, requireModelId } from "../shared";

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
};
