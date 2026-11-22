import { expect, test } from "nsh/test";
import {
  createLanguageDetectionSettingsStore,
  LANGUAGE_DETECTION_STORAGE_KEY,
  type LanguageDetectionPreferences,
  type LanguageDetectionSettingsStorage,
  type LanguageDetectorKind,
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

function detectionRecord(
  options: {
    order?: readonly LanguageDetectorKind[];
    enabled?: Partial<Record<LanguageDetectorKind, boolean>>;
    modelId?: string | null;
    nativeLanguage?: string | null;
    preferredTranslationLanguage?: string | null;
  } = {},
): string {
  const ai =
    options.modelId === undefined || options.modelId === null ? null : { modelId: options.modelId };
  return JSON.stringify({
    version: 2,
    order: options.order ?? ["ai", "google"],
    enabled: {
      ai: options.enabled?.ai ?? ai !== null,
      google: options.enabled?.google ?? false,
    },
    ai,
    nativeLanguage: options.nativeLanguage ?? null,
    preferredTranslationLanguage: options.preferredTranslationLanguage ?? null,
  });
}

const PREFERENCES: LanguageDetectionPreferences = {
  nativeLanguage: "zh",
  preferredTranslationLanguage: "en",
};

test("detection settings: starts with both detectors disabled in the default order", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);

  expect(store.detectorOrder()).toEqual(["ai", "google"]);
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.isEnabled("google")).toBe(false);
  expect(store.savedAiBinding()).toBeNull();
  expect(store.enabledDetectors()).toEqual([]);
  expect(store.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  expect(store.loadError()).toBeNull();

  await store.load();
  expect(store.loadError()).toBeNull();
  expect(store.detectorOrder()).toEqual(["ai", "google"]);
  expect(store.enabledDetectors()).toEqual([]);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: saving the AI model enables the detector and persists the v2 record", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const result = await store.saveAiModel("m-1");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.binding).toEqual({ kind: "ai", modelId: "m-1" });

  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
  expect(store.isEnabled("ai")).toBe(true);
  expect(store.isEnabled("google")).toBe(false);
  expect(store.enabledDetectors()).toEqual([{ kind: "ai", modelId: "m-1" }]);

  expect(JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!)).toEqual({
    version: 2,
    order: ["ai", "google"],
    enabled: { ai: true, google: false },
    ai: { modelId: "m-1" },
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.loadError()).toBeNull();
  expect(reopened.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
  expect(reopened.enabledDetectors()).toEqual([{ kind: "ai", modelId: "m-1" }]);
});

test("detection settings: editing a disabled AI detector keeps it disabled", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  await store.saveAiModel("m-1");
  const disabled = await store.setEnabled("ai", false);
  expect(disabled.ok).toBe(true);

  const edited = await store.saveAiModel("m-2");
  expect(edited.ok).toBe(true);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-2" });
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.enabledDetectors()).toEqual([]);
  expect(JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!).enabled.ai).toBe(false);
});

test("detection settings: Google enables without configuration and an unconfigured AI detector refuses to enable", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const google = await store.setEnabled("google", true);
  expect(google.ok).toBe(true);
  expect(store.isEnabled("google")).toBe(true);
  expect(store.enabledDetectors()).toEqual([{ kind: "google" }]);

  const ai = await store.setEnabled("ai", true);
  expect(ai.ok).toBe(false);
  if (!ai.ok) expect(ai.key).toBe("detector_unconfigured");
  expect(store.isEnabled("ai")).toBe(false);

  await store.saveAiModel("m-1");
  expect(store.isEnabled("ai")).toBe(true);
  expect(store.enabledDetectors()).toEqual([{ kind: "ai", modelId: "m-1" }, { kind: "google" }]);
});

test("detection settings: reorders detectors, clamps targets, and keeps same-slot moves inert", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();
  await store.saveAiModel("m-1");
  await store.setEnabled("google", true);

  const moved = await store.moveDetectorTo("google", 0);
  expect(moved.ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google", "ai"]);
  expect(store.enabledDetectors()).toEqual([{ kind: "google" }, { kind: "ai", modelId: "m-1" }]);

  const writes = mem.getSetCalls();
  expect((await store.moveDetectorTo("google", 0)).ok).toBe(true);
  expect((await store.moveDetectorTo("ai", 1)).ok).toBe(true);
  expect(mem.getSetCalls()).toBe(writes);

  expect((await store.moveDetectorTo("google", 99)).ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["ai", "google"]);
  expect((await store.moveDetectorTo("google", -5)).ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google", "ai"]);

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.detectorOrder()).toEqual(["google", "ai"]);
});

test("detection settings: saves and restores the language preferences", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const native = await store.setPreference("nativeLanguage", "zh");
  expect(native.ok).toBe(true);
  const preferred = await store.setPreference("preferredTranslationLanguage", "en");
  expect(preferred.ok).toBe(true);
  expect(store.preferences()).toEqual(PREFERENCES);
  expect(store.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });

  const raw = JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!);
  expect(raw.nativeLanguage).toBe("zh");
  expect(raw.preferredTranslationLanguage).toBe("en");

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.loadError()).toBeNull();
  expect(reopened.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });
});

test("detection settings: rejects invalid and identical preferences without writing", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const automatic = await store.setPreference(
    "nativeLanguage",
    "auto" as unknown as LanguageDetectionPreferences["nativeLanguage"],
  );
  expect(automatic.ok).toBe(false);
  if (!automatic.ok) expect(automatic.key).toBe("preference_invalid");

  const native = await store.setPreference("nativeLanguage", "zh");
  expect(native.ok).toBe(true);

  const identical = await store.setPreference("preferredTranslationLanguage", "zh");
  expect(identical.ok).toBe(false);
  if (!identical.ok) expect(identical.key).toBe("preferences_identical");

  expect(mem.getSetCalls()).toBe(1);
  expect(store.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
});

test("detection settings: keeps malformed storage untouched and reports a load error", async () => {
  const raw = "{ not json";
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(store.loadError()?.message).toBeTruthy();
  expect(store.enabledDetectors()).toEqual([]);
  expect(store.detectorOrder()).toEqual(["ai", "google"]);
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: keeps an unsupported version untouched and reports a load error", async () => {
  const raw = JSON.stringify({
    version: 1,
    mode: "ai",
    modelIds: ["m-1"],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()?.key).toBe("storage_unsupported_version");
  expect(store.enabledDetectors()).toEqual([]);
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: rejects an enabled AI detector without a saved model", async () => {
  const raw = detectionRecord({ enabled: { ai: true }, modelId: null });
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(store.enabledDetectors()).toEqual([]);
  expect(store.savedAiBinding()).toBeNull();
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: rejects a malformed order, enabled map, or AI binding", async () => {
  const records = [
    JSON.stringify({ version: 2, order: ["ai"], enabled: { ai: false, google: false }, ai: null }),
    JSON.stringify({
      version: 2,
      order: ["ai", "ai"],
      enabled: { ai: false, google: false },
      ai: null,
    }),
    JSON.stringify({
      version: 2,
      order: ["ai", "google"],
      enabled: { ai: false, google: "no" },
      ai: null,
    }),
    JSON.stringify({
      version: 2,
      order: ["ai", "google"],
      enabled: { ai: false, google: false },
      ai: { modelId: 42 },
    }),
  ];

  for (const raw of records) {
    const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
    const store = createLanguageDetectionSettingsStore(mem.storage);
    await store.load();
    expect(store.loadError()?.key).toBe("storage_malformed");
    expect(store.detectorOrder()).toEqual(["ai", "google"]);
    expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
    expect(mem.getSetCalls()).toBe(0);
  }
});

test("detection settings: reports a read failure and keeps detection off", async () => {
  const mem = createMemoryStorage();
  mem.setGetError(new Error("ERR_NSH_IO"));
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()?.key).toBe("storage_read_failed");
  expect(store.enabledDetectors()).toEqual([]);
});

test("detection settings: rejects a blank model ID without writing", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const blank = await store.saveAiModel("   ");
  expect(blank.ok).toBe(false);
  if (!blank.ok) expect(blank.key).toBe("model_id_blank");
  expect(mem.getSetCalls()).toBe(0);
  expect(store.savedAiBinding()).toBeNull();
});

test("detection settings: keeps the last saved snapshot when a write fails", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();
  await store.saveAiModel("m-1");
  const savedOrder = store.detectorOrder();

  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"));
  const failed = await store.moveDetectorTo("ai", 1);

  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.key).toBe("storage_write_failed");
  expect(store.detectorOrder()).toEqual(savedOrder);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });

  mem.setSetError(null);
  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.detectorOrder()).toEqual(savedOrder);
  expect(reopened.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
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

  const first = store.saveAiModel("m-1");
  const second = store.setPreference("nativeLanguage", "zh");
  releaseFirstWrite();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.ok).toBe(true);
  expect(secondResult.ok).toBe(true);
  expect(mem.getSetCalls()).toBe(2);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
  expect(store.snapshot()).toEqual({
    detectors: [{ kind: "ai", modelId: "m-1" }],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
});

test("detection settings: loads a disabled saved model and one unset preference", async () => {
  const mem = createMemoryStorage({
    [LANGUAGE_DETECTION_STORAGE_KEY]: detectionRecord({
      order: ["google", "ai"],
      enabled: { ai: false, google: false },
      modelId: "m-1",
      nativeLanguage: "zh",
    }),
  });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()).toBeNull();
  expect(store.detectorOrder()).toEqual(["google", "ai"]);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
  expect(store.enabledDetectors()).toEqual([]);
  expect(store.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
});
