// ABOUTME: Unit tests for shared translation output view mode helpers.
// ABOUTME: Covers defaults, invalid values, read/write, and toggle.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_OUTPUT_VIEW_MODE,
  OUTPUT_VIEW_MODE_KEY,
  getOutputViewMode,
  isOutputViewMode,
  normalizeOutputViewMode,
  setOutputViewMode,
  toggleOutputViewMode,
} from "./output-view-mode";

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
  localStorage.removeItem(OUTPUT_VIEW_MODE_KEY);
});

describe("isOutputViewMode", () => {
  test("accepts plain and markdown only", () => {
    expect(isOutputViewMode("plain")).toBe(true);
    expect(isOutputViewMode("markdown")).toBe(true);
    expect(isOutputViewMode("html")).toBe(false);
    expect(isOutputViewMode(null)).toBe(false);
  });
});

describe("normalizeOutputViewMode", () => {
  test("returns default for invalid input", () => {
    expect(normalizeOutputViewMode(null)).toBe(DEFAULT_OUTPUT_VIEW_MODE);
    expect(normalizeOutputViewMode(undefined)).toBe(DEFAULT_OUTPUT_VIEW_MODE);
    expect(normalizeOutputViewMode("oops")).toBe(DEFAULT_OUTPUT_VIEW_MODE);
    expect(normalizeOutputViewMode(1)).toBe(DEFAULT_OUTPUT_VIEW_MODE);
  });

  test("passes through valid modes", () => {
    expect(normalizeOutputViewMode("plain")).toBe("plain");
    expect(normalizeOutputViewMode("markdown")).toBe("markdown");
  });
});

describe("getOutputViewMode / setOutputViewMode", () => {
  test("defaults to plain when unset", () => {
    expect(getOutputViewMode()).toBe("plain");
  });

  test("round-trips markdown", () => {
    setOutputViewMode("markdown");
    expect(getOutputViewMode()).toBe("markdown");
    expect(localStorage.getItem(OUTPUT_VIEW_MODE_KEY)).toBe("markdown");
  });

  test("recovers from corrupt storage", () => {
    localStorage.setItem(OUTPUT_VIEW_MODE_KEY, "{not-json");
    expect(getOutputViewMode()).toBe("plain");
  });
});

describe("toggleOutputViewMode", () => {
  test("swaps plain and markdown", () => {
    expect(toggleOutputViewMode("plain")).toBe("markdown");
    expect(toggleOutputViewMode("markdown")).toBe("plain");
  });
});
