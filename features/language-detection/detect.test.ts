import { expect, test } from "nsh/test";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import type { AiClientInput } from "../../modules/ai/runtime/client";
import { detectLanguage } from "./detect";
import type { LanguageDetectionSettings } from "./settings";

const CONNECTION: AiClientInput = {
  providerTypeId: "openai",
  protocolId: "openai-responses",
  baseUrl: "https://api.example.com/v1",
  credential: "sk-test",
};

function aiSettings(modelIds: readonly string[]): LanguageDetectionSettings {
  return {
    mode: "ai",
    modelIds,
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  };
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

test("AI detection: sends the sample to the primary model and accepts a trimmed language ID", async () => {
  const h = harness({ responses: { "key-m1": async () => " FR\n" } });

  const result = await detectLanguage("  Bonjour le monde  ", aiSettings(["m1"]), h.options);

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

  await detectLanguage(text, aiSettings(["m1"]), h.options);

  const sample = h.requests[0]!.request.user;
  expect(Array.from(sample)).toHaveLength(2048);
  expect(sample.startsWith("a😀")).toBe(true);
  expect(sample.endsWith("😀")).toBe(true);
});

test("AI detection: falls back past an unavailable model, a rate limit, and a malformed answer", async () => {
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

  const result = await detectLanguage("Bonjour", aiSettings(["m1", "m2", "m3", "m4"]), h.options);

  expect(result).toEqual({ ok: true, language: "fr" });
  expect(h.resolveCalls).toEqual(["m1", "m2", "m3", "m4"]);
  expect(h.requests.map((entry) => entry.modelId)).toEqual(["key-m2", "key-m3", "key-m4"]);
});

test("AI detection: accepts only an exact supported ID, never prose, JSON, or auto", async () => {
  const answers = ["fr-FR", "```fr```", '{"language":"fr"}', "auto", "French", "zh_CN", "FR"];
  for (const [index, answer] of answers.entries()) {
    const h = harness({ responses: { "key-m1": async () => answer } });
    const result = await detectLanguage("Texte", aiSettings(["m1"]), h.options);
    if (index === answers.length - 1) {
      expect(result).toEqual({ ok: true, language: "fr" });
    } else {
      expect(result).toEqual({ ok: false, code: "failed" });
    }
  }
});

test("AI detection: tries the next model after und and reports unknown_language when every answer is und", async () => {
  const retry = harness({
    responses: { "key-m1": async () => "und", "key-m2": async () => "ja" },
  });
  expect(await detectLanguage("Texte", aiSettings(["m1", "m2"]), retry.options)).toEqual({
    ok: true,
    language: "ja",
  });
  expect(retry.requests.map((entry) => entry.modelId)).toEqual(["key-m1", "key-m2"]);

  const allUnd = harness({
    responses: { "key-m1": async () => "und", "key-m2": async () => " UND " },
  });
  expect(await detectLanguage("Texte", aiSettings(["m1", "m2"]), allUnd.options)).toEqual({
    ok: false,
    code: "unknown_language",
  });
});

test("AI detection: reports no_eligible_model when no request was possible", async () => {
  const h = harness({ unavailable: ["m1", "m2"] });

  expect(await detectLanguage("Texte", aiSettings(["m1", "m2"]), h.options)).toEqual({
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

  expect(await detectLanguage("Texte", aiSettings(["m1", "m2"]), h.options)).toEqual({
    ok: false,
    code: "failed",
  });
});

test("AI detection: maps an unexpected exception to failed and stops the chain", async () => {
  const h = harness({
    responses: {
      "key-m1": async () => {
        throw new Error("secret provider detail");
      },
      "key-m2": async () => "fr",
    },
  });

  const result = await detectLanguage("Texte", aiSettings(["m1", "m2"]), h.options);

  expect(result).toEqual({ ok: false, code: "failed" });
  expect(JSON.stringify(result)).not.toContain("secret provider detail");
  expect(h.requests.map((entry) => entry.modelId)).toEqual(["key-m1"]);
  expect(h.resolveCalls).toEqual(["m1"]);
});

test("AI detection: does not resolve a model for blank input or when detection is off", async () => {
  const blank = harness({ responses: {} });
  expect(await detectLanguage("   ", aiSettings(["m1"]), blank.options)).toEqual({
    ok: false,
    code: "blank_input",
  });
  expect(blank.resolveCalls).toHaveLength(0);

  const off = harness({ responses: {} });
  expect(
    await detectLanguage("Texte", { ...aiSettings(["m1"]), mode: "off" }, off.options),
  ).toEqual({ ok: false, code: "unconfigured" });
  expect(off.resolveCalls).toHaveLength(0);

  const unconfigured = harness({ responses: {} });
  expect(await detectLanguage("Texte", aiSettings([]), unconfigured.options)).toEqual({
    ok: false,
    code: "unconfigured",
  });
  expect(unconfigured.resolveCalls).toHaveLength(0);
});

test("AI detection: stops on cancellation during resolution and prevents later attempts", async () => {
  const controller = new AbortController();
  const resolveCalls: string[] = [];
  const requests: string[] = [];

  const result = await detectLanguage("Texte", aiSettings(["m1", "m2"]), {
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

  const result = await detectLanguage("Texte", aiSettings(["m1", "m2"]), {
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

  expect(await detectLanguage("Texte", aiSettings(["m1", "m2"]), h.options)).toEqual({
    ok: false,
    code: "cancelled",
  });
  expect(h.requests).toHaveLength(1);
});
