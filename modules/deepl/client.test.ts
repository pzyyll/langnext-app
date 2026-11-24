import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { FetchLike, HttpResponseLike } from "../../services/http";
import { createDeepLClient, DEEPL_MAX_REQUEST_BYTES, DEEPL_NO_CHARACTER_LIMIT } from "./client";

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
    return jsonResponse({ translations: [{ detected_source_language: "EN", text: "你好" }] });
  };
  return { requests, client: createDeepLClient({ fetchImpl }) };
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
  apiKey: "test-key:fx",
  text: "Hello\nWorld",
  sourceLanguage: "en" as const,
  targetLanguage: "zh" as const,
};

test("deepl client: sends both required languages to the Free host and returns the text", async () => {
  const harness = createHarness();

  const text = await harness.client.translate(baseInput);
  expect(text).toBe("你好");
  expect(harness.requests).toHaveLength(1);

  const [request] = harness.requests;
  expect(request!.url).toBe("https://api-free.deepl.com/v2/translate");
  expect(request!.method).toBe("POST");
  expect(request!.headers.Authorization).toBe("DeepL-Auth-Key test-key:fx");
  expect(request!.headers["Content-Type"]).toBe("application/json");
  expect(request!.redirect).toBe("error");
  expect(JSON.parse(request!.body!)).toEqual({
    text: ["Hello\nWorld"],
    source_lang: "EN",
    target_lang: "ZH-HANS",
  });
});

test("deepl client: uses the Pro host for keys without the Free marker", async () => {
  const harness = createHarness();
  await harness.client.translate({ ...baseInput, apiKey: "pro-key" });

  expect(harness.requests).toHaveLength(1);
  expect(harness.requests[0]!.url).toBe("https://api.deepl.com/v2/translate");
  expect(harness.requests[0]!.headers.Authorization).toBe("DeepL-Auth-Key pro-key");
});

test("deepl client: rejects a missing key or an unmapped language before HTTP", async () => {
  const harness = createHarness();

  const missing = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, apiKey: "   " }),
  );
  expect(missing.kind).toBe("auth");
  expect(missing.message).toBe(t("deepl.error.missingKey"));

  const unsupportedTarget = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, targetLanguage: "th" }),
  );
  expect(unsupportedTarget.kind).toBe("invalid_request");
  expect(unsupportedTarget.message).toBe(t("deepl.error.unsupportedLanguage"));

  const unsupportedSource = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, sourceLanguage: "th" }),
  );
  expect(unsupportedSource.kind).toBe("invalid_request");
  expect(unsupportedSource.message).toBe(t("deepl.error.unsupportedLanguage"));

  expect(harness.requests).toHaveLength(0);
});

test("deepl client: rejects a serialized body above the 128 KiB limit before HTTP", async () => {
  const harness = createHarness();
  const oversized = "a".repeat(DEEPL_MAX_REQUEST_BYTES);

  const error = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, text: oversized }),
  );
  expect(error.kind).toBe("invalid_request");
  expect(error.message).toBe(t("deepl.error.tooLarge"));
  expect(harness.requests).toHaveLength(0);
});

test("deepl client: maps 403/413/429/456/5xx to localized errors without retrying", async () => {
  const cases: Array<{ status: number; kind: string; message: string }> = [
    { status: 403, kind: "auth", message: t("deepl.error.auth") },
    { status: 413, kind: "invalid_request", message: t("deepl.error.tooLarge") },
    { status: 429, kind: "rate_limited", message: t("deepl.error.rateLimited") },
    { status: 456, kind: "rate_limited", message: t("deepl.error.quota") },
    { status: 500, kind: "server", message: t("deepl.error.server") },
    { status: 503, kind: "server", message: t("deepl.error.server") },
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
});

test("deepl client: reports unreadable responses without retrying", async () => {
  for (const payload of [{}, { translations: [] }, { translations: [{}] }, { translations: "x" }]) {
    const harness = createHarness(() => jsonResponse(payload));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(t("deepl.error.invalidResponse"));
    expect(harness.requests).toHaveLength(1);
  }
});

test("deepl client: passes cancellation through without a request", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort();

  const error = await catchProtocolError(() =>
    harness.client.translate(baseInput, { signal: controller.signal }),
  );
  expect(error.kind).toBe("cancelled");
  expect(harness.requests).toHaveLength(0);
});

test("deepl client: keeps the key out of network error details", async () => {
  const harness = createHarness(() => {
    throw new Error("socket failed while sending DeepL-Auth-Key secret-key:fx");
  });
  const error = await catchProtocolError(() => harness.client.translate(baseInput));
  expect(error.kind).toBe("network");
  expect(error.message).not.toContain("secret-key:fx");
  expect(harness.requests).toHaveLength(1);
});

test("deepl client: reads Free usage from the Free host", async () => {
  const harness = createHarness(() =>
    jsonResponse({ character_count: 180118, character_limit: 1250000 }),
  );

  const usage = await harness.client.getUsage({ apiKey: " test-key:fx " });
  expect(usage).toEqual({
    characterCount: 180118,
    characterLimit: 1250000,
    apiKeyCharacterCount: null,
    periodEnd: null,
  });

  expect(harness.requests).toHaveLength(1);
  const [request] = harness.requests;
  expect(request!.url).toBe("https://api-free.deepl.com/v2/usage");
  expect(request!.method).toBe("GET");
  expect(request!.headers.Authorization).toBe("DeepL-Auth-Key test-key:fx");
  expect(request!.redirect).toBe("error");
  expect(request!.body).toBeUndefined();
});

test("deepl client: reads Pro usage with the key count and period end", async () => {
  const harness = createHarness(() =>
    jsonResponse({
      character_count: 5947223,
      character_limit: 1000000000000,
      api_key_character_count: 636,
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2026-02-01T00:00:00Z",
    }),
  );

  const usage = await harness.client.getUsage({ apiKey: "pro-key" });
  expect(usage).toEqual({
    characterCount: 5947223,
    characterLimit: DEEPL_NO_CHARACTER_LIMIT,
    apiKeyCharacterCount: 636,
    periodEnd: "2026-02-01T00:00:00Z",
  });
  expect(harness.requests[0]!.url).toBe("https://api.deepl.com/v2/usage");
});

test("deepl client: rejects a usage request without a key or with unreadable counts", async () => {
  const harness = createHarness();

  const missing = await catchProtocolError(() => harness.client.getUsage({ apiKey: "   " }));
  expect(missing.kind).toBe("auth");
  expect(missing.message).toBe(t("deepl.error.missingKey"));
  expect(harness.requests).toHaveLength(0);

  const payloads = [
    {},
    { character_count: 1 },
    { character_limit: 5 },
    { character_count: -1, character_limit: 5 },
    { character_count: "1", character_limit: 5 },
  ];
  for (const payload of payloads) {
    const broken = createHarness(() => jsonResponse(payload));
    const error = await catchProtocolError(() => broken.client.getUsage({ apiKey: "pro-key" }));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(t("deepl.error.invalidResponse"));
    expect(broken.requests).toHaveLength(1);
  }
});

test("deepl client: maps a rejected usage request to localized copy", async () => {
  const harness = createHarness(() => jsonResponse({ message: "raw provider detail" }, 403));

  const error = await catchProtocolError(() => harness.client.getUsage({ apiKey: "bad-key" }));
  expect(error.kind).toBe("auth");
  expect(error.message).toBe(t("deepl.error.auth"));
  expect(error.message).not.toContain("raw provider detail");
  expect(harness.requests).toHaveLength(1);
});

test("deepl client: accepts an injected JSON transport", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = createDeepLClient({
    http: {
      getJson: async () => ({}),
      postEventStream: async () => {},
      postJson: async (target, body) => {
        calls.push({ url: target.url, body });
        return { translations: [{ text: "Hallo" }] };
      },
    },
  });
  expect(await client.translate({ ...baseInput, targetLanguage: "de" })).toBe("Hallo");
  expect(calls).toEqual([
    {
      url: "https://api-free.deepl.com/v2/translate",
      body: { text: ["Hello\nWorld"], source_lang: "EN", target_lang: "DE" },
    },
  ]);
});
