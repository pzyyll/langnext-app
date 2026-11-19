import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../contracts/errors";
import type { RemoteModelRecord } from "../../contracts/model";
import type {
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  RequestOperation,
  ResolvedRequestTarget,
  StreamContext,
  TextGenerationRequest,
} from "../../contracts/protocol";
import { decodeOpenAICatalogPage } from "../openai-common";
import {
  isPlainObject,
  normalizeCredential,
  normalizeRequestRoot,
  parseEventPayload,
  requireGeneratedText,
  requireModelId,
} from "../shared";

/** Anthropic API version sent with every Messages and catalog request. */
export const ANTHROPIC_API_VERSION = "2023-06-01";
/** Catalog pages fetched at most, so a broken cursor cannot loop forever. */
export const ANTHROPIC_MAX_CATALOG_PAGES = 10;
/** Default `max_tokens` sent when the preset leaves max output tokens unset. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

/** Strips one trailing `/v1` so the standard version segment is added once. */
function anthropicRoot(baseUrl: string): string {
  return normalizeRequestRoot(baseUrl).replace(/\/v1$/, "");
}

/** Collects `text` blocks, ignoring `thinking` and tool blocks. */
function anthropicTextParts(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.content)) return [];
  const parts: string[] = [];
  for (const block of payload.content) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts;
}

/** Builds the Messages request body; `stream` selects the delivery mode. */
function anthropicBody(request: TextGenerationRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: requireModelId({ kind: "model", modelId: request.modelId }),
    messages: [{ role: "user", content: request.user }],
    max_tokens:
      request.maxOutputTokens !== null && request.maxOutputTokens !== undefined
        ? request.maxOutputTokens
        : ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream,
  };
  if (request.system.trim().length > 0) {
    body.system = request.system;
  }
  if (request.temperature !== null && request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.disableReasoning) {
    // Extended thinking is opt-in, but disabled states keep the intent explicit.
    body.thinking = { type: "disabled" };
  }
  return body;
}

function anthropicHeaders(connection: ProtocolConnection): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "anthropic-version": ANTHROPIC_API_VERSION,
  };
  const token = normalizeCredential(connection.credential);
  if (token) {
    headers["x-api-key"] = token;
  }
  return headers;
}

function catalogTarget(
  connection: ProtocolConnection,
  queryExtras?: Record<string, string>,
): ResolvedRequestTarget {
  const query = new URLSearchParams(queryExtras ?? {});
  const path = `${anthropicRoot(connection.baseUrl)}/v1/models`;
  const qs = query.toString();
  return {
    method: "GET",
    url: qs.length > 0 ? `${path}?${qs}` : path,
    headers: anthropicHeaders(connection),
  };
}

function cursorFrom(payload: Record<string, unknown>): {
  hasMore: boolean;
  lastId: string | null;
} {
  const hasMore = payload.has_more === true;
  const lastId = typeof payload.last_id === "string" ? payload.last_id.trim() : "";
  return { hasMore, lastId: lastId || null };
}

/**
 * Anthropic Messages wire API. Its model list uses the OpenAI-style
 * `{ data: [...] }` envelope, but pagination and authentication stay here.
 */
export const anthropicProtocol: ProtocolDefinition = {
  id: "anthropic",
  labelKey: "ai.protocol.anthropic",

  resolveTarget(
    connection: ProtocolConnection,
    operation: RequestOperation,
  ): ResolvedRequestTarget {
    if (operation.kind === "catalog") {
      return catalogTarget(connection, operation.queryExtras);
    }
    requireModelId(operation);
    return {
      method: "POST",
      url: `${anthropicRoot(connection.baseUrl)}/v1/messages`,
      headers: {
        ...anthropicHeaders(connection),
        "Content-Type": "application/json",
      },
    };
  },

  async listModels(connection: ProtocolConnection, context: ProtocolContext) {
    const unique = new Map<string, RemoteModelRecord>();
    let afterId: string | null = null;
    for (let page = 0; page < ANTHROPIC_MAX_CATALOG_PAGES; page++) {
      const target = catalogTarget(connection, afterId ? { after_id: afterId } : undefined);
      const payload = await context.http.getJson(target, {
        signal: context.signal,
        timeoutMs: context.timeoutMs,
      });
      for (const record of decodeOpenAICatalogPage(payload)) {
        if (!unique.has(record.modelKey)) {
          unique.set(record.modelKey, record);
        }
      }
      const { hasMore, lastId } = cursorFrom(payload);
      if (!hasMore || !lastId || lastId === afterId) break;
      afterId = lastId;
    }
    return Array.from(unique.values());
  },

  async generateText(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: ProtocolContext,
  ): Promise<string> {
    const target = anthropicProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
    });
    const payload = await context.http.postJson(target, anthropicBody(request, false), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });
    return requireGeneratedText(anthropicTextParts(payload));
  },

  async streamText(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: StreamContext,
  ): Promise<string> {
    const target = anthropicProtocol.resolveTarget(connection, {
      kind: "model",
      modelId: request.modelId,
      stream: true,
    });
    let text = "";
    await context.http.postEventStream(target, anthropicBody(request, true), {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
      onEvent: (data) => {
        const payload = parseEventPayload(data);
        if (!payload) return;
        let part = "";
        if (payload.type === "error") {
          throw new ProviderProtocolError(
            "invalid_response",
            t("protocol.error.streamInterrupted"),
          );
        }
        if (payload.type === "content_block_delta" && isPlainObject(payload.delta)) {
          const delta = payload.delta;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            part = delta.text;
          }
        } else if (Array.isArray(payload.content)) {
          // A gateway that ignored the stream flag sends the complete message at once.
          part = anthropicTextParts(payload).join("");
        }
        if (part.length === 0) return;
        text += part;
        context.onText(text);
      },
    });
    return requireGeneratedText([text]);
  },
};
