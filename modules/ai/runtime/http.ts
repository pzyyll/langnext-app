import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../contracts/errors";
import type { JsonHttpClient, JsonHttpOptions, ResolvedRequestTarget } from "../contracts/protocol";

/** Default timeout shared by every AI HTTP request. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** Minimal response shape the client needs; a real `Response` satisfies it. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Fetch boundary replacement point for isolated tests. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "follow" | "manual" | "error";
    signal: AbortSignal;
  },
) => Promise<HttpResponseLike>;

export interface CreateJsonHttpClientOptions {
  /** Replaces the global `fetch`; it is never called while constructing a client. */
  fetchImpl?: FetchLike;
}

function cancelling(error: unknown): boolean {
  return error instanceof ProviderProtocolError && error.kind === "cancelled";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof ProviderProtocolError && error.kind === "timeout";
}

/** Strips URLs and known credential patterns so network errors never leak secrets or endpoints. */
function sanitizeNetworkDetail(raw: string): string {
  const sanitized = raw
    .replace(/https?:\/\/[^\s"'<>()]+/gi, "")
    .replace(/Bearer\s+\S+/gi, "")
    .replace(/\b(?:sk|AIza)[A-Za-z0-9_-]+/g, "")
    .replace(/[?&](?:key|api_key|token)=[^&\s)]+/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-()[\]\s]+|[:\-()[\]\s]+$/g, "");
  return sanitized.length > 0 ? sanitized : t("protocol.error.networkDefault");
}

async function requestJson(
  fetchImpl: FetchLike,
  target: ResolvedRequestTarget,
  body: string | undefined,
  options: JsonHttpOptions,
): Promise<Record<string, unknown>> {
  const externalSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let triggerExternalCancel: (() => void) | null = null;
  let triggerTimeout: (() => void) | null = null;

  if (externalSignal?.aborted) {
    throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
  }

  const racePromises: Array<Promise<never>> = [];

  if (externalSignal) {
    racePromises.push(
      new Promise<never>((_, reject) => {
        triggerExternalCancel = () =>
          reject(new ProviderProtocolError("cancelled", t("protocol.error.cancelled")));
      }),
    );
  }

  racePromises.push(
    new Promise<never>((_, reject) => {
      triggerTimeout = () =>
        reject(new ProviderProtocolError("timeout", t("protocol.error.timeout")));
    }),
  );

  const onExternalAbort = () => {
    controller.abort();
    triggerExternalCancel?.();
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    triggerTimeout?.();
  }, timeoutMs);

  try {
    let response: HttpResponseLike;
    try {
      const fetchPromise = fetchImpl(target.url, {
        method: target.method,
        headers: target.headers,
        ...(body !== undefined ? { body } : {}),
        ...(options.redirect ? { redirect: options.redirect } : {}),
        signal: controller.signal,
      });
      fetchPromise.catch(() => {});
      response = await Promise.race([fetchPromise, ...racePromises]);
    } catch (error) {
      if (timedOut || isTimeoutError(error)) {
        throw new ProviderProtocolError("timeout", t("protocol.error.timeout"));
      }
      if (cancelling(error) || externalSignal?.aborted) {
        throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
      }
      const rawDetail = error instanceof Error ? error.message : t("protocol.error.networkDefault");
      throw new ProviderProtocolError(
        "network",
        t("protocol.error.network", { detail: sanitizeNetworkDetail(rawDetail) }),
      );
    }

    if (externalSignal?.aborted) {
      throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
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
      const jsonPromise = response.json();
      jsonPromise.catch(() => {});
      parsed = await Promise.race([jsonPromise, ...racePromises]);
    } catch (error) {
      if (timedOut || isTimeoutError(error)) {
        throw new ProviderProtocolError("timeout", t("protocol.error.timeout"));
      }
      if (cancelling(error) || externalSignal?.aborted) {
        throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
      }
      throw new ProviderProtocolError("invalid_response", t("protocol.error.unreadable"));
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProviderProtocolError("invalid_response", t("protocol.error.unexpectedShape"));
    }

    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Creates the shared JSON HTTP boundary; it performs no I/O until a call. */
export function createJsonHttpClient(options: CreateJsonHttpClientOptions = {}): JsonHttpClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    getJson: (target, callOptions) => requestJson(fetchImpl, target, undefined, callOptions ?? {}),
    postJson: (target, body, callOptions) =>
      requestJson(fetchImpl, target, JSON.stringify(body), {
        ...callOptions,
        redirect: callOptions?.redirect ?? "error",
      }),
  };
}

/** The production HTTP boundary used by the AI client and the old adapters. */
export const jsonHttp = createJsonHttpClient();
