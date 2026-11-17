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
};
