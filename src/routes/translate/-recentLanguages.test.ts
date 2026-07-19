// ABOUTME: Unit tests for grow-on-use language tabs and source/target conflict resolution.
// ABOUTME: Covers empty defaults, Auto pin, first-use order, and opposite-side Auto switch.

import { describe, expect, it } from "bun:test";
import {
  EMPTY_USED_LANGUAGES,
  MAX_USED_LANGUAGES,
  normalizeUsedLanguageIds,
  recordLanguageUse,
  resolveOppositeOnConflict,
  visibleLanguageTabs,
} from "./-recentLanguages";

describe("visibleLanguageTabs", () => {
  it("shows only Auto when history is empty and current is auto", () => {
    expect(visibleLanguageTabs([], "auto", { pinFirst: "auto" })).toEqual(["auto"]);
  });

  it("shows Auto + current for an English <-> Chinese style preset", () => {
    expect(visibleLanguageTabs([], "en", { pinFirst: "auto" })).toEqual(["auto", "en"]);
    expect(visibleLanguageTabs([], "zh", { pinFirst: "auto" })).toEqual(["auto", "zh"]);
  });

  it("keeps first-use order and does not move the selected tab", () => {
    expect(visibleLanguageTabs(["en", "zh"], "zh", { pinFirst: "auto" })).toEqual(["auto", "en", "zh"]);
    expect(visibleLanguageTabs(["en", "zh"], "en", { pinFirst: "auto" })).toEqual(["auto", "en", "zh"]);
  });

  it("does not invent unused languages beyond current", () => {
    expect(visibleLanguageTabs([], "auto", { pinFirst: "auto" })).toEqual(["auto"]);
    expect(visibleLanguageTabs(["en"], "auto", { pinFirst: "auto" })).toEqual(["auto", "en"]);
  });
});

describe("recordLanguageUse", () => {
  it("keeps the previous concrete language when switching to a new one", () => {
    expect(recordLanguageUse([], "zh", "en")).toEqual(["en", "zh"]);
  });

  it("does not store auto", () => {
    expect(recordLanguageUse(["en"], "auto", "en")).toEqual(["en"]);
  });

  it("does not reorder when re-selecting an existing language", () => {
    expect(recordLanguageUse(["en", "zh"], "en", "zh")).toEqual(["en", "zh"]);
  });

  it("drops the oldest concrete language when over capacity", () => {
    expect(recordLanguageUse(["en", "zh"], "ja", "zh", MAX_USED_LANGUAGES)).toEqual(["zh", "ja"]);
  });
});

describe("resolveOppositeOnConflict", () => {
  it("switches the opposite side to auto when both would be the same concrete language", () => {
    expect(resolveOppositeOnConflict("zh", "zh")).toBe("auto");
    expect(resolveOppositeOnConflict("en", "zh")).toBe("zh");
    expect(resolveOppositeOnConflict("auto", "zh")).toBe("zh");
  });
});

describe("normalizeUsedLanguageIds", () => {
  it("returns empty for non-arrays", () => {
    expect(normalizeUsedLanguageIds(null)).toEqual(EMPTY_USED_LANGUAGES);
    expect(normalizeUsedLanguageIds("x")).toEqual([]);
  });

  it("strips auto and invalid ids and caps length", () => {
    expect(normalizeUsedLanguageIds(["auto", "nope", "en", "zh", "fr"])).toEqual(["en", "zh"]);
  });
});
