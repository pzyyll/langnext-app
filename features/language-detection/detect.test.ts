import { expect, test } from "nsh/test";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import type { AiClientInput } from "../../modules/ai/runtime/client";
import {
  detectLanguage,
  GOOGLE_DETECTION_URL,
  type DetectLanguageOptions,
  type GoogleDetectionFetch,
} from "./detect";
import type { LanguageDetectorBinding } from "./settings";

const CONNECTION: AiClientInput = {
  providerTypeId: "openai",
  protocolId: "openai-responses",
  baseUrl: "https://api.example.com/v1",
  credential: "sk-test",
};

const GOOGLE_DETECTOR: LanguageDetectorBinding = { kind: "google" };
const GOOGLE_CLOUD_DETECTOR: LanguageDetectorBinding = {
  kind: "google-cloud",
  credentialRef: "ref-1",
};

function aiDetector(modelId: string): LanguageDetectorBinding {
  return { kind: "ai", modelId };
}

function aiDetectors(modelIds: readonly string[]): LanguageDetectorBinding[] {
  return modelIds.map(aiDetector);
}

interface Harness {
  resolveCalls: string[];
  requests: { modelId: string; request: TextGenerationRequest }[];
  options: Parameters<typeof detectLanguage>[2];
}

function harness(options: {
  unavailable?: readonly string[];
  responses?: Record<string, () => Promise<string>>;
  resolve?: (
    modelId: string,
  ) => Promise<
    | { ok: true; modelId: string; modelKey: string; connection: typeof CONNECTION }
    | { ok: false; reason: string }
  >;
}): Harness {
  const resolveCalls: string[] = [];
  const requests: { modelId: string; request: TextGenerationRequest }[] = [];
  return {
    resolveCalls,
    requests,
    options: {
      resolveSavedModelRequest: async (modelId: string) => {
        resolveCalls.push(modelId);
        if (options.resolve) return options.resolve(modelId);
        if (options.unavailable?.includes(modelId)) {
          return { ok: false, reason: "Model unavailable" };
        }
        return {
          ok: true,
          modelId,
          modelKey: `key-${modelId}`,
          connection: CONNECTION,
        };
      },
      generateText: async (_connection, request) => {
        requests.push({ modelId: request.modelId, request });
        const responder = options.responses?.[request.modelId];
        if (!responder) throw new Error("unexpected generation");
        return responder();
      },
    },
  };
}

test("AI detection: sends the sample to the saved model and accepts a trimmed language ID", async () => {
  const h = harness({ responses: { "key-m1": async () => " FR\n" } });

  const result = await detectLanguage("  Bonjour le monde  ", aiDetectors(["m1"]), h.options);

  expect(result).toEqual({ ok: true, language: "fr" });
  expect(h.resolveCalls).toEqual(["m1"]);
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]!.modelId).toBe("key-m1");
  expect(h.requests[0]!.request.user).toBe("Bonjour le monde");
  expect(h.requests[0]!.request.system).not.toContain("Bonjour");
  expect(h.requests[0]!.request.system).toContain("und");
  expect(h.requests[0]!.request.disableReasoning).toBe(true);
  expect(h.requests[0]!.request.system).toContain("fr");
  expect(h.requests[0]!.request.temperature).toBeUndefined();
  expect(h.requests[0]!.request.maxOutputTokens).toBeUndefined();
});

test("AI detection: bounds the sample to 2048 code points without splitting a code point", async () => {
  const h = harness({ responses: { "key-m1": async () => "en" } });
  const text = `a${"😀".repeat(3000)}`;

  await detectLanguage(text, aiDetectors(["m1"]), h.options);

  const sample = h.requests[0]!.request.user;
  expect(Array.from(sample)).toHaveLength(2048);
  expect(sample.startsWith("a😀")).toBe(true);
  expect(sample.endsWith("😀")).toBe(true);
});

test("AI detection: falls through an unavailable detector, a rate limit, and a malformed answer", async () => {
  const h = harness({
    unavailable: ["m1"],
    responses: {
      "key-m2": async () => {
        throw new ProviderProtocolError("rate_limited", "Too many requests", 429);
      },
      "key-m3": async () => "The text is French.",
      "key-m4": async () => "fr",
    },
  });

  const result = await detectLanguage("Bonjour", aiDetectors(["m1", "m2", "m3", "m4"]), h.options);

  expect(result).toEqual({ ok: true, language: "fr" });
  expect(h.resolveCalls).toEqual(["m1", "m2", "m3", "m4"]);
  expect(h.requests.map((entry) => entry.modelId)).toEqual(["key-m2", "key-m3", "key-m4"]);
});

test("AI detection: accepts only an exact supported ID, never prose, JSON, or auto", async () => {
  const answers = ["fr-FR", "```fr```", '{"language":"fr"}', "auto", "French", "zh_CN", "FR"];
  for (const [index, answer] of answers.entries()) {
    const h = harness({ responses: { "key-m1": async () => answer } });
    const result = await detectLanguage("Texte", aiDetectors(["m1"]), h.options);
    if (index === answers.length - 1) {
      expect(result).toEqual({ ok: true, language: "fr" });
    } else {
      expect(result).toEqual({ ok: false, code: "failed" });
    }
  }
});

test("AI detection: tries the next detector after und and reports unknown_language when every answer is und", async () => {
  const retry = harness({
    responses: { "key-m1": async () => "und", "key-m2": async () => "ja" },
  });
  expect(await detectLanguage("Texte", aiDetectors(["m1", "m2"]), retry.options)).toEqual({
    ok: true,
    language: "ja",
  });
  expect(retry.requests.map((entry) => entry.modelId)).toEqual(["key-m1", "key-m2"]);

  const allUnd = harness({
    responses: { "key-m1": async () => "und", "key-m2": async () => " UND " },
  });
  expect(await detectLanguage("Texte", aiDetectors(["m1", "m2"]), allUnd.options)).toEqual({
    ok: false,
    code: "unknown_language",
  });
});

test("AI detection: reports no_eligible_model when no request was possible", async () => {
  const h = harness({ unavailable: ["m1", "m2"] });

  expect(await detectLanguage("Texte", aiDetectors(["m1", "m2"]), h.options)).toEqual({
    ok: false,
    code: "no_eligible_model",
  });
  expect(h.requests).toHaveLength(0);
});

test("AI detection: reports failed when attempts fail without a definite und answer", async () => {
  const h = harness({
    responses: {
      "key-m1": async () => {
        throw new ProviderProtocolError("server", "Upstream failed", 500);
      },
      "key-m2": async () => "not a language",
    },
  });

  expect(await detectLanguage("Texte", aiDetectors(["m1", "m2"]), h.options)).toEqual({
    ok: false,
    code: "failed",
  });
});

test("AI detection: maps an unexpected exception to failed and falls through to the next detector", async () => {
  const h = harness({
    responses: {
      "key-m1": async () => {
        throw new Error("secret provider detail");
      },
      "key-m2": async () => "fr",
    },
  });

  const result = await detectLanguage("Texte", aiDetectors(["m1", "m2"]), h.options);

  expect(result).toEqual({ ok: true, language: "fr" });
  expect(JSON.stringify(result)).not.toContain("secret provider detail");
  expect(h.requests.map((entry) => entry.modelId)).toEqual(["key-m1", "key-m2"]);
  expect(h.resolveCalls).toEqual(["m1", "m2"]);
});

test("detection: blank input and an empty chain resolve nothing", async () => {
  const blank = harness({ responses: {} });
  expect(await detectLanguage("   ", aiDetectors(["m1"]), blank.options)).toEqual({
    ok: false,
    code: "blank_input",
  });
  expect(blank.resolveCalls).toHaveLength(0);

  const empty = harness({ responses: {} });
  expect(await detectLanguage("Texte", [], empty.options)).toEqual({
    ok: false,
    code: "unconfigured",
  });
  expect(empty.resolveCalls).toHaveLength(0);
});

test("AI detection: stops on cancellation during resolution and prevents later attempts", async () => {
  const controller = new AbortController();
  const resolveCalls: string[] = [];
  const requests: string[] = [];

  const result = await detectLanguage("Texte", aiDetectors(["m1", "m2"]), {
    signal: controller.signal,
    resolveSavedModelRequest: async (modelId) => {
      resolveCalls.push(modelId);
      controller.abort();
      return { ok: true, modelId, modelKey: `key-${modelId}`, connection: CONNECTION };
    },
    generateText: async (_connection, request) => {
      requests.push(request.modelId);
      return "fr";
    },
  });

  expect(result).toEqual({ ok: false, code: "cancelled" });
  expect(resolveCalls).toEqual(["m1"]);
  expect(requests).toHaveLength(0);
});

test("AI detection: ignores a late result after cancellation", async () => {
  const controller = new AbortController();
  const requests: string[] = [];

  const result = await detectLanguage("Texte", aiDetectors(["m1", "m2"]), {
    signal: controller.signal,
    resolveSavedModelRequest: async (modelId) => ({
      ok: true,
      modelId,
      modelKey: `key-${modelId}`,
      connection: CONNECTION,
    }),
    generateText: async (_connection, request) => {
      requests.push(request.modelId);
      controller.abort();
      return "fr";
    },
  });

  expect(result).toEqual({ ok: false, code: "cancelled" });
  expect(requests).toEqual(["key-m1"]);
});

test("AI detection: treats a cancelled provider error as cancellation", async () => {
  const h = harness({
    responses: {
      "key-m1": async () => {
        throw new ProviderProtocolError("cancelled", "Request cancelled");
      },
      "key-m2": async () => "fr",
    },
  });

  expect(await detectLanguage("Texte", aiDetectors(["m1", "m2"]), h.options)).toEqual({
    ok: false,
    code: "cancelled",
  });
  expect(h.requests).toHaveLength(1);
});

type GoogleInit = Parameters<GoogleDetectionFetch>[1];

interface GoogleHarness {
  calls: { url: string; init: GoogleInit }[];
  options: DetectLanguageOptions;
}

function googleHarness(
  options: {
    payload?: unknown;
    ok?: boolean;
    status?: number;
    unreadable?: boolean;
    hang?: boolean;
    beforeJson?: () => void;
  } = {},
): GoogleHarness {
  const calls: { url: string; init: GoogleInit }[] = [];
  return {
    calls,
    options: {
      googleFetch: async (url, init) => {
        calls.push({ url, init });
        if (options.hang) {
          await new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return {
          ok: options.ok ?? true,
          status: options.status ?? 200,
          json: async () => {
            options.beforeJson?.();
            if (options.unreadable) throw new Error("<html>We're sorry</html>");
            return options.payload;
          },
        };
      },
    },
  };
}

test("Google detection: posts the trimmed sample and maps a regional code onto its base language", async () => {
  const h = googleHarness({ payload: [["Hello world", "zh-CN"]] });

  const result = await detectLanguage("  你好，世界  ", [GOOGLE_DETECTOR], h.options);

  expect(result).toEqual({ ok: true, language: "zh" });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.url).toBe(GOOGLE_DETECTION_URL);
  expect(h.calls[0]!.init.method).toBe("POST");
  expect(h.calls[0]!.init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(h.calls[0]!.init.body).toBe(`q=${encodeURIComponent("你好，世界")}`);
});

test("Google detection: maps legacy and regional codes onto supported IDs", async () => {
  const cases: [string, string][] = [
    ["iw", "he"],
    ["in", "id"],
    ["pt-BR", "pt"],
    ["en-US", "en"],
    ["FR", "fr"],
  ];
  for (const [code, expected] of cases) {
    const h = googleHarness({ payload: [["text", code]] });
    expect(await detectLanguage("Texte", [GOOGLE_DETECTOR], h.options)).toEqual({
      ok: true,
      language: expected,
    });
  }
});

test("Google detection: reports unsupported_language for a language outside the supported set", async () => {
  const h = googleHarness({ payload: [["Good morning", "cy"]] });

  expect(await detectLanguage("Bore da", [GOOGLE_DETECTOR], h.options)).toEqual({
    ok: false,
    code: "unsupported_language",
  });
});

test("Google detection: reads the code beside the segments and reports unknown_language when absent", async () => {
  const beside = googleHarness({ payload: [["Hello"], "ja"] });
  expect(await detectLanguage("こんにちは", [GOOGLE_DETECTOR], beside.options)).toEqual({
    ok: true,
    language: "ja",
  });

  const absent = googleHarness({ payload: [["Hello"]] });
  expect(await detectLanguage("Texte", [GOOGLE_DETECTOR], absent.options)).toEqual({
    ok: false,
    code: "unknown_language",
  });

  const notAList = googleHarness({ payload: { languages: "fr" } });
  expect(await detectLanguage("Texte", [GOOGLE_DETECTOR], notAList.options)).toEqual({
    ok: false,
    code: "unknown_language",
  });
});

test("Google detection: maps a refusal page and an HTTP error to failed", async () => {
  const refusal = googleHarness({ unreadable: true });
  expect(await detectLanguage("Texte", [GOOGLE_DETECTOR], refusal.options)).toEqual({
    ok: false,
    code: "failed",
  });

  const rateLimited = googleHarness({ ok: false, status: 429, payload: [["text", "fr"]] });
  expect(await detectLanguage("Texte", [GOOGLE_DETECTOR], rateLimited.options)).toEqual({
    ok: false,
    code: "failed",
  });
});

test("Google detection: maps a network failure and a timeout to failed", async () => {
  const failing = googleHarness();
  failing.options.googleFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  expect(await detectLanguage("Texte", [GOOGLE_DETECTOR], failing.options)).toEqual({
    ok: false,
    code: "failed",
  });

  const slow = googleHarness({ hang: true });
  expect(
    await detectLanguage("Texte", [GOOGLE_DETECTOR], { ...slow.options, timeoutMs: 5 }),
  ).toEqual({ ok: false, code: "failed" });
  expect(slow.calls).toHaveLength(1);
});

test("Google detection: reports cancelled and never lets a late answer win", async () => {
  const controller = new AbortController();
  const hanging = googleHarness({ hang: true });
  const cancelled = detectLanguage("Texte", [GOOGLE_DETECTOR], {
    ...hanging.options,
    signal: controller.signal,
  });
  controller.abort();
  expect(await cancelled).toEqual({ ok: false, code: "cancelled" });

  const late = new AbortController();
  const lateAnswer = googleHarness({
    payload: [["text", "fr"]],
    beforeJson: () => late.abort(),
  });
  expect(
    await detectLanguage("Texte", [GOOGLE_DETECTOR], {
      ...lateAnswer.options,
      signal: late.signal,
    }),
  ).toEqual({ ok: false, code: "cancelled" });
});

test("Google detection: sends nothing for blank input or an empty chain", async () => {
  const blank = googleHarness({ payload: [["text", "fr"]] });
  expect(await detectLanguage("   ", [GOOGLE_DETECTOR], blank.options)).toEqual({
    ok: false,
    code: "blank_input",
  });
  expect(blank.calls).toHaveLength(0);

  const empty = googleHarness({ payload: [["text", "fr"]] });
  expect(await detectLanguage("Texte", [], empty.options)).toEqual({
    ok: false,
    code: "unconfigured",
  });
  expect(empty.calls).toHaveLength(0);
});

interface GoogleCloudHarness {
  calls: { apiKey: string; text: string }[];
  reads: string[];
  options: DetectLanguageOptions;
}

function googleCloudHarness(
  options: {
    code?: string;
    credential?: string | null;
    detectError?: Error;
    readError?: Error;
  } = {},
): GoogleCloudHarness {
  const calls: { apiKey: string; text: string }[] = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    options: {
      readGoogleCloudCredential: async (credentialRef) => {
        reads.push(credentialRef);
        if (options.readError) throw options.readError;
        return options.credential === undefined ? "cloud-key" : options.credential;
      },
      googleCloudDetect: async (input) => {
        calls.push({ apiKey: input.apiKey, text: input.text });
        if (options.detectError) throw options.detectError;
        return options.code ?? "fr";
      },
    },
  };
}

test("Google Cloud detection: reads the stored key and sends the trimmed sample", async () => {
  const h = googleCloudHarness({ code: "zh-CN" });

  const result = await detectLanguage("  你好，世界  ", [GOOGLE_CLOUD_DETECTOR], h.options);

  expect(result).toEqual({ ok: true, language: "zh" });
  expect(h.reads).toEqual(["ref-1"]);
  expect(h.calls).toEqual([{ apiKey: "cloud-key", text: "你好，世界" }]);
});

test("Google Cloud detection: falls through when the stored key is missing or unreadable", async () => {
  for (const h of [
    googleCloudHarness({ credential: null }),
    googleCloudHarness({ credential: "   " }),
    googleCloudHarness({ readError: new Error("ERR_NSH_IO") }),
  ]) {
    expect(await detectLanguage("Texte", [GOOGLE_CLOUD_DETECTOR], h.options)).toEqual({
      ok: false,
      code: "failed",
    });
    expect(h.calls).toHaveLength(0);
  }
});

test("Google Cloud detection: reports unsupported_language for a language outside the supported set", async () => {
  const h = googleCloudHarness({ code: "cy" });

  expect(await detectLanguage("Bore da", [GOOGLE_CLOUD_DETECTOR], h.options)).toEqual({
    ok: false,
    code: "unsupported_language",
  });
});

test("Google Cloud detection: maps a transport failure and cancellation", async () => {
  const failing = googleCloudHarness({
    detectError: new ProviderProtocolError("auth", "API key not valid", 403),
  });
  expect(await detectLanguage("Texte", [GOOGLE_CLOUD_DETECTOR], failing.options)).toEqual({
    ok: false,
    code: "failed",
  });

  const aborted = googleCloudHarness({
    detectError: new ProviderProtocolError("cancelled", "Cancelled"),
  });
  expect(await detectLanguage("Texte", [GOOGLE_CLOUD_DETECTOR], aborted.options)).toEqual({
    ok: false,
    code: "cancelled",
  });

  const controller = new AbortController();
  controller.abort();
  const preAborted = googleCloudHarness();
  expect(
    await detectLanguage("Texte", [GOOGLE_CLOUD_DETECTOR], {
      ...preAborted.options,
      signal: controller.signal,
    }),
  ).toEqual({ ok: false, code: "cancelled" });
  expect(preAborted.reads).toHaveLength(0);
});

test("detector chain: the free endpoint and Google Cloud back each other up", async () => {
  const cloud = googleCloudHarness({ code: "ja" });
  const brokenFree = googleHarness({ unreadable: true });
  const freeByCloud = await detectLanguage("Texte", [GOOGLE_DETECTOR, GOOGLE_CLOUD_DETECTOR], {
    ...brokenFree.options,
    ...cloud.options,
  });
  expect(freeByCloud).toEqual({ ok: true, language: "ja" });
  expect(brokenFree.calls).toHaveLength(1);
  expect(cloud.calls).toHaveLength(1);

  const free = googleHarness({ payload: [["Hello", "de"]] });
  const cloudByFree = await detectLanguage("Texte", [GOOGLE_CLOUD_DETECTOR, GOOGLE_DETECTOR], {
    ...googleCloudHarness({ detectError: new Error("socket hang up") }).options,
    ...free.options,
  });
  expect(cloudByFree).toEqual({ ok: true, language: "de" });
  expect(free.calls).toHaveLength(1);
});

test("detector chain: an AI failure falls through to an enabled Google detector", async () => {
  const ai = harness({
    responses: {
      "key-m1": async () => {
        throw new ProviderProtocolError("server", "Upstream failed", 500);
      },
    },
  });
  const google = googleHarness({ payload: [["Hello", "fr"]] });

  const result = await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
    ...ai.options,
    ...google.options,
  });

  expect(result).toEqual({ ok: true, language: "fr" });
  expect(ai.resolveCalls).toEqual(["m1"]);
  expect(google.calls).toHaveLength(1);
});

test("detector chain: an AI und answer falls through to Google", async () => {
  const ai = harness({ responses: { "key-m1": async () => "und" } });
  const google = googleHarness({ payload: [["Hello", "ja"]] });

  const result = await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
    ...ai.options,
    ...google.options,
  });

  expect(result).toEqual({ ok: true, language: "ja" });
  expect(google.calls).toHaveLength(1);
});

test("detector chain: an unavailable AI detector lets Google answer", async () => {
  const ai = harness({ unavailable: ["m1"] });
  const google = googleHarness({ payload: [["Hello", "de"]] });

  const result = await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
    ...ai.options,
    ...google.options,
  });

  expect(result).toEqual({ ok: true, language: "de" });
  expect(ai.requests).toHaveLength(0);
});

test("detector chain: the first valid answer stops later detectors", async () => {
  const ai = harness({ responses: { "key-m1": async () => "fr" } });
  const google = googleHarness({ payload: [["Hello", "de"]] });

  const aiFirst = await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
    ...ai.options,
    ...google.options,
  });
  expect(aiFirst).toEqual({ ok: true, language: "fr" });
  expect(google.calls).toHaveLength(0);

  const googleFirst = googleHarness({ payload: [["Hello", "de"]] });
  const aiAfter = harness({ responses: { "key-m1": async () => "fr" } });
  const googleResult = await detectLanguage("Texte", [GOOGLE_DETECTOR, aiDetector("m1")], {
    ...googleFirst.options,
    ...aiAfter.options,
  });
  expect(googleResult).toEqual({ ok: true, language: "de" });
  expect(aiAfter.resolveCalls).toHaveLength(0);
});

test("detector chain: reports the last concrete failure across enabled detectors", async () => {
  const ai = harness({ unavailable: ["m1"] });
  const google = googleHarness({ unreadable: true });

  expect(
    await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
      ...ai.options,
      ...google.options,
    }),
  ).toEqual({ ok: false, code: "failed" });

  const aiUnd = harness({ responses: { "key-m1": async () => "und" } });
  const googleAbsent = googleHarness({ payload: [["Hello"]] });
  expect(
    await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
      ...aiUnd.options,
      ...googleAbsent.options,
    }),
  ).toEqual({ ok: false, code: "unknown_language" });
});

test("detector chain: cancellation in one detector prevents the next", async () => {
  const controller = new AbortController();
  const google = googleHarness({ payload: [["Hello", "fr"]] });

  const result = await detectLanguage("Texte", [aiDetector("m1"), GOOGLE_DETECTOR], {
    signal: controller.signal,
    resolveSavedModelRequest: async (_modelId) => {
      controller.abort();
      return { ok: false, reason: "aborted" };
    },
    ...google.options,
  });

  expect(result).toEqual({ ok: false, code: "cancelled" });
  expect(google.calls).toHaveLength(0);
});
