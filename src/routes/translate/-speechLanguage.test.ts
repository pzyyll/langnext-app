// ABOUTME: Unit tests for Translate Speech language resolution helpers.
// ABOUTME: Covers manual languages, auto detection reuse, and Auto-target resolution.
import { describe, expect, test } from "bun:test";
import { resolveResultSpeechLanguage, resolveSourceSpeechLanguage } from "./-speechLanguage";

describe("resolveSourceSpeechLanguage", () => {
  test("returns the manual source language", () => {
    expect(
      resolveSourceSpeechLanguage({
        sourceLang: "en",
        detectedSourceLang: null,
      }),
    ).toEqual({ kind: "ready", languageId: "en" });
  });

  test("reuses detected language when source is auto", () => {
    expect(
      resolveSourceSpeechLanguage({
        sourceLang: "auto",
        detectedSourceLang: "zh",
      }),
    ).toEqual({ kind: "ready", languageId: "zh" });
  });

  test("requests detection when source is auto without a prior result", () => {
    expect(
      resolveSourceSpeechLanguage({
        sourceLang: "auto",
        detectedSourceLang: null,
      }),
    ).toEqual({ kind: "needs_detection" });
  });
});

describe("resolveResultSpeechLanguage", () => {
  test("returns a concrete configured target unchanged", () => {
    expect(
      resolveResultSpeechLanguage({
        effectiveSource: "en",
        configuredTarget: "ja",
        profileLangPrefs: { primary: "en", preferredTarget: "zh" },
      }),
    ).toEqual({ kind: "ready", languageId: "ja" });
  });

  test("resolves auto target via preferred target when source differs", () => {
    expect(
      resolveResultSpeechLanguage({
        effectiveSource: "en",
        configuredTarget: "auto",
        profileLangPrefs: { primary: "en", preferredTarget: "zh" },
      }),
    ).toEqual({ kind: "ready", languageId: "zh" });
  });

  test("resolves auto target via primary when source equals preferred target", () => {
    expect(
      resolveResultSpeechLanguage({
        effectiveSource: "zh",
        configuredTarget: "auto",
        profileLangPrefs: { primary: "en", preferredTarget: "zh" },
      }),
    ).toEqual({ kind: "ready", languageId: "en" });
  });

  test("is unresolved for auto target without an effective source", () => {
    expect(
      resolveResultSpeechLanguage({
        effectiveSource: null,
        configuredTarget: "auto",
        profileLangPrefs: { primary: "en", preferredTarget: "zh" },
      }),
    ).toEqual({ kind: "unresolved" });
  });
});
