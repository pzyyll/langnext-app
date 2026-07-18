// ABOUTME: Tests cross-window UI language sync via the shared localStorage cache.
// ABOUTME: Covers storage-event resolution and peer-window apply into i18n + DOM.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LANGUAGE_STORAGE_KEY, applyLanguageToDom } from "./languages";
import {
  applyAppLanguage,
  getAppLanguage,
  handleLanguageStorageEvent,
  initI18n,
  resolveLanguageFromStorageEvent,
} from "./index";

/** Minimal in-memory localStorage + document/window for bun:test. */
function installDomAndStorage(): void {
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

  const documentElement = { lang: "" };
  const windowLike = {
    localStorage: memoryStorage,
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
}

beforeEach(async () => {
  installDomAndStorage();
  await initI18n("en");
  await applyAppLanguage("en");
});

afterEach(async () => {
  await applyAppLanguage("en");
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

describe("applyLanguageToDom", () => {
  test("does not rewrite localStorage when the value is already current", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    let writes = 0;
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key: string, value: string) => {
      writes += 1;
      original(key, value);
    };

    applyLanguageToDom("zh-CN");
    expect(writes).toBe(0);
    expect(document.documentElement.lang).toBe("zh-CN");

    localStorage.setItem = original;
  });
});

describe("resolveLanguageFromStorageEvent", () => {
  test("ignores unrelated keys", () => {
    expect(resolveLanguageFromStorageEvent({ key: "other", newValue: "zh-CN" })).toBeNull();
  });

  test("reads the language key and normalizes tags", () => {
    expect(resolveLanguageFromStorageEvent({ key: LANGUAGE_STORAGE_KEY, newValue: "zh-CN" })).toBe("zh-CN");
    expect(resolveLanguageFromStorageEvent({ key: LANGUAGE_STORAGE_KEY, newValue: "zh" })).toBe("zh-CN");
    expect(resolveLanguageFromStorageEvent({ key: LANGUAGE_STORAGE_KEY, newValue: "en-US" })).toBe("en");
  });

  test("falls back to cache when the key is cleared", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    // clear() storage event: key null
    expect(resolveLanguageFromStorageEvent({ key: null, newValue: null })).toBe("zh-CN");
  });
});

describe("handleLanguageStorageEvent", () => {
  test("applies peer-window language changes to i18n and document lang", async () => {
    expect(getAppLanguage()).toBe("en");

    // Peer window already wrote the shared cache before the storage event arrives.
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    await handleLanguageStorageEvent({ key: LANGUAGE_STORAGE_KEY, newValue: "zh-CN" });

    expect(getAppLanguage()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
  });

  test("ignores unrelated storage events", async () => {
    await applyAppLanguage("en");
    await handleLanguageStorageEvent({ key: "theme", newValue: "dark" });
    expect(getAppLanguage()).toBe("en");
  });
});
