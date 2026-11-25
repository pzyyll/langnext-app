import { expect, test } from "nsh/test";
import { resolveTargetLanguage } from "./resolve";
import type { LanguageDetectionSnapshot } from "./settings";

function detection(overrides: Partial<LanguageDetectionSnapshot> = {}): LanguageDetectionSnapshot {
  return {
    detectors: [{ kind: "ai", modelId: "m1" }],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
    ...overrides,
  };
}

test("target language: a concrete target passes the source through unchanged", () => {
  expect(
    resolveTargetLanguage({
      sourceLanguage: "fr",
      targetLanguage: "ja",
      detection: detection(),
    }),
  ).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "ja" });
});

test("target language: automatic translates another language into the native language", () => {
  expect(
    resolveTargetLanguage({
      sourceLanguage: "fr",
      targetLanguage: "auto",
      detection: detection(),
    }),
  ).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "zh" });
});

test("target language: automatic translates the native language into the preferred one", () => {
  expect(
    resolveTargetLanguage({
      sourceLanguage: "zh",
      targetLanguage: "auto",
      detection: detection(),
    }),
  ).toEqual({ ok: true, sourceLanguage: "zh", targetLanguage: "en" });
});

test("target language: automatic requires the native language", () => {
  expect(
    resolveTargetLanguage({
      sourceLanguage: "fr",
      targetLanguage: "auto",
      detection: detection({ nativeLanguage: null }),
    }),
  ).toEqual({ ok: false, code: "missing_native_language" });
});

test("target language: automatic requires the preferred language only for the native source", () => {
  const noPreferred = detection({ preferredTranslationLanguage: null });

  expect(
    resolveTargetLanguage({
      sourceLanguage: "fr",
      targetLanguage: "auto",
      detection: noPreferred,
    }),
  ).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "zh" });
  expect(
    resolveTargetLanguage({
      sourceLanguage: "zh",
      targetLanguage: "auto",
      detection: noPreferred,
    }),
  ).toEqual({ ok: false, code: "missing_preferred_language" });
});

test("target language: a concrete target needs no preferences", () => {
  expect(
    resolveTargetLanguage({
      sourceLanguage: "fr",
      targetLanguage: "en",
      detection: detection({ nativeLanguage: null, preferredTranslationLanguage: null }),
    }),
  ).toEqual({ ok: true, sourceLanguage: "fr", targetLanguage: "en" });
});
