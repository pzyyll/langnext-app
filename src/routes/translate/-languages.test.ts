// ABOUTME: Unit tests for the shared translation language policy module.
// ABOUTME: Covers defaults, guards, the exclusion invariant, and the Auto target decision rules.
import { test, expect } from "bun:test";
import {
  AUTO_LANGUAGE,
  LANGUAGE_IDS,
  getDefaultProfileLanguages,
  isLanguageId,
  isSelectableLanguageId,
  resolveProfileLangPrefs,
  resolveTargetLanguage,
} from "./-languages";

test("getDefaultProfileLanguages maps UI locale to a valid distinct pair", () => {
  expect(getDefaultProfileLanguages("zh-CN")).toEqual({ primary: "zh", target: "en" });
  expect(getDefaultProfileLanguages("zh")).toEqual({ primary: "zh", target: "en" });
  expect(getDefaultProfileLanguages("zh-TW")).toEqual({ primary: "zh", target: "en" });
  expect(getDefaultProfileLanguages("en")).toEqual({ primary: "en", target: "zh" });
  expect(getDefaultProfileLanguages("en-US")).toEqual({ primary: "en", target: "zh" });
  expect(getDefaultProfileLanguages(null)).toEqual({ primary: "en", target: "zh" });
  expect(getDefaultProfileLanguages(undefined)).toEqual({ primary: "en", target: "zh" });
});

test("getDefaultProfileLanguages never produces an equal or auto pair", () => {
  for (const ui of ["zh-CN", "zh", "en", "en-US", "fr", "", null, undefined]) {
    const { primary, target } = getDefaultProfileLanguages(ui);
    expect(primary).not.toBe(AUTO_LANGUAGE);
    expect(target).not.toBe(AUTO_LANGUAGE);
    expect(primary).not.toBe(target);
  }
});

test("isLanguageId accepts concrete supported ids and rejects auto and garbage", () => {
  for (const id of LANGUAGE_IDS) {
    expect(isLanguageId(id)).toBe(true);
  }
  expect(isLanguageId(AUTO_LANGUAGE)).toBe(false);
  expect(isLanguageId("xx")).toBe(false);
  expect(isLanguageId("")).toBe(false);
  expect(isLanguageId(null)).toBe(false);
  expect(isLanguageId(undefined)).toBe(false);
});

test("isSelectableLanguageId accepts auto plus concrete ids", () => {
  expect(isSelectableLanguageId(AUTO_LANGUAGE)).toBe(true);
  for (const id of LANGUAGE_IDS) {
    expect(isSelectableLanguageId(id)).toBe(true);
  }
  expect(isSelectableLanguageId("xx")).toBe(false);
  expect(isSelectableLanguageId(null)).toBe(false);
});

test("resolveTargetLanguage keeps a concrete configured target unchanged", () => {
  // Even when the concrete target equals the source, it is sent as-is.
  expect(
    resolveTargetLanguage({
      source: "en",
      configuredTarget: "en",
      primary: "zh",
      preferredTarget: "en",
    }),
  ).toBe("en");
  expect(
    resolveTargetLanguage({
      source: "ja",
      configuredTarget: "de",
      primary: "zh",
      preferredTarget: "en",
    }),
  ).toBe("de");
});

test("resolveTargetLanguage uses preferredTarget when source differs (rule 2)", () => {
  expect(
    resolveTargetLanguage({
      source: "ja",
      configuredTarget: AUTO_LANGUAGE,
      primary: "zh",
      preferredTarget: "en",
    }),
  ).toBe("en");
  expect(
    resolveTargetLanguage({
      source: "fr",
      configuredTarget: AUTO_LANGUAGE,
      primary: "en",
      preferredTarget: "zh",
    }),
  ).toBe("zh");
});

test("resolveTargetLanguage falls back to primary when source matches preferredTarget (rule 3)", () => {
  expect(
    resolveTargetLanguage({
      source: "en",
      configuredTarget: AUTO_LANGUAGE,
      primary: "zh",
      preferredTarget: "en",
    }),
  ).toBe("zh");
  expect(
    resolveTargetLanguage({
      source: "zh",
      configuredTarget: AUTO_LANGUAGE,
      primary: "en",
      preferredTarget: "zh",
    }),
  ).toBe("en");
});

test("resolveTargetLanguage never returns auto", () => {
  const cases: Parameters<typeof resolveTargetLanguage>[0][] = [
    { source: "ja", configuredTarget: AUTO_LANGUAGE, primary: "zh", preferredTarget: "en" },
    { source: "en", configuredTarget: AUTO_LANGUAGE, primary: "zh", preferredTarget: "en" },
    { source: "ko", configuredTarget: "ko", primary: "zh", preferredTarget: "en" },
  ];
  for (const input of cases) {
    expect(resolveTargetLanguage(input)).not.toBe(AUTO_LANGUAGE);
  }
});

test("resolveProfileLangPrefs uses profile preferences for an active profile with both fields", () => {
  expect(resolveProfileLangPrefs(true, "ja", "ko", "en")).toEqual({ primary: "ja", preferredTarget: "ko" });
  expect(resolveProfileLangPrefs(true, "zh", "en", "zh-CN")).toEqual({ primary: "zh", preferredTarget: "en" });
});

test("resolveProfileLangPrefs resets to UI-locale defaults when no profile is active", () => {
  // No active profile (cleared, apply failed, or invalidated) -> defaults, ignoring stale prefs.
  expect(resolveProfileLangPrefs(false, "ja", "ko", "en")).toEqual({ primary: "en", preferredTarget: "zh" });
  expect(resolveProfileLangPrefs(false, "ja", "ko", "zh-CN")).toEqual({ primary: "zh", preferredTarget: "en" });
  expect(resolveProfileLangPrefs(false, null, null, "en")).toEqual({ primary: "en", preferredTarget: "zh" });
});

test("resolveProfileLangPrefs falls back to UI-locale defaults for a legacy/partial active profile", () => {
  // Active profile missing both fields (legacy) -> defaults.
  expect(resolveProfileLangPrefs(true, null, null, "zh-CN")).toEqual({ primary: "zh", preferredTarget: "en" });
  // Active profile missing one field (partial) -> defaults.
  expect(resolveProfileLangPrefs(true, "ja", null, "en")).toEqual({ primary: "en", preferredTarget: "zh" });
  expect(resolveProfileLangPrefs(true, null, "ko", "zh-CN")).toEqual({ primary: "zh", preferredTarget: "en" });
});

test("resolveProfileLangPrefs never returns auto or an equal pair", () => {
  for (const ui of ["zh-CN", "zh", "en", "en-US", "fr", "", null, undefined]) {
    const { primary, preferredTarget } = resolveProfileLangPrefs(false, null, null, ui);
    expect(primary).not.toBe(AUTO_LANGUAGE);
    expect(preferredTarget).not.toBe(AUTO_LANGUAGE);
    expect(primary).not.toBe(preferredTarget);
  }
});
