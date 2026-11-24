import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { initializeAiModules } from "../../app/ai-setup";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { OCR_MAX_IMAGE_BYTES, recognizeScreenshot } from "./recognize";
import {
  baiduCredentialStorageKey,
  googleCloudCredentialStorageKey,
  OCR_STORAGE_KEY,
  type BaiduOcrOperation,
  type OcrServiceKind,
} from "./settings";

initializeAiModules();

/** Smallest valid PNG payload (1x1); recognition treats the bytes as opaque. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
const VISION_MODEL_ID = "vision-model";
const BAIDU_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAAAAAA6mKC9AAAAAElFTkSuQmCC";
const BAIDU_REF = "baidu-ref";
const GOOGLE_REF = "google-ref";
const GOOGLE_KEY = "synthetic-vision-key";
const GOOGLE_ANNOTATE = "https://vision.googleapis.com/v1/images:annotate";

const BAIDU_TOKEN = "POST https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_OCR =
  "POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token";

function ocrSeedRecord(options: {
  order?: readonly OcrServiceKind[];
  enabled?: Partial<Record<OcrServiceKind, boolean>>;
  aiModelId?: string | null;
  baidu?: { operation: BaiduOcrOperation; credentialRef: string } | null;
  googleCloud?: { credentialRef: string; apiKey?: string | null } | null;
}): Record<string, string> {
  const ai = options.aiModelId ? { modelId: options.aiModelId } : null;
  const baidu = options.baidu ?? null;
  const googleCloud = options.googleCloud ?? null;
  const enabled: Record<string, boolean> = {
    ai: options.enabled?.ai ?? ai !== null,
    baidu: options.enabled?.baidu ?? baidu !== null,
  };
  if (options.enabled?.["google-cloud"] !== undefined || googleCloud !== null) {
    enabled["google-cloud"] = options.enabled?.["google-cloud"] ?? true;
  }
  const record: Record<string, unknown> = {
    version: 4,
    order: options.order ?? ["ai", "baidu"],
    enabled,
    ai,
    baidu,
  };
  if (googleCloud !== null) {
    record["google-cloud"] = { credentialRef: googleCloud.credentialRef };
  }
  const extra: Record<string, string> = {
    [OCR_STORAGE_KEY]: JSON.stringify(record),
  };
  if (baidu) {
    extra[baiduCredentialStorageKey(baidu.credentialRef)] = JSON.stringify({
      apiKey: "synthetic-api-key",
      secretKey: "synthetic-secret-key",
    });
  }
  if (googleCloud !== null && googleCloud.apiKey !== null) {
    extra[googleCloudCredentialStorageKey(googleCloud.credentialRef)] = JSON.stringify({
      apiKey: googleCloud.apiKey ?? GOOGLE_KEY,
    });
  }
  return extra;
}

function googleLines(text: string): unknown {
  return { responses: [{ fullTextAnnotation: { text } }] };
}

function ocrBindingStorage(modelId: string): Record<string, string> {
  return ocrSeedRecord({ aiModelId: modelId });
}

function baiduBindingStorage(): Record<string, string> {
  return ocrSeedRecord({
    order: ["baidu", "ai"],
    enabled: { ai: false, baidu: true },
    baidu: { operation: "accurate", credentialRef: BAIDU_REF },
  });
}

function baiduNetwork(ocrBody: unknown) {
  return {
    [BAIDU_TOKEN]: { status: 200, body: { access_token: "fixture-token" } },
    [BAIDU_OCR]: { status: 200, body: ocrBody },
  };
}

/** Vision-capable reply: one JSON object with the transcribed lines. */
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

function visionSeedStorage(extra: Record<string, string> = {}) {
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
  return makeSeedStorage({
    channels: [channel],
    models: [model],
    credentials: { "ch-vision": "sk-vision" },
    extra,
  });
}

test("ocr recognize: returns the recognized lines from a saved image model", async () => {
  const app = await open("./__tests__/recognize-app.tsx", {
    storage: visionSeedStorage(ocrBindingStorage(VISION_MODEL_ID)),
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
  const app = await open("./__tests__/recognize-app.tsx", {
    storage: visionSeedStorage(ocrBindingStorage(VISION_MODEL_ID)),
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
  const storage = visionSeedStorage(ocrBindingStorage(VISION_MODEL_ID));
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
    [{ kind: "ai", modelId: "any-model" }],
    new Uint8Array([1, 2, 3]),
  );
  expect(invalid).toEqual({ status: "failed", message: t("ocr.failure.invalidImage") });

  const oversized = new Uint8Array(OCR_MAX_IMAGE_BYTES + 1);
  oversized.set(PNG_BYTES);
  const tooLarge = await recognizeScreenshot([{ kind: "ai", modelId: "any-model" }], oversized);
  expect(tooLarge).toEqual({ status: "failed", message: t("ocr.failure.imageTooLarge") });
});

test("ocr recognize: an empty channel list is unavailable without a request", async () => {
  const outcome = await recognizeScreenshot([], PNG_BYTES);
  expect(outcome).toEqual({ status: "unavailable", reason: t("ocr.failure.unconfigured") });
});

test("ocr recognize: reports a timeout without importing text", async () => {
  const app = await open("./__tests__/recognize-app.tsx", {
    storage: visionSeedStorage(ocrBindingStorage(VISION_MODEL_ID)),
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
  const app = await open("./__tests__/recognize-app.tsx", {
    storage: visionSeedStorage(ocrBindingStorage(VISION_MODEL_ID)),
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
    network: baiduNetwork({
      words_result: [{ words: "First line" }, { words: "\u7b2c\u4e8c\u884c" }],
      words_result_num: 2,
    }),
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

test("ocr recognize: unreadable Baidu keys and a disabled binding send nothing", async () => {
  const broken = makeSeedStorage({
    extra: {
      [OCR_STORAGE_KEY]: JSON.stringify({
        version: 4,
        order: ["baidu", "ai"],
        enabled: { ai: false, baidu: true },
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

  const disabled = await open("./__tests__/recognize-app.tsx", {
    storage: makeSeedStorage({ extra: baiduBindingStorage() }),
    host: { params: { pngBase64: BAIDU_PNG_BASE64, disableBaiduBeforeRecognize: true } },
    network: baiduNetwork({ words_result: [{ words: "Nope" }] }),
  });
  await disabled.waitUntil(() => disabled.texts()[0] !== "running");
  expect(JSON.parse(disabled.texts()[1]!).outcomes[0]).toEqual({
    status: "unavailable",
    reason: t("ocr.failure.unconfigured"),
  });
  expect(disabled.requests()).toHaveLength(0);
});

test("ocr recognize: falls back from primary Baidu failure to backup AI", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["baidu", "ai"],
      enabled: { ai: true, baidu: true },
      aiModelId: VISION_MODEL_ID,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
  );
  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      ...baiduNetwork({ error_code: 17, error_msg: "quota exceeded" }),
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("fallback ai text"),
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "recognized", text: "fallback ai text" });
  expect(app.requests().map((req) => req.url)).toEqual([
    "https://aip.baidubce.com/oauth/2.0/token",
    "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token",
    "https://vision.example.com/v1/responses",
  ]);
});

test("ocr recognize: falls back from primary AI failure to backup Baidu", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["ai", "baidu"],
      enabled: { ai: true, baidu: true },
      aiModelId: VISION_MODEL_ID,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
  );
  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      "POST https://vision.example.com/v1/responses": {
        status: 500,
        body: { error: "upstream error" },
      },
      ...baiduNetwork({
        words_result: [{ words: "backup baidu text" }],
        words_result_num: 1,
      }),
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "recognized", text: "backup baidu text" });
  expect(app.requests().map((req) => req.url)).toEqual([
    "https://vision.example.com/v1/responses",
    "https://aip.baidubce.com/oauth/2.0/token",
    "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token",
  ]);
});

test("ocr recognize: skips unavailable primary AI model and succeeds via backup Baidu", async () => {
  const storage = makeSeedStorage({
    extra: ocrSeedRecord({
      order: ["ai", "baidu"],
      enabled: { ai: true, baidu: true },
      aiModelId: "deleted-model",
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
  });
  const ready = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64, readinessOnly: true } },
  });
  await ready.waitUntil(() => ready.texts()[0] !== "running");
  expect(JSON.parse(ready.texts()[1]!).readiness).toEqual({ ready: true, reason: null });
  expect(ready.requests()).toHaveLength(0);

  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: baiduNetwork({
      words_result: [{ words: "baidu backup" }],
      words_result_num: 1,
    }),
  });
  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "recognized", text: "baidu backup" });
  expect(app.requests()).toHaveLength(2);
});

test("ocr recognize: skips disabled first channel and runs enabled backup directly", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["baidu", "ai"],
      enabled: { ai: true, baidu: false },
      aiModelId: VISION_MODEL_ID,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
  );
  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      ...baiduNetwork({ words_result: [{ words: "should not run" }] }),
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("direct ai"),
      },
    },
  });

  await app.waitUntil(() => app.texts()[0] !== "running");
  const result = JSON.parse(app.texts()[1]!);
  expect(result.outcomes[0]).toEqual({ status: "recognized", text: "direct ai" });
  expect(app.requests().map((req) => req.url)).toEqual(["https://vision.example.com/v1/responses"]);
});

test("ocr recognize: stops on primary no_text or cancellation without calling backup", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["baidu", "ai"],
      enabled: { ai: true, baidu: true },
      aiModelId: VISION_MODEL_ID,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
  );

  const noText = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      ...baiduNetwork({ words_result: [], words_result_num: 0 }),
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("should not run"),
      },
    },
  });
  await noText.waitUntil(() => noText.texts()[0] !== "running");
  expect(JSON.parse(noText.texts()[1]!).outcomes[0]).toEqual({ status: "no_text" });
  expect(noText.requests().some((req) => req.url.includes("vision.example.com"))).toBe(false);

  const cancelled = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64, abortAfterMs: 20 } },
    network: {
      [BAIDU_TOKEN]: { status: 200, body: { access_token: "fixture-token" }, delay: 2_000 },
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("should not run"),
      },
    },
  });
  await cancelled.waitUntil(() => cancelled.texts()[0] !== "running");
  expect(JSON.parse(cancelled.texts()[1]!).outcomes[0]).toEqual({ status: "cancelled" });
  expect(cancelled.requests().some((req) => req.url.includes("vision.example.com"))).toBe(false);
});

test("ocr recognize: falls back past Baidu local dimension failure to AI and surfaces final failure when all fail", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["baidu", "ai"],
      enabled: { ai: true, baidu: true },
      aiModelId: VISION_MODEL_ID,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
  );

  // 1x1 PNG is below Baidu's 15px minimum side, so Baidu fails locally and AI succeeds.
  const tinyFallback = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      ...baiduNetwork({ words_result: [{ words: "unreachable" }] }),
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("tiny image recognized by ai"),
      },
    },
  });
  await tinyFallback.waitUntil(() => tinyFallback.texts()[0] !== "running");
  expect(JSON.parse(tinyFallback.texts()[1]!).outcomes[0]).toEqual({
    status: "recognized",
    text: "tiny image recognized by ai",
  });
  expect(tinyFallback.requests().map((req) => req.url)).toEqual([
    "https://vision.example.com/v1/responses",
  ]);

  // Both fail -> returns failed without text.
  const bothFail = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: {
      ...baiduNetwork({ error_code: 17, error_msg: "quota" }),
      "POST https://vision.example.com/v1/responses": {
        status: 500,
        body: { error: "busy" },
      },
    },
  });
  await bothFail.waitUntil(() => bothFail.texts()[0] !== "running");
  expect(JSON.parse(bothFail.texts()[1]!).outcomes[0].status).toBe("failed");

  // Baidu fails with quota, backup AI model is deleted -> preserves Baidu's quota failure.
  const baiduFailsAiUnavailable = await open("./__tests__/recognize-app.tsx", {
    storage: makeSeedStorage({
      extra: ocrSeedRecord({
        order: ["baidu", "ai"],
        enabled: { ai: true, baidu: true },
        aiModelId: "deleted-model",
        baidu: { operation: "accurate", credentialRef: BAIDU_REF },
      }),
    }),
    host: { params: { pngBase64: BAIDU_PNG_BASE64 } },
    network: baiduNetwork({ error_code: 17, error_msg: "quota" }),
  });
  await baiduFailsAiUnavailable.waitUntil(() => baiduFailsAiUnavailable.texts()[0] !== "running");
  expect(JSON.parse(baiduFailsAiUnavailable.texts()[1]!).outcomes[0]).toEqual({
    status: "failed",
    message: t("ocr.failure.baiduQuota"),
  });
});

function googleStorage(
  googleCloud: { credentialRef: string; apiKey?: string | null } = { credentialRef: GOOGLE_REF },
) {
  return makeSeedStorage({
    extra: ocrSeedRecord({
      order: ["google-cloud"],
      enabled: { ai: false, baidu: false, "google-cloud": true },
      googleCloud,
    }),
  });
}

test("ocr recognize: a saved Vision binding is ready without requests and returns the lines", async () => {
  const storage = googleStorage();
  const ready = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64, readinessOnly: true } },
  });
  await ready.waitUntil(() => ready.texts()[0] !== "running");
  expect(JSON.parse(ready.texts()[1]!).readiness).toEqual({ ready: true, reason: null });
  expect(ready.requests()).toHaveLength(0);

  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      ["POST " + GOOGLE_ANNOTATE]: { status: 200, body: googleLines("Hello\n你好") },
    },
  });
  await app.waitUntil(() => app.texts()[0] !== "running");
  expect(JSON.parse(app.texts()[1]!).outcomes[0]).toEqual({
    status: "recognized",
    text: "Hello\n你好",
  });
  const requests = app.requests();
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe(GOOGLE_ANNOTATE);
  expect(request.url).not.toContain(GOOGLE_KEY);
  expect(request.headers?.["x-goog-api-key"]).toBe(GOOGLE_KEY);
  expect(JSON.parse(request.body ?? "")).toEqual({
    requests: [
      {
        image: { content: PNG_BASE64 },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      },
    ],
  });
});

test("ocr recognize: a missing Vision key or a disabled channel sends nothing", async () => {
  const missing = await open("./__tests__/recognize-app.tsx", {
    storage: googleStorage({ credentialRef: GOOGLE_REF, apiKey: null }),
    host: { params: { pngBase64: PNG_BASE64 } },
    network: { ["POST " + GOOGLE_ANNOTATE]: { status: 200, body: googleLines("Nope") } },
  });
  await missing.waitUntil(() => missing.texts()[0] !== "running");
  const missingResult = JSON.parse(missing.texts()[1]!);
  expect(missingResult.readiness).toEqual({
    ready: false,
    reason: t("ocr.failure.unconfigured"),
  });
  expect(missingResult.outcomes[0]).toEqual({
    status: "unavailable",
    reason: t("ocr.failure.unconfigured"),
  });
  expect(missing.requests()).toHaveLength(0);

  const disabled = await open("./__tests__/recognize-app.tsx", {
    storage: googleStorage(),
    host: { params: { pngBase64: PNG_BASE64, disableGoogleCloudBeforeRecognize: true } },
    network: { ["POST " + GOOGLE_ANNOTATE]: { status: 200, body: googleLines("Nope") } },
  });
  await disabled.waitUntil(() => disabled.texts()[0] !== "running");
  expect(JSON.parse(disabled.texts()[1]!).readiness).toEqual({ ready: true, reason: null });
  expect(JSON.parse(disabled.texts()[1]!).outcomes[0]).toEqual({
    status: "unavailable",
    reason: t("ocr.failure.unconfigured"),
  });
  expect(disabled.requests()).toHaveLength(0);
});

test("ocr recognize: maps Vision failures without exposing provider text", async () => {
  const cases: { body: unknown; status: number; message: string }[] = [
    {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "SENTINEL-SECRET",
          details: [{ reason: "API_KEY_INVALID", domain: "googleapis.com" }],
        },
      },
      message: t("ocr.failure.googleSetup"),
    },
    {
      status: 429,
      body: { error: { code: 429, message: "SENTINEL-SECRET", status: "RESOURCE_EXHAUSTED" } },
      message: t("ocr.failure.googleQuota"),
    },
    {
      status: 413,
      body: { error: { code: 413, message: "SENTINEL-SECRET" } },
      message: t("ocr.failure.imageTooLarge"),
    },
    {
      status: 500,
      body: { error: { code: 500, message: "SENTINEL-SECRET" } },
      message: t("ocr.failure.googleFailed"),
    },
    {
      status: 200,
      body: { responses: [{ error: { message: "SENTINEL-SECRET" } }] },
      message: t("ocr.failure.googleResponse"),
    },
  ];
  for (const entry of cases) {
    const app = await open("./__tests__/recognize-app.tsx", {
      storage: googleStorage(),
      host: { params: { pngBase64: PNG_BASE64 } },
      network: { ["POST " + GOOGLE_ANNOTATE]: { status: entry.status, body: entry.body } },
    });
    await app.waitUntil(() => app.texts()[0] !== "running");
    const result = JSON.parse(app.texts()[1]!).outcomes[0];
    expect(result).toEqual({ status: "failed", message: entry.message });
    expect(JSON.stringify(result).includes("SENTINEL-SECRET")).toBe(false);
    expect(app.requests()).toHaveLength(1);
  }
});

test("ocr recognize: falls back from primary Vision failure to backup AI", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["google-cloud", "ai"],
      enabled: { ai: true, "google-cloud": true },
      aiModelId: VISION_MODEL_ID,
      googleCloud: { credentialRef: GOOGLE_REF },
    }),
  );
  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      ["POST " + GOOGLE_ANNOTATE]: {
        status: 500,
        body: { error: { code: 500, message: "SENTINEL-SECRET" } },
      },
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("fallback ai text"),
      },
    },
  });
  await app.waitUntil(() => app.texts()[0] !== "running");
  expect(JSON.parse(app.texts()[1]!).outcomes[0]).toEqual({
    status: "recognized",
    text: "fallback ai text",
  });
  expect(app.requests().map((request) => request.url)).toEqual([
    GOOGLE_ANNOTATE,
    "https://vision.example.com/v1/responses",
  ]);
});

test("ocr recognize: falls back from primary AI failure to backup Vision", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["ai", "google-cloud"],
      enabled: { ai: true, "google-cloud": true },
      aiModelId: VISION_MODEL_ID,
      googleCloud: { credentialRef: GOOGLE_REF },
    }),
  );
  const app = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      "POST https://vision.example.com/v1/responses": { status: 500, body: { error: "busy" } },
      ["POST " + GOOGLE_ANNOTATE]: { status: 200, body: googleLines("vision fallback") },
    },
  });
  await app.waitUntil(() => app.texts()[0] !== "running");
  expect(JSON.parse(app.texts()[1]!).outcomes[0]).toEqual({
    status: "recognized",
    text: "vision fallback",
  });
  expect(app.requests().map((request) => request.url)).toEqual([
    "https://vision.example.com/v1/responses",
    GOOGLE_ANNOTATE,
  ]);
});

test("ocr recognize: Vision no-text and cancellation do not call the backup", async () => {
  const storage = visionSeedStorage(
    ocrSeedRecord({
      order: ["google-cloud", "ai"],
      enabled: { ai: true, "google-cloud": true },
      aiModelId: VISION_MODEL_ID,
      googleCloud: { credentialRef: GOOGLE_REF },
    }),
  );
  const noText = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64 } },
    network: {
      ["POST " + GOOGLE_ANNOTATE]: { status: 200, body: googleLines("  \n") },
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("should not run"),
      },
    },
  });
  await noText.waitUntil(() => noText.texts()[0] !== "running");
  expect(JSON.parse(noText.texts()[1]!).outcomes[0]).toEqual({ status: "no_text" });
  expect(noText.requests().some((request) => request.url.includes("vision.example.com"))).toBe(
    false,
  );

  const cancelled = await open("./__tests__/recognize-app.tsx", {
    storage,
    host: { params: { pngBase64: PNG_BASE64, abortAfterMs: 20 } },
    network: {
      ["POST " + GOOGLE_ANNOTATE]: { status: 200, body: googleLines("late"), delay: 2_000 },
      "POST https://vision.example.com/v1/responses": {
        status: 200,
        body: recognitionBody("should not run"),
      },
    },
  });
  await cancelled.waitUntil(() => cancelled.texts()[0] !== "running");
  expect(JSON.parse(cancelled.texts()[1]!).outcomes[0]).toEqual({ status: "cancelled" });
  expect(cancelled.requests().some((request) => request.url.includes("vision.example.com"))).toBe(
    false,
  );
});
