// ABOUTME: Unit tests for quick-translate localStorage load/save normalization.
// ABOUTME: Covers corrupt JSON, invalid langs, promptTemplateId, and collapsed-id pruning.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadQuickTranslateSession,
  QUICK_TRANSLATE_SESSION_KEY,
  saveQuickTranslateSession,
} from "./quickTranslateSession";

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
  localStorage.removeItem(QUICK_TRANSLATE_SESSION_KEY);
});

describe("quickTranslateSession", () => {
  test("returns defaults when nothing is stored", () => {
    const session = loadQuickTranslateSession();
    expect(session.sourceLang).toBe("auto");
    expect(session.targetLang).toBe("zh");
    expect(session.slots).toEqual([]);
    expect(session.collapsedSlotIds).toEqual([]);
    expect(session.autoTranslate).toBe(true);
  });

  test("round-trips a valid session", () => {
    saveQuickTranslateSession({
      sourceLang: "en",
      targetLang: "ja",
      slots: [{ id: "s1", profileId: "p1", promptTemplateId: "tpl-1" }],
      collapsedSlotIds: ["s1"],
      autoTranslate: false,
    });
    const session = loadQuickTranslateSession();
    expect(session.sourceLang).toBe("en");
    expect(session.targetLang).toBe("ja");
    expect(session.slots).toEqual([{ id: "s1", profileId: "p1", promptTemplateId: "tpl-1" }]);
    expect(session.collapsedSlotIds).toEqual(["s1"]);
    expect(session.autoTranslate).toBe(false);
  });

  test("defaults missing promptTemplateId to empty string", () => {
    localStorage.setItem(
      QUICK_TRANSLATE_SESSION_KEY,
      JSON.stringify({
        sourceLang: "auto",
        targetLang: "zh",
        slots: [{ id: "s1", profileId: "p1" }],
        collapsedSlotIds: [],
        autoTranslate: true,
      }),
    );
    expect(loadQuickTranslateSession().slots).toEqual([{ id: "s1", profileId: "p1", promptTemplateId: "" }]);
  });

  test("returns defaults for corrupt JSON", () => {
    localStorage.setItem(QUICK_TRANSLATE_SESSION_KEY, "{not-json");
    const session = loadQuickTranslateSession();
    expect(session.sourceLang).toBe("auto");
    expect(session.slots).toEqual([]);
  });

  test("drops collapsed ids that do not match any slot", () => {
    saveQuickTranslateSession({
      sourceLang: "auto",
      targetLang: "zh",
      slots: [{ id: "s1", profileId: "p1", promptTemplateId: "" }],
      collapsedSlotIds: ["s1", "missing"],
      autoTranslate: true,
    });
    expect(loadQuickTranslateSession().collapsedSlotIds).toEqual(["s1"]);
  });
});
