import { expect, test } from "nsh/test";
import {
  createLanguageDetectionSettingsStore,
  DEFAULT_LANGUAGE_DETECTION_SETTINGS,
  LANGUAGE_DETECTION_STORAGE_KEY,
  type LanguageDetectionSettings,
  type LanguageDetectionSettingsStorage,
} from "./settings";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let setCalls = 0;
  let setHook: (() => Promise<void>) | null = null;

  const storage: LanguageDetectionSettingsStorage = {
    getItem: async (key) => {
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key, value) => {
      setCalls += 1;
      if (setHook) await setHook();
      if (failSetError) throw failSetError;
      backing[key] = value;
    },
  };

  return {
    backing,
    storage,
    setGetError: (err: Error | null) => {
      failGetError = err;
    },
    setSetError: (err: Error | null) => {
      failSetError = err;
    },
    setWriteHook: (hook: (() => Promise<void>) | null) => {
      setHook = hook;
    },
    getSetCalls: () => setCalls,
  };
}

function makeSettings(
  overrides: Partial<LanguageDetectionSettings> = {},
): LanguageDetectionSettings {
  return {
    mode: "ai",
    modelIds: ["primary", "backup-b", "backup-a"],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
    ...overrides,
  };
}

test("detection settings: keeps the saved mode, model order, and language preferences", async () => {
  const mem = createMemoryStorage();
  const store1 = createLanguageDetectionSettingsStore(mem.storage);

  expect(store1.settings()).toEqual(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
  expect(store1.loadError()).toBeNull();

  await store1.load();
  expect(store1.loadError()).toBeNull();

  const result = await store1.save(makeSettings());
  expect(result.ok).toBe(true);
  expect(store1.settings()).toEqual(makeSettings());

  const store2 = createLanguageDetectionSettingsStore(mem.storage);
  await store2.load();
  expect(store2.loadError()).toBeNull();
  expect(store2.settings()).toEqual(makeSettings());
  expect(store2.settings().modelIds).toEqual(["primary", "backup-b", "backup-a"]);

  const raw = JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!);
  expect(raw.version).toBe(1);
  expect(raw.mode).toBe("ai");
  expect(raw.modelIds).toEqual(["primary", "backup-b", "backup-a"]);
  expect(raw.nativeLanguage).toBe("zh");
  expect(raw.preferredTranslationLanguage).toBe("en");
});

test("detection settings: starts disabled with no model and no preferences", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()).toBeNull();
  expect(store.settings()).toEqual({
    mode: "off",
    modelIds: [],
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: keeps malformed storage untouched and reports a load error", async () => {
  const raw = "{ not json";
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.settings()).toEqual(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(store.loadError()?.message).toBeTruthy();
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: keeps an unsupported version untouched and reports a load error", async () => {
  const raw = JSON.stringify({
    version: 2,
    mode: "ai",
    modelIds: ["primary"],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.settings()).toEqual(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
  expect(store.loadError()?.key).toBe("storage_unsupported_version");
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: rejects an invalid stored shape without enabling detection", async () => {
  const raw = JSON.stringify({
    version: 1,
    mode: "ai",
    modelIds: ["primary", "primary"],
    nativeLanguage: "auto",
    preferredTranslationLanguage: null,
  });
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.settings().mode).toBe("off");
  expect(store.loadError()?.key).toBe("storage_malformed");
});

test("detection settings: rejects a non-string model ID instead of promoting a backup", async () => {
  const raw = JSON.stringify({ version: 1, ...makeSettings(), modelIds: [42, "backup"] });
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.settings()).toEqual(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: reports a read failure without enabling detection", async () => {
  const mem = createMemoryStorage();
  mem.setGetError(new Error("ERR_NSH_IO"));
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.settings()).toEqual(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
  expect(store.loadError()?.key).toBe("storage_read_failed");
});

test("detection settings: keeps the last saved snapshot when a write fails", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const saved = await store.save(makeSettings());
  expect(saved.ok).toBe(true);
  const snapshot = store.settings();

  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"));
  const failed = await store.save(makeSettings({ mode: "off", modelIds: [] }));

  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  expect(failed.key).toBe("storage_write_failed");
  expect(failed.message).toBeTruthy();
  expect(failed.message.includes("ERR_NSH_QUOTA_EXCEEDED")).toBe(false);
  expect(store.settings()).toEqual(snapshot);

  const reloaded = createLanguageDetectionSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.settings()).toEqual(snapshot);
});

test("detection settings: serializes writes so a late failure cannot replace a saved snapshot", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  let releaseFirstWrite = () => {};
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let writeCount = 0;
  mem.setWriteHook(async () => {
    writeCount += 1;
    if (writeCount === 1) await firstWriteGate;
  });

  const first = store.save(makeSettings({ modelIds: ["primary"] }));
  const second = store.save(makeSettings({ modelIds: ["primary", "backup-a"] }));
  releaseFirstWrite();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.ok).toBe(true);
  expect(secondResult.ok).toBe(true);
  expect(mem.getSetCalls()).toBe(2);
  expect(store.settings().modelIds).toEqual(["primary", "backup-a"]);

  const raw = JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!);
  expect(raw.modelIds).toEqual(["primary", "backup-a"]);
});

test("detection settings: rejects blank and duplicate model IDs", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const blank = await store.save(makeSettings({ modelIds: ["primary", "  "] }));
  expect(blank.ok).toBe(false);
  if (!blank.ok) expect(blank.key).toBe("model_id_blank");

  const duplicate = await store.save(
    makeSettings({ modelIds: ["primary", "backup-a", "primary"] }),
  );
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.key).toBe("model_id_duplicate");

  expect(mem.getSetCalls()).toBe(0);
  expect(store.settings()).toEqual(DEFAULT_LANGUAGE_DETECTION_SETTINGS);
});

test("detection settings: requires a primary model in AI mode", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const result = await store.save(makeSettings({ modelIds: [] }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.key).toBe("primary_model_required");
  expect(mem.getSetCalls()).toBe(0);

  const offResult = await store.save(makeSettings({ mode: "off", modelIds: [] }));
  expect(offResult.ok).toBe(true);
  expect(store.settings().mode).toBe("off");
});

test("detection settings: rejects automatic and identical language preferences", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const automaticNative = await store.save(
    makeSettings({
      nativeLanguage: "auto" as unknown as LanguageDetectionSettings["nativeLanguage"],
    }),
  );
  expect(automaticNative.ok).toBe(false);
  if (!automaticNative.ok) expect(automaticNative.key).toBe("preference_invalid");

  const automaticPreferred = await store.save(
    makeSettings({
      preferredTranslationLanguage:
        "auto" as unknown as LanguageDetectionSettings["preferredTranslationLanguage"],
    }),
  );
  expect(automaticPreferred.ok).toBe(false);
  if (!automaticPreferred.ok) expect(automaticPreferred.key).toBe("preference_invalid");

  const identical = await store.save(
    makeSettings({ nativeLanguage: "zh", preferredTranslationLanguage: "zh" }),
  );
  expect(identical.ok).toBe(false);
  if (!identical.ok) expect(identical.key).toBe("preferences_identical");

  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: saves Google detection without any model", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const result = await store.save({
    mode: "google",
    modelIds: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
  expect(result.ok).toBe(true);

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.loadError()).toBeNull();
  expect(reopened.settings()).toEqual({
    mode: "google",
    modelIds: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
  expect(JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!).mode).toBe("google");
});

test("detection settings: accepts one unset preference and a disabled mode with saved models", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const onePreference = await store.save(
    makeSettings({ nativeLanguage: "zh", preferredTranslationLanguage: null }),
  );
  expect(onePreference.ok).toBe(true);
  expect(store.settings().preferredTranslationLanguage).toBeNull();

  const offWithModels = await store.save(
    makeSettings({ mode: "off", nativeLanguage: null, preferredTranslationLanguage: null }),
  );
  expect(offWithModels.ok).toBe(true);
  expect(store.settings()).toEqual({
    mode: "off",
    modelIds: ["primary", "backup-b", "backup-a"],
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
});
