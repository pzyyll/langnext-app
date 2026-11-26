// ABOUTME: Contract tests for the OCR channel contributions: parse, validate, readiness, execute, failure keys.
import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import type {
  ChannelBinding,
  CredentialRecord,
  HostModels,
  HostServices,
  ResolvedModelRoute,
} from "../../../framework/contributions";
import type { FetchLike, HttpResponseLike } from "../../../services/http";
import { createLogger } from "../../../services/log";
import { aiOcrChannel } from "./ai";
import { baiduOcrChannel } from "./baidu";
import { googleCloudOcrChannel } from "./google-cloud";
import { ocrChannelContributions } from "../index";

const MODEL_ROUTE: ResolvedModelRoute = {
  ok: true,
  modelId: "m-vision",
  modelKey: "gpt-4.1",
  connection: {
    providerTypeId: "openai",
    protocolId: "openai-responses",
    baseUrl: "https://vision.example.com/v1",
    credential: "sk-vision",
  },
};

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

function recordingFetch(respond: (url: string, index: number) => HttpResponseLike) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return respond(url, urls.length - 1);
  };
  return { urls, fetchImpl };
}

const UNUSED_MODELS: HostModels = {
  resolveSaved: async () => ({ ok: false, reason: "no saved model" }),
  generateText: async () => "",
  generateTextFromImage: async () => "",
};

function services(
  options: {
    credential?: CredentialRecord | null;
    fetchImpl?: FetchLike;
    models?: Partial<HostModels>;
  } = {},
): HostServices {
  return {
    credential: options.credential ?? null,
    models: { ...UNUSED_MODELS, ...options.models },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    log: createLogger("test/ocr"),
  };
}

function bindingOf<C>(config: C, credentialRef: string | null = null): ChannelBinding<C> {
  return { enabled: true, configured: true, config, credentialRef };
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
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** A 16x16 PNG, above Baidu's 15px minimum side. */
function syntheticPng(width: number, height: number): Uint8Array {
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  const header = pngChunk("IHDR", ihdr);
  const iend = pngChunk("IEND", new Uint8Array());
  const png = new Uint8Array(signature.length + header.length + iend.length);
  png.set(signature, 0);
  png.set(header, signature.length);
  png.set(iend, signature.length + header.length);
  return png;
}

const PNG = syntheticPng(16, 16);

const BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const GOOGLE_ANNOTATE_URL = "https://vision.googleapis.com/v1/images:annotate";

test("ocr contribution: registers the three channels in catalog order", () => {
  expect(ocrChannelContributions.map((contribution) => contribution.id)).toEqual([
    "ai",
    "baidu",
    "google-cloud",
  ]);
  for (const contribution of ocrChannelContributions) {
    expect(contribution.capability).toBe("ocr");
    expect(contribution.configurable).toBe(true);
  }
  expect(aiOcrChannel.labelKey).toBe("settings.ocr.ai");
  expect(baiduOcrChannel.labelKey).toBe("settings.ocr.baidu");
  expect(googleCloudOcrChannel.labelKey).toBe("settings.ocr.google-cloud");
  expect(aiOcrChannel.credential).toBeNull();
  expect(baiduOcrChannel.credential?.map((field) => field.key)).toEqual(["apiKey", "secretKey"]);
  expect(googleCloudOcrChannel.credential?.map((field) => field.key)).toEqual(["apiKey"]);
});

test("ocr contribution: parses saved config and rejects an unknown Baidu operation", () => {
  expect(aiOcrChannel.config.parse({ modelId: "m-vision" })).toEqual({ modelId: "m-vision" });
  expect(aiOcrChannel.config.parse({ modelId: 7 })).toBeNull();
  expect(aiOcrChannel.config.parse(null)).toBeNull();
  expect(aiOcrChannel.config.defaults()).toEqual({ modelId: "" });

  expect(baiduOcrChannel.config.parse({ operation: "accurate_basic" })).toEqual({
    operation: "accurate_basic",
  });
  expect(baiduOcrChannel.config.parse({ operation: "premium" })).toBeNull();
  expect(baiduOcrChannel.config.parse({})).toBeNull();
  expect(baiduOcrChannel.config.defaults()).toEqual({ operation: "accurate" });

  expect(googleCloudOcrChannel.config.parse({})).toEqual({});
  expect(googleCloudOcrChannel.config.parse("vision")).toBeNull();
  expect(googleCloudOcrChannel.config.defaults()).toEqual({});
});

test("ocr contribution: validate returns the legacy error keys for missing input", () => {
  expect(
    aiOcrChannel.validate!({
      config: { modelId: "   " },
      credentialDraft: {},
      savedCredential: false,
    }),
  ).toEqual({ ok: false, key: "settings.ocr.error.modelIdBlank" });
  expect(
    aiOcrChannel.validate!({
      config: { modelId: "m-vision" },
      credentialDraft: {},
      savedCredential: false,
    }),
  ).toEqual({ ok: true });

  const baiduDraft = (apiKey: string, secretKey: string, savedCredential = false) =>
    baiduOcrChannel.validate!({
      config: { operation: "accurate" },
      credentialDraft: { apiKey, secretKey },
      savedCredential,
    });
  expect(baiduDraft("", "")).toEqual({ ok: false, key: "settings.ocr.error.baiduKeysRequired" });
  expect(baiduDraft("key", "  ")).toEqual({
    ok: false,
    key: "settings.ocr.error.baiduKeysRequired",
  });
  expect(baiduDraft("key", "secret")).toEqual({ ok: true });
  expect(baiduDraft("", "", true)).toEqual({ ok: true });

  const googleDraft = (apiKey: string, savedCredential = false) =>
    googleCloudOcrChannel.validate!({ config: {}, credentialDraft: { apiKey }, savedCredential });
  expect(googleDraft("")).toEqual({ ok: false, key: "settings.ocr.error.googleCloudKeyRequired" });
  expect(googleDraft("AIza-synthetic")).toEqual({ ok: true });
  expect(googleDraft("", true)).toEqual({ ok: true });
});

test("ocr contribution: Baidu runs through the host credential and fetch", async () => {
  const fetcher = recordingFetch((_url, index) =>
    index === 0
      ? jsonResponse({ access_token: "fixture-token" })
      : jsonResponse({
          words_result: [{ words: "First line" }, { words: "\u7b2c\u4e8c\u884c" }],
          words_result_num: 2,
        }),
  );
  const binding = bindingOf({ operation: "accurate" as const }, "baidu-ref");
  const live = services({
    credential: { apiKey: "api-key", secretKey: "secret-key" },
    fetchImpl: fetcher.fetchImpl,
  });

  expect(await baiduOcrChannel.readiness(binding, services())).toEqual({
    ready: false,
    reason: t("ocr.failure.unconfigured"),
  });
  expect(await baiduOcrChannel.readiness(binding, live)).toEqual({ ready: true });
  expect(await baiduOcrChannel.execute(binding, { png: PNG }, live)).toEqual({
    status: "recognized",
    text: "First line\n\u7b2c\u4e8c\u884c",
  });
  expect(fetcher.urls[0]).toBe(BAIDU_TOKEN_URL);
  expect(fetcher.urls[1]).toContain("/rest/2.0/ocr/v1/accurate");
  expect(fetcher.urls[1]).toContain("access_token=fixture-token");

  expect(await baiduOcrChannel.execute(binding, { png: PNG }, services())).toEqual({
    status: "unavailable",
    reason: t("ocr.failure.unconfigured"),
  });
});

test("ocr contribution: Google Cloud runs through the host credential and fetch", async () => {
  const fetcher = recordingFetch(() =>
    jsonResponse({ responses: [{ fullTextAnnotation: { text: "Hello\n\u4f60\u597d" } }] }),
  );
  const binding = bindingOf({}, "vision-ref");
  const live = services({
    credential: { apiKey: "AIza-synthetic" },
    fetchImpl: fetcher.fetchImpl,
  });

  expect(await googleCloudOcrChannel.readiness(binding, services())).toEqual({
    ready: false,
    reason: t("ocr.failure.unconfigured"),
  });
  expect(await googleCloudOcrChannel.readiness(binding, live)).toEqual({ ready: true });
  expect(await googleCloudOcrChannel.execute(binding, { png: PNG }, live)).toEqual({
    status: "recognized",
    text: "Hello\n\u4f60\u597d",
  });
  expect(fetcher.urls).toEqual([GOOGLE_ANNOTATE_URL]);
});

test("ocr contribution: AI resolves the saved image model and transcribes its answer", async () => {
  const resolutions: Array<[string, string]> = [];
  const requests: Array<{ modelId: string; image: { mimeType: string; base64: string } }> = [];
  const models: Partial<HostModels> = {
    resolveSaved: async (modelId, purpose) => {
      resolutions.push([modelId, purpose]);
      return MODEL_ROUTE;
    },
    generateTextFromImage: async (_connection, request) => {
      requests.push(request);
      return JSON.stringify({ text: "first line" });
    },
  };
  const binding = bindingOf({ modelId: "m-vision" });
  const live = services({ models });

  expect(await aiOcrChannel.readiness(binding, live)).toEqual({ ready: true });
  expect(await aiOcrChannel.execute(binding, { png: PNG }, live)).toEqual({
    status: "recognized",
    text: "first line",
  });
  expect(resolutions).toEqual([
    ["m-vision", "image"],
    ["m-vision", "image"],
  ]);
  expect(requests[0]!.modelId).toBe("gpt-4.1");
  expect(requests[0]!.image).toEqual({
    mimeType: "image/png",
    base64: Buffer.from(PNG).toString("base64"),
  });
});

test("ocr contribution: AI reports an ineligible model, an unreadable answer, and a timeout", async () => {
  const ineligible = services({
    models: { resolveSaved: async () => ({ ok: false, reason: "not image-capable" }) },
  });
  const binding = bindingOf({ modelId: "m-vision" });
  expect(await aiOcrChannel.readiness(binding, ineligible)).toEqual({
    ready: false,
    reason: "not image-capable",
  });
  expect(await aiOcrChannel.execute(binding, { png: PNG }, ineligible)).toEqual({
    status: "unavailable",
    reason: "not image-capable",
  });

  const prose = services({
    models: {
      resolveSaved: async () => MODEL_ROUTE,
      generateTextFromImage: async () => "Here is the text: first line",
    },
  });
  expect(await aiOcrChannel.execute(binding, { png: PNG }, prose)).toEqual({
    status: "failed",
    failure: "malformed_answer",
  });

  const blankModel = bindingOf({ modelId: "  " });
  expect(await aiOcrChannel.readiness(blankModel, prose)).toEqual({
    ready: false,
    reason: t("settings.ocr.error.modelIdBlank"),
  });
});

test("ocr contribution: failureKey maps every vendor failure code", () => {
  const baidu: Record<string, string> = {
    invalid_image: "ocr.failure.invalidImage",
    image_too_small: "ocr.failure.imageTooSmall",
    image_too_large: "ocr.failure.imageTooLarge",
    credentials: "ocr.failure.baiduCredentials",
    rate_limited: "ocr.failure.baiduLater",
    quota: "ocr.failure.baiduQuota",
    malformed: "ocr.failure.baiduResponse",
    service: "ocr.failure.failed",
    timeout: "ocr.failure.timeout",
  };
  for (const [code, key] of Object.entries(baidu)) {
    expect(baiduOcrChannel.failureKey(code)).toBe(key);
  }
  expect(baiduOcrChannel.failureKey("mystery")).toBeNull();

  const google: Record<string, string> = {
    image_too_large: "ocr.failure.imageTooLarge",
    setup: "ocr.failure.googleSetup",
    quota: "ocr.failure.googleQuota",
    malformed: "ocr.failure.googleResponse",
    service: "ocr.failure.googleFailed",
    timeout: "ocr.failure.timeout",
  };
  for (const [code, key] of Object.entries(google)) {
    expect(googleCloudOcrChannel.failureKey(code)).toBe(key);
  }
  expect(googleCloudOcrChannel.failureKey("mystery")).toBeNull();

  expect(aiOcrChannel.failureKey("malformed_answer")).toBe("ocr.failure.malformedAnswer");
  expect(aiOcrChannel.failureKey("timeout")).toBe("ocr.failure.timeout");
  expect(aiOcrChannel.failureKey("failed")).toBe("ocr.failure.failed");
  expect(aiOcrChannel.failureKey("mystery")).toBeNull();
});

test("ocr contribution: describe names the saved configuration", () => {
  expect(baiduOcrChannel.describe(bindingOf({ operation: "accurate_basic" as const }))).toBe(
    t("settings.ocr.operation.accurate_basic"),
  );
  expect(googleCloudOcrChannel.describe(bindingOf({}))).toBe(t("settings.ocr.configured"));
  expect(aiOcrChannel.describe(bindingOf({ modelId: "m-vision" }))).toBe("m-vision");
  expect(
    aiOcrChannel.describe(bindingOf({ modelId: "m-vision" }), {
      resolveModelBinding: () => ({ ok: true, label: "OpenAI Main · gpt-4.1" }),
    }),
  ).toBe("OpenAI Main · gpt-4.1");
  expect(
    aiOcrChannel.describe(bindingOf({ modelId: "m-removed" }), {
      resolveModelBinding: () => ({
        ok: false,
        reason: "deleted",
        label: t("presets.model.unavailableLabel"),
      }),
    }),
  ).toBe(t("presets.model.unavailableLabel"));
  expect(aiOcrChannel.describe(bindingOf({ modelId: "  " }))).toBe(t("settings.ocr.notConfigured"));
});
