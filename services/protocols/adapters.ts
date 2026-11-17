import { t } from "nsh/i18n";
import { resolveRequestTarget } from "./routing";
import {
  ProviderProtocolError,
  type AdapterId,
  type AdapterRequestParams,
  type AdapterSpec,
  type DiscoveredRemoteModel,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

export const ADAPTER_SPECS: readonly AdapterSpec[] = [
  {
    id: "openai-compatible",
    label: "OpenAI Chat Completions",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic Messages",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    id: "gemini",
    label: "Gemini API",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
  },
];

const ADAPTER_MAP = new Map<AdapterId, AdapterSpec>(ADAPTER_SPECS.map((spec) => [spec.id, spec]));

export function getAdapterSpec(adapterId: AdapterId): AdapterSpec {
  return ADAPTER_MAP.get(adapterId) ?? ADAPTER_SPECS[0]!;
}

export function getAdapterLabel(adapterId: AdapterId): string {
  return ADAPTER_MAP.get(adapterId)?.label ?? adapterId;
}

export function getAdapterDefaultBaseUrl(adapterId: AdapterId): string {
  return getAdapterSpec(adapterId).defaultBaseUrl;
}

function inferCapabilitiesFromId(modelId: string): DiscoveredRemoteModel["capabilities"] {
  const lower = modelId.toLowerCase();
  const isVision =
    lower.includes("gpt-4o") ||
    lower.includes("gpt-4.1") ||
    lower.includes("gpt-4.5") ||
    lower.includes("gpt-5") ||
    lower.includes("o3") ||
    lower.includes("o4") ||
    lower.includes("claude-3") ||
    lower.includes("claude-4") ||
    lower.includes("claude-sonnet") ||
    lower.includes("claude-opus") ||
    lower.includes("claude-haiku") ||
    lower.includes("gemini-1.5") ||
    lower.includes("gemini-2") ||
    lower.includes("gemini-3") ||
    lower.includes("vision") ||
    lower.includes("vl");
  const isGeminiOrClaudePdf =
    lower.includes("gemini-") ||
    lower.includes("claude-3-5") ||
    lower.includes("claude-3-7") ||
    lower.includes("claude-4") ||
    lower.includes("claude-sonnet-4") ||
    lower.includes("claude-opus-4");
  const isVideo =
    lower.includes("gemini-1.5") || lower.includes("gemini-2") || lower.includes("gemini-3");

  return {
    text: true,
    image: isVision,
    pdf: isGeminiOrClaudePdf,
    video: isVideo,
  };
}

async function fetchJsonPage(
  url: string,
  headers: Record<string, string>,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw new ProviderProtocolError("timeout", t("protocol.error.timeout"));
    }
    if (externalSignal?.aborted) {
      throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
    }
    const detail = err instanceof Error ? err.message : "Network request failed.";
    throw new ProviderProtocolError("network", t("protocol.error.network", { detail }));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new ProviderProtocolError("auth", t("protocol.error.auth", { status }), status);
    }
    if (status === 429) {
      throw new ProviderProtocolError(
        "rate_limited",
        t("protocol.error.rateLimited", { status }),
        status,
      );
    }
    if (status >= 500) {
      throw new ProviderProtocolError("server", t("protocol.error.server", { status }), status);
    }
    throw new ProviderProtocolError(
      "invalid_request",
      t("protocol.error.rejected", { status }),
      status,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.unreadable"));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.unexpectedShape"));
  }

  return parsed as Record<string, unknown>;
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function parseOpenAIPage(payload: Record<string, unknown>): DiscoveredRemoteModel[] {
  if (!Array.isArray(payload.data)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingModels"));
  }

  const out: DiscoveredRemoteModel[] = [];
  for (const raw of payload.data) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const displayName =
      typeof item.display_name === "string" && item.display_name.trim()
        ? item.display_name.trim()
        : null;
    out.push({
      modelKey: id,
      displayName,
      contextLimit: normalizePositiveInt(item.context_window ?? item.context_length),
      maxTokens: normalizePositiveInt(item.max_tokens ?? item.max_output_tokens),
      capabilities: inferCapabilitiesFromId(id),
    });
  }
  return out;
}

function parseGeminiPage(payload: Record<string, unknown>): {
  models: DiscoveredRemoteModel[];
  nextPageToken: string | null;
} {
  if (!Array.isArray(payload.models)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingGeminiModels"));
  }

  const models: DiscoveredRemoteModel[] = [];
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
      capabilities: inferCapabilitiesFromId(modelKey),
    });
  }

  const nextPageToken =
    typeof payload.nextPageToken === "string" && payload.nextPageToken.trim()
      ? payload.nextPageToken.trim()
      : null;

  return { models, nextPageToken };
}

/** Fetches the model catalog from the configured protocol endpoint with pagination and timeout. */
export async function listRemoteModels(
  params: AdapterRequestParams,
): Promise<DiscoveredRemoteModel[]> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deduped = new Map<string, DiscoveredRemoteModel>();

  if (params.presetId !== "deepseek" && params.adapterId === "anthropic") {
    let afterId: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const queryExtras: Record<string, string> = {};
      if (afterId) queryExtras.after_id = afterId;
      const { url, headers } = resolveRequestTarget(params, { kind: "catalog", queryExtras });
      const payload = await fetchJsonPage(url, headers, params.signal, timeoutMs);
      for (const item of parseOpenAIPage(payload)) {
        if (!deduped.has(item.modelKey)) deduped.set(item.modelKey, item);
      }
      const hasMore = payload.has_more === true;
      const lastId = typeof payload.last_id === "string" ? payload.last_id.trim() : "";
      if (!hasMore || !lastId || lastId === afterId) break;
      afterId = lastId;
    }
    return Array.from(deduped.values());
  }

  if (params.adapterId === "gemini") {
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const queryExtras: Record<string, string> = {};
      if (pageToken) queryExtras.pageToken = pageToken;
      const { url, headers } = resolveRequestTarget(params, { kind: "catalog", queryExtras });
      const payload = await fetchJsonPage(url, headers, params.signal, timeoutMs);
      const parsed = parseGeminiPage(payload);
      for (const item of parsed.models) {
        if (!deduped.has(item.modelKey)) deduped.set(item.modelKey, item);
      }
      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
      pageToken = parsed.nextPageToken;
    }
    return Array.from(deduped.values());
  }

  const { url, headers } = resolveRequestTarget(params, { kind: "catalog" });
  const payload = await fetchJsonPage(url, headers, params.signal, timeoutMs);
  for (const item of parseOpenAIPage(payload)) {
    if (!deduped.has(item.modelKey)) deduped.set(item.modelKey, item);
  }
  return Array.from(deduped.values());
}

/** Tests connectivity and credentials by invoking the adapter's models list endpoint. */
export async function testAdapterConnection(params: AdapterRequestParams): Promise<{
  modelCount: number;
}> {
  const models = await listRemoteModels(params);
  return { modelCount: models.length };
}
