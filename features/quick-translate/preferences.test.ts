import { expect, open, test } from "nsh/test";
import type { TranslationPreset } from "../presets/types";
import {
  createQuickTranslatePreferencesStore,
  QUICK_TRANSLATE_PREFERENCES_KEY,
  resolveQuickTranslateCards,
} from "./preferences";

function makePreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-1",
    name: "Default Preset",
    enabled: true,
    sourceLanguage: "en",
    targetLanguage: "zh",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "{{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-formal",
          name: "Formal",
          systemTemplate: "Formal {{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
    ...overrides,
  };
}

test("quick preferences: persists only allowed fields, recovers from corrupt storage, serializes writes, and filters cards only after presets load", async () => {
  const backing = new Map<string, string>();
  const store = createQuickTranslatePreferencesStore({
    getItem: async (key) => backing.get(key) ?? null,
    setItem: async (key, value) => {
      backing.set(key, value);
    },
  });

  // 1. Corrupt JSON retains safe defaults and allows a subsequent explicit save.
  backing.set(QUICK_TRANSLATE_PREFERENCES_KEY, "{not valid json");
  await store.load();
  expect(store.preferences()).toEqual({
    version: 1,
    doubleCopyEnabled: false,
    autoTranslate: false,
    sourceLanguage: null,
    targetLanguage: null,
    cards: [],
  });

  // Wrong version or invalid language/cards is rejected at load.
  backing.set(
    QUICK_TRANSLATE_PREFERENCES_KEY,
    JSON.stringify({
      version: 2,
      doubleCopyEnabled: true,
      autoTranslate: "bad",
      sourceLanguage: "xx",
    }),
  );
  await store.load();
  expect(store.doubleCopyEnabled()).toBe(false);
  expect(store.autoTranslate()).toBe(false);

  // Explicit save overwrites corrupt storage cleanly without storing forbidden fields.
  const ok = await store.savePopupState({
    autoTranslate: true,
    sourceLanguage: "en",
    targetLanguage: "ja",
    cards: [
      { id: "card-1", presetId: "preset-1", templateId: "tpl-formal", collapsed: true },
      { id: "card-2", presetId: "preset-disabled", templateId: null, collapsed: false },
    ],
  });
  expect(ok).toBe(true);
  const rawSaved = backing.get(QUICK_TRANSLATE_PREFERENCES_KEY)!;
  const parsedSaved = JSON.parse(rawSaved);
  expect(parsedSaved).toEqual({
    version: 1,
    doubleCopyEnabled: false,
    autoTranslate: true,
    sourceLanguage: "en",
    targetLanguage: "ja",
    cards: [
      { id: "card-1", presetId: "preset-1", templateId: "tpl-formal", collapsed: true },
      { id: "card-2", presetId: "preset-disabled", templateId: null, collapsed: false },
    ],
  });
  expect(rawSaved).not.toContain("pinned");
  expect(rawSaved).not.toContain("sourceText");
  expect(rawSaved).not.toContain("result");
  expect(rawSaved).not.toContain("error");

  // 2. Do not filter against preset store before presets finish loading.
  const preReady = resolveQuickTranslateCards(parsedSaved.cards, { kind: "loading" }, [
    makePreset({ id: "preset-1" }),
  ]);
  expect(preReady).toBeNull();

  // Once ready, drop missing/disabled presets and clear missing template overrides to default (null).
  const activePreset = makePreset({
    id: "preset-1",
    enabled: true,
    engine: {
      ...makePreset().engine,
      templates: [makePreset().engine.templates[0]!], // tpl-formal removed
    },
  });
  const disabledPreset = makePreset({ id: "preset-disabled", enabled: false });
  const filtered = resolveQuickTranslateCards(
    [
      { id: "card-1", presetId: "preset-1", templateId: "tpl-formal", collapsed: true },
      { id: "card-2", presetId: "preset-disabled", templateId: null, collapsed: false },
      { id: "card-3", presetId: "preset-missing", templateId: null, collapsed: false },
    ],
    { kind: "ready" },
    [activePreset, disabledPreset],
  );
  expect(filtered).toEqual([
    { id: "card-1", presetId: "preset-1", templateId: null, collapsed: true },
  ]);

  // 3. Serialize writes so an earlier slow write never reverts a later setting.
  const writeGates: Array<{ resolve: () => void; payload: string }> = [];
  let failWrites = false;
  const queuedStore = createQuickTranslatePreferencesStore({
    getItem: async (key) => backing.get(key) ?? null,
    setItem: (key, value) =>
      new Promise<void>((resolve, reject) => {
        if (failWrites) {
          reject(new Error("disk full"));
          return;
        }
        writeGates.push({
          payload: value,
          resolve: () => {
            backing.set(key, value);
            resolve();
          },
        });
      }),
  });
  await queuedStore.load();

  const slowEnable = queuedStore.savePopupState({ autoTranslate: true });
  const quickDisable = queuedStore.savePopupState({ autoTranslate: false });
  await Promise.resolve();
  // Second write must wait behind first write rather than racing out of order.
  expect(writeGates).toHaveLength(1);
  expect(JSON.parse(writeGates[0]!.payload).autoTranslate).toBe(true);
  writeGates[0]!.resolve();
  for (let i = 0; i < 6 && writeGates.length < 2; i += 1) {
    await Promise.resolve();
  }
  expect(writeGates).toHaveLength(2);
  expect(JSON.parse(writeGates[1]!.payload).autoTranslate).toBe(false);
  writeGates[1]!.resolve();
  await Promise.all([slowEnable, quickDisable]);
  expect(JSON.parse(backing.get(QUICK_TRANSLATE_PREFERENCES_KEY)!).autoTranslate).toBe(false);

  // 4. Write failure surfaces error cleanly and does not throw or falsely claim saved.
  failWrites = true;
  const failedWrite = await queuedStore.savePopupState({ autoTranslate: true });
  expect(failedWrite).toBe(false);
  expect(queuedStore.saveError()).not.toBeNull();
  expect(open).toBeDefined();
});

test("automatic target: keeps an automatic target and preserves the inherit-preset default", async () => {
  const backing = new Map<string, string>();
  const openStore = () =>
    createQuickTranslatePreferencesStore({
      getItem: async (key) => backing.get(key) ?? null,
      setItem: async (key, value) => {
        backing.set(key, value);
      },
    });

  const store = openStore();
  await store.load();
  expect(store.preferences().targetLanguage).toBeNull();

  await store.savePopupState({ targetLanguage: "auto" });
  const reloaded = openStore();
  await reloaded.load();
  expect(reloaded.preferences().targetLanguage).toBe("auto");
  expect(reloaded.preferences().sourceLanguage).toBeNull();

  await reloaded.savePopupState({ targetLanguage: null });
  const cleared = openStore();
  await cleared.load();
  expect(cleared.preferences().targetLanguage).toBeNull();
});
