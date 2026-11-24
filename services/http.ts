// ABOUTME: The app's only HTTP entry: one fetch wrapper that logs every request, answer, and failure.
// ABOUTME: Clients inject their test seam here, so no other module calls `fetch` directly.
import { createHttpLog, HTTP_LOG_PAYLOAD_LIMIT, type HttpLog } from "./http-log";

/** What one call sends; every field maps onto `RequestInit`. */
export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: "follow" | "manual" | "error";
  signal: AbortSignal;
}

/** Minimal response shape the app reads; a real `Response` satisfies it. */
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
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface CreateHttpFetchOptions {
  /** Replaces the global `fetch`; isolated tests pass a double. */
  fetchImpl?: FetchLike;
  /** Log scope, `<area>/<module>`. */
  scope: string;
  /** Set false when the caller maps errors itself and writes its own failure line. */
  logFailures?: boolean;
}

/** Only network calls are logged; `asset:` and `data:` reads stay out of the log. */
const NETWORK_URL = /^https?:\/\//i;

/** Content types whose body is text worth keeping; everything else is only counted. */
const TEXTUAL_BODY = /(?:json|xml|text\/)/i;

/**
 * Wraps the fetch boundary so every call logs its method, URL, status, and failure, and so every
 * response body the caller reads is logged at debug level.
 */
export function createHttpFetch(options: CreateHttpFetchOptions): FetchLike {
  const httpLog = createHttpLog(options.scope);
  const send: FetchLike =
    options.fetchImpl ?? ((url: string, init: HttpRequestInit) => fetch(url, init));
  return async (url, init) => {
    const logged = NETWORK_URL.test(url);
    if (logged) httpLog.request(init.method, url, init.body);
    let response: HttpResponseLike;
    try {
      response = await send(url, init);
    } catch (error) {
      if (!logged) throw error;
      if (init.signal.aborted) httpLog.aborted(init.method, url);
      else if (options.logFailures !== false) httpLog.failure(init.method, url, error);
      throw error;
    }
    if (!logged) return response;
    httpLog.response(init.method, url, response.status);
    return watchResponse(response, init.method, url, httpLog);
  };
}

/** Wraps the response so the log sees the body once the caller reads it. */
function watchResponse(
  response: HttpResponseLike,
  method: string,
  url: string,
  httpLog: HttpLog,
): HttpResponseLike {
  const textual = TEXTUAL_BODY.test(response.headers?.get("content-type") ?? "");
  let reported = false;
  const report = (body: unknown) => {
    if (reported) return;
    reported = true;
    httpLog.responseBody(method, url, response.status, body);
  };

  const watched: HttpResponseLike = {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: async () => {
      const value = await response.json();
      report(value);
      return value;
    },
  };

  const readText = response.text?.bind(response);
  if (readText) {
    watched.text = async () => {
      const text = await readText();
      report(text);
      return text;
    };
  }

  if (response.body) watched.body = watchBody(response.body, textual, report);
  return watched;
}

/**
 * Wraps a response body so the log counts what the caller reads. The reader is taken only on
 * the first read, so a body the caller discards is never pulled; only `read` and `cancel` are
 * replaced, which is all the app uses from a stream.
 */
function watchBody(
  body: ReadableStream<Uint8Array>,
  textual: boolean,
  report: (body: unknown) => void,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let chars = 0;
  let preview = "";

  const record = (value: Uint8Array) => {
    bytes += value.byteLength;
    if (!textual) return;
    const chunk = decoder.decode(value, { stream: true });
    chars += chunk.length;
    if (preview.length < HTTP_LOG_PAYLOAD_LIMIT) {
      preview += chunk.slice(0, HTTP_LOG_PAYLOAD_LIMIT - preview.length);
    }
  };

  const watched = {
    getReader() {
      reader ??= body.getReader();
      const reading = reader;
      return {
        read: async () => {
          const result = await reading.read();
          if (!result.done) {
            record(result.value);
            return result;
          }
          report(
            textual
              ? { streamedBytes: bytes, streamedChars: chars, preview }
              : { streamedBytes: bytes },
          );
          return result;
        },
        cancel: () => reading.cancel(),
        releaseLock: () => reading.releaseLock(),
        get closed() {
          return reading.closed;
        },
      };
    },
    cancel: () => (reader ? reader.cancel() : body.cancel()),
  };
  return watched as unknown as ReadableStream<Uint8Array>;
}
