import { expect, test } from "nsh/test";
import type { FetchLike, HttpResponseLike } from "../../../services/http";
import {
  createGoogleCloudOcrClient,
  type GoogleCloudOcrFailureReason,
  type GoogleCloudOcrRecognition,
} from "./google-cloud";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
  signal?: AbortSignal;
}

const API_KEY = "vision-test-key";
const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const RECOGNIZED_TEXT = "Hello\n你好";
const ANNOTATE_URL = "https://vision.googleapis.com/v1/images:annotate";

function jsonResponse(value: unknown, status = 200): HttpResponseLike {
  const text = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => text,
    json: async () => value,
  };
}

function textResponse(text: string, status: number): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "text/plain" },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function hangingResponse(status: number): HttpResponseLike {
  const pending = () => new Promise<never>(() => {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: pending,
    text: pending,
  };
}

function createHarness(
  respond: (request: RecordedRequest) => HttpResponseLike | Promise<HttpResponseLike> = () =>
    jsonResponse({
      responses: [{ fullTextAnnotation: { text: RECOGNIZED_TEXT } }],
    }),
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
    return respond(request);
  };
  return { requests, client: createGoogleCloudOcrClient({ fetchImpl }) };
}

function recognized(text: string): unknown {
  return { responses: [{ fullTextAnnotation: { text, pages: [{ property: {} }] } }] };
}

function httpError(status: number, error: Record<string, unknown>): HttpResponseLike {
  return jsonResponse(
    { error: { code: status, message: "raw provider detail", ...error } },
    status,
  );
}

function info(reason: string, domain = "googleapis.com"): Record<string, unknown> {
  return {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain,
    metadata: { service: "vision.googleapis.com" },
  };
}

async function recognize(response: HttpResponseLike): Promise<{
  result: GoogleCloudOcrRecognition;
  requests: RecordedRequest[];
}> {
  const harness = createHarness(() => response);
  const result = await harness.client.recognize({ apiKey: API_KEY, imageBase64: IMAGE_BASE64 });
  return { result, requests: harness.requests };
}

test("google cloud ocr: posts one document text request and returns the original lines", async () => {
  const harness = createHarness();

  const result = await harness.client.recognize({
    apiKey: API_KEY,
    imageBase64: IMAGE_BASE64,
  });

  expect(result).toEqual({ status: "recognized", text: RECOGNIZED_TEXT });
  expect(harness.requests).toHaveLength(1);
  const request = harness.requests[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe(ANNOTATE_URL);
  expect(request.url).not.toContain("?");
  expect(request.url).not.toContain(API_KEY);
  expect(request.headers["Content-Type"]).toBe("application/json");
  expect(request.headers["x-goog-api-key"]).toBe(API_KEY);
  expect(request.redirect).toBe("error");
  expect(JSON.parse(request.body!)).toEqual({
    requests: [
      {
        image: { content: IMAGE_BASE64 },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      },
    ],
  });
});

test("google cloud ocr: keeps surrounding spaces when the annotation is not blank", async () => {
  const text = "  Hello \n 你好  ";
  const { result } = await recognize(jsonResponse(recognized(text)));
  expect(result).toEqual({ status: "recognized", text });
});

test("google cloud ocr: returns no text when the annotation is missing or blank", async () => {
  const payloads = [
    { responses: [{}] },
    { responses: [{ fullTextAnnotation: { text: "  \n\t" } }] },
    { responses: [{ error: { code: 0, message: "ok" } }] },
    { responses: [{ error: { code: 0 }, fullTextAnnotation: { text: "" } }] },
  ];
  for (const payload of payloads) {
    const { result, requests } = await recognize(jsonResponse(payload));
    expect(result).toEqual({ status: "no_text" });
    expect(requests).toHaveLength(1);
  }
});

test("google cloud ocr: rejects a malformed envelope or image error without importing text", async () => {
  const leaked = "Hello\n你好";
  const payloads = [
    {},
    { responses: [] },
    {
      responses: [{ fullTextAnnotation: { text: leaked } }, { fullTextAnnotation: { text: "x" } }],
    },
    { responses: [null] },
    { responses: ["text"] },
    { responses: [{ fullTextAnnotation: {} }] },
    { responses: [{ fullTextAnnotation: { text: 1 } }] },
    { responses: [{ fullTextAnnotation: null }] },
    { responses: [{ error: { message: "bad image" }, fullTextAnnotation: { text: leaked } }] },
    { responses: [{ error: { code: "7" }, fullTextAnnotation: { text: leaked } }] },
    { responses: [{ error: { code: 1.5 }, fullTextAnnotation: { text: leaked } }] },
    { responses: [{ error: null, fullTextAnnotation: { text: leaked } }] },
    [],
  ];
  for (const payload of payloads) {
    const { result, requests } = await recognize(jsonResponse(payload));
    expect(result).toEqual({ status: "failed", failure: "malformed" });
    expect(JSON.stringify(result)).not.toContain(leaked);
    expect(requests).toHaveLength(1);
  }

  const broken = await recognize(textResponse("{not json", 200));
  expect(broken.result).toEqual({ status: "failed", failure: "malformed" });
  expect(JSON.stringify(broken.result)).not.toContain("not json");
});

test("google cloud ocr: checks an image error before reading text", async () => {
  const leaked = "Hello\n你好";
  const cases: { error: Record<string, unknown>; failure: GoogleCloudOcrFailureReason }[] = [
    { error: { code: 7, message: leaked }, failure: "setup" },
    { error: { code: 16, message: leaked }, failure: "setup" },
    { error: { code: 8, message: leaked, status: "RESOURCE_EXHAUSTED" }, failure: "quota" },
    { error: { code: 3, message: leaked }, failure: "service" },
    {
      error: { code: 3, message: leaked, details: [info("API_KEY_INVALID")] },
      failure: "setup",
    },
    {
      error: { code: 3, message: leaked, details: [info("RATE_LIMIT_EXCEEDED")] },
      failure: "quota",
    },
    {
      error: { code: 7, message: leaked, details: [info("API_KEY_INVALID", "example.com")] },
      failure: "setup",
    },
    {
      error: {
        code: 3,
        message: leaked,
        details: [info("BILLING_DISABLED"), info("RESOURCE_QUOTA_EXCEEDED")],
      },
      failure: "quota",
    },
  ];
  for (const entry of cases) {
    const { result } = await recognize(
      jsonResponse({
        responses: [{ error: entry.error, fullTextAnnotation: { text: leaked } }],
      }),
    );
    expect(result).toEqual({ status: "failed", failure: entry.failure });
    expect(JSON.stringify(result)).not.toContain(leaked);
  }
});

test("google cloud ocr: sends nothing for a blank key or a cancelled call", async () => {
  const harness = createHarness();
  for (const apiKey of ["", "   ", "\n\t"]) {
    const blank = await harness.client.recognize({ apiKey, imageBase64: IMAGE_BASE64 });
    expect(blank).toEqual({ status: "failed", failure: "setup" });
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = await harness.client.recognize(
    { apiKey: API_KEY, imageBase64: IMAGE_BASE64 },
    { signal: controller.signal },
  );
  expect(cancelled).toEqual({ status: "cancelled" });
  expect(harness.requests).toHaveLength(0);
});

test("google cloud ocr: maps HTTP failures without exposing provider text", async () => {
  const cases: {
    status: number;
    error: Record<string, unknown>;
    failure: GoogleCloudOcrFailureReason;
  }[] = [
    { status: 401, error: {}, failure: "setup" },
    { status: 403, error: { details: [info("API_KEY_INVALID")] }, failure: "setup" },
    { status: 403, error: { details: [info("API_KEY_SERVICE_BLOCKED")] }, failure: "setup" },
    { status: 403, error: { details: [info("SERVICE_DISABLED")] }, failure: "setup" },
    { status: 403, error: { details: [info("BILLING_DISABLED")] }, failure: "setup" },
    { status: 403, error: { details: [info("API_KEY_INVALID", "example.com")] }, failure: "setup" },
    { status: 403, error: { details: [info("RATE_LIMIT_EXCEEDED")] }, failure: "quota" },
    { status: 403, error: { details: [info("RESOURCE_QUOTA_EXCEEDED")] }, failure: "quota" },
    { status: 429, error: { status: "RESOURCE_EXHAUSTED" }, failure: "quota" },
    { status: 413, error: {}, failure: "image_too_large" },
    { status: 400, error: {}, failure: "service" },
    { status: 500, error: {}, failure: "service" },
    { status: 302, error: {}, failure: "service" },
  ];
  for (const entry of cases) {
    const { result, requests } = await recognize(httpError(entry.status, entry.error));
    expect(result).toEqual({ status: "failed", failure: entry.failure });
    expect(JSON.stringify(result)).not.toContain("raw provider detail");
    expect(requests).toHaveLength(1);
  }

  const broken = await recognize(textResponse("{not json", 500));
  expect(broken.result).toEqual({ status: "failed", failure: "service" });
  expect(JSON.stringify(broken.result)).not.toContain("not json");

  const quotaStatus = await recognize(textResponse("{not json", 403));
  expect(quotaStatus.result).toEqual({ status: "failed", failure: "setup" });

  const redirect = createHarness(() => {
    throw new Error("redirect to https://evil.example/vision-test-key");
  });
  const redirected = await redirect.client.recognize({
    apiKey: API_KEY,
    imageBase64: IMAGE_BASE64,
  });
  expect(redirected).toEqual({ status: "failed", failure: "service" });
  expect(JSON.stringify(redirected)).not.toContain(API_KEY);
  expect(JSON.stringify(redirected)).not.toContain("evil.example");
  expect(redirect.requests).toHaveLength(1);
});

test("google cloud ocr: times out or cancels while the response is still being read", async () => {
  const abortHarness = createHarness(() => hangingResponse(200));
  const controller = new AbortController();
  const pending = abortHarness.client.recognize(
    { apiKey: API_KEY, imageBase64: IMAGE_BASE64 },
    { signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  expect(await pending).toEqual({ status: "cancelled" });
  expect(abortHarness.requests).toHaveLength(1);

  const timeoutHarness = createHarness(() => hangingResponse(200));
  const timedOut = await timeoutHarness.client.recognize(
    { apiKey: API_KEY, imageBase64: IMAGE_BASE64 },
    { timeoutMs: 20 },
  );
  expect(timedOut).toEqual({ status: "failed", failure: "timeout" });
  expect(timeoutHarness.requests).toHaveLength(1);

  const errorAbort = createHarness(() => hangingResponse(503));
  const errorController = new AbortController();
  const errorPending = errorAbort.client.recognize(
    { apiKey: API_KEY, imageBase64: IMAGE_BASE64 },
    { signal: errorController.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  errorController.abort();
  expect(await errorPending).toEqual({ status: "cancelled" });

  const errorTimeout = createHarness(() => hangingResponse(503));
  const errorTimedOut = await errorTimeout.client.recognize(
    { apiKey: API_KEY, imageBase64: IMAGE_BASE64 },
    { timeoutMs: 20 },
  );
  expect(errorTimedOut).toEqual({ status: "failed", failure: "timeout" });
});
