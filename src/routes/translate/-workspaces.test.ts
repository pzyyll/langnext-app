// ABOUTME: Unit tests for translate workspace store normalize/CRUD helpers.
// ABOUTME: Covers defaults, migration from session prefs, clamps, and active-id repair.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TRANSLATE_SESSION_PREFERENCES_KEY } from "./-sessionPreferences";
import {
  MAX_TRANSLATE_WORKSPACES,
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACE_TEXT_LENGTH,
  TRANSLATE_WORKSPACES_KEY,
  TRANSLATE_WORKSPACES_VERSION,
  addWorkspaceToStore,
  createTranslateWorkspace,
  getActiveWorkspace,
  getTranslateWorkspacesStore,
  nextDefaultWorkspaceName,
  normalizeTranslateWorkspace,
  normalizeTranslateWorkspacesStore,
  removeWorkspaceFromStore,
  reorderWorkspacesInStore,
  setRailCollapsedInStore,
  setTranslateWorkspacesStore,
  updateWorkspaceInStore,
} from "./-workspaces";

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
  localStorage.removeItem(TRANSLATE_WORKSPACES_KEY);
  localStorage.removeItem(TRANSLATE_SESSION_PREFERENCES_KEY);
});

describe("normalizeTranslateWorkspace", () => {
  test("returns null for non-objects and missing id", () => {
    expect(normalizeTranslateWorkspace(null)).toBeNull();
    expect(normalizeTranslateWorkspace("x")).toBeNull();
    expect(normalizeTranslateWorkspace({ name: "A" })).toBeNull();
  });

  test("accepts a full valid payload", () => {
    const ws = normalizeTranslateWorkspace({
      id: "w1",
      name: "Legal",
      profileId: "p1",
      modelId: "m1",
      sourceLang: "zh",
      targetLang: "en",
      usedSourceLangs: ["en", "zh"],
      usedTargetLangs: ["ja"],
      outputViewMode: "markdown",
      promptTemplateId: "t1",
      sourceText: "你好",
      outputText: "Hello",
      detectedSourceLang: "zh",
      latencyMs: 120.2,
      activeModelLabel: "GPT",
      errorMessage: null,
      updatedAt: 1000,
    });
    expect(ws).toEqual({
      id: "w1",
      name: "Legal",
      profileId: "p1",
      modelId: "m1",
      sourceLang: "zh",
      targetLang: "en",
      usedSourceLangs: ["en", "zh"],
      usedTargetLangs: ["ja"],
      outputViewMode: "markdown",
      promptTemplateId: "t1",
      sourceText: "你好",
      outputText: "Hello",
      detectedSourceLang: "zh",
      latencyMs: 120,
      activeModelLabel: "GPT",
      errorMessage: null,
      updatedAt: 1000,
    });
  });

  test("defaults missing used langs and outputViewMode for legacy rows", () => {
    const ws = normalizeTranslateWorkspace({
      id: "w1",
      name: "Legacy",
      sourceLang: "auto",
      targetLang: "en",
    });
    expect(ws?.usedSourceLangs).toEqual([]);
    expect(ws?.usedTargetLangs).toEqual([]);
    expect(ws?.outputViewMode).toBe("plain");
  });

  test("clamps name and text length", () => {
    const longName = "N".repeat(MAX_WORKSPACE_NAME_LENGTH + 20);
    const longText = "T".repeat(MAX_WORKSPACE_TEXT_LENGTH + 50);
    const ws = normalizeTranslateWorkspace({
      id: "w1",
      name: longName,
      sourceText: longText,
      outputText: longText,
    });
    expect(ws?.name).toHaveLength(MAX_WORKSPACE_NAME_LENGTH);
    expect(ws?.sourceText).toHaveLength(MAX_WORKSPACE_TEXT_LENGTH);
    expect(ws?.outputText).toHaveLength(MAX_WORKSPACE_TEXT_LENGTH);
  });

  test("falls back invalid languages and empty name", () => {
    const ws = normalizeTranslateWorkspace({
      id: "w1",
      name: "   ",
      sourceLang: "zz",
      targetLang: "xx",
      detectedSourceLang: "nope",
    });
    expect(ws?.name).toBe("Workspace 1");
    expect(ws?.sourceLang).toBe("auto");
    expect(ws?.targetLang).toBe("auto");
    expect(ws?.detectedSourceLang).toBeNull();
  });
});

describe("normalizeTranslateWorkspacesStore", () => {
  test("seeds a workspace from legacy session prefs when empty", () => {
    localStorage.setItem(
      TRANSLATE_SESSION_PREFERENCES_KEY,
      JSON.stringify({
        profileId: "legacy-p",
        modelId: "legacy-m",
        sourceLang: "ja",
        targetLang: "de",
      }),
    );
    const store = normalizeTranslateWorkspacesStore(null);
    expect(store.version).toBe(TRANSLATE_WORKSPACES_VERSION);
    expect(store.workspaces).toHaveLength(1);
    expect(store.activeWorkspaceId).toBe(store.workspaces[0]!.id);
    expect(store.railCollapsed).toBe(false);
    expect(store.workspaces[0]).toMatchObject({
      profileId: "legacy-p",
      modelId: "legacy-m",
      sourceLang: "ja",
      targetLang: "de",
      sourceText: "",
      outputText: "",
    });
  });

  test("preserves railCollapsed true", () => {
    const store = normalizeTranslateWorkspacesStore({
      version: 1,
      activeWorkspaceId: "a",
      railCollapsed: true,
      workspaces: [{ id: "a", name: "A" }],
    });
    expect(store.railCollapsed).toBe(true);
  });

  test("repairs stale activeWorkspaceId", () => {
    const store = normalizeTranslateWorkspacesStore({
      version: 1,
      activeWorkspaceId: "missing",
      workspaces: [
        {
          id: "a",
          name: "A",
          profileId: "",
          modelId: "",
          sourceLang: "auto",
          targetLang: "en",
        },
      ],
    });
    expect(store.activeWorkspaceId).toBe("a");
  });

  test("dedupes ids and caps workspace count", () => {
    const rawWorkspaces = Array.from({ length: MAX_TRANSLATE_WORKSPACES + 5 }, (_, i) => ({
      id: i < 2 ? "dup" : `w${i}`,
      name: `W${i}`,
    }));
    const store = normalizeTranslateWorkspacesStore({
      activeWorkspaceId: "dup",
      workspaces: rawWorkspaces,
    });
    expect(store.workspaces.length).toBeLessThanOrEqual(MAX_TRANSLATE_WORKSPACES);
    expect(store.workspaces.filter((ws) => ws.id === "dup")).toHaveLength(1);
  });
});

describe("store CRUD helpers", () => {
  test("updateWorkspaceInStore patches fields and bumps updatedAt", () => {
    const base = createTranslateWorkspace({ name: "A" }, 100);
    const store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: base.id,
      workspaces: [base],
      railCollapsed: false,
    };
    const next = updateWorkspaceInStore(store, base.id, { sourceText: "hi", outputText: "yo" }, 200);
    expect(getActiveWorkspace(next).sourceText).toBe("hi");
    expect(getActiveWorkspace(next).outputText).toBe("yo");
    expect(getActiveWorkspace(next).updatedAt).toBe(200);
  });

  test("addWorkspaceToStore activates the new workspace", () => {
    const a = createTranslateWorkspace({ name: "A" });
    const b = createTranslateWorkspace({ name: "B" });
    let store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: a.id,
      workspaces: [a],
      railCollapsed: false,
    };
    store = addWorkspaceToStore(store, b);
    expect(store.workspaces).toHaveLength(2);
    expect(store.activeWorkspaceId).toBe(b.id);
  });

  test("removeWorkspaceFromStore activates neighbor and recreates when empty", () => {
    const a = createTranslateWorkspace({ name: "A" });
    const b = createTranslateWorkspace({ name: "B" });
    const c = createTranslateWorkspace({ name: "C" });
    let store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: b.id,
      workspaces: [a, b, c],
      railCollapsed: true,
    };
    store = removeWorkspaceFromStore(store, b.id);
    expect(store.workspaces.map((ws) => ws.id)).toEqual([a.id, c.id]);
    expect(store.activeWorkspaceId).toBe(a.id);
    expect(store.railCollapsed).toBe(true);

    store = removeWorkspaceFromStore(store, a.id);
    store = removeWorkspaceFromStore(store, c.id);
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0]!.name).toBe("Workspace 1");
    expect(store.workspaces[0]!.sourceText).toBe("");
    expect(store.railCollapsed).toBe(true);
  });

  test("reorderWorkspacesInStore reorders by id list", () => {
    const a = createTranslateWorkspace({ name: "A" });
    const b = createTranslateWorkspace({ name: "B" });
    const c = createTranslateWorkspace({ name: "C" });
    const store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: a.id,
      workspaces: [a, b, c],
      railCollapsed: false,
    };
    const next = reorderWorkspacesInStore(store, [c.id, a.id, b.id]);
    expect(next.workspaces.map((ws) => ws.id)).toEqual([c.id, a.id, b.id]);
    expect(next.activeWorkspaceId).toBe(a.id);
  });

  test("reorderWorkspacesInStore is a no-op for the same order", () => {
    const a = createTranslateWorkspace({ name: "A" });
    const b = createTranslateWorkspace({ name: "B" });
    const store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: a.id,
      workspaces: [a, b],
      railCollapsed: false,
    };
    const next = reorderWorkspacesInStore(store, [a.id, b.id]);
    expect(next).toBe(store);
  });

  test("setRailCollapsedInStore toggles only when changed", () => {
    const a = createTranslateWorkspace({ name: "A" });
    const store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: a.id,
      workspaces: [a],
      railCollapsed: false,
    };
    expect(setRailCollapsedInStore(store, false)).toBe(store);
    expect(setRailCollapsedInStore(store, true).railCollapsed).toBe(true);
  });

  test("nextDefaultWorkspaceName skips used names", () => {
    const a = createTranslateWorkspace({ name: "Workspace 1" });
    const b = createTranslateWorkspace({ name: "Workspace 2" });
    expect(nextDefaultWorkspaceName([a, b])).toBe("Workspace 3");
  });
});

describe("getTranslateWorkspacesStore / setTranslateWorkspacesStore", () => {
  test("round-trips a store with draft text", () => {
    const ws = createTranslateWorkspace({ name: "Legal", profileId: "p1" });
    ws.sourceText = "hello";
    ws.outputText = "你好";
    const store = {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: ws.id,
      workspaces: [ws],
      railCollapsed: true,
    };
    setTranslateWorkspacesStore(store);
    const loaded = getTranslateWorkspacesStore();
    expect(loaded.activeWorkspaceId).toBe(ws.id);
    expect(loaded.railCollapsed).toBe(true);
    expect(loaded.workspaces[0]).toMatchObject({
      name: "Legal",
      profileId: "p1",
      sourceText: "hello",
      outputText: "你好",
    });
  });

  test("returns seeded store for corrupt JSON", () => {
    localStorage.setItem(TRANSLATE_WORKSPACES_KEY, "{not-json");
    const store = getTranslateWorkspacesStore();
    expect(store.workspaces).toHaveLength(1);
  });
});
