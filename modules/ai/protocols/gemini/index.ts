import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../contracts/errors";
import type { RemoteModelRecord } from "../../contracts/model";
import type {
  ProtocolConnection,
  ProtocolContext,
  ProtocolDefinition,
  RequestOperation,
  ResolvedRequestTarget,
  TextGenerationRequest,
} from "../../contracts/protocol";
import { normalizePositiveInt } from "../openai-common";
import {
  isPlainObject,
  normalizeCredential,
  normalizeRequestRoot,
  requireGeneratedText,
  requireModelId,
} from "../shared";

/** Catalog pages fetched at most, so a broken page token cannot loop forever. */
export const GEMINI_MAX_CATALOG_PAGES = 10;

/** Strips one trailing `/v1` or `/v1beta` so the version segment is added once. */
function geminiRoot(baseUrl: string): string {
  return normalizeRequestRoot(baseUrl)
    .replace(/\/v1beta$/, "")
    .replace(/\/v1$/, "");
}

function catalogTarget(
  connection: ProtocolConnection,
  pageToken: string | null,
): ResolvedRequestTarget {
  const query = new URLSearchParams();
  if (pageToken) query.set("pageToken", pageToken);
  const path = `${geminiRoot(connection.baseUrl)}/v1beta/models`;
  const token = normalizeCredential(connection.credential);
  if (token) query.set("key", token);
  const qs = query.toString();
  return {
    method: "GET",
    url: qs.length > 0 ? `${path}?${qs}` : path,
    headers: { Accept: "application/json" },
  };
}

function decodeGeminiPage(payload: Record<string, unknown>): {
  models: RemoteModelRecord[];
  nextPageToken: string | null;
} {
  if (!Array.isArray(payload.models)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeminiModels"));
  }

  const models: RemoteModelRecord[] = [];
  for (const raw of payload.models) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    const modelKey = rawName.replace(/^models\//, "");
    if (!modelKey) continue;
    const displayName =
      typeof item.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : null;
    models.push({
      modelKey,
      displayName,
      contextLimit: normalizePositiveInt(item.inputTokenLimit),
      maxTokens: normalizePositiveInt(item.outputTokenLimit),
      capabilities: null,
    });
  }

  const nextPageToken =
    typeof payload.nextPageToken === "string" && payload.nextPageToken.trim()
      ? payload.nextPageToken.trim()
      : null;

  return { models, nextPageToken };
}

/** Gemini API wire protocol, including page-token pagination and encoded model IDs. */
export const geminiProtocol: ProtocolDefinition = {
  id: "gemini",
  labelKey: "ai.protocol.gemini",

  resolveTarget(
    connection: ProtocolConnection,
    operation: RequestOperation,
  ): ResolvedRequestTarget {
    if (operation.kind === "catalog") {
      const query = new URLSearchParams(operation.queryExtras ?? {});
      const path = `${geminiRoot(connection.baseUrl)}/v1beta/models`;
      const token = normalizeCredential(connection.credential);
      if (token) query.set("key", token);
      const qs = query.toString();
      return {
        method: "GET",
        url: qs.length > 0 ? `${path}?${qs}` : path,
        headers: { Accept: "application/json" },
      };
    }

    const modelId = requireModelId(operation).replace(/^models\//, "");
    const query = new URLSearchParams();
    const token = normalizeCredential(connection.credential);
    if (token) query.set("key", token);
    const qs = query.toString();
    const path = `${geminiRoot(connection.baseUrl)}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
    return {
      method: "POST",
      url: qs.length > 0 ? `${path}?${qs}` : path,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    };
  },

  async listModels(connection: ProtocolConnection, context: ProtocolContext) {
    const unique = new Map<string, RemoteModelRecord>();
    let pageToken: string | null = null;
    for (let page = 0; page < GEMINI_MAX_CATALOG_PAGES; page++) {
      const target = catalogTarget(connection, pageToken);
      const payload = await context.http.getJson(target, {
        signal: context.signal,
        timeoutMs: context.timeoutMs,
      });
      const parsed = decodeGeminiPage(payload);
      for (const record of parsed.models) {
        if (!unique.has(record.modelKey)) {
          unique.set(record.modelKey, record);
        }
      }
      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
      pageToken = parsed.nextPageToken;
    }
    return Array.from(unique.values());
  },

  async generateText(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: ProtocolContext,
  ): Promise<string> {
    const modelId = requireModelId({ kind: "model", modelId: request.modelId });
    const target = geminiProtocol.resolveTarget(connection, { kind: "model", modelId });
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: request.user }] }],
    };
    if (request.system.trim().length > 0) {
      body.systemInstruction = { parts: [{ text: request.system }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== null && request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== null && request.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxOutputTokens;
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const payload = await context.http.postJson(target, body, {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      redirect: "error",
    });

    if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
      throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
    }
    const firstCandidate = payload.candidates[0];
    if (
      !isPlainObject(firstCandidate) ||
      !isPlainObject(firstCandidate.content) ||
      !Array.isArray(firstCandidate.content.parts)
    ) {
      throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeneratedText"));
    }
    const parts: string[] = [];
    for (const part of firstCandidate.content.parts) {
      if (
        isPlainObject(part) &&
        part.thought !== true &&
        !("functionCall" in part) &&
        !("functionResponse" in part) &&
        !("executableCode" in part) &&
        !("codeExecutionResult" in part) &&
        typeof part.text === "string"
      ) {
        parts.push(part.text);
      }
    }
    return requireGeneratedText(parts);
  },
};
