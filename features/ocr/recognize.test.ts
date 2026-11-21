import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { initializeAiModules } from "../../app/ai-setup";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { OCR_MAX_IMAGE_BYTES, recognizeScreenshot } from "./recognize";
import { baiduCredentialStorageKey, OCR_STORAGE_KEY } from "./settings";

initializeAiModules();

/** Smallest valid PNG payload; recognition treats the bytes as opaque. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
const VISION_MODEL_ID = "vision-model";

function ocrBindingStorage(modelId: string): Record<string, string> {
  return {
    [OCR_STORAGE_KEY]: JSON.stringify({
      version: 2,
      active: "ai",
      ai: { modelId },
      baidu: null,
    }),
  };
}

/** Vision-capable reply: one JSON object with the two transcribed lines. */
function recognitionBody(text: string): unknown {
  return {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ text }) }],
      },
    ],
  };
}

test("ocr recognize: returns the recognized lines from a saved image model", async () => {
  const channel = makeChannel({
    id: "ch-vision",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
  });
  const model = makeModel({
    id: VISION_MODEL_ID,
    providerId: "ch-vision",
    modelKey: "gpt-4.1",
    enabled: true,
    capabilities: { text: true, image: true, pdf: false, video: false },
  });
  const storage = makeSeedStorage({
    channels: [channel],
    models: [model],
    credentials: { "ch-vision": "sk-vision" },
    extra: ocrBindingStorage(VISION_MODEL_ID),
  });

  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("first line\n第二行"),
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "recognized", text: "first line\n第二行" });

  const requests = app.requests();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers?.authorization).toBe("Bearer sk-vision");
  const sent = JSON.parse(requests[0]!.body!);
  expect(sent.model).toBe("gpt-4.1");
  expect(sent.input[0].content[1]).toEqual({
    type: "input_image",
    image_url: `data:image/png;base64,${PNG_BASE64}`,
  });
});

test("ocr recognize: an ineligible binding uploads nothing", async () => {
  const chOpen = makeChannel({
    id: "ch-open",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
  });
  const chDisabled = makeChannel({
    id: "ch-disabled",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://disabled.example.com/v1",
    enabled: false,
  });
  const chBadProtocol = makeChannel({
    id: "ch-bad-proto",
    presetId: "anthropic",
    adapterId: "openai-compatible",
    baseUrl: "https://bad-proto.example.com/v1",
  });
  const chHttp = makeChannel({
    id: "ch-http",
    presetId: "custom",
    adapterId: "openai-responses",
    baseUrl: "http://insecure.example.com/v1",
    insecureHttpConfirmedAt: null,
  });

  const models = [
    makeModel({
      id: "m-image-override",
      providerId: "ch-open",
      modelKey: "gpt-4.1",
      enabled: true,
      capabilities: { text: true, image: false, pdf: false, video: false },
      capabilitiesOverride: { image: true },
    }),
    makeModel({
      id: "m-text-only",
      providerId: "ch-open",
      modelKey: "gpt-4.1-mini",
      enabled: true,
      capabilities: { text: true, image: false, pdf: false, video: false },
    }),
    makeModel({
      id: "m-disabled",
      providerId: "ch-open",
      modelKey: "gpt-4.1-nano",
      enabled: false,
      capabilities: { text: true, image: true, pdf: false, video: false },
    }),
    makeModel({
      id: "m-missing",
      providerId: "ch-open",
      modelKey: "gpt-4o",
      enabled: true,
      syncStatus: "missing",
      capabilities: { text: true, image: true, pdf: false, video: false },
    }),
    makeModel({
      id: "m-channel-disabled",
      providerId: "ch-disabled",
      modelKey: "gpt-4.1",
      enabled: true,
      capabilities: { text: true, image: true, pdf: false, video: false },
    }),
    makeModel({
      id: "m-bad-protocol",
      providerId: "ch-bad-proto",
      modelKey: "claude-sonnet-4",
      enabled: true,
      capabilities: { text: true, image: true, pdf: false, video: false },
    }),
    makeModel({
      id: "m-http-no-consent",
      providerId: "ch-http",
      modelKey: "gpt-4.1",
      enabled: true,
      capabilities: { text: true, image: true, pdf: false, video: false },
    }),
  ];

  const storage = makeSeedStorage({
    channels: [chOpen, chDisabled, chBadProtocol, chHttp],
    models,
    credentials: { "ch-open": "sk-open" },
    extra: ocrBindingStorage("m-image-override"),
  });

  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: {
      params: {
        pngBase64: PNG_BASE64,
        modelIds: [
          "m-image-override",
          "m-text-only",
          "m-disabled",
          "m-missing",
          "m-deleted",
          "m-channel-disabled",
          "m-bad-protocol",
          "m-http-no-consent",
        ],
      },
    },
    network: {
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("overridden"),
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);

  expect(result.outcomes[0]).toEqual({ status: "recognized", text: "overridden" });
  expect(result.outcomes[1]).toEqual({
    status: "unavailable",
    reason: t("presets.model.reasonNotImageCapable"),
  });
  expect(result.outcomes[2]).toEqual({
    status: "unavailable",
    reason: t("presets.model.reasonModelDisabled"),
  });
  expect(result.outcomes[3]).toEqual({
    status: "unavailable",
    reason: t("presets.model.reasonMissing"),
  });
  expect(result.outcomes[4]).toEqual({
    status: "unavailable",
    reason: t("presets.model.reasonDeleted"),
  });
  expect(result.outcomes[5]).toEqual({
    status: "unavailable",
    reason: t("presets.model.reasonChannelDisabled"),
  });
  expect(result.outcomes[6]).toEqual({
    status: "unavailable",
    reason: t("presets.model.reasonUnsupported"),
  });
  expect(result.outcomes[7]).toEqual({
    status: "unavailable",
    reason: t("models.error.confirmInsecureRequest"),
  });

  expect(app.requests()).toHaveLength(1);
});

test("ocr recognize: a valid no-text answer reports no text", async () => {
  const channel = makeChannel({
    id: "ch-vision",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
  });
  const model = makeModel({
    id: VISION_MODEL_ID,
    providerId: "ch-vision",
    modelKey: "gpt-4.1",
    enabled: true,
    capabilities: { text: true, image: true, pdf: false, video: false },
  });

  const app = await open("./__tests__/recognize-app.tsx", {
    storage: makeSeedStorage({
      channels: [channel],
      models: [model],
      credentials: { "ch-vision": "sk-vision" },
      extra: ocrBindingStorage(VISION_MODEL_ID),
    }),
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody(""),
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "no_text" });
});

test("ocr recognize: refuses prose and Markdown instead of importing them as text", async () => {
  const channel = makeChannel({
    id: "ch-vision",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
  });
  const model = makeModel({
    id: VISION_MODEL_ID,
    providerId: "ch-vision",
    modelKey: "gpt-4.1",
    enabled: true,
    capabilities: { text: true, image: true, pdf: false, video: false },
  });
  const storage = makeSeedStorage({
    channels: [channel],
    models: [model],
    credentials: { "ch-vision": "sk-vision" },
    extra: ocrBindingStorage(VISION_MODEL_ID),
  });
  const answers = ["Here is the text: first line", '```json\n{"text":"first line"}\n```'];

  for (const answer of answers) {
    const app = await open("./__tests__/recognize-app.tsx", {
      storage,
      host: { params: { pngBase64: PNG_BASE64 } },
      network: {
        "POST https://vision.example.com/v1/responses": {
          status: 200,
          body: {
            output: [{ type: "message", content: [{ type: "output_text", text: answer }] }],
          },
        },
      },
    });

    await app.waitUntil(() => app.texts()[0] !== "running");
    const result = JSON.parse(app.texts()[1]!);
    expect(result.outcomes[0]).toEqual({
      status: "failed",
      message: t("ocr.failure.malformedAnswer"),
    });
  }
});

test("ocr recognize: rejects an invalid or oversized PNG before resolving a model", async () => {
  const invalid = await recognizeScreenshot(
    { kind: "ai", modelId: "any-model" },
    new Uint8Array([1, 2, 3]),
  );
  expect(invalid).toEqual({ status: "failed", message: t("ocr.failure.invalidImage") });

  const oversized = new Uint8Array(OCR_MAX_IMAGE_BYTES + 1);
  oversized.set(PNG_BYTES);
  const tooLarge = await recognizeScreenshot({ kind: "ai", modelId: "any-model" }, oversized);
  expect(tooLarge).toEqual({ status: "failed", message: t("ocr.failure.imageTooLarge") });
});

test("ocr recognize: an unsaved binding is unavailable without a request", async () => {
  const outcome = await recognizeScreenshot(null, PNG_BYTES);
  expect(outcome).toEqual({ status: "unavailable", reason: t("ocr.failure.unconfigured") });
});

test("ocr recognize: reports a timeout without importing text", async () => {
  const channel = makeChannel({
    id: "ch-vision",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
  });
  const model = makeModel({
    id: VISION_MODEL_ID,
    providerId: "ch-vision",
    modelKey: "gpt-4.1",
    enabled: true,
    capabilities: { text: true, image: true, pdf: false, video: false },
  });

  const app = await open("./__tests__/recognize-app.tsx", {
    storage: makeSeedStorage({
      channels: [channel],
      models: [model],
      credentials: { "ch-vision": "sk-vision" },
      extra: ocrBindingStorage(VISION_MODEL_ID),
    }),
    host: { params: { pngBase64: PNG_BASE64, timeoutMs: 30 } },
    network: {
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("late"),
        delay: 2_000,
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "failed", message: t("ocr.failure.timeout") });
});

test("ocr recognize: a cancelled request reports cancellation without text", async () => {
  const channel = makeChannel({
    id: "ch-vision",
    presetId: "openai",
    adapterId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
  });
  const model = makeModel({
    id: VISION_MODEL_ID,
    providerId: "ch-vision",
    modelKey: "gpt-4.1",
    enabled: true,
    capabilities: { text: true, image: true, pdf: false, video: false },
  });

  const app = await open("./__tests__/recognize-app.tsx", {
    storage: makeSeedStorage({
      channels: [channel],
      models: [model],
      credentials: { "ch-vision": "sk-vision" },
      extra: ocrBindingStorage(VISION_MODEL_ID),
    }),
    host: { params: { pngBase64: PNG_BASE64, abortAfterMs: 20 } },
    network: {
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("cancelled away"),
        delay: 2_000,
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "cancelled" });
});

const BAIDU_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAAElFTkSuQmCC";
const BAIDU_REF = "baidu-ref";

function baiduBindingStorage(): Record<string, string> {
  return {
    [OCR_STORAGE_KEY]: JSON.stringify({
      version: 2,
      active: "baidu",
      ai: null,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
    [baiduCredentialStorageKey(BAIDU_REF)]: JSON.stringify({
      apiKey: "synthetic-api-key",
      secretKey: "synthetic-secret-key",
    }),
  };
}

test("ocr recognize: a saved Baidu binding is ready without requests and returns the lines", async () => {
  const storage = makeSeedStorage({ extra: baiduBindingStorage() });
  const ready = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64, readinessOnly: true } },
  });
  await ready.waitUntil(() => ready.texts()[0] !== "running");
  const readyResult = JSON.parse(ready.texts()[1]!);
  expect(readyResult.readiness).toEqual({ ready: true, reason: null });
  expect(ready.requests()).toHaveLength(0);

  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      "POST https://aip.baidubce.com/oauth/2.0/token": {
        status: 200,
        body: { access_token: "fixture-token" },
      },
      "POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token": {
        status: 200,
        body: {
          words_result: [{ words: "First line" }, { words: "\u7b2c\u4e8c\u884c" }],
          words_result_num: 2,
        },
      },
    },
  });
  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({
    status: "recognized",
    text: "First line\n\u7b2c\u4e8c\u884c",
  });
  const requests = app.requests();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.url).toBe("https://aip.baidubce.com/oauth/2.0/token");
  expect(requests[1]!.url).toContain("/rest/2.0/ocr/v1/accurate");
  expect(new URLSearchParams(requests[1]!.body ?? "").get("language_type")).toBe("auto_detect");
});

const BAIDU_TOKEN = "POST https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_OCR =
  "POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token";

function baiduNetwork(ocrBody: unknown) {
  return {
    [BAIDU_TOKEN]: { status: 200, body: { access_token: "fixture-token" } },
    [BAIDU_OCR]: { status: 200, body: ocrBody },
  };
}

test("ocr recognize: Baidu cancellation, empty text, and bad responses stay out of the draft", async () => {
  const storage = makeSeedStorage({ extra: baiduBindingStorage() });
  const cancelled = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64, abortAfterMs: 20 } },
    network: {
      [BAIDU_TOKEN]: { status: 200, body: { access_token: "fixture-token" }, delay: 2_000 },
    },
  });
  await cancelled.waitUntil(() => cancelled.texts()[0] !== "running");
  expect(JSON.parse(cancelled.texts()[1]!).outcomes[0]).toEqual({ status: "cancelled" });

  const empty = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: baiduNetwork({ words_result: [{ words: "  " }], words_result_num: 1 }),
  });
  await empty.waitUntil(() => empty.texts()[0] !== "running");
  expect(JSON.parse(empty.texts()[1]!).outcomes[0]).toEqual({ status: "no_text" });

  const malformed = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: baiduNetwork({ error_msg: "SENTINEL-SECRET", words_result: "Nope" }),
  });
  await malformed.waitUntil(() => malformed.texts()[0] !== "running");
  const malformedResult = JSON.parse(malformed.texts()[1]!).outcomes[0];
  expect(malformedResult).toEqual({ status: "failed", message: t("ocr.failure.baiduResponse") });
  expect(JSON.stringify(malformedResult).includes("SENTINEL-SECRET")).toBe(false);

  const credentials = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      [BAIDU_TOKEN]: {
        status: 401,
        body: { error: "invalid_client", error_description: "SENTINEL-SECRET" },
      },
    },
  });
  await credentials.waitUntil(() => credentials.texts()[0] !== "running");
  const credentialResult = JSON.parse(credentials.texts()[1]!).outcomes[0];
  expect(credentialResult).toEqual({
    status: "failed",
    message: t("ocr.failure.baiduCredentials"),
  });
  expect(JSON.stringify(credentialResult).includes("SENTINEL-SECRET")).toBe(false);
  expect(credentials.requests()).toHaveLength(1);
});

test("ocr recognize: unreadable Baidu keys and a changed binding send nothing", async () => {
  const broken = makeSeedStorage({
    extra: {
      [OCR_STORAGE_KEY]: JSON.stringify({
        version: 2,
        active: "baidu",
        ai: null,
        baidu: { operation: "accurate", credentialRef: BAIDU_REF },
      }),
      [baiduCredentialStorageKey(BAIDU_REF)]: JSON.stringify({ apiKey: 1 }),
    },
  });
  const unreadable = await open("./__tests__/recognize-app.tsx", {
    storage: broken,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: baiduNetwork({ words_result: [{ words: "Nope" }] }),
  });
  await unreadable.waitUntil(() => unreadable.texts()[0] !== "running");
  expect(JSON.parse(unreadable.texts()[1]!).readiness).toEqual({
    ready: false,
    reason: t("ocr.failure.unconfigured"),
  });
  expect(JSON.parse(unreadable.texts()[1]!).outcomes[0]).toEqual({
    status: "unavailable",
    reason: t("ocr.failure.unconfigured"),
  });
  expect(unreadable.requests()).toHaveLength(0);

  const swapped = await open("./__tests__/recognize-app.tsx", {
    storage: makeSeedStorage({ extra: baiduBindingStorage() }),
    host: { params: { pngBase64: BAIDU_PNG_BASE64, swapToAiModelId: "other-model" } },
    network: baiduNetwork({ words_result: [{ words: "Nope" }] }),
  });
  await swapped.waitUntil(() => swapped.texts()[0] !== "running");
  expect(JSON.parse(swapped.texts()[1]!).outcomes[0]).toEqual({
    status: "unavailable",
    reason: t("ocr.failure.unconfigured"),
  });
  expect(swapped.requests()).toHaveLength(0);
});
