import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { logLevel, setLogLevel } from "../../services/log";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { FetchLike, HttpResponseLike } from "../../services/http";
import { createDeepLXClient, DEEPLX_TEXT_LIMIT } from "./client";
import { normalizeDeepLXEndpoint } from "./endpoint";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
  signal?: AbortSignal;
}

type Responder = (request: RecordedRequest) => HttpResponseLike | Promise<HttpResponseLike>;

function jsonResponse(value: unknown, status = 200): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function createHarness(respond?: Responder) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
      signal: init.signal,
    };
    requests.push(request);
    if (respond) return respond(request);
    return jsonResponse({ code: 200, data: "早上好。" });
  };
  return { requests, client: createDeepLXClient({ fetchImpl }) };
}

async function catchProtocolError(run: () => Promise<unknown>): Promise<ProviderProtocolError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProviderProtocolError) return error;
    throw error;
  }
  throw new Error("expected a ProviderProtocolError");
}

type Captured = { calls: unknown[][] };

function captureConsole(): { restore(): void; text(): string } {
  const methods = console as unknown as Record<
    "info" | "debug" | "warn" | "error",
    (...data: unknown[]) => void
  >;
  const originals = {
    info: methods.info,
    debug: methods.debug,
    warn: methods.warn,
    error: methods.error,
  };
  const captured: Captured = { calls: [] };
  const record = (...data: unknown[]) => {
    captured.calls.push(data);
  };
  methods.info = record;
  methods.debug = record;
  methods.warn = record;
  methods.error = record;
  return {
    text: () => captured.calls.map((call) => call.map(String).join(" ")).join("\n"),
    restore: () => {
      methods.info = originals.info;
      methods.debug = originals.debug;
      methods.warn = originals.warn;
      methods.error = originals.error;
    },
  };
}

const baseInput = {
  endpointUrl: "http://localhost:1188/translate",
  token: null,
  text: "Good morning.",
  sourceLanguage: "en" as const,
  targetLanguage: "zh" as const,
};

test("DeepLX client: sends one JSON POST without a token and returns the unchanged data", async () => {
  const harness = createHarness(() =>
    jsonResponse({
      code: 200,
      id: 7,
      data: "  你好  ",
      alternatives: ["你好啊"],
      source_lang: "EN",
      target_lang: "ZH-HANS",
    }),
  );

  const text = await harness.client.translate(baseInput);
  expect(text).toBe("  你好  ");
  expect(harness.requests).toHaveLength(1);

  const [request] = harness.requests;
  expect(request!.url).toBe("http://localhost:1188/translate");
  expect(request!.method).toBe("POST");
  expect(request!.headers["Content-Type"]).toBe("application/json");
  expect(request!.headers.Authorization).toBeUndefined();
  expect(request!.redirect).toBe("error");
  expect(JSON.parse(request!.body!)).toEqual({
    text: "Good morning.",
    source_lang: "EN",
    target_lang: "ZH-HANS",
  });
  expect(request!.url).not.toContain("Good morning");
});

test("DeepLX client: normalizes complete endpoints and rejects unusable ones", () => {
  const accepted: Array<[string, string]> = [
    ["http://localhost:1188/translate", "http://localhost:1188/translate"],
    ["  http://127.0.0.1:1188/dlx/translate/  ", "http://127.0.0.1:1188/dlx/translate"],
    ["http://[::1]:1188/translate", "http://[::1]:1188/translate"],
    [
      "https://translation.example.com/dlx/translate",
      "https://translation.example.com/dlx/translate",
    ],
    ["HTTP://LOCALHOST:1188/translate", "http://localhost:1188/translate"],
    ["https://example.com/translate", "https://example.com/translate"],
  ];
  for (const [input, expected] of accepted) {
    expect(normalizeDeepLXEndpoint(input)).toBe(expected);
  }

  const rejected: Array<string | null | undefined> = [
    null,
    undefined,
    "",
    "   ",
    "localhost:1188/translate",
    "ftp://localhost/translate",
    "http://example.com/translate",
    "https://example.com",
    "https://example.com/api/translate?token=x",
    "https://example.com/translate#fragment",
    "https://user:secret@example.com/translate",
    "https://example.com/v1/translate",
    "https://example.com/dlx/v2/translate",
    "https://example.com/translate/extra",
  ];
  for (const input of rejected) {
    expect(normalizeDeepLXEndpoint(input)).toBeNull();
  }
});

test("DeepLX client: sends a server token only as a Bearer header", async () => {
  const harness = createHarness();
  await harness.client.translate({ ...baseInput, token: "  secret-token  " });
  expect(harness.requests).toHaveLength(1);
  expect(harness.requests[0]!.headers.Authorization).toBe("Bearer secret-token");
  expect(harness.requests[0]!.url).not.toContain("secret-token");
  expect(harness.requests[0]!.body).not.toContain("secret-token");

  const withoutToken = createHarness();
  await withoutToken.client.translate(baseInput);
  expect(withoutToken.requests[0]!.headers.Authorization).toBeUndefined();

  for (const token of ["has space", "tab\there", "café", "你好", "", "   "]) {
    const invalid = createHarness();
    const error = await catchProtocolError(() => invalid.client.translate({ ...baseInput, token }));
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toBe(t("deeplx.error.tokenInvalid"));
    expect(invalid.requests).toHaveLength(0);
  }
});

test("DeepLX client: rejects an invalid endpoint, blank text, an unsupported pair, or an over-limit text before HTTP", async () => {
  const invalidEndpoint = createHarness();
  const endpointError = await catchProtocolError(() =>
    invalidEndpoint.client.translate({ ...baseInput, endpointUrl: "http://example.com/translate" }),
  );
  expect(endpointError.kind).toBe("invalid_request");
  expect(endpointError.message).toBe(t("deeplx.error.invalidEndpoint"));
  expect(invalidEndpoint.requests).toHaveLength(0);

  const blank = createHarness();
  const blankError = await catchProtocolError(() =>
    blank.client.translate({ ...baseInput, text: "  \n\t " }),
  );
  expect(blankError.kind).toBe("invalid_request");
  expect(blankError.message).toBe(t("quickTranslate.error.blankInput"));
  expect(blank.requests).toHaveLength(0);

  const unsupported = createHarness();
  for (const pair of [
    { sourceLanguage: "th" as const, targetLanguage: "zh" as const },
    { sourceLanguage: "en" as const, targetLanguage: "th" as const },
  ]) {
    const error = await catchProtocolError(() =>
      unsupported.client.translate({ ...baseInput, ...pair }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toBe(t("deeplx.error.unsupportedLanguage"));
  }
  expect(unsupported.requests).toHaveLength(0);
});

test("DeepLX client: accepts the exact UTF-16 limit, including emoji, and sends the text unchanged", async () => {
  const harness = createHarness();
  const boundary = "😀".repeat(750);
  expect(boundary.length).toBe(DEEPLX_TEXT_LIMIT);
  await harness.client.translate({ ...baseInput, text: boundary });
  expect(JSON.parse(harness.requests[0]!.body!).text).toBe(boundary);

  for (const text of ["a".repeat(DEEPLX_TEXT_LIMIT + 1), "😀".repeat(751), `a${boundary}`]) {
    const over = createHarness();
    const error = await catchProtocolError(() => over.client.translate({ ...baseInput, text }));
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toBe(t("deeplx.error.tooLarge"));
    expect(over.requests).toHaveLength(0);
  }

  const spaced = "  Hello\nworld  ";
  const trimmed = createHarness();
  await trimmed.client.translate({ ...baseInput, text: spaced });
  expect(JSON.parse(trimmed.requests[0]!.body!).text).toBe(spaced);
});

test("DeepLX client: maps app languages to DLX codes", async () => {
  const cases = [
    {
      sourceLanguage: "en" as const,
      targetLanguage: "zh" as const,
      source: "EN",
      target: "ZH-HANS",
    },
    { sourceLanguage: "he" as const, targetLanguage: "vi" as const, source: "HE", target: "VI" },
    { sourceLanguage: "no" as const, targetLanguage: "pt" as const, source: "NB", target: "PT-BR" },
    { sourceLanguage: "zh" as const, targetLanguage: "en" as const, source: "ZH", target: "EN-US" },
  ];
  for (const entry of cases) {
    const harness = createHarness();
    await harness.client.translate({ ...baseInput, ...entry });
    const body = JSON.parse(harness.requests[0]!.body!) as {
      source_lang: string;
      target_lang: string;
    };
    expect(body.source_lang).toBe(entry.source);
    expect(body.target_lang).toBe(entry.target);
  }
});

test("DeepLX client: maps statuses and unreadable answers to localized errors without retrying", async () => {
  const cases: Array<{ status: number; kind: string; message: string }> = [
    { status: 401, kind: "auth", message: t("deeplx.error.auth") },
    { status: 403, kind: "auth", message: t("deeplx.error.accessDenied") },
    { status: 429, kind: "rate_limited", message: t("deeplx.error.rateLimited") },
    { status: 413, kind: "invalid_request", message: t("deeplx.error.tooLarge") },
    { status: 400, kind: "invalid_request", message: t("deeplx.error.rejected") },
    { status: 500, kind: "server", message: t("deeplx.error.server") },
    { status: 503, kind: "server", message: t("deeplx.error.server") },
  ];
  for (const entry of cases) {
    const harness = createHarness(() =>
      jsonResponse({ message: "raw provider detail" }, entry.status),
    );
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe(entry.kind);
    expect(error.message).toBe(entry.message);
    expect(error.message).not.toContain("raw provider detail");
    expect(error.status).toBe(entry.status);
    expect(harness.requests).toHaveLength(1);
  }

  const payloads: unknown[] = [
    {},
    { code: 500, data: "raw provider detail" },
    { code: "200", data: "你好" },
    { code: 200 },
    { code: 200, data: "" },
    { code: 200, data: "   " },
    { code: 200, data: ["你好"] },
    { code: 200, data: 42 },
  ];
  for (const payload of payloads) {
    const harness = createHarness(() => jsonResponse(payload));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(t("deeplx.error.invalidResponse"));
    expect(harness.requests).toHaveLength(1);
  }
});

test("DeepLX client: passes timeout and cancellation through without retrying", async () => {
  const aborted = createHarness();
  const controller = new AbortController();
  controller.abort();
  const cancelledBefore = await catchProtocolError(() =>
    aborted.client.translate(baseInput, { signal: controller.signal }),
  );
  expect(cancelledBefore.kind).toBe("cancelled");
  expect(aborted.requests).toHaveLength(0);

  const reading = createHarness(() => ({
    ok: true,
    status: 200,
    json: () => new Promise<unknown>(() => {}),
  }));
  const readingController = new AbortController();
  const readingPromise = reading.client.translate(baseInput, { signal: readingController.signal });
  while (reading.requests.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  readingController.abort();
  const cancelledDuring = await catchProtocolError(() => readingPromise);
  expect(cancelledDuring.kind).toBe("cancelled");

  const slow = createHarness(() => ({
    ok: true,
    status: 200,
    json: () => new Promise<unknown>(() => {}),
  }));
  const timedOut = await catchProtocolError(() =>
    slow.client.translate(baseInput, { timeoutMs: 10 }),
  );
  expect(timedOut.kind).toBe("timeout");

  const unreadable = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("invalid JSON at position 0");
    },
  }));
  const unreadableError = await catchProtocolError(() => unreadable.client.translate(baseInput));
  expect(unreadableError.kind).toBe("invalid_response");
  expect(unreadableError.message).toBe(t("deeplx.error.invalidResponse"));
});

test("DeepLX client: keeps the token and text out of logs and the user-facing error", async () => {
  const token = "secret-server-token";
  const text = "Private sentence to translate";
  const input = { ...baseInput, token, text };
  const previousLevel = logLevel();
  setLogLevel("info");

  let readErrorBody = false;
  const echoed = createHarness(
    () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({ error: `${token} ${text}` }),
        text: async () => {
          readErrorBody = true;
          return `${token} ${text}`;
        },
      }) as HttpResponseLike,
  );
  const echoedCapture = captureConsole();
  let echoedError: ProviderProtocolError | null = null;
  try {
    echoedError = await catchProtocolError(() => echoed.client.translate(input));
  } finally {
    echoedCapture.restore();
    setLogLevel(previousLevel);
  }
  expect(echoedError!.message).not.toContain(token);
  expect(echoedError!.message).not.toContain(text);
  expect(readErrorBody).toBe(false);
  expect(echoedCapture.text()).not.toContain(token);
  expect(echoedCapture.text()).not.toContain(text);

  const throwing = createHarness(() => {
    throw new Error(`socket failed sending ${token} and ${text}`);
  });
  setLogLevel("info");
  const throwingCapture = captureConsole();
  let throwingError: ProviderProtocolError | null = null;
  try {
    throwingError = await catchProtocolError(() => throwing.client.translate(input));
  } finally {
    throwingCapture.restore();
    setLogLevel(previousLevel);
  }
  expect(throwingError!.kind).toBe("network");
  expect(throwingError!.message).not.toContain(token);
  expect(throwingError!.message).not.toContain(text);
  expect(throwingCapture.text()).not.toContain(token);
  expect(throwingCapture.text()).not.toContain(text);
});
