import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import type { LanguageId } from "../../framework/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { FetchLike, HttpResponseLike } from "../../services/http";
import {
  createGoogleCloudTranslateClient,
  GOOGLE_CLOUD_TRANSLATION_MAX_REQUEST_BYTES,
} from "./client";

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

function errorResponse(value: unknown, status: number): HttpResponseLike {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { ok: false, status, json: async () => JSON.parse(text), text: async () => text };
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
    return jsonResponse({ data: { translations: [{ translatedText: "你好" }] } });
  };
  return { requests, client: createGoogleCloudTranslateClient({ fetchImpl }) };
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

const baseInput = {
  apiKey: "test-key",
  text: "Hello\nWorld",
  sourceLanguage: "en" as const,
  targetLanguage: "zh" as const,
};

test("google cloud client: sends one plain-text request with the key in the header and returns the translated text", async () => {
  const harness = createHarness();

  const text = await harness.client.translate(baseInput);
  expect(text).toBe("你好");
  expect(harness.requests).toHaveLength(1);

  const [request] = harness.requests;
  expect(request!.url).toBe("https://translation.googleapis.com/language/translate/v2");
  expect(request!.method).toBe("POST");
  expect(request!.headers["x-goog-api-key"]).toBe("test-key");
  expect(request!.headers["Content-Type"]).toBe("application/json");
  expect(request!.redirect).toBe("error");
  expect(request!.url).not.toContain("test-key");
  expect(request!.url).not.toContain("Hello");
  expect(JSON.parse(request!.body!)).toEqual({
    q: ["Hello\nWorld"],
    source: "en",
    target: "zh-CN",
    format: "text",
  });
});

test("google cloud client: sends one detect request with the sample as a single q entry", async () => {
  const harness = createHarness(() =>
    jsonResponse({ data: { detections: [[{ language: "zh-CN", confidence: 0.91 }]] } }),
  );

  const code = await harness.client.detect({ apiKey: "test-key", text: " 你好 " });

  expect(code).toBe("zh-CN");
  expect(harness.requests).toHaveLength(1);
  const [request] = harness.requests;
  expect(request!.url).toBe("https://translation.googleapis.com/language/translate/v2/detect");
  expect(request!.method).toBe("POST");
  expect(request!.headers["x-goog-api-key"]).toBe("test-key");
  expect(request!.headers["Content-Type"]).toBe("application/json");
  expect(request!.redirect).toBe("error");
  expect(request!.url).not.toContain("test-key");
  expect(request!.url).not.toContain("你好");
  expect(JSON.parse(request!.body!)).toEqual({ q: [" 你好 "] });
});

test("google cloud client: rejects a blank key, blank sample, and unreadable detect response", async () => {
  const harness = createHarness();

  const missing = await catchProtocolError(() =>
    harness.client.detect({ apiKey: "   ", text: "Hello" }),
  );
  expect(missing.kind).toBe("auth");
  expect(missing.message).toBe(t("googleCloud.error.missingKey"));

  const blank = await catchProtocolError(() =>
    harness.client.detect({ apiKey: "test-key", text: "  \n\t " }),
  );
  expect(blank.kind).toBe("invalid_request");
  expect(blank.message).toBe(t("googleCloud.error.blankInput"));
  expect(harness.requests).toHaveLength(0);

  const payloads = [
    {},
    { data: {} },
    { data: { detections: [] } },
    { data: { detections: [[]] } },
    { data: { detections: [[{ language: 5 }]] } },
    { data: { detections: ["text"] } },
  ];
  for (const payload of payloads) {
    const unreadable = createHarness(() => jsonResponse(payload));
    const error = await catchProtocolError(() =>
      unreadable.client.detect({ apiKey: "test-key", text: "Hello" }),
    );
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(t("googleCloud.error.invalidResponse"));
    expect(unreadable.requests).toHaveLength(1);
  }

  const rejected = createHarness(() =>
    errorResponse({ error: { errors: [{ reason: "keyInvalid" }] } }, 403),
  );
  const keyError = await catchProtocolError(() =>
    rejected.client.detect({ apiKey: "bad-key", text: "Hello" }),
  );
  expect(keyError.kind).toBe("auth");
  expect(keyError.message).toBe(t("googleCloud.error.auth"));
});

test("google cloud client: rejects a blank key, blank input, or invalid language before HTTP", async () => {
  const harness = createHarness();

  const missing = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, apiKey: "   " }),
  );
  expect(missing.kind).toBe("auth");
  expect(missing.message).toBe(t("googleCloud.error.missingKey"));

  const blank = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, text: "  \n\t " }),
  );
  expect(blank.kind).toBe("invalid_request");
  expect(blank.message).toBe(t("googleCloud.error.blankInput"));

  for (const pair of [
    { sourceLanguage: "auto", targetLanguage: "zh" },
    { sourceLanguage: "en", targetLanguage: "auto" },
    { sourceLanguage: "xx", targetLanguage: "zh" },
    { sourceLanguage: "en", targetLanguage: "xx" },
  ]) {
    const invalid = await catchProtocolError(() =>
      harness.client.translate({
        ...baseInput,
        sourceLanguage: pair.sourceLanguage as LanguageId,
        targetLanguage: pair.targetLanguage as LanguageId,
      }),
    );
    expect(invalid.kind).toBe("invalid_request");
    expect(invalid.message).toBe(t("googleCloud.error.unsupportedLanguage"));
  }

  expect(harness.requests).toHaveLength(0);
});

test("google cloud client: enforces the 100K-byte serialized limit with UTF-8 bytes, not code points", async () => {
  const harness = createHarness();

  const overhead = new TextEncoder().encode(
    JSON.stringify({ q: [""], source: "en", target: "zh-CN", format: "text" }),
  ).length;
  const exact = "a".repeat(GOOGLE_CLOUD_TRANSLATION_MAX_REQUEST_BYTES - overhead);
  expect(
    new TextEncoder().encode(
      JSON.stringify({ q: [exact], source: "en", target: "zh-CN", format: "text" }),
    ).length,
  ).toBe(GOOGLE_CLOUD_TRANSLATION_MAX_REQUEST_BYTES);
  expect(await harness.client.translate({ ...baseInput, text: exact })).toBe("你好");
  expect(harness.requests).toHaveLength(1);

  const over = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, text: `${exact}a` }),
  );
  expect(over.kind).toBe("invalid_request");
  expect(over.message).toBe(t("googleCloud.error.tooLarge"));
  expect(harness.requests).toHaveLength(1);

  // 33,334 CJK characters are 100,002 UTF-8 bytes even though they are far under 100,000 code points.
  const multibyte = "你".repeat(33_334);
  const multibyteError = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, text: multibyte }),
  );
  expect(multibyteError.kind).toBe("invalid_request");
  expect(multibyteError.message).toBe(t("googleCloud.error.tooLarge"));
  expect(harness.requests).toHaveLength(1);

  // The 5,000-code-point latency recommendation is not a hard limit.
  expect(await harness.client.translate({ ...baseInput, text: "a".repeat(6_000) })).toBe("你好");
  expect(harness.requests).toHaveLength(2);
});

test("google cloud client: rejects an unreadable success response without retrying", async () => {
  const payloads = [
    {},
    { data: {} },
    { data: { translations: [] } },
    { data: { translations: [{}] } },
    { data: { translations: [{ translatedText: 5 }] } },
    { data: { translations: ["text"] } },
  ];
  for (const payload of payloads) {
    const harness = createHarness(() => jsonResponse(payload));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(t("googleCloud.error.invalidResponse"));
    expect(harness.requests).toHaveLength(1);
  }

  const unreadable = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  }));
  const error = await catchProtocolError(() => unreadable.client.translate(baseInput));
  expect(error.kind).toBe("invalid_response");
  expect(error.message).toBe(t("googleCloud.error.invalidResponse"));
  expect(unreadable.requests).toHaveLength(1);
});

test("google cloud client: passes cancellation through without a request or retry", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const abortedHarness = createHarness();
  const aborted = await catchProtocolError(() =>
    abortedHarness.client.translate(baseInput, { signal: alreadyAborted.signal }),
  );
  expect(aborted.kind).toBe("cancelled");
  expect(abortedHarness.requests).toHaveLength(0);

  const pending = createHarness(
    (_request) =>
      new Promise((_, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        void onAbort;
      }),
  );
  const controller = new AbortController();
  const call = pending.client.translate(baseInput, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  const cancelled = await catchProtocolError(() => call);
  expect(cancelled.kind).toBe("cancelled");
  expect(pending.requests).toHaveLength(1);
});

test("google cloud client: reports documented daily-quota and rate-limit 403 bodies as limits, not key errors", async () => {
  const cases: Array<{ status: number; body: unknown; message: string }> = [
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Daily Limit Exceeded",
          errors: [
            {
              message: "Daily Limit Exceeded",
              domain: "usageLimits",
              reason: "dailyLimitExceeded",
            },
          ],
        },
      },
      message: t("googleCloud.error.quota"),
    },
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "quota",
          errors: [{ reason: "dailyLimitExceeded" }],
        },
      },
      message: t("googleCloud.error.quota"),
    },
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "User Rate Limit Exceeded",
          errors: [
            {
              message: "User Rate Limit Exceeded",
              domain: "usageLimits",
              reason: "userRateLimitExceeded",
            },
          ],
        },
      },
      message: t("googleCloud.error.rateLimited"),
    },
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Rate limit exceeded",
          errors: [{ reason: "rateLimitExceeded" }],
        },
      },
      message: t("googleCloud.error.rateLimited"),
    },
  ];

  for (const entry of cases) {
    const harness = createHarness(() => errorResponse(entry.body, entry.status));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe("rate_limited");
    expect(error.message).toBe(entry.message);
    expect(error.message).not.toContain("Daily Limit Exceeded");
    expect(error.status).toBe(entry.status);
    expect(harness.requests).toHaveLength(1);
  }
});

test("google cloud client: reports rejected or restricted keys, including key errors sent as 400", async () => {
  const cases: Array<{ status: number; body: unknown }> = [
    {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          errors: [
            { message: "API key not valid. Please pass a valid API key.", reason: "badRequest" },
          ],
        },
      },
    },
    {
      status: 400,
      body: { error: { code: 400, message: "Bad Request", errors: [{ reason: "keyInvalid" }] } },
    },
    {
      status: 401,
      body: { error: { code: 401, message: "Request had invalid authentication credentials." } },
    },
    {
      status: 403,
      body: { error: { code: 403, message: "The request is missing a valid API key." } },
    },
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Cloud Translation API has not been used in project 1 before or it is disabled.",
        },
      },
    },
    {
      status: 403,
      body: { error: { code: 403, message: "Some other forbidden response" } },
    },
  ];

  for (const entry of cases) {
    const harness = createHarness(() => errorResponse(entry.body, entry.status));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe("auth");
    expect(error.message).toBe(t("googleCloud.error.auth"));
    expect(error.status).toBe(entry.status);
    expect(harness.requests).toHaveLength(1);
  }
});

test("google cloud client: maps 429, 5xx, other 4xx, and non-JSON errors without raw provider text", async () => {
  const cases: Array<{ status: number; body: unknown; kind: string; message: string }> = [
    {
      status: 429,
      body: { error: { code: 429, message: "Too many requests" } },
      kind: "rate_limited",
      message: t("googleCloud.error.rateLimited"),
    },
    {
      status: 500,
      body: "raw provider detail",
      kind: "server",
      message: t("googleCloud.error.server"),
    },
    {
      status: 503,
      body: { error: { code: 503, message: "backend unavailable" } },
      kind: "server",
      message: t("googleCloud.error.server"),
    },
    {
      status: 400,
      body: { error: { code: 400, message: "Unsupported language pair" } },
      kind: "invalid_request",
      message: t("googleCloud.error.rejected"),
    },
    {
      status: 404,
      body: { error: { code: 404, message: "Not found" } },
      kind: "invalid_request",
      message: t("googleCloud.error.rejected"),
    },
    {
      status: 413,
      body: { error: { code: 413, message: "Request too large" } },
      kind: "invalid_request",
      message: t("googleCloud.error.tooLarge"),
    },
    {
      status: 403,
      body: "{not json",
      kind: "auth",
      message: t("googleCloud.error.auth"),
    },
    {
      status: 500,
      body: "{not json",
      kind: "server",
      message: t("googleCloud.error.server"),
    },
  ];

  for (const entry of cases) {
    const harness = createHarness(() => errorResponse(entry.body, entry.status));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe(entry.kind);
    expect(error.message).toBe(entry.message);
    expect(error.message).not.toContain("raw provider detail");
    expect(error.message).not.toContain("not json");
    expect(harness.requests).toHaveLength(1);
  }
});

test("google cloud client: keeps cancellation and timeout active while reading an error body", async () => {
  const pendingErrorResponse = (): HttpResponseLike => ({
    ok: false,
    status: 403,
    json: async () => ({}),
    text: () => new Promise<string>(() => {}),
  });

  const abortHarness = createHarness(() => pendingErrorResponse());
  const controller = new AbortController();
  const call = abortHarness.client.translate(baseInput, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const cancelled = await catchProtocolError(() => call);
  expect(cancelled.kind).toBe("cancelled");
  expect(abortHarness.requests).toHaveLength(1);

  const timeoutHarness = createHarness(() => pendingErrorResponse());
  const timedOut = await catchProtocolError(() =>
    timeoutHarness.client.translate(baseInput, { timeoutMs: 10 }),
  );
  expect(timedOut.kind).toBe("timeout");
  expect(timeoutHarness.requests).toHaveLength(1);
});
