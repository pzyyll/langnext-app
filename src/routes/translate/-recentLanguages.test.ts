// ABOUTME: Unit tests for fixed-order language tab helpers and store normalization.
// ABOUTME: Covers stable select, admit-new, pin-first auto, and localStorage round-trip.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_RECENT_SOURCE_LANGUAGES,
  DEFAULT_RECENT_TARGET_LANGUAGES,
  MAX_RECENT_LANGUAGES,
  RECENT_LANGUAGES_KEY,
  admitLanguageToTabs,
  getRecentLanguagesStore,
  normalizeRecentLanguagesStore,
  setRecentLanguagesStore,
  visibleLanguageTabs,
} from "./-recentLanguages";

/** Minimal in-memory localStorage for bun:test (no DOM globals). */
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: memoryStorage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: memoryStorage },
  });
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  localStorage.removeItem(RECENT_LANGUAGES_KEY);
});

describe("visibleLanguageTabs", () => {
  it("keeps stable order when current is already in the strip", () => {
    expect(visibleLanguageTabs(["auto", "en", "zh"], "zh")).toEqual(["auto", "en", "zh"]);
    expect(visibleLanguageTabs(["auto", "en", "zh"], "en")).toEqual(["auto", "en", "zh"]);
  });

  it("does not move the selected tab to the front", () => {
    // Regression: old MRU display put current first.
    expect(visibleLanguageTabs(["en", "zh", "ja"], "ja")).toEqual(["en", "zh", "ja"]);
  });

  it("injects current into the last slot when missing", () => {
    expect(visibleLanguageTabs(["en", "zh", "ja"], "ko")).toEqual(["en", "zh", "ko"]);
  });

  it("pins auto first on the source strip", () => {
    expect(visibleLanguageTabs(["en", "zh", "auto"], "en", { pinFirst: "auto" })).toEqual(["auto", "en", "zh"]);
  });

  it("replaces a non-pinned slot when current is missing under pinFirst", () => {
    expect(visibleLanguageTabs(["auto", "en", "zh"], "ja", { pinFirst: "auto" })).toEqual(["auto", "en", "ja"]);
  });
});

describe("admitLanguageToTabs", () => {
  it("keeps order when the language is already a tab", () => {
    expect(admitLanguageToTabs(["auto", "en", "zh"], "zh", { pinFirst: "auto" })).toEqual(["auto", "en", "zh"]);
  });

  it("inserts a new language after the pin and drops the tail", () => {
    expect(admitLanguageToTabs(["auto", "en", "zh"], "fr", { pinFirst: "auto" })).toEqual(["auto", "fr", "en"]);
  });

  it("inserts a new target language at the front", () => {
    expect(admitLanguageToTabs(["en", "zh", "ja"], "ko")).toEqual(["ko", "en", "zh"]);
  });

  it("respects max", () => {
    expect(admitLanguageToTabs(["en", "zh"], "fr", { max: MAX_RECENT_LANGUAGES })).toEqual(["fr", "en", "zh"]);
  });
});

describe("normalizeRecentLanguagesStore", () => {
  it("falls back to defaults for invalid input", () => {
    expect(normalizeRecentLanguagesStore(null)).toEqual({
      source: DEFAULT_RECENT_SOURCE_LANGUAGES,
      target: DEFAULT_RECENT_TARGET_LANGUAGES,
    });
  });

  it("filters invalid ids and caps length", () => {
    expect(
      normalizeRecentLanguagesStore({
        source: ["auto", "nope", "en", "zh", "fr"],
        target: ["ja", "en"],
      }),
    ).toEqual({
      source: ["auto", "en", "zh"],
      target: ["ja", "en"],
    });
  });
});

describe("getRecentLanguagesStore / setRecentLanguagesStore", () => {
  it("round-trips through localStorage", () => {
    setRecentLanguagesStore({ source: ["auto", "fr"], target: ["de", "en", "zh"] });
    expect(getRecentLanguagesStore()).toEqual({
      source: ["auto", "fr"],
      target: ["de", "en", "zh"],
    });
  });

  it("returns defaults when storage is empty", () => {
    expect(getRecentLanguagesStore()).toEqual({
      source: DEFAULT_RECENT_SOURCE_LANGUAGES,
      target: DEFAULT_RECENT_TARGET_LANGUAGES,
    });
  });
});
