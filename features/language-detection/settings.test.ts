import { expect, test } from "nsh/test";
import {
  createLanguageDetectionSettingsStore,
  googleCloudDetectionCredentialStorageKey,
  LANGUAGE_DETECTION_STORAGE_KEY,
  LANGUAGE_GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX,
  type LanguageDetectionPreferences,
  type LanguageDetectionSettingsStorage,
  type LanguageDetectorKind,
} from "./settings";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  const removed: string[] = [];
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let failRemoveError: Error | null = null;
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
    removeItem: async (key) => {
      if (failRemoveError) throw failRemoveError;
      removed.push(key);
      delete backing[key];
    },
  };

  return {
    backing,
    removed,
    storage,
    setGetError: (err: Error | null) => {
      failGetError = err;
    },
    setSetError: (err: Error | null) => {
      failSetError = err;
    },
    setRemoveError: (err: Error | null) => {
      failRemoveError = err;
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
    credentialRef?: string | null;
    nativeLanguage?: string | null;
    preferredTranslationLanguage?: string | null;
  } = {},
): string {
  const ai =
    options.modelId === undefined || options.modelId === null ? null : { modelId: options.modelId };
  const googleCloud =
    options.credentialRef === undefined || options.credentialRef === null
      ? null
      : { credentialRef: options.credentialRef };
  return JSON.stringify({
    version: 4,
    order: options.order ?? ["ai", "google", "google-cloud"],
    enabled: {
      ai: options.enabled?.ai ?? ai !== null,
      google: options.enabled?.google ?? false,
      "google-cloud": options.enabled?.["google-cloud"] ?? googleCloud !== null,
    },
    ai,
    googleCloud,
    nativeLanguage: options.nativeLanguage ?? null,
    preferredTranslationLanguage: options.preferredTranslationLanguage ?? null,
  });
}

const PREFERENCES: LanguageDetectionPreferences = {
  nativeLanguage: "zh",
  preferredTranslationLanguage: "en",
};

test("detection settings: starts with no added detectors and every kind available", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);

  expect(store.detectorOrder()).toEqual([]);
  expect(store.availableDetectors()).toEqual(["ai", "google", "google-cloud"]);
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.isEnabled("google")).toBe(false);
  expect(store.isEnabled("google-cloud")).toBe(false);
  expect(store.savedAiBinding()).toBeNull();
  expect(store.savedGoogleCloudBinding()).toBeNull();
  expect(store.enabledDetectors()).toEqual([]);
  expect(store.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  expect(store.loadError()).toBeNull();

  await store.load();
  expect(store.loadError()).toBeNull();
  expect(store.detectorOrder()).toEqual([]);
  expect(store.availableDetectors()).toEqual(["ai", "google", "google-cloud"]);
  expect(store.enabledDetectors()).toEqual([]);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: adding detectors appends them and enables the free Google endpoint immediately", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect((await store.addDetector("google")).ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google"]);
  expect(store.availableDetectors()).toEqual(["ai", "google-cloud"]);
  expect(store.isEnabled("google")).toBe(true);
  expect(store.enabledDetectors()).toEqual([{ kind: "google" }]);

  expect((await store.addDetector("ai")).ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google", "ai"]);
  expect(store.availableDetectors()).toEqual(["google-cloud"]);
  expect(store.isEnabled("ai")).toBe(false);

  // Re-adding an already added detector is a no-op without writing again.
  const writes = mem.getSetCalls();
  expect((await store.addDetector("google")).ok).toBe(true);
  expect(mem.getSetCalls()).toBe(writes);

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.detectorOrder()).toEqual(["google", "ai"]);
  expect(reopened.availableDetectors()).toEqual(["google-cloud"]);
  expect(reopened.isEnabled("google")).toBe(true);
  expect(reopened.isEnabled("ai")).toBe(false);
});

test("detection settings: removing a detector drops its binding and deletes any Google Cloud key", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  await store.addDetector("google");
  await store.saveAiModel("m-1");
  const cloud = await store.saveGoogleCloudKey("cloud-secret");
  expect(cloud.ok).toBe(true);
  if (!cloud.ok) return;

  expect(store.detectorOrder()).toEqual(["google", "ai", "google-cloud"]);
  expect(store.availableDetectors()).toEqual([]);

  const removedCloud = await store.removeDetector("google-cloud");
  expect(removedCloud.ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google", "ai"]);
  expect(store.availableDetectors()).toEqual(["google-cloud"]);
  expect(store.savedGoogleCloudBinding()).toBeNull();
  expect(store.isEnabled("google-cloud")).toBe(false);
  expect(mem.removed).toContain(
    googleCloudDetectionCredentialStorageKey(cloud.binding.credentialRef),
  );
  expect(await store.readGoogleCloudCredential(cloud.binding.credentialRef)).toBeNull();

  const removedAi = await store.removeDetector("ai");
  expect(removedAi.ok).toBe(true);
  expect(store.savedAiBinding()).toBeNull();
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.detectorOrder()).toEqual(["google"]);
  expect(store.availableDetectors()).toEqual(["ai", "google-cloud"]);

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.detectorOrder()).toEqual(["google"]);
  expect(reopened.savedAiBinding()).toBeNull();
  expect(reopened.savedGoogleCloudBinding()).toBeNull();
});

test("detection settings: saving the AI model adds and enables the detector and persists the v4 record", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const result = await store.saveAiModel("m-1");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.binding).toEqual({ kind: "ai", modelId: "m-1" });

  expect(store.detectorOrder()).toEqual(["ai"]);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
  expect(store.isEnabled("ai")).toBe(true);
  expect(store.isEnabled("google")).toBe(false);
  expect(store.enabledDetectors()).toEqual([{ kind: "ai", modelId: "m-1" }]);

  expect(JSON.parse(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!)).toEqual({
    version: 4,
    order: ["ai"],
    enabled: { ai: true, google: false, "google-cloud": false },
    ai: { modelId: "m-1" },
    googleCloud: null,
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.loadError()).toBeNull();
  expect(reopened.detectorOrder()).toEqual(["ai"]);
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

test("detection settings: the free Google endpoint enables after being added and unconfigured detectors refuse to enable", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const googleBeforeAdd = await store.setEnabled("google", true);
  expect(googleBeforeAdd.ok).toBe(false);
  if (!googleBeforeAdd.ok) expect(googleBeforeAdd.key).toBe("detector_unconfigured");

  const google = await store.addDetector("google");
  expect(google.ok).toBe(true);
  expect(store.isEnabled("google")).toBe(true);
  expect(store.enabledDetectors()).toEqual([{ kind: "google" }]);
  expect((await store.setEnabled("google", false)).ok).toBe(true);
  expect(store.isEnabled("google")).toBe(false);
  expect((await store.setEnabled("google", true)).ok).toBe(true);
  expect(store.isEnabled("google")).toBe(true);

  await store.addDetector("ai");
  const ai = await store.setEnabled("ai", true);
  expect(ai.ok).toBe(false);
  if (!ai.ok) expect(ai.key).toBe("detector_unconfigured");
  expect(store.isEnabled("ai")).toBe(false);

  await store.addDetector("google-cloud");
  const cloud = await store.setEnabled("google-cloud", true);
  expect(cloud.ok).toBe(false);
  if (!cloud.ok) expect(cloud.key).toBe("detector_unconfigured");
  expect(store.isEnabled("google-cloud")).toBe(false);

  await store.saveAiModel("m-1");
  expect(store.isEnabled("ai")).toBe(true);
  expect(store.enabledDetectors()).toEqual([{ kind: "google" }, { kind: "ai", modelId: "m-1" }]);
});

test("detection settings: saves a Google Cloud key apart from the record and replaces the old key", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const saved = await store.saveGoogleCloudKey("first-key");
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  const firstRef = saved.binding.credentialRef;

  expect(store.savedGoogleCloudBinding()).toEqual({
    kind: "google-cloud",
    credentialRef: firstRef,
  });
  expect(store.isEnabled("google-cloud")).toBe(true);
  expect(store.enabledDetectors()).toEqual([{ kind: "google-cloud", credentialRef: firstRef }]);
  expect(mem.backing[googleCloudDetectionCredentialStorageKey(firstRef)]).toBe("first-key");
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]!.includes("first-key")).toBe(false);
  expect(await store.readGoogleCloudCredential(firstRef)).toBe("first-key");

  const disabled = await store.setEnabled("google-cloud", false);
  expect(disabled.ok).toBe(true);

  const replaced = await store.saveGoogleCloudKey("second-key");
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) return;
  expect(replaced.binding.credentialRef).not.toBe(firstRef);
  expect(mem.removed).toContain(googleCloudDetectionCredentialStorageKey(firstRef));
  expect(await store.readGoogleCloudCredential(firstRef)).toBeNull();
  expect(await store.readGoogleCloudCredential(replaced.binding.credentialRef)).toBe("second-key");
  expect(store.isEnabled("google-cloud")).toBe(false);

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.loadError()).toBeNull();
  expect(reopened.savedGoogleCloudBinding()).toEqual({
    kind: "google-cloud",
    credentialRef: replaced.binding.credentialRef,
  });
  expect(await reopened.readGoogleCloudCredential(replaced.binding.credentialRef)).toBe(
    "second-key",
  );
});

test("detection settings: reuses a readable Google Cloud key and rejects a blank one", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const blank = await store.saveGoogleCloudKey("   ");
  expect(blank.ok).toBe(false);
  if (!blank.ok) expect(blank.key).toBe("google_cloud_key_required");
  expect(mem.getSetCalls()).toBe(0);

  const nothingSaved = await store.saveGoogleCloudKey(null);
  expect(nothingSaved.ok).toBe(false);
  if (!nothingSaved.ok) expect(nothingSaved.key).toBe("google_cloud_key_required");

  const saved = await store.saveGoogleCloudKey("cloud-key");
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;

  const kept = await store.saveGoogleCloudKey(null);
  expect(kept.ok).toBe(true);
  if (!kept.ok) return;
  expect(kept.binding.credentialRef).toBe(saved.binding.credentialRef);
  expect(await store.readGoogleCloudCredential(saved.binding.credentialRef)).toBe("cloud-key");
  expect(mem.removed).toEqual([]);
});

test("detection settings: a failed old-key cleanup does not undo the new key", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  const first = await store.saveGoogleCloudKey("first-key");
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  mem.setRemoveError(new Error("ERR_NSH_IO"));
  const replaced = await store.saveGoogleCloudKey("second-key");
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) return;
  expect(store.savedGoogleCloudBinding()).toEqual({
    kind: "google-cloud",
    credentialRef: replaced.binding.credentialRef,
  });
  expect(await store.readGoogleCloudCredential(replaced.binding.credentialRef)).toBe("second-key");
});

test("detection settings: reorders detectors, clamps targets, and keeps same-slot moves inert", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();
  await store.saveAiModel("m-1");
  await store.addDetector("google");
  await store.addDetector("google-cloud");

  const moved = await store.moveDetectorTo("google", 0);
  expect(moved.ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google", "ai", "google-cloud"]);
  expect(store.enabledDetectors()).toEqual([{ kind: "google" }, { kind: "ai", modelId: "m-1" }]);

  const writes = mem.getSetCalls();
  expect((await store.moveDetectorTo("google", 0)).ok).toBe(true);
  expect((await store.moveDetectorTo("ai", 1)).ok).toBe(true);
  expect(mem.getSetCalls()).toBe(writes);

  expect((await store.moveDetectorTo("google", 99)).ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["ai", "google-cloud", "google"]);
  expect((await store.moveDetectorTo("google", -5)).ok).toBe(true);
  expect(store.detectorOrder()).toEqual(["google", "ai", "google-cloud"]);

  const reopened = createLanguageDetectionSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.detectorOrder()).toEqual(["google", "ai", "google-cloud"]);
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
  expect(store.detectorOrder()).toEqual([]);
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: keeps an unsupported version untouched and reports a load error", async () => {
  const raw = detectionRecord({ modelId: "m-1" }).replace('"version":4', '"version":3');
  const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()?.key).toBe("storage_unsupported_version");
  expect(store.enabledDetectors()).toEqual([]);
  expect(mem.backing[LANGUAGE_DETECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("detection settings: rejects an enabled detector without its saved configuration or list entry", async () => {
  const records = [
    detectionRecord({ enabled: { ai: true }, modelId: null }),
    detectionRecord({ enabled: { "google-cloud": true }, credentialRef: null }),
    detectionRecord({ order: [], enabled: { google: true } }),
    detectionRecord({ order: ["google"], modelId: "m-1", enabled: { ai: false } }),
    detectionRecord({
      order: ["google"],
      credentialRef: "ref-1",
      enabled: { "google-cloud": false },
    }),
  ];

  for (const raw of records) {
    const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
    const store = createLanguageDetectionSettingsStore(mem.storage);
    await store.load();

    expect(store.loadError()?.key).toBe("storage_malformed");
    expect(store.enabledDetectors()).toEqual([]);
    expect(store.savedAiBinding()).toBeNull();
    expect(store.savedGoogleCloudBinding()).toBeNull();
    expect(mem.getSetCalls()).toBe(0);
  }
});

test("detection settings: rejects a malformed order, enabled map, or detector binding", async () => {
  const records = [
    JSON.stringify({ version: 4, order: ["ai"], enabled: {}, ai: null, googleCloud: null }),
    JSON.stringify({
      version: 4,
      order: ["ai", "ai"],
      enabled: { ai: false, google: false, "google-cloud": false },
      ai: null,
      googleCloud: null,
    }),
    JSON.stringify({
      version: 4,
      order: ["ai", "google", "google-cloud"],
      enabled: { ai: false, google: "no", "google-cloud": false },
      ai: null,
      googleCloud: null,
    }),
    JSON.stringify({
      version: 4,
      order: ["ai", "google", "google-cloud"],
      enabled: { ai: false, google: false, "google-cloud": false },
      ai: { modelId: 42 },
      googleCloud: null,
    }),
    JSON.stringify({
      version: 4,
      order: ["ai", "google", "google-cloud"],
      enabled: { ai: false, google: false, "google-cloud": false },
      ai: null,
      googleCloud: { credentialRef: "   " },
    }),
  ];

  for (const raw of records) {
    const mem = createMemoryStorage({ [LANGUAGE_DETECTION_STORAGE_KEY]: raw });
    const store = createLanguageDetectionSettingsStore(mem.storage);
    await store.load();
    expect(store.loadError()?.key).toBe("storage_malformed");
    expect(store.detectorOrder()).toEqual([]);
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
  await store.addDetector("google");
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

test("detection settings: a failed record write removes the key it just stored", async () => {
  const mem = createMemoryStorage();
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();
  const saved = await store.saveGoogleCloudKey("first-key");
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;

  let writes = 0;
  mem.setWriteHook(async () => {
    writes += 1;
    if (writes === 2) throw new Error("ERR_NSH_QUOTA_EXCEEDED");
  });
  const failed = await store.saveGoogleCloudKey("second-key");
  mem.setWriteHook(null);

  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.key).toBe("storage_write_failed");
  expect(store.savedGoogleCloudBinding()).toEqual(saved.binding);
  const storedKeys = Object.keys(mem.backing).filter((key) =>
    key.startsWith(LANGUAGE_GOOGLE_CLOUD_CREDENTIAL_KEY_PREFIX),
  );
  expect(storedKeys).toEqual([
    googleCloudDetectionCredentialStorageKey(saved.binding.credentialRef),
  ]);
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

test("detection settings: loads a disabled saved configuration and one unset preference", async () => {
  const mem = createMemoryStorage({
    [LANGUAGE_DETECTION_STORAGE_KEY]: detectionRecord({
      order: ["google", "google-cloud", "ai"],
      enabled: { ai: false, google: false, "google-cloud": false },
      modelId: "m-1",
      credentialRef: "ref-1",
      nativeLanguage: "zh",
    }),
    [googleCloudDetectionCredentialStorageKey("ref-1")]: "cloud-key",
  });
  const store = createLanguageDetectionSettingsStore(mem.storage);
  await store.load();

  expect(store.loadError()).toBeNull();
  expect(store.detectorOrder()).toEqual(["google", "google-cloud", "ai"]);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "m-1" });
  expect(store.savedGoogleCloudBinding()).toEqual({
    kind: "google-cloud",
    credentialRef: "ref-1",
  });
  expect(store.enabledDetectors()).toEqual([]);
  expect(store.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
  expect(await store.readGoogleCloudCredential("ref-1")).toBe("cloud-key");
  expect(await store.readGoogleCloudCredential("missing-ref")).toBeNull();
});
