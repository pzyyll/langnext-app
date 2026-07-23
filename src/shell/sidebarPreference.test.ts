// ABOUTME: Unit tests for main-window sidebar open preference load/save.
// ABOUTME: Covers bare strings, JSON booleans, corrupt values, and defaults.

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SIDEBAR_OPEN,
  getSidebarOpen,
  normalizeSidebarOpen,
  setSidebarOpen,
  SIDEBAR_OPEN_KEY,
} from "./sidebarPreference";

/** Minimal in-memory localStorage for bun:test (no DOM globals). */
const memory = new Map<string, string>();
const memoryStorage = {
  getItem(key: string): string | null {
    return memory.has(key) ? memory.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
  },
  removeItem(key: string): void {
    memory.delete(key);
  },
  clear(): void {
    memory.clear();
  },
};

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: memoryStorage,
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: memoryStorage },
});

afterEach(() => {
  memory.clear();
});

describe("normalizeSidebarOpen", () => {
  test("accepts booleans", () => {
    expect(normalizeSidebarOpen(true)).toBe(true);
    expect(normalizeSidebarOpen(false)).toBe(false);
  });

  test("accepts bare true/false strings", () => {
    expect(normalizeSidebarOpen("true")).toBe(true);
    expect(normalizeSidebarOpen("false")).toBe(false);
  });

  test("falls back to default for invalid values", () => {
    expect(normalizeSidebarOpen(null)).toBe(DEFAULT_SIDEBAR_OPEN);
    expect(normalizeSidebarOpen("open")).toBe(DEFAULT_SIDEBAR_OPEN);
    expect(normalizeSidebarOpen(1)).toBe(DEFAULT_SIDEBAR_OPEN);
  });
});

describe("getSidebarOpen / setSidebarOpen", () => {
  test("defaults to expanded when unset", () => {
    expect(getSidebarOpen()).toBe(DEFAULT_SIDEBAR_OPEN);
  });

  test("round-trips open and collapsed", () => {
    setSidebarOpen(false);
    expect(localStorage.getItem(SIDEBAR_OPEN_KEY)).toBe("false");
    expect(getSidebarOpen()).toBe(false);

    setSidebarOpen(true);
    expect(localStorage.getItem(SIDEBAR_OPEN_KEY)).toBe("true");
    expect(getSidebarOpen()).toBe(true);
  });

  test("reads bare true/false strings", () => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, "false");
    expect(getSidebarOpen()).toBe(false);
  });

  test("reads JSON-encoded booleans", () => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, "false");
    expect(getSidebarOpen()).toBe(false);
    localStorage.setItem(SIDEBAR_OPEN_KEY, JSON.stringify(false));
    // JSON false is the bare string "false" — already covered; true JSON true is "true".
    localStorage.setItem(SIDEBAR_OPEN_KEY, "true");
    expect(getSidebarOpen()).toBe(true);
  });

  test("corrupt JSON falls back to expanded", () => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, "{not-json");
    expect(getSidebarOpen()).toBe(DEFAULT_SIDEBAR_OPEN);
  });
});
