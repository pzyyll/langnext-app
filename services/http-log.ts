// ABOUTME: Writes one log line per outbound HTTP call: request, answer, and failure.
// ABOUTME: Keeps every payload on a debug line, shortened and with credentials masked.
import { createLogger } from "./log";

/** Longest payload kept in one line; the transport caps its streamed capture at this length. */
export const HTTP_LOG_PAYLOAD_LIMIT = 4_000;

/** Field, query, and header names whose value is a credential the log must not keep. */
const SECRET_NAME =
  /^(?:authorization|api[_-]?key|apikey|x-api-key|x-goog-api-key|ocp-apim-subscription-key|access[_-]?token|client[_-]?secret|key|password|secret|token)$/i;

/** What replaces a credential value. */
const SECRET_MASK = "***";

/** Deepest object level masked; request bodies nest a few levels at most. */
const MASK_DEPTH = 10;

/** Lines one HTTP client writes; every line names the method and URL. */
export interface HttpLog {
  /** Writes the outgoing call; its body follows on a debug line. */
  request(method: string, url: string, body?: string | null): void;
  /** Writes the answer, an error line outside 2xx. */
  response(method: string, url: string, status: number): void;
  /** Writes the answer body the transport read, always on a debug line. */
  responseBody(method: string, url: string, status: number, body: unknown): void;
  /** Writes a call the caller stopped, at debug level. */
  aborted(method: string, url: string): void;
  /** Writes a call that threw. */
  failure(method: string, url: string, error: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

/** Replaces credential values inside parsed JSON so a body can be logged. */
function maskFields(value: unknown, depth = 0): unknown {
  if (depth > MASK_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => maskFields(item, depth + 1));
  if (!isRecord(value)) return value;
  const masked: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(value)) {
    masked[name] = SECRET_NAME.test(name) ? SECRET_MASK : maskFields(nested, depth + 1);
  }
  return masked;
}

/** Replaces query credential values, keeping the endpoint itself readable. */
function maskUrl(url: string): string {
  const queryAt = url.indexOf("?");
  if (queryAt === -1) return url;
  const query = url
    .slice(queryAt + 1)
    .split("&")
    .map((pair) => {
      const equalsAt = pair.indexOf("=");
      if (equalsAt <= 0) return pair;
      let name: string;
      try {
        name = decodeURIComponent(pair.slice(0, equalsAt));
      } catch {
        return pair;
      }
      return SECRET_NAME.test(name) ? `${pair.slice(0, equalsAt)}=${SECRET_MASK}` : pair;
    })
    .join("&");
  return `${url.slice(0, queryAt + 1)}${query}`;
}

/** Replaces credential values in a form body; a body without one keeps its exact bytes. */
function maskForm(body: string): string {
  const params = new URLSearchParams(body);
  let masked = false;
  for (const name of new Set(params.keys())) {
    if (!SECRET_NAME.test(name)) continue;
    params.set(name, SECRET_MASK);
    masked = true;
  }
  return masked ? params.toString() : body;
}

/** One line of payload: credentials masked, newlines escaped, the tail dropped. */
function oneLine(payload: string): string {
  const head = payload
    .slice(0, HTTP_LOG_PAYLOAD_LIMIT)
    .replace(/\r?\n/g, "\\n")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => maskUrl(url));
  if (payload.length <= HTTP_LOG_PAYLOAD_LIMIT) return head;
  return `${head.slice(0, HTTP_LOG_PAYLOAD_LIMIT)}…(+${payload.length - HTTP_LOG_PAYLOAD_LIMIT} chars)`;
}

/** Serializes a request body: JSON and form bodies are masked, other text is kept as sent. */
function describeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return oneLine(JSON.stringify(maskFields(JSON.parse(trimmed))));
    } catch {
      // A body that only starts like JSON is logged exactly as sent.
    }
  }
  return oneLine(maskForm(body));
}

/** Serializes an answer body; a string is taken as it came off the wire. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return oneLine(value);
  try {
    return oneLine(JSON.stringify(maskFields(value)) ?? String(value));
  } catch {
    return oneLine(String(value));
  }
}

/** Serializes a thrown value, keeping the error name, message, and provider category. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return describeValue(error);
  const kind = (error as { kind?: unknown }).kind;
  const status = (error as { status?: unknown }).status;
  const category = typeof kind === "string" ? ` kind=${kind}` : "";
  const statusCode = typeof status === "number" ? ` status=${status}` : "";
  return `${oneLine(`${error.name}: ${error.message}`)}${category}${statusCode}`;
}

/** True for a failure the app already reports as a stopped request. */
function cancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { kind?: unknown }).kind === "cancelled"
  );
}

/** Creates the lines one HTTP client writes. */
export function createHttpLog(scope: string): HttpLog {
  const log = createLogger(scope);
  const call = (method: string, url: string) => `${method} ${maskUrl(url)}`;
  return {
    request: (method, url, body) => {
      log.info(`request ${call(method, url)}`);
      if (body === undefined || body === null) return;
      log.debug(`request body ${call(method, url)} body=${describeBody(body)}`);
    },
    response: (method, url, status) => {
      const line = `response ${status} ${call(method, url)}`;
      if (status >= 200 && status < 300) log.info(line);
      else log.error(line);
    },
    responseBody: (method, url, status, body) => {
      log.debug(`response body ${status} ${call(method, url)} body=${describeValue(body)}`);
    },
    aborted: (method, url) => {
      log.debug(`aborted ${call(method, url)}`);
    },
    failure: (method, url, error) => {
      const line = `failure ${call(method, url)} error=${describeError(error)}`;
      if (cancelled(error)) log.debug(line);
      else log.error(line);
    },
  };
}
