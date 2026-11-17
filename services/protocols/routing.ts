import { t } from "nsh/i18n";
import { getProviderPreset, isProtocolAllowedForPreset } from "./presets";
import {
  ProviderProtocolError,
  type AdapterRequestParams,
  type RequestOperation,
  type ResolvedRequestTarget,
} from "./types";

function resolveNormalizedRoot(params: AdapterRequestParams): string {
  const raw = params.baseUrl?.trim();
  if (raw) {
    return raw.replace(/\/+$/, "");
  }
  const defaultBaseUrl = getProviderPreset(params.presetId).defaultBaseUrl;
  if (defaultBaseUrl) {
    return defaultBaseUrl.replace(/\/+$/, "");
  }
  throw new ProviderProtocolError("invalid_request", t("models.error.baseUrlRequired"));
}

/**
 * Resolves the target HTTP method, URL, and protocol headers for either a catalog
 * discovery request or a model endpoint request, preserving configured path prefixes.
 */
export function resolveRequestTarget(
  params: AdapterRequestParams,
  operation: RequestOperation,
): ResolvedRequestTarget {
  if (!isProtocolAllowedForPreset(params.presetId, params.adapterId)) {
    throw new ProviderProtocolError("invalid_request", t("models.error.unsupportedProtocol"));
  }

  const root = resolveNormalizedRoot(params);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = params.credential?.trim() || null;

  if (operation.kind === "catalog") {
    const query = new URLSearchParams(operation.queryExtras ?? {});
    let path: string;

    if (params.presetId === "deepseek") {
      path = `${root}/models`;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    } else if (params.adapterId === "anthropic") {
      const base = root.replace(/\/v1$/, "");
      path = `${base}/v1/models`;
      headers["anthropic-version"] = "2023-06-01";
      if (token) {
        headers["x-api-key"] = token;
      }
    } else if (params.adapterId === "gemini") {
      const base = root.replace(/\/v1beta$/, "").replace(/\/v1$/, "");
      path = `${base}/v1beta/models`;
      if (token) {
        query.set("key", token);
      }
    } else {
      path = `${root}/models`;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const qs = query.toString();
    return {
      method: "GET",
      url: qs.length > 0 ? `${path}?${qs}` : path,
      headers,
    };
  }

  const modelId = operation.modelId.trim();
  if (!modelId) {
    throw new ProviderProtocolError("invalid_request", t("models.error.modelIdRequired"));
  }

  headers["Content-Type"] = "application/json";
  const query = new URLSearchParams();
  let path: string;

  if (params.adapterId === "openai-compatible") {
    path = `${root}/chat/completions`;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (params.adapterId === "openai-responses") {
    path = `${root}/responses`;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (params.adapterId === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (token) {
      headers["x-api-key"] = token;
    }
    if (params.presetId === "deepseek") {
      const base = root.replace(/\/anthropic(?:\/v1)?$/, "").replace(/\/v1$/, "");
      path = `${base}/anthropic/v1/messages`;
    } else {
      const base = root.replace(/\/v1$/, "");
      path = `${base}/v1/messages`;
    }
  } else {
    const base = root.replace(/\/v1beta$/, "").replace(/\/v1$/, "");
    const cleanModelId = modelId.replace(/^models\//, "");
    path = `${base}/v1beta/models/${encodeURIComponent(cleanModelId)}:generateContent`;
    if (token) {
      query.set("key", token);
    }
  }

  const qs = query.toString();
  return {
    method: "POST",
    url: qs.length > 0 ? `${path}?${qs}` : path,
    headers,
  };
}
