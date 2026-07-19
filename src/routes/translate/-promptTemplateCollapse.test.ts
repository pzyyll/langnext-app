// ABOUTME: Unit tests for prompt-template collapse preference helpers.
// ABOUTME: Covers normalize, read/write, invalid JSON, and empty fallbacks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PROMPT_TEMPLATE_COLLAPSE_KEY,
  getCollapsedPromptTemplateIds,
  normalizeCollapsedTemplateIds,
  setCollapsedPromptTemplateIds,
} from "./-promptTemplateCollapse";

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
  localStorage.removeItem(PROMPT_TEMPLATE_COLLAPSE_KEY);
});

describe("normalizeCollapsedTemplateIds", () => {
  test("returns empty for null, non-arrays, and non-objects", () => {
    expect(normalizeCollapsedTemplateIds(null)).toEqual([]);
    expect(normalizeCollapsedTemplateIds(undefined)).toEqual([]);
    expect(normalizeCollapsedTemplateIds("oops")).toEqual([]);
    expect(normalizeCollapsedTemplateIds(42)).toEqual([]);
  });

  test("accepts a bare string array and drops empties/duplicates", () => {
    expect(normalizeCollapsedTemplateIds(["a", "", "b", "a", 3, null])).toEqual(["a", "b"]);
  });

  test("accepts wrapped payload shape", () => {
    expect(normalizeCollapsedTemplateIds({ collapsedTemplateIds: ["t1", "t2"] })).toEqual(["t1", "t2"]);
  });
});

describe("getCollapsedPromptTemplateIds / setCollapsedPromptTemplateIds", () => {
  test("defaults to empty when missing", () => {
    expect(getCollapsedPromptTemplateIds()).toEqual([]);
  });

  test("round-trips ids", () => {
    setCollapsedPromptTemplateIds(["t1", "t2"]);
    expect(getCollapsedPromptTemplateIds()).toEqual(["t1", "t2"]);
    expect(JSON.parse(localStorage.getItem(PROMPT_TEMPLATE_COLLAPSE_KEY) ?? "null")).toEqual(["t1", "t2"]);
  });

  test("tolerates invalid JSON", () => {
    localStorage.setItem(PROMPT_TEMPLATE_COLLAPSE_KEY, "{not-json");
    expect(getCollapsedPromptTemplateIds()).toEqual([]);
  });

  test("reads wrapped payload written by older shape", () => {
    localStorage.setItem(PROMPT_TEMPLATE_COLLAPSE_KEY, JSON.stringify({ collapsedTemplateIds: ["legacy"] }));
    expect(getCollapsedPromptTemplateIds()).toEqual(["legacy"]);
  });
});
