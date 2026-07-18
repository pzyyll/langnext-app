// ABOUTME: Tests cross-window theme sync via the shared localStorage cache.
// ABOUTME: Covers storage-event resolution and peer-window apply into DOM attributes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  THEME_STORAGE_KEY,
  applyThemeToDom,
  getAppliedTheme,
  handleThemeStorageEvent,
  resolveThemeFromStorageEvent,
} from "./theme";

/** Minimal in-memory localStorage + document/window for bun:test. */
function installDomAndStorage(initialTheme: "light" | "dark" = "light"): void {
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

  const documentElement = {
    attributes: new Map<string, string>(),
    style: { colorScheme: "" as string },
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
  };

  const windowLike = {
    localStorage: memoryStorage,
    matchMedia() {
      return { matches: false };
    },
    addEventListener() {
      /* no-op for unit tests */
    },
    removeEventListener() {
      /* no-op for unit tests */
    },
    dispatchEvent() {
      return true;
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: memoryStorage,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { documentElement },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: windowLike,
  });

  applyThemeToDom(initialTheme);
}

beforeEach(() => {
  installDomAndStorage("light");
});

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
});

describe("applyThemeToDom", () => {
  test("does not rewrite localStorage when the value is already current", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.style.colorScheme = "dark";

    let writes = 0;
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key: string, value: string) => {
      writes += 1;
      original(key, value);
    };

    applyThemeToDom("dark");
    expect(writes).toBe(0);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    localStorage.setItem = original;
  });
});

describe("resolveThemeFromStorageEvent", () => {
  test("ignores unrelated keys", () => {
    expect(resolveThemeFromStorageEvent({ key: "other", newValue: "dark" })).toBeNull();
  });

  test("reads the theme key", () => {
    expect(resolveThemeFromStorageEvent({ key: THEME_STORAGE_KEY, newValue: "dark" })).toBe("dark");
    expect(resolveThemeFromStorageEvent({ key: THEME_STORAGE_KEY, newValue: "light" })).toBe("light");
  });

  test("falls back to cache for invalid or cleared values", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(resolveThemeFromStorageEvent({ key: THEME_STORAGE_KEY, newValue: "nope" })).toBe("dark");
    expect(resolveThemeFromStorageEvent({ key: null, newValue: null })).toBe("dark");
  });
});

describe("handleThemeStorageEvent", () => {
  test("applies peer-window theme changes to data-theme and color-scheme", () => {
    expect(getAppliedTheme()).toBe("light");

    // Peer window already wrote the shared cache before the storage event arrives.
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    handleThemeStorageEvent({ key: THEME_STORAGE_KEY, newValue: "dark" });

    expect(getAppliedTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  test("ignores unrelated storage events", () => {
    applyThemeToDom("light");
    handleThemeStorageEvent({ key: "langnext-ui-language", newValue: "zh-CN" });
    expect(getAppliedTheme()).toBe("light");
  });
});
