import { expect, test } from "nsh/test";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import type { AiClientInput } from "../../modules/ai/runtime/client";
import { resolveTranslationLanguages } from "./resolve";
import type { LanguageDetectionSnapshot } from "./settings";

const CONNECTION: AiClientInput = {
  providerTypeId: "openai",
  protocolId: "openai-responses",
  baseUrl: "https://api.example.com/v1",
  credential: "sk-test",
};

function detection(overrides: Partial<LanguageDetectionSnapshot> = {}): LanguageDetectionSnapshot {
  return {
    detectors: [{ kind: "ai", modelId: "m1" }],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
    ...overrides,
  };
}

function detector(options: { answer?: string } = {}) {
  const calls: { modelId: string }[] = [];
  const resolveCalls: string[] = [];
  return {
    calls,
    resolveCalls,
    options: {
      resolveSavedModelRequest: async (modelId: string) => {
        resolveCalls.push(modelId);
        return { ok: true as const, modelId, modelKey: `key-${modelId}`, connection: CONNECTION };
      },
      generateText: async (_connection: AiClientInput, request: TextGenerationRequest) => {
        calls.push({ modelId: request.modelId });
        return options.answer ?? "fr";
      },
    },
  };
}

test("language pair: resolves a concrete source and an automatic target without detection", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "fr",
      targetLanguage: "auto",
      detection: detection(),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "zh" });
  expect(spy.resolveCalls).toHaveLength(0);
  expect(spy.calls).toHaveLength(0);
});

test("language pair: translates the native language into the preferred one", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "你好",
      sourceLanguage: "zh",
      targetLanguage: "auto",
      detection: detection(),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: true, sourceLanguage: "zh", targetLanguage: "en" });
  expect(spy.calls).toHaveLength(0);
});

test("language pair: detects an automatic source once and keeps a concrete target", async () => {
  const spy = detector({ answer: "de" });

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Guten Tag",
      sourceLanguage: "auto",
      targetLanguage: "ja",
      detection: detection({ nativeLanguage: null, preferredTranslationLanguage: null }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: true, sourceLanguage: "de", targetLanguage: "ja" });
  expect(spy.calls).toHaveLength(1);
});

test("language pair: resolves both concrete selections with no detection and no preferences", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "fr",
      targetLanguage: "ja",
      detection: detection({ nativeLanguage: null, preferredTranslationLanguage: null }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "ja" });
  expect(spy.calls).toHaveLength(0);
});

test("language pair: requires the native language before detection for an automatic target", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection({ nativeLanguage: null }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: false, code: "missing_native_language" });
  expect(spy.resolveCalls).toHaveLength(0);
  expect(spy.calls).toHaveLength(0);
});

test("language pair: propagates a detector failure without guessing a target", async () => {
  const spy = detector({ answer: "und" });

  const result = await resolveTranslationLanguages(
    {
      sourceText: "???",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection(),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: false, code: "unknown_language" });
  expect(spy.calls).toHaveLength(1);
});

test("language pair: reports unconfigured when no detector is enabled", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "auto",
      targetLanguage: "ko",
      detection: detection({ detectors: [] }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: false, code: "unconfigured" });
  expect(spy.resolveCalls).toHaveLength(0);
  expect(spy.calls).toHaveLength(0);
});

test("language pair: uses the native language when the preferred one is unset and the source differs", async () => {
  const spy = detector({ answer: "fr" });

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection({ preferredTranslationLanguage: null }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "zh" });

  const native = await resolveTranslationLanguages(
    {
      sourceText: "你好",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection({ preferredTranslationLanguage: null }),
    },
    { ...spy.options, generateText: async () => "zh" },
  );

  expect(native).toEqual({ ok: false, code: "missing_preferred_language" });
});

test("language pair: requires the preferred language only when the source is the native one", async () => {
  const spy = detector({ answer: "zh" });

  const result = await resolveTranslationLanguages(
    {
      sourceText: "你好",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection({ preferredTranslationLanguage: null }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: false, code: "missing_preferred_language" });
  expect(spy.calls).toHaveLength(1);

  const concrete = await resolveTranslationLanguages(
    {
      sourceText: "你好",
      sourceLanguage: "zh",
      targetLanguage: "auto",
      detection: detection({ preferredTranslationLanguage: null }),
    },
    spy.options,
  );

  expect(concrete).toEqual({ ok: false, code: "missing_preferred_language" });
});

test("language pair: does not require preferences for a concrete target", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "auto",
      targetLanguage: "en",
      detection: detection({ nativeLanguage: null, preferredTranslationLanguage: null }),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "en" });
});

test("language pair: reports blank input instead of detecting", async () => {
  const spy = detector();

  const result = await resolveTranslationLanguages(
    {
      sourceText: "   ",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection(),
    },
    spy.options,
  );

  expect(result).toEqual({ ok: false, code: "blank_input" });
  expect(spy.calls).toHaveLength(0);
});

test("language pair: checks cancellation before and after detection", async () => {
  const beforeController = new AbortController();
  beforeController.abort();
  const before = detector();

  const cancelledBefore = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection(),
    },
    { ...before.options, signal: beforeController.signal },
  );

  expect(cancelledBefore).toEqual({ ok: false, code: "cancelled" });
  expect(before.calls).toHaveLength(0);

  const afterController = new AbortController();
  const after = detector();
  const cancelledAfter = await resolveTranslationLanguages(
    {
      sourceText: "Bonjour",
      sourceLanguage: "auto",
      targetLanguage: "auto",
      detection: detection(),
    },
    {
      ...after.options,
      signal: afterController.signal,
      generateText: async () => {
        afterController.abort();
        return "fr";
      },
    },
  );

  expect(cancelledAfter).toEqual({ ok: false, code: "cancelled" });
});
