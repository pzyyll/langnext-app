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
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<HttpResponseLike>;

export interface CreateJsonHttpClientOptions {
  /** Replaces the global `fetch`; it is never called while constructing a client. */
  fetchImpl?: FetchLike;
}

function cancelling(error: unknown): boolean {
  return error instanceof ProviderProtocolError && error.kind === "cancelled";
}

async function requestJson(
  fetchImpl: FetchLike,
  target: ResolvedRequestTarget,
  options: JsonHttpOptions,
): Promise<Record<string, unknown>> {
  const externalSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let triggerExternalCancel: (() => void) | null = null;

  const externalCancelPromise = externalSignal
    ? new Promise<never>((_, reject) => {
        triggerExternalCancel = () =>
          reject(new ProviderProtocolError("cancelled", t("protocol.error.cancelled")));
      })
    : null;

  const onExternalAbort = () => {
    controller.abort();
    triggerExternalCancel?.();
  };
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

  let response: HttpResponseLike;
  try {
    const fetchPromise = fetchImpl(target.url, {
      method: target.method,
      headers: target.headers,
      signal: controller.signal,
    });
    if (externalCancelPromise) {
      fetchPromise.catch(() => {});
      response = await Promise.race([fetchPromise, externalCancelPromise]);
    } else {
      response = await fetchPromise;
    }
  } catch (error) {
    if (timedOut) {
      throw new ProviderProtocolError("timeout", t("protocol.error.timeout"));
    }
    if (cancelling(error)) {
      throw error;
    }
    if (externalSignal?.aborted) {
      throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
    }
    const detail = error instanceof Error ? error.message : t("protocol.error.networkDefault");
    throw new ProviderProtocolError("network", t("protocol.error.network", { detail }));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
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
    parsed = await response.json();
  } catch {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.unreadable"));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.unexpectedShape"));
  }

  return parsed as Record<string, unknown>;
}

/** Creates the shared JSON HTTP boundary; it performs no I/O until a call. */
export function createJsonHttpClient(options: CreateJsonHttpClientOptions = {}): JsonHttpClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    getJson: (target, callOptions) => requestJson(fetchImpl, target, callOptions ?? {}),
  };
}

/** The production HTTP boundary used by the AI client and the old adapters. */
export const jsonHttp = createJsonHttpClient();
