import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../contracts/errors";
import type {
  JsonEventStreamOptions,
  JsonHttpClient,
  JsonHttpOptions,
  ResolvedRequestTarget,
} from "../contracts/protocol";

/** Default timeout shared by every AI HTTP request; event streams measure it as inactivity. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/** Minimal response shape the client needs; a real `Response` satisfies it. */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Real responses expose headers; a buffered test double may omit them. */
  headers?: { get(name: string): string | null };
  text?(): Promise<string>;
  /** Present on real responses; absent means the body can only be read whole. */
  body?: ReadableStream<Uint8Array> | null;
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

/** Maps an unsuccessful HTTP status onto the shared error categories. */
function statusError(status: number): ProviderProtocolError {
  if (status === 401 || status === 403) {
    return new ProviderProtocolError("auth", t("protocol.error.auth", { status }), status);
  }
  if (status === 429) {
    return new ProviderProtocolError(
      "rate_limited",
      t("protocol.error.rateLimited", { status }),
      status,
    );
  }
  if (status >= 500) {
    return new ProviderProtocolError("server", t("protocol.error.server", { status }), status);
  }
  return new ProviderProtocolError(
    "invalid_request",
    t("protocol.error.rejected", { status }),
    status,
  );
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
      throw statusError(response.status);
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
    postEventStream: (target, body, callOptions) =>
      requestEventStream(fetchImpl, target, JSON.stringify(body), {
        ...callOptions,
        redirect: callOptions.redirect ?? "error",
      }),
  };
}

/** Prefix that marks one server-sent event payload line. */
const SSE_DATA_PREFIX = "data:";

/**
 * Posts a request body and reads the response as server-sent events.
 * Every `data:` payload goes to `onEvent` as it arrives. A body that is not an event stream
 * is delivered once, whole, so a gateway that ignores the stream flag still works.
 * The timeout restarts on each received chunk, so it measures inactivity.
 */
async function requestEventStream(
  fetchImpl: FetchLike,
  target: ResolvedRequestTarget,
  body: string,
  options: JsonEventStreamOptions,
): Promise<void> {
  const externalSignal = options.signal;
  const idleTimeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
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

  let timer: number | null = null;
  const armIdleTimer = () => {
    clearTimeout(timer ?? undefined);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      triggerTimeout?.();
    }, idleTimeoutMs);
  };
  armIdleTimer();

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const streamError = (error: unknown): ProviderProtocolError => {
    if (timedOut || isTimeoutError(error)) {
      return new ProviderProtocolError("timeout", t("protocol.error.timeout"));
    }
    if (cancelling(error) || externalSignal?.aborted) {
      return new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
    }
    const rawDetail = error instanceof Error ? error.message : t("protocol.error.networkDefault");
    return new ProviderProtocolError(
      "network",
      t("protocol.error.network", { detail: sanitizeNetworkDetail(rawDetail) }),
    );
  };

  try {
    let response: HttpResponseLike;
    try {
      const fetchPromise = fetchImpl(target.url, {
        method: target.method,
        headers: target.headers,
        body,
        ...(options.redirect ? { redirect: options.redirect } : {}),
        signal: controller.signal,
      });
      fetchPromise.catch(() => {});
      response = await Promise.race([fetchPromise, ...racePromises]);
    } catch (error) {
      throw streamError(error);
    }

    if (externalSignal?.aborted) {
      throw new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
    }

    if (!response.ok) {
      throw statusError(response.status);
    }

    let sawEvent = false;
    let bufferedBody = "";
    let lineBuffer = "";
    const decoder = new TextDecoder();

    const deliver = (payload: string) => {
      const data = payload.trim();
      if (data.length === 0) return;
      sawEvent = true;
      bufferedBody = "";
      options.onEvent(data);
    };

    const deliverLine = (line: string) => {
      if (!line.startsWith(SSE_DATA_PREFIX)) return;
      deliver(line.slice(SSE_DATA_PREFIX.length).replace(/^ /, ""));
    };

    const reading = response.body?.getReader();
    reader = reading ?? null;
    if (!reader) {
      // A buffered body is not an event stream; hand it over once.
      const textPromise = response.text ? response.text() : Promise.resolve("");
      textPromise.catch(() => {});
      const text = await Promise.race([textPromise, ...racePromises]);
      deliver(String(text));
      return;
    }

    while (true) {
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const result = await Promise.race([readPromise, ...racePromises]);
      if (result.done) break;
      armIdleTimer();
      const chunk = decoder.decode(result.value, { stream: true });
      if (!sawEvent) bufferedBody += chunk;
      lineBuffer += chunk;
      let lineEnd = lineBuffer.indexOf("\n");
      while (lineEnd !== -1) {
        const line = lineBuffer.slice(0, lineEnd).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(lineEnd + 1);
        deliverLine(line);
        lineEnd = lineBuffer.indexOf("\n");
      }
    }

    lineBuffer += decoder.decode();
    if (lineBuffer.length > 0) deliverLine(lineBuffer.replace(/\r$/, ""));
    if (!sawEvent) deliver(bufferedBody);
  } catch (error) {
    // Keep category errors raised by the protocol or by cancellation; wrap transport failures.
    if (error instanceof ProviderProtocolError) throw error;
    throw streamError(error);
  } finally {
    clearTimeout(timer ?? undefined);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (reader) {
      reader.cancel().catch(() => {});
    }
  }
}

/** The production HTTP boundary used by the AI client and the old adapters. */
export const jsonHttp = createJsonHttpClient();
