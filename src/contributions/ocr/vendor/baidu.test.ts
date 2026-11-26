import { expect, test } from "nsh/test";
import type { FetchLike, HttpResponseLike } from "../../../services/http";
import { logLevel, setLogLevel } from "../../../services/log";
import { createBaiduOcrClient, type BaiduOcrOperation, type BaiduOcrRecognition } from "./baidu";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
  signal?: AbortSignal;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = (crc & 1) === 1 ? 0xedb88320 : 0;
      crc = (crc >>> 1) ^ mask;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crc = crc32(crcInput);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc);
  return out;
}

function syntheticPng(width: number, height: number): Uint8Array {
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  const iend = pngChunk("IEND", new Uint8Array());
  const header = pngChunk("IHDR", ihdr);
  const png = new Uint8Array(signature.length + header.length + iend.length);
  png.set(signature, 0);
  png.set(header, signature.length);
  png.set(iend, signature.length + header.length);
  return png;
}

const PNG = syntheticPng(16, 16);
const API_KEY = "api+key";
const SECRET_KEY = "secret/key=";
const ACCESS_TOKEN = "tok+en/=";

function streamResponse(value: unknown, status = 200): HttpResponseLike {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    json: async () => value,
  };
}

/** A streamed JSON response whose content type makes the transport treat its body as text. */
function streamJsonResponse(value: unknown, status = 200): HttpResponseLike {
  return { ...streamResponse(value, status), headers: { get: () => "application/json" } };
}

type Level = "debug" | "info";

interface Captured {
  calls: unknown[][];
  restore(): void;
}

/** Replaces one `console` method so a test reads what the transport logged. */
function capture(level: Level): Captured {
  const calls: unknown[][] = [];
  const methods = console as unknown as Record<Level, (...data: unknown[]) => void>;
  const original = methods[level];
  methods[level] = (...data: unknown[]) => {
    calls.push(data);
  };
  return {
    calls,
    restore: () => {
      methods[level] = original;
    },
  };
}

function createHarness(
  respond: (
    request: RecordedRequest,
    index: number,
  ) => HttpResponseLike | Promise<HttpResponseLike>,
) {
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
    return respond(request, requests.length - 1);
  };
  return { requests, client: createBaiduOcrClient({ fetchImpl }) };
}

function recognizedText(): unknown {
  return {
    words_result: [
      { words: "First line", location: { left: 1, top: 2 } },
      { words: "  \u7b2c\u4e8c\u884c  ", location: { left: 4 } },
    ],
    words_result_num: 2,
  };
}

test("baidu ocr: exchanges a token and reads accurate text", async () => {
  const harness = createHarness((_request, index) => {
    if (index === 0) return streamResponse({ access_token: ACCESS_TOKEN });
    return streamResponse(recognizedText());
  });

  const result = await harness.client.recognize({
    operation: "accurate",
    credentials: { apiKey: API_KEY, secretKey: SECRET_KEY },
    png: PNG,
  });

  expect(result).toEqual({ status: "recognized", text: "First line\n\u7b2c\u4e8c\u884c" });
  expect(harness.requests).toHaveLength(2);

  const token = harness.requests[0]!;
  expect(token.url).toBe("https://aip.baidubce.com/oauth/2.0/token");
  expect(token.method).toBe("POST");
  expect(token.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  expect(token.redirect).toBe("error");
  const tokenForm = new URLSearchParams(token.body);
  expect(tokenForm.get("grant_type")).toBe("client_credentials");
  expect(tokenForm.get("client_id")).toBe(API_KEY);
  expect(tokenForm.get("client_secret")).toBe(SECRET_KEY);
  expect(token.body).not.toContain(API_KEY);
  expect(token.body).not.toContain(SECRET_KEY);

  const ocr = harness.requests[1]!;
  const ocrUrl = new URL(ocr.url);
  expect(ocrUrl.origin + ocrUrl.pathname).toBe("https://aip.baidubce.com/rest/2.0/ocr/v1/accurate");
  expect(ocrUrl.searchParams.get("access_token")).toBe(ACCESS_TOKEN);
  expect(ocr.url).not.toContain(ACCESS_TOKEN);
  expect(ocr.method).toBe("POST");
  expect(ocr.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  expect(ocr.redirect).toBe("error");
  const ocrForm = new URLSearchParams(ocr.body);
  const image = Buffer.from(PNG).toString("base64");
  expect(ocrForm.get("image")).toBe(image);
  expect(ocrForm.get("language_type")).toBe("auto_detect");
  expect(Array.from(ocrForm.keys()).sort()).toEqual(["image", "language_type"]);
  expect(ocrForm.get("image")!.startsWith("data:")).toBe(false);
  if (/[+/=]/.test(image)) expect(ocr.body).not.toContain(image);
});

test("baidu ocr: token exchange does not log credentials", async () => {
  const tokenEndpoint = "https://aip.baidubce.com/oauth/2.0/token";
  const maskedOcrEndpoint = "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=***";
  const previousLevel = logLevel();
  setLogLevel("info");
  const info = capture("info");
  const debug = capture("debug");
  const harness = createHarness((_request, index) => {
    if (index === 0) return streamJsonResponse({ access_token: ACCESS_TOKEN });
    return streamJsonResponse(recognizedText());
  });

  let result: BaiduOcrRecognition;
  try {
    result = await harness.client.recognize({
      operation: "accurate",
      credentials: { apiKey: API_KEY, secretKey: SECRET_KEY },
      png: PNG,
    });
  } finally {
    info.restore();
    debug.restore();
    setLogLevel(previousLevel);
  }

  expect(result).toEqual({ status: "recognized", text: "First line\n\u7b2c\u4e8c\u884c" });
  expect(info.calls).toEqual([
    [`[ocr/baidu] request POST ${tokenEndpoint}`],
    [`[ocr/baidu] response 200 POST ${tokenEndpoint}`],
    [`[ocr/baidu] request POST ${maskedOcrEndpoint}`],
    [`[ocr/baidu] response 200 POST ${maskedOcrEndpoint}`],
  ]);

  const debugLines = debug.calls.map(([line]) => String(line));
  expect(debugLines.filter((line) => line.includes(tokenEndpoint))).toEqual([]);
  expect(
    debugLines.some((line) => line.includes("request body") && line.includes(maskedOcrEndpoint)),
  ).toBe(true);

  const markers = [
    API_KEY,
    SECRET_KEY,
    ACCESS_TOKEN,
    encodeURIComponent(API_KEY),
    encodeURIComponent(SECRET_KEY),
    encodeURIComponent(ACCESS_TOKEN),
  ];
  const captured = [...info.calls, ...debug.calls].map(([line]) => String(line));
  for (const marker of markers) {
    expect(captured.some((line) => line.includes(marker))).toBe(false);
  }
});

const MODES: readonly [BaiduOcrOperation, string][] = [
  ["general_basic", "CHN_ENG"],
  ["accurate_basic", "auto_detect"],
  ["general", "CHN_ENG"],
  ["accurate", "auto_detect"],
];

test("baidu ocr: uses the documented path and language for each mode", async () => {
  for (const [operation, languageType] of MODES) {
    const harness = createHarness((_request, index) => {
      if (index === 0) return streamResponse({ access_token: "plain-token" });
      return streamResponse({ words_result: [{ words: "Line" }] });
    });
    const result = await harness.client.recognize({
      operation,
      credentials: { apiKey: "key", secretKey: "secret" },
      png: PNG,
    });
    expect(result).toEqual({ status: "recognized", text: "Line" });
    const ocrUrl = new URL(harness.requests[1]!.url);
    expect(ocrUrl.pathname).toBe("/rest/2.0/ocr/v1/" + operation);
    expect(new URLSearchParams(harness.requests[1]!.body).get("language_type")).toBe(languageType);
  }
});

test("baidu ocr: drops blank lines and rejects a malformed words result", async () => {
  const cases: { body: unknown; expected: BaiduOcrRecognition }[] = [
    { body: { words_result: [] }, expected: { status: "no_text" } },
    {
      body: { words_result: [{ words: "  " }, { words: "" }], words_result_num: 2 },
      expected: { status: "no_text" },
    },
    {
      body: { words_result: [{ words: "Kept" }] },
      expected: { status: "recognized", text: "Kept" },
    },
    { body: { log_id: 1 }, expected: { status: "failed", failure: "malformed" } },
    {
      body: { words_result: [{ words: "Kept" }, { words: 2 }] },
      expected: { status: "failed", failure: "malformed" },
    },
    {
      body: { words_result: [{ words: "Kept" }], words_result_num: 2 },
      expected: { status: "failed", failure: "malformed" },
    },
  ];

  for (const item of cases) {
    const harness = createHarness((_request, index) => {
      if (index === 0) return streamResponse({ access_token: "plain-token" });
      return streamResponse(item.body);
    });
    const result = await harness.client.recognize({
      operation: "accurate",
      credentials: { apiKey: "key", secretKey: "secret" },
      png: PNG,
    });
    expect(result).toEqual(item.expected);
  }
});

function paddedPng(width: number, height: number, total: number): Uint8Array {
  const base = syntheticPng(width, height);
  const out = new Uint8Array(total);
  out.set(base, 0);
  return out;
}

function encodedImageLength(bytes: Uint8Array): number {
  const image = Buffer.from(bytes).toString("base64");
  return new URLSearchParams({ image }).toString().length - "image=".length;
}

async function recognizePng(png: Uint8Array) {
  const harness = createHarness((_request, index) => {
    if (index === 0) return streamResponse({ access_token: "plain-token" });
    return streamResponse({ words_result: [{ words: "Line" }] });
  });
  const result = await harness.client.recognize({
    operation: "accurate",
    credentials: { apiKey: "key", secretKey: "secret" },
    png,
  });
  return { result, requests: harness.requests };
}

test("baidu ocr: rejects a bad header or out-of-range crop before any request", async () => {
  const bad = await recognizePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  expect(bad.result).toEqual({ status: "failed", failure: "invalid_image" });
  expect(bad.requests).toHaveLength(0);

  const truncated = await recognizePng(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(truncated.result).toEqual({ status: "failed", failure: "invalid_image" });
  expect(truncated.requests).toHaveLength(0);

  const tooNarrow = await recognizePng(syntheticPng(14, 15));
  expect(tooNarrow.result).toEqual({ status: "failed", failure: "image_too_small" });
  expect(tooNarrow.requests).toHaveLength(0);

  const tooShort = await recognizePng(syntheticPng(15, 14));
  expect(tooShort.result).toEqual({ status: "failed", failure: "image_too_small" });
  expect(tooShort.requests).toHaveLength(0);

  const minSide = await recognizePng(syntheticPng(15, 15));
  expect(minSide.result).toEqual({ status: "recognized", text: "Line" });
  expect(minSide.requests).toHaveLength(2);

  const maxSide = await recognizePng(syntheticPng(4096, 4096));
  expect(maxSide.result).toEqual({ status: "recognized", text: "Line" });
  expect(maxSide.requests).toHaveLength(2);

  const tooWide = await recognizePng(syntheticPng(4097, 15));
  expect(tooWide.result).toEqual({ status: "failed", failure: "image_too_large" });
  expect(tooWide.requests).toHaveLength(0);

  const tooTall = await recognizePng(syntheticPng(15, 4097));
  expect(tooTall.result).toEqual({ status: "failed", failure: "image_too_large" });
  expect(tooTall.requests).toHaveLength(0);

  const rawLimit = 3 * 1024 * 1024;
  const overRaw = await recognizePng(paddedPng(16, 16, rawLimit + 1));
  expect(overRaw.result).toEqual({ status: "failed", failure: "image_too_large" });
  expect(overRaw.requests).toHaveLength(0);

  const exactEncoded = paddedPng(16, 16, 2999995);
  const overEncoded = paddedPng(16, 16, 2999998);
  expect(exactEncoded.byteLength).toBeLessThanOrEqual(rawLimit);
  expect(overEncoded.byteLength).toBeLessThanOrEqual(rawLimit);
  expect(encodedImageLength(exactEncoded)).toBe(4000000);
  expect(encodedImageLength(overEncoded)).toBe(4000004);

  const atFormLimit = await recognizePng(exactEncoded);
  expect(atFormLimit.result).toEqual({ status: "recognized", text: "Line" });
  expect(atFormLimit.requests).toHaveLength(2);

  const overForm = await recognizePng(overEncoded);
  expect(overForm.result).toEqual({ status: "failed", failure: "image_too_large" });
  expect(overForm.requests).toHaveLength(0);
});

const SECRET = "SENTINEL-SECRET";

function assertSafe(result: BaiduOcrRecognition) {
  const raw = JSON.stringify(result);
  expect(raw.includes(SECRET)).toBe(false);
  expect(raw.includes("evil.example")).toBe(false);
}

function bytesResponse(bytes: Uint8Array, status = 200): HttpResponseLike {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

test("baidu ocr: maps provider failures without returning secrets or partial text", async () => {
  const cases: {
    respond: (
      request: RecordedRequest,
      index: number,
    ) => HttpResponseLike | Promise<HttpResponseLike>;
    expected: BaiduOcrRecognition;
    requests: number;
  }[] = [
    {
      respond: () =>
        bytesResponse(jsonBytes({ error: "invalid_client", error_description: SECRET }), 401),
      expected: { status: "failed", failure: "credentials" },
      requests: 1,
    },
    {
      respond: () =>
        bytesResponse(jsonBytes({ error: "invalid_client", error_description: SECRET }), 400),
      expected: { status: "failed", failure: "credentials" },
      requests: 1,
    },
    {
      respond: () => streamResponse({ error: "invalid_client", error_description: SECRET }),
      expected: { status: "failed", failure: "credentials" },
      requests: 1,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : bytesResponse(jsonBytes({ error_code: 6, error_msg: SECRET }), 403),
      expected: { status: "failed", failure: "credentials" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({
              error_code: 110,
              error_msg: SECRET,
              words_result: [{ words: "Nope" }],
            }),
      expected: { status: "failed", failure: "credentials" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({ error_code: 111, error_msg: SECRET }),
      expected: { status: "failed", failure: "credentials" },
      requests: 2,
    },
    {
      respond: () => bytesResponse(jsonBytes({ error: "rate", error_description: SECRET }), 429),
      expected: { status: "failed", failure: "rate_limited" },
      requests: 1,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({ error_code: 4, error_msg: SECRET, words_result: [{ words: "Nope" }] }),
      expected: { status: "failed", failure: "rate_limited" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({
              error_code: 18,
              error_msg: SECRET,
              words_result: [{ words: "Nope" }],
            }),
      expected: { status: "failed", failure: "rate_limited" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({ error_code: 17, error_msg: SECRET }),
      expected: { status: "failed", failure: "quota" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({ error_code: 19, error_msg: SECRET }),
      expected: { status: "failed", failure: "quota" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : bytesResponse(jsonBytes({ error_msg: SECRET }), 413),
      expected: { status: "failed", failure: "image_too_large" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({
              error_code: 216202,
              error_msg: SECRET,
              words_result: [{ words: "Nope" }],
            }),
      expected: { status: "failed", failure: "image_too_large" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : streamResponse({
              error_code: 100,
              error_msg: SECRET,
              words_result: [{ words: "Nope" }],
            }),
      expected: { status: "failed", failure: "service" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : bytesResponse(jsonBytes({ error_msg: SECRET }), 500),
      expected: { status: "failed", failure: "service" },
      requests: 2,
    },
    {
      respond: (_request, index) =>
        index === 0
          ? streamResponse({ access_token: "plain-token" })
          : bytesResponse(new TextEncoder().encode("{"), 200),
      expected: { status: "failed", failure: "malformed" },
      requests: 2,
    },
  ];

  for (const item of cases) {
    const harness = createHarness(item.respond);
    const result = await harness.client.recognize({
      operation: "general",
      credentials: { apiKey: "key", secretKey: "secret" },
      png: PNG,
    });
    expect(result).toEqual(item.expected);
    expect(harness.requests).toHaveLength(item.requests);
    assertSafe(result);
  }
});

test("baidu ocr: treats network and redirect errors as service failures", async () => {
  const harness = createHarness(() => {
    throw new Error("connect " + SECRET + " https://evil.example/oauth/2.0/token");
  });
  const failed = await harness.client.recognize({
    operation: "accurate",
    credentials: { apiKey: "key", secretKey: "secret" },
    png: PNG,
  });
  expect(failed).toEqual({ status: "failed", failure: "service" });
  assertSafe(failed);

  const redirected = createHarness((_request, index) => {
    if (index === 0) return streamResponse({ access_token: "plain-token" });
    throw new Error("redirect to https://evil.example/ocr?access_token=" + SECRET);
  });
  const result = await redirected.client.recognize({
    operation: "accurate",
    credentials: { apiKey: "key", secretKey: "secret" },
    png: PNG,
  });
  expect(result).toEqual({ status: "failed", failure: "service" });
  expect(redirected.requests).toHaveLength(2);
  expect(redirected.requests[0]!.redirect).toBe("error");
  expect(redirected.requests[1]!.redirect).toBe("error");
  assertSafe(result);
});

test("baidu ocr: stops reading an oversized token or OCR body before parsing it", async () => {
  const tokenJson = JSON.stringify({ access_token: "plain-token" });
  const tokenExact = tokenJson + " ".repeat(8 * 1024 - tokenJson.length);
  const tokenOver = tokenExact + " " + SECRET;
  const exactToken = await recognizePng(PNG);
  expect(exactToken.requests).toHaveLength(2);

  const overToken = createHarness(() => bytesResponse(new TextEncoder().encode(tokenOver)));
  const overTokenResult = await overToken.client.recognize({
    operation: "accurate",
    credentials: { apiKey: "key", secretKey: "secret" },
    png: PNG,
  });
  expect(overTokenResult).toEqual({ status: "failed", failure: "malformed" });
  expect(overToken.requests).toHaveLength(1);
  assertSafe(overTokenResult);

  const atTokenLimit = createHarness((_request, index) => {
    if (index === 0) return bytesResponse(new TextEncoder().encode(tokenExact));
    return streamResponse({ words_result: [{ words: "Kept" }] });
  });
  const atToken = await atTokenLimit.client.recognize({
    operation: "accurate",
    credentials: { apiKey: "key", secretKey: "secret" },
    png: PNG,
  });
  expect(atToken).toEqual({ status: "recognized", text: "Kept" });

  const wordsJson = JSON.stringify({ words_result: [{ words: "Nope" }] });
  const ocrOver = wordsJson + " ".repeat(2 * 1024 * 1024 - wordsJson.length) + SECRET;
  const overOcr = createHarness((_request, index) => {
    if (index === 0) return streamResponse({ access_token: "plain-token" });
    return bytesResponse(new TextEncoder().encode(ocrOver));
  });
  const overOcrResult = await overOcr.client.recognize({
    operation: "accurate",
    credentials: { apiKey: "key", secretKey: "secret" },
    png: PNG,
  });
  expect(overOcrResult).toEqual({ status: "failed", failure: "malformed" });
  assertSafe(overOcrResult);
});

test("baidu ocr: cancellation before exchange sends no request", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = createHarness(() => {
    throw new Error("fetch " + SECRET);
  });
  const result = await harness.client.recognize(
    { operation: "accurate", credentials: { apiKey: "key", secretKey: "secret" }, png: PNG },
    { signal: controller.signal },
  );
  expect(result).toEqual({ status: "cancelled" });
  expect(harness.requests).toHaveLength(0);
  assertSafe(result);
});

test("baidu ocr: abort while waiting for a token does not upload", async () => {
  const requests: RecordedRequest[] = [];
  const controller = new AbortController();
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
      signal: init.signal,
    });
    await new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("hung")), 5000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted " + SECRET));
      });
    });
    throw new Error("unreachable");
  };
  const client = createBaiduOcrClient({ fetchImpl });
  const pending = client.recognize(
    { operation: "accurate", credentials: { apiKey: "key", secretKey: "secret" }, png: PNG },
    { signal: controller.signal, timeoutMs: 5000 },
  );
  while (requests.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  const result = await pending;
  expect(result).toEqual({ status: "cancelled" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toContain("/oauth/2.0/token");
  assertSafe(result);
});

test("baidu ocr: times out during the OCR body without returning text", async () => {
  const harness = createHarness((_request, index) => {
    if (index === 0) return streamResponse({ access_token: "plain-token" });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ words_result: [{ words: "Late" }] })),
          );
          controller.close();
        }, 250);
      },
      cancel() {
        if (timer !== null) clearTimeout(timer);
      },
    });
    return {
      ok: true,
      status: 200,
      body,
      json: async () => ({ words_result: [{ words: "Late" }] }),
    };
  });
  const result = await harness.client.recognize(
    { operation: "accurate", credentials: { apiKey: "key", secretKey: "secret" }, png: PNG },
    { timeoutMs: 40 },
  );
  expect(result).toEqual({ status: "failed", failure: "timeout" });
  expect(harness.requests).toHaveLength(2);
  expect(JSON.stringify(result).includes("Late")).toBe(false);
});
