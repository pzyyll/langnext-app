import { expect, test } from "nsh/test";
import type { FetchLike, HttpResponseLike } from "../../services/http";
import { DEFAULT_GOOGLE_VOICE_PREFERENCES, googleAudioOptions } from "./google-preferences";
import {
  createGoogleCloudTtsClient,
  GOOGLE_CLOUD_TTS_URL,
  TTS_DEFAULT_TIMEOUT_MS,
  TTS_MAX_UTF8_BYTES,
  TTS_RESPONSE_BYTE_LIMIT,
  type GoogleCloudTtsSynthesis,
} from "./google-cloud";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
  signal?: AbortSignal;
}

const API_KEY = "tts-api-key+secret=";
const MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x7f]);

function streamResponse(
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
): HttpResponseLike {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytesResponse(bytes, status, headers);
}

function bytesResponse(
  bytes: Uint8Array,
  status = 200,
  headers?: Record<string, string>,
): HttpResponseLike {
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
    headers: headers
      ? { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null }
      : undefined,
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
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
  return { requests, client: createGoogleCloudTtsClient({ fetchImpl }) };
}

function assertNoSecret(result: GoogleCloudTtsSynthesis, secret: string) {
  expect(JSON.stringify(result).includes(secret)).toBe(false);
}

test("google cloud tts: posts the v1 synthesize body and returns mp3 bytes", async () => {
  const audioContent = Buffer.from(MP3).toString("base64");
  const harness = createHarness(() => streamResponse({ audioContent }));

  const result = await harness.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });

  expect(result).toEqual({ status: "synthesized", audio: MP3 });
  expect(harness.requests).toHaveLength(1);
  const request = harness.requests[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe(GOOGLE_CLOUD_TTS_URL);
  expect(new URL(request.url).search).toBe("");
  expect(request.url.includes(API_KEY)).toBe(false);
  expect(request.headers["Content-Type"]).toBe("application/json");
  expect(request.headers["x-goog-api-key"]).toBe(API_KEY);
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.redirect).toBe("error");
  expect(JSON.parse(request.body ?? "")).toEqual({
    input: { text: "Hello" },
    voice: { languageCode: "en-US", name: "en-US-Standard-C" },
    audioConfig: { audioEncoding: "MP3" },
  });
  if (result.status === "synthesized") {
    expect(Buffer.from(result.audio).toString("utf8")).not.toBe(audioContent);
  }
  assertNoSecret(result, API_KEY);
});

test("google cloud tts: serializes only the effective audio fields", async () => {
  const audioContent = Buffer.from(MP3).toString("base64");
  const harness = createHarness(() => streamResponse({ audioContent }));
  const preferences = {
    ...DEFAULT_GOOGLE_VOICE_PREFERENCES,
    voiceTier: "neural2" as const,
    speakingRate: 1.25,
    pitch: 2,
  };

  const result = await harness.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Neural2-D",
    audio: googleAudioOptions(preferences, "neural2"),
  });
  expect(result).toEqual({ status: "synthesized", audio: MP3 });
  expect(JSON.parse(harness.requests[0]!.body ?? "").audioConfig).toEqual({
    audioEncoding: "MP3",
    speakingRate: 1.25,
    pitch: 2,
  });

  const defaults = createHarness(() => streamResponse({ audioContent }));
  await defaults.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
    audio: googleAudioOptions(DEFAULT_GOOGLE_VOICE_PREFERENCES, "standard"),
  });
  expect(JSON.parse(defaults.requests[0]!.body ?? "").audioConfig).toEqual({
    audioEncoding: "MP3",
  });

  const chirp = createHarness(() => streamResponse({ audioContent }));
  await chirp.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Chirp3-HD-Kore",
    audio: googleAudioOptions({ ...preferences, voiceTier: "chirp3-hd" }, "chirp3-hd"),
  });
  expect(JSON.parse(chirp.requests[0]!.body ?? "").audioConfig).toEqual({
    audioEncoding: "MP3",
  });
  expect(JSON.parse(chirp.requests[0]!.body ?? "").voice).toEqual({
    languageCode: "en-US",
    name: "en-US-Chirp3-HD-Kore",
  });
});

const VOICE = { languageCode: "en-US", voiceName: "en-US-Standard-C" };

function synthesize(text: string) {
  const audioContent = Buffer.from(MP3).toString("base64");
  const harness = createHarness(() => streamResponse({ audioContent }));
  const pending = harness.client.synthesize({
    apiKey: API_KEY,
    text,
    languageCode: VOICE.languageCode,
    voiceName: VOICE.voiceName,
  });
  return { harness, pending };
}

test("google cloud tts: rejects blank text before fetch and keeps surrounding spaces", async () => {
  for (const text of ["", "   ", "\n\t "]) {
    const { harness, pending } = synthesize(text);
    expect(await pending).toEqual({ status: "failed", failure: "text_blank" });
    expect(harness.requests).toHaveLength(0);
  }

  const spaced = synthesize("  Hello  ");
  expect(await spaced.pending).toEqual({ status: "synthesized", audio: MP3 });
  expect(JSON.parse(spaced.harness.requests[0]!.body ?? "").input.text).toBe("  Hello  ");
});

test("google cloud tts: accepts 5000 utf-8 bytes and rejects 5001 without a second request", async () => {
  const asciiOk = "a".repeat(TTS_MAX_UTF8_BYTES);
  const asciiOver = "a".repeat(TTS_MAX_UTF8_BYTES + 1);
  const within = synthesize(asciiOk);
  expect(await within.pending).toEqual({ status: "synthesized", audio: MP3 });
  expect(within.harness.requests).toHaveLength(1);
  expect(JSON.parse(within.harness.requests[0]!.body ?? "").input.text).toBe(asciiOk);

  const over = synthesize(asciiOver);
  expect(await over.pending).toEqual({ status: "failed", failure: "text_too_long" });
  expect(over.harness.requests).toHaveLength(0);

  const hanOk = "\u4f60".repeat(1666) + "ab";
  const hanOver = "\u4f60".repeat(1667);
  expect(new TextEncoder().encode(hanOk).byteLength).toBe(TTS_MAX_UTF8_BYTES);
  expect(new TextEncoder().encode(hanOver).byteLength).toBe(TTS_MAX_UTF8_BYTES + 1);
  const multiOk = synthesize(hanOk);
  expect(await multiOk.pending).toEqual({ status: "synthesized", audio: MP3 });
  expect(multiOk.harness.requests).toHaveLength(1);
  const multiOver = synthesize(hanOver);
  expect(await multiOver.pending).toEqual({ status: "failed", failure: "text_too_long" });
  expect(multiOver.harness.requests).toHaveLength(0);
});

function paddedBody(byteLength: number): Uint8Array {
  const audioContent = Buffer.from(MP3).toString("base64");
  const prefix = `{"audioContent":"${audioContent}","pad":"`;
  const suffix = `"}`;
  const pad = byteLength - new TextEncoder().encode(prefix).byteLength - suffix.length;
  return new TextEncoder().encode(prefix + "x".repeat(pad) + suffix);
}

test("google cloud tts: bounds the json body at 8 mib before parsing", async () => {
  const exact = createHarness(() => bytesResponse(paddedBody(TTS_RESPONSE_BYTE_LIMIT)));
  expect(
    await exact.client.synthesize({
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    }),
  ).toEqual({ status: "synthesized", audio: MP3 });

  const over = createHarness(() => bytesResponse(paddedBody(TTS_RESPONSE_BYTE_LIMIT + 1)));
  const overResult = await over.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(overResult).toEqual({ status: "failed", failure: "malformed" });
  assertNoSecret(overResult, "x".repeat(8));

  let parsed = false;
  const declared = createHarness(() => {
    const response = streamResponse({
      audioContent: Buffer.from(MP3).toString("base64"),
      note: API_KEY,
    });
    const json = response.json.bind(response);
    response.json = async () => {
      parsed = true;
      return json();
    };
    response.headers = {
      get: (name) =>
        name.toLowerCase() === "content-length" ? String(TTS_RESPONSE_BYTE_LIMIT + 1) : null,
    };
    return response;
  });
  const declaredResult = await declared.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(declaredResult).toEqual({ status: "failed", failure: "malformed" });
  expect(parsed).toBe(false);
  assertNoSecret(declaredResult, API_KEY);

  const authOversize = createHarness(() =>
    bytesResponse(new TextEncoder().encode("{"), 401, {
      "content-length": String(TTS_RESPONSE_BYTE_LIMIT + 1),
    }),
  );
  expect(
    await authOversize.client.synthesize({
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    }),
  ).toEqual({ status: "failed", failure: "auth" });
});

test("google cloud tts: maps auth failures and an invalid key reason without provider text", async () => {
  const secret = "provider says " + API_KEY;
  const cases: { status: number; body: unknown; expected: GoogleCloudTtsSynthesis }[] = [
    {
      status: 401,
      body: { error: { message: secret } },
      expected: { status: "failed", failure: "auth" },
    },
    {
      status: 403,
      body: { error: { message: secret } },
      expected: { status: "failed", failure: "auth" },
    },
    {
      status: 400,
      body: {
        error: {
          message: secret,
          details: [{ reason: "API_KEY_INVALID", domain: "googleapis.com" }],
        },
      },
      expected: { status: "failed", failure: "auth" },
    },
    {
      status: 400,
      body: { error: { message: secret, status: "INVALID_ARGUMENT" } },
      expected: { status: "failed", failure: "rejected" },
    },
  ];
  for (const item of cases) {
    const harness = createHarness(() => streamResponse(item.body, item.status));
    const result = await harness.client.synthesize({
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    });
    expect(result).toEqual(item.expected);
    expect(harness.requests).toHaveLength(1);
    assertNoSecret(result, API_KEY);
    assertNoSecret(result, "provider says");
  }
});

test("google cloud tts: maps quota without a retry", async () => {
  const harness = createHarness(() =>
    streamResponse({ error: { message: API_KEY, status: "RESOURCE_EXHAUSTED" } }, 429),
  );
  const result = await harness.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(result).toEqual({ status: "failed", failure: "quota" });
  expect(harness.requests).toHaveLength(1);
  assertNoSecret(result, API_KEY);
});

test("google cloud tts: rejects malformed audio and other http failures", async () => {
  const cases: { body: unknown; status?: number; expected: GoogleCloudTtsSynthesis }[] = [
    { body: { audioContent: "" }, expected: { status: "failed", failure: "malformed" } },
    { body: {}, expected: { status: "failed", failure: "malformed" } },
    { body: { audioContent: "abc" }, expected: { status: "failed", failure: "malformed" } },
    { body: { audioContent: "!!!!" }, expected: { status: "failed", failure: "malformed" } },
    { body: [], expected: { status: "failed", failure: "malformed" } },
    {
      body: { error: { message: API_KEY } },
      status: 500,
      expected: { status: "failed", failure: "rejected" },
    },
    {
      body: { error: { message: API_KEY } },
      status: 404,
      expected: { status: "failed", failure: "rejected" },
    },
  ];
  for (const item of cases) {
    const harness = createHarness(() => streamResponse(item.body, item.status ?? 200));
    const result = await harness.client.synthesize({
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    });
    expect(result).toEqual(item.expected);
    expect(harness.requests).toHaveLength(1);
    assertNoSecret(result, API_KEY);
  }

  const broken = createHarness(() =>
    bytesResponse(new TextEncoder().encode("{not json" + API_KEY)),
  );
  const brokenResult = await broken.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(brokenResult).toEqual({ status: "failed", failure: "malformed" });
  assertNoSecret(brokenResult, API_KEY);

  const network = createHarness(() => {
    throw new Error(
      "connect " + API_KEY + " https://texttospeech.googleapis.com/v1/text:synthesize",
    );
  });
  const networkResult = await network.client.synthesize({
    apiKey: API_KEY,
    text: "Hello",
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(networkResult).toEqual({ status: "failed", failure: "network" });
  expect(network.requests).toHaveLength(1);
  assertNoSecret(networkResult, API_KEY);
  assertNoSecret(networkResult, "texttospeech.googleapis.com");
});

test("google cloud tts: cancellation before and during the request returns no audio", async () => {
  const early = new AbortController();
  early.abort();
  const earlyHarness = createHarness(() => {
    throw new Error("fetch " + API_KEY);
  });
  const earlyResult = await earlyHarness.client.synthesize(
    {
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    },
    { signal: early.signal },
  );
  expect(earlyResult).toEqual({ status: "cancelled" });
  expect(earlyHarness.requests).toHaveLength(0);

  const controller = new AbortController();
  const late: { send: ((response: HttpResponseLike) => void) | null } = { send: null };
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
      signal: init.signal,
    });
    return new Promise<HttpResponseLike>((resolve) => {
      late.send = resolve;
      init.signal.addEventListener("abort", () => {
        late.send = null;
      });
    });
  };
  const client = createGoogleCloudTtsClient({ fetchImpl });
  const pending = client.synthesize(
    {
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    },
    { signal: controller.signal, timeoutMs: 5_000 },
  );
  while (requests.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  expect(await pending).toEqual({ status: "cancelled" });
  const sendLate = late.send;
  if (typeof sendLate === "function") {
    sendLate(
      streamResponse({ audioContent: Buffer.from(MP3).toString("base64"), leaked: API_KEY }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(requests).toHaveLength(1);
});

test("google cloud tts: times out during the body read and ignores the late response", async () => {
  expect(TTS_DEFAULT_TIMEOUT_MS).toBe(15_000);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const harness = createHarness(() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                audioContent: Buffer.from(MP3).toString("base64"),
                leaked: API_KEY,
              }),
            ),
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
      json: async () => ({ audioContent: Buffer.from(MP3).toString("base64"), leaked: API_KEY }),
    };
  });
  const result = await harness.client.synthesize(
    {
      apiKey: API_KEY,
      text: "Hello",
      languageCode: "en-US",
      voiceName: "en-US-Standard-C",
    },
    { timeoutMs: 40 },
  );
  expect(result).toEqual({ status: "failed", failure: "timeout" });
  expect(harness.requests).toHaveLength(1);
  assertNoSecret(result, API_KEY);
  expect(JSON.stringify(result).includes("leaked")).toBe(false);
});
