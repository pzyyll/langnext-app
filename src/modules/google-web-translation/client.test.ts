import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import type { LanguageId } from "../../framework/languages";
import { ProviderProtocolError } from "../ai/contracts/errors";
import type { FetchLike, HttpResponseLike } from "../../services/http";
import { createGoogleWebTranslateClient } from "./client";

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
    return jsonResponse(["你好"]);
  };
  return { requests, client: createGoogleWebTranslateClient({ fetchImpl }) };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  text: "Hello & welcome +\nGood morning",
  sourceLanguage: "en" as const,
  targetLanguage: "zh" as const,
};

test("Google Web client: sends one ordered form POST and returns the whole translated string", async () => {
  const harness = createHarness(() => jsonResponse(["您好，欢迎。\n早上好！"]));

  const text = await harness.client.translate(baseInput);
  expect(text).toBe("您好，欢迎。\n早上好！");
  expect(harness.requests).toHaveLength(1);

  const [request] = harness.requests;
  expect(request!.url).toBe(
    "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN",
  );
  expect(request!.method).toBe("POST");
  expect(request!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(request!.redirect).toBe("error");
  expect(request!.body).toBe(`q=${encodeURIComponent(baseInput.text)}`);

  const form = new URLSearchParams(request!.body);
  expect([...form.keys()]).toEqual(["q"]);
  expect(form.get("q")).toBe(baseInput.text);
  expect(request!.url).not.toContain("welcome");
});

test("Google Web client: zh maps to zh-CN in either direction and invalid input sends nothing", async () => {
  const toChinese = createHarness();
  await toChinese.client.translate({
    text: "Good morning",
    sourceLanguage: "en",
    targetLanguage: "zh",
  });
  expect(toChinese.requests[0]!.url).toBe(
    "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN",
  );

  const fromChinese = createHarness();
  await fromChinese.client.translate({
    text: "早上好",
    sourceLanguage: "zh",
    targetLanguage: "ja",
  });
  expect(fromChinese.requests[0]!.url).toBe(
    "https://translate.googleapis.com/translate_a/t?client=gtx&sl=zh-CN&tl=ja",
  );

  const harness = createHarness();
  const blank = await catchProtocolError(() =>
    harness.client.translate({ ...baseInput, text: "  \n\t " }),
  );
  expect(blank.kind).toBe("invalid_request");
  expect(blank.message).toBe(t("quickTranslate.error.blankInput"));

  for (const pair of [
    { sourceLanguage: "auto", targetLanguage: "zh" },
    { sourceLanguage: "en", targetLanguage: "auto" },
    { sourceLanguage: "xx", targetLanguage: "zh" },
    { sourceLanguage: "en", targetLanguage: "xx" },
  ]) {
    const invalid = await catchProtocolError(() =>
      harness.client.translate({
        ...baseInput,
        sourceLanguage: pair.sourceLanguage as unknown as LanguageId,
        targetLanguage: pair.targetLanguage as unknown as LanguageId,
      }),
    );
    expect(invalid.kind).toBe("invalid_request");
    expect(invalid.message).toBe(t("googleWeb.error.unsupportedLanguage"));
  }

  const controller = new AbortController();
  controller.abort();
  const aborted = await catchProtocolError(() =>
    harness.client.translate(baseInput, { signal: controller.signal }),
  );
  expect(aborted.kind).toBe("cancelled");
  expect(harness.requests).toHaveLength(0);
});

test("Google Web client: accepts only a one-element array with a non-blank string", async () => {
  const payloads: unknown[] = [[], ["a", "b"], [5], ["   "], [""], {}, "text", null, [[]]];
  for (const payload of payloads) {
    const harness = createHarness(() => jsonResponse(payload));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(t("googleWeb.error.invalidResponse"));
    expect(harness.requests).toHaveLength(1);
  }
});

test("Google Web client: maps 403, 429, 413, other 4xx, and 5xx without provider text", async () => {
  const cases: Array<{ status: number; kind: string; message: string }> = [
    { status: 403, kind: "auth", message: t("googleWeb.error.accessDenied") },
    { status: 429, kind: "rate_limited", message: t("googleWeb.error.rateLimited") },
    { status: 413, kind: "invalid_request", message: t("googleWeb.error.tooLarge") },
    { status: 400, kind: "invalid_request", message: t("googleWeb.error.rejected") },
    { status: 404, kind: "invalid_request", message: t("googleWeb.error.rejected") },
    { status: 500, kind: "server", message: t("googleWeb.error.server") },
    { status: 503, kind: "server", message: t("googleWeb.error.server") },
  ];

  for (const entry of cases) {
    const harness = createHarness(() => ({
      ok: false,
      status: entry.status,
      json: async () => {
        throw new Error("raw provider detail");
      },
    }));
    const error = await catchProtocolError(() => harness.client.translate(baseInput));
    expect(error.kind).toBe(entry.kind);
    expect(error.message).toBe(entry.message);
    expect(error.message).not.toContain("raw provider detail");
    expect(error.status).toBe(entry.status);
    expect(harness.requests).toHaveLength(1);
  }
});

test("Google Web client: maps unreadable answers and network failures without provider text", async () => {
  const unreadable = createHarness(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("<html>blocked</html>");
    },
  }));
  const unreadableError = await catchProtocolError(() => unreadable.client.translate(baseInput));
  expect(unreadableError.kind).toBe("invalid_response");
  expect(unreadableError.message).toBe(t("googleWeb.error.invalidResponse"));
  expect(unreadableError.message).not.toContain("<html>");

  const network = createHarness(() => {
    throw new Error("connect ECONNREFUSED internal-host");
  });
  const networkError = await catchProtocolError(() => network.client.translate(baseInput));
  expect(networkError.kind).toBe("network");
  expect(networkError.message).toBe(t("protocol.error.networkDefault"));
  expect(networkError.message).not.toContain("ECONNREFUSED");
  expect(network.requests).toHaveLength(1);
});

test("Google Web client: cancellation and the deadline settle during the body read", async () => {
  const slow = createHarness(() => ({
    ok: true,
    status: 200,
    json: () => new Promise<unknown>((resolve) => setTimeout(() => resolve(["late"]), 50)),
  }));
  const timedOut = await catchProtocolError(() =>
    slow.client.translate(baseInput, { timeoutMs: 5 }),
  );
  expect(timedOut.kind).toBe("timeout");
  expect(timedOut.message).toBe(t("protocol.error.timeout"));

  const lateBody = createDeferred<unknown>();
  const hanging = createHarness(() => ({ ok: true, status: 200, json: () => lateBody.promise }));
  const controller = new AbortController();
  const call = hanging.client.translate(baseInput, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  const cancelled = await catchProtocolError(() => call);
  expect(cancelled.kind).toBe("cancelled");
  expect(cancelled.message).toBe(t("protocol.error.cancelled"));
  lateBody.resolve(["stale success"]);

  const late = createDeferred<unknown>();
  const lateHarness = createHarness(() => ({ ok: true, status: 200, json: () => late.promise }));
  const lateError = await catchProtocolError(() =>
    lateHarness.client.translate(baseInput, { timeoutMs: 5 }),
  );
  expect(lateError.kind).toBe("timeout");
  late.resolve(["late success"]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const neverAnswers = createHarness(() => new Promise<HttpResponseLike>(() => {}));
  const pre = new AbortController();
  const pending = neverAnswers.client.translate(baseInput, { signal: pre.signal });
  await new Promise((resolve) => setTimeout(resolve, 1));
  pre.abort();
  const preError = await catchProtocolError(() => pending);
  expect(preError.kind).toBe("cancelled");
  expect(neverAnswers.requests).toHaveLength(1);
});
