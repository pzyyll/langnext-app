import { expect, test } from "nsh/test";
import type { FetchLike, HttpResponseLike } from "../../services/http";
import {
  AZURE_TTS_DEFAULT_TIMEOUT_MS,
  AZURE_TTS_RESPONSE_BYTE_LIMIT,
  createAzureSpeechTtsClient,
  type AzureSpeechTtsSynthesizeInput,
} from "./azure-speech";
import { parseAzureSpeechRegion } from "./azure-regions";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
  signal?: AbortSignal;
}

const API_KEY = "azure-speech-key+secret=";
const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0xc3, 0x00, 0x80, 0x7f, 0x01]);

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
    json: async () => {
      throw new Error("audio bytes are not json");
    },
  };
}

function createHarness(
  respond: (request: RecordedRequest) => HttpResponseLike | Promise<HttpResponseLike>,
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
  return { requests, client: createAzureSpeechTtsClient({ fetchImpl }) };
}

const ENGLISH: AzureSpeechTtsSynthesizeInput = {
  apiKey: API_KEY,
  region: "eastus",
  text: "A & B < C > D",
  voice: { languageCode: "en-US", voiceName: "en-US-JennyNeural" },
};

test("azure speech tts: posts escaped ssml and returns the mp3 bytes", async () => {
  const harness = createHarness(() => bytesResponse(MP3));
  const result = await harness.client.synthesize(ENGLISH);

  expect(result).toEqual({ status: "synthesized", audio: MP3 });
  expect(harness.requests).toHaveLength(1);
  const request = harness.requests[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
  expect(new URL(request.url).search).toBe("");
  expect(request.url.includes(API_KEY)).toBe(false);
  expect(request.redirect).toBe("error");
  expect(request.headers["Ocp-Apim-Subscription-Key"]).toBe(API_KEY);
  expect(request.headers["Content-Type"]).toBe("application/ssml+xml");
  expect(request.headers["X-Microsoft-OutputFormat"]).toBe("audio-24khz-48kbitrate-mono-mp3");
  expect(request.headers["User-Agent"]).toBe("Langnext");
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body).toBe(
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-JennyNeural">A &amp; B &lt; C &gt; D</voice></speak>',
  );
  expect(JSON.stringify(result).includes(API_KEY)).toBe(false);
});

test("azure speech tts: accepts only a public regional host", async () => {
  expect(parseAzureSpeechRegion("  EASTUS  ")).toBe("eastus");
  expect(parseAzureSpeechRegion("westus2")).toBe("westus2");
  const padded = createHarness(() => bytesResponse(MP3));
  expect(await padded.client.synthesize({ ...ENGLISH, region: "  EASTUS  " })).toEqual({
    status: "synthesized",
    audio: MP3,
  });
  expect(padded.requests[0]?.url).toBe(
    "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
  );

  const rejected = [
    "not-a-region",
    "https://eastus.tts.speech.microsoft.com",
    "east.us",
    "eastus/v1",
    "eastus:443",
    "usgovvirginia",
    "",
    "   ",
  ];
  for (const region of rejected) {
    expect(parseAzureSpeechRegion(region)).toBeNull();
    const harness = createHarness(() => bytesResponse(MP3));
    const result = await harness.client.synthesize({ ...ENGLISH, region });
    expect(result).toEqual({ status: "failed", failure: "invalid_region" });
    expect(harness.requests).toHaveLength(0);
    expect(JSON.stringify(result).includes(region.trim())).toBe(region.trim().length === 0);
  }
});

const AZURE_TEXT_LIMIT = 5_000;

test("azure speech tts: rejects blank and over-limit text before fetch", async () => {
  for (const value of ["", "   ", "\n\t "]) {
    const harness = createHarness(() => bytesResponse(MP3));
    expect(await harness.client.synthesize({ ...ENGLISH, text: value })).toEqual({
      status: "failed",
      failure: "text_blank",
    });
    expect(harness.requests).toHaveLength(0);
  }

  const kept = createHarness(() => bytesResponse(MP3));
  expect(await kept.client.synthesize({ ...ENGLISH, text: "  Hello  " })).toEqual({
    status: "synthesized",
    audio: MP3,
  });
  expect(kept.requests[0]?.body).toContain(">  Hello  <");

  const asciiOk = "a".repeat(AZURE_TEXT_LIMIT);
  const within = createHarness(() => bytesResponse(MP3));
  expect(await within.client.synthesize({ ...ENGLISH, text: asciiOk })).toEqual({
    status: "synthesized",
    audio: MP3,
  });
  expect(within.requests).toHaveLength(1);

  const asciiOver = createHarness(() => bytesResponse(MP3));
  expect(
    await asciiOver.client.synthesize({ ...ENGLISH, text: "a".repeat(AZURE_TEXT_LIMIT + 1) }),
  ).toEqual({ status: "failed", failure: "text_too_long" });
  expect(asciiOver.requests).toHaveLength(0);

  const hanOk = "\u4f60".repeat(1666) + "ab";
  const hanOver = "\u4f60".repeat(1667);
  expect(new TextEncoder().encode(hanOk).byteLength).toBe(AZURE_TEXT_LIMIT);
  expect(new TextEncoder().encode(hanOver).byteLength).toBe(AZURE_TEXT_LIMIT + 1);
  const multiOk = createHarness(() => bytesResponse(MP3));
  expect(await multiOk.client.synthesize({ ...ENGLISH, text: hanOk })).toEqual({
    status: "synthesized",
    audio: MP3,
  });
  const multiOver = createHarness(() => bytesResponse(MP3));
  expect(await multiOver.client.synthesize({ ...ENGLISH, text: hanOver })).toEqual({
    status: "failed",
    failure: "text_too_long",
  });
  expect(multiOver.requests).toHaveLength(0);

  const escapedOk = "a".repeat(AZURE_TEXT_LIMIT - 1) + "&";
  expect(new TextEncoder().encode(escapedOk).byteLength).toBe(AZURE_TEXT_LIMIT);
  const escaped = createHarness(() => bytesResponse(MP3));
  expect(await escaped.client.synthesize({ ...ENGLISH, text: escapedOk })).toEqual({
    status: "synthesized",
    audio: MP3,
  });
  expect(escaped.requests[0]?.body).toContain(
    `<voice name="en-US-JennyNeural">${"a".repeat(AZURE_TEXT_LIMIT - 1)}&amp;</voice>`,
  );
});

test("azure speech tts: escapes xml text and rejects characters xml cannot represent", async () => {
  const cr = String.fromCharCode(0x0d);
  const lf = String.fromCharCode(0x0a);
  const tab = String.fromCharCode(0x09);
  const harness = createHarness(() => bytesResponse(MP3));
  const text = "line1" + cr + lf + "line2" + tab + "&<>\"'";
  expect(
    await harness.client.synthesize({
      ...ENGLISH,
      text,
      voice: { languageCode: "en-US", voiceName: 'Jen"ny' },
    }),
  ).toEqual({ status: "synthesized", audio: MP3 });
  expect(harness.requests[0]?.body).toBe(
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
      '<voice name="Jen&quot;ny">line1&#xD;' +
      lf +
      "line2" +
      tab +
      "&amp;&lt;&gt;&quot;&apos;</voice></speak>",
  );

  const illegal = [
    String.fromCharCode(0x00),
    "ok" + String.fromCharCode(0x08),
    String.fromCharCode(0x0b),
    String.fromCharCode(0x0c),
    String.fromCharCode(0x1f),
    String.fromCharCode(0xfffe),
    String.fromCharCode(0xffff),
    String.fromCharCode(0xd800),
  ];
  for (const value of illegal) {
    const rejected = createHarness(() => bytesResponse(MP3));
    expect(await rejected.client.synthesize({ ...ENGLISH, text: value })).toEqual({
      status: "failed",
      failure: "invalid_text",
    });
    expect(rejected.requests).toHaveLength(0);
  }
});

function responseWith(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  headers?: Record<string, string>,
  onRead?: () => void,
): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(body !== null ? { body } : {}),
    headers: headers
      ? { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null }
      : undefined,
    json: async () => {
      onRead?.();
      return { error: API_KEY };
    },
    text: async () => {
      onRead?.();
      return "provider says " + API_KEY;
    },
  };
}

test("azure speech tts: maps status codes without reading provider bodies or retrying", async () => {
  const cases: { status: number; failure: string }[] = [
    { status: 401, failure: "auth" },
    { status: 403, failure: "auth" },
    { status: 429, failure: "rate_limited" },
    { status: 400, failure: "rejected" },
    { status: 404, failure: "rejected" },
    { status: 500, failure: "rejected" },
    { status: 204, failure: "rejected" },
  ];
  for (const item of cases) {
    let pulls = 0;
    let primed = 0;
    let decoded = 0;
    const harness = createHarness(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("provider says " + API_KEY));
        },
      });
      await Promise.resolve();
      primed = pulls;
      return responseWith(item.status, body, undefined, () => {
        decoded += 1;
      });
    });
    const result = await harness.client.synthesize(ENGLISH);
    expect(result).toEqual({ status: "failed", failure: item.failure });
    expect(harness.requests).toHaveLength(1);
    expect(pulls).toBe(primed);
    expect(decoded).toBe(0);
    expect(JSON.stringify(result).includes(API_KEY)).toBe(false);
    expect(JSON.stringify(result).includes("provider says")).toBe(false);
  }

  const network = createHarness(() => {
    throw new Error(
      "connect " + API_KEY + " https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
    );
  });
  const networkResult = await network.client.synthesize(ENGLISH);
  expect(networkResult).toEqual({ status: "failed", failure: "network" });
  expect(network.requests).toHaveLength(1);
  expect(JSON.stringify(networkResult).includes(API_KEY)).toBe(false);
  expect(JSON.stringify(networkResult).includes("tts.speech.microsoft.com")).toBe(false);
});

test("azure speech tts: bounds the mp3 body at 4 mib and rejects an empty body", async () => {
  expect(AZURE_TTS_RESPONSE_BYTE_LIMIT).toBe(4 * 1024 * 1024);
  const exactBytes = new Uint8Array(AZURE_TTS_RESPONSE_BYTE_LIMIT);
  exactBytes[0] = 0xff;
  exactBytes[AZURE_TTS_RESPONSE_BYTE_LIMIT - 1] = 0x7f;
  const exact = createHarness(() => bytesResponse(exactBytes));
  const exactResult = await exact.client.synthesize(ENGLISH);
  expect(exactResult.status).toBe("synthesized");
  if (exactResult.status === "synthesized") {
    expect(exactResult.audio.byteLength).toBe(AZURE_TTS_RESPONSE_BYTE_LIMIT);
    expect(exactResult.audio[0]).toBe(0xff);
    expect(exactResult.audio[AZURE_TTS_RESPONSE_BYTE_LIMIT - 1]).toBe(0x7f);
  }

  let pulls = 0;
  let primed = 0;
  let hangingCancel = false;
  const declared = createHarness(async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(MP3);
      },
      cancel() {
        hangingCancel = true;
        return new Promise(() => {});
      },
    });
    await Promise.resolve();
    primed = pulls;
    return responseWith(200, body, {
      "content-length": String(AZURE_TTS_RESPONSE_BYTE_LIMIT + 1),
    });
  });
  const declaredResult = await Promise.race([
    declared.client.synthesize(ENGLISH),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
  ]);
  expect(declaredResult).toEqual({ status: "failed", failure: "malformed" });
  expect(pulls).toBe(primed);
  expect(hangingCancel).toBe(true);
  expect(JSON.stringify(declaredResult).includes(API_KEY)).toBe(false);

  const inaccurate = createHarness(() => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > AZURE_TTS_RESPONSE_BYTE_LIMIT) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    return responseWith(200, body, { "content-length": "10" });
  });
  expect(await inaccurate.client.synthesize(ENGLISH)).toEqual({
    status: "failed",
    failure: "malformed",
  });

  const empty = createHarness(() => bytesResponse(new Uint8Array()));
  expect(await empty.client.synthesize(ENGLISH)).toEqual({
    status: "failed",
    failure: "malformed",
  });

  let missingRead = false;
  const missing = createHarness(() =>
    responseWith(200, null, undefined, () => {
      missingRead = true;
    }),
  );
  expect(await missing.client.synthesize(ENGLISH)).toEqual({
    status: "failed",
    failure: "malformed",
  });
  expect(missingRead).toBe(false);

  const authOversize = createHarness(() =>
    responseWith(401, bytesResponse(new TextEncoder().encode(API_KEY)).body ?? null, {
      "content-length": String(AZURE_TTS_RESPONSE_BYTE_LIMIT + 1),
    }),
  );
  expect(await authOversize.client.synthesize(ENGLISH)).toEqual({
    status: "failed",
    failure: "auth",
  });
});
test("azure speech tts: cancellation and timeout return no audio", async () => {
  expect(AZURE_TTS_DEFAULT_TIMEOUT_MS).toBe(15_000);

  const early = new AbortController();
  early.abort();
  const earlyHarness = createHarness(() => {
    throw new Error("fetch " + API_KEY);
  });
  const earlyResult = await earlyHarness.client.synthesize(ENGLISH, { signal: early.signal });
  expect(earlyResult).toEqual({ status: "cancelled" });
  expect(earlyHarness.requests).toHaveLength(0);

  const controller = new AbortController();
  const pendingResponse: { release: ((response: HttpResponseLike) => void) | null } = {
    release: null,
  };
  const requests: { signal: AbortSignal }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    requests.push({ signal: init.signal });
    return new Promise<HttpResponseLike>((resolve) => {
      pendingResponse.release = resolve;
      const timer = setTimeout(() => resolve(bytesResponse(MP3)), 200);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
      });
    });
  };
  const client = createAzureSpeechTtsClient({ fetchImpl });
  const pending = client.synthesize(ENGLISH, { signal: controller.signal, timeoutMs: 5_000 });
  while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  const cancelled = await Promise.race([
    pending,
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
  ]);
  expect(cancelled).toEqual({ status: "cancelled" });
  expect(requests[0]?.signal.aborted).toBe(true);
  pendingResponse.release?.(bytesResponse(MP3));

  let bodyTimer: ReturnType<typeof setTimeout> | null = null;
  const stalled = createHarness(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyTimer = setTimeout(() => {
          controller.enqueue(MP3);
          controller.close();
        }, 250);
      },
      cancel() {
        if (bodyTimer !== null) clearTimeout(bodyTimer);
      },
    });
    return responseWith(200, body);
  });
  expect(await stalled.client.synthesize(ENGLISH, { timeoutMs: 40 })).toEqual({
    status: "failed",
    failure: "timeout",
  });
  expect(stalled.requests).toHaveLength(1);
});
