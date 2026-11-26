import { beforeEach, expect, test } from "nsh/test";
import type { LanguageId } from "../../framework/languages";
import {
  createContributionRegistry,
  credentialStorageKey,
  setContributionRegistry,
} from "../../framework/contributions";
import { registerDetectContributions } from "../../contributions/detect";
import {
  createLanguageDetectionPreferencesStore,
  LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY,
  type LanguageDetectionPreferences,
} from "./preferences";
import {
  createDetectChannels,
  DETECT_COLLECTION_STORAGE_KEY,
  DETECT_CREDENTIAL_NAMESPACE,
} from "./store";

const PREFERENCES: LanguageDetectionPreferences = {
  nativeLanguage: "zh",
  preferredTranslationLanguage: "en",
};

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  const removed: string[] = [];
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let failRemoveError: Error | null = null;
  let setCalls = 0;

  const storage = {
    getItem: async (key: string) => {
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key: string, value: string) => {
      setCalls += 1;
      if (failSetError) throw failSetError;
      backing[key] = value;
    },
    removeItem: async (key: string) => {
      if (failRemoveError) throw failRemoveError;
      removed.push(key);
      delete backing[key];
    },
  };

  return {
    backing,
    removed,
    storage,
    setGetError: (error: Error | null) => {
      failGetError = error;
    },
    setSetError: (error: Error | null) => {
      failSetError = error;
    },
    setRemoveError: (error: Error | null) => {
      failRemoveError = error;
    },
    setCalls: () => setCalls,
  };
}

function createStores(initial: Record<string, string> = {}) {
  const mem = createMemoryStorage(initial);
  const channels = createDetectChannels(mem.storage);
  const preferences = createLanguageDetectionPreferencesStore(mem.storage, { channels });
  return { mem, channels, preferences };
}

function storedCollection(
  options: {
    order?: readonly string[];
    channels?: Record<string, unknown>;
  } = {},
): string {
  return JSON.stringify({
    version: 1,
    order: options.order ?? [],
    channels: options.channels ?? {},
  });
}

beforeEach(() => {
  const registry = createContributionRegistry();
  registerDetectContributions(registry);
  setContributionRegistry(registry);
});

test("detection settings: starts with no added detectors and every detector available", async () => {
  const { mem, channels, preferences } = createStores();

  expect(channels.order()).toEqual([]);
  expect(channels.available()).toEqual(["ai", "google", "google-cloud"]);
  expect(channels.skippedCount()).toBe(0);
  expect(channels.loadError()).toBeNull();
  expect(preferences.preferences()).toEqual({
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  expect(preferences.loadError()).toBeNull();
  expect(preferences.saveError()).toBeNull();

  await channels.load();
  await preferences.load();

  expect(channels.loadError()).toBeNull();
  expect(channels.order()).toEqual([]);
  expect(channels.available()).toEqual(["ai", "google", "google-cloud"]);
  expect(preferences.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  expect(mem.setCalls()).toBe(0);
});

test("detection settings: adds google enabled and enables ai and google-cloud on first save", async () => {
  const { mem, channels } = createStores();
  await channels.load();

  expect((await channels.add("google")).ok).toBe(true);
  expect(channels.order()).toEqual(["google"]);
  expect(channels.available()).toEqual(["ai", "google-cloud"]);
  expect(channels.isEnabled("google")).toBe(true);
  expect(channels.binding("google")).toEqual({
    enabled: true,
    configured: true,
    credentialRef: null,
    config: {},
  });

  expect((await channels.add("ai")).ok).toBe(true);
  expect(channels.isEnabled("ai")).toBe(false);
  expect(channels.binding("ai")?.configured).toBe(false);
  expect(await channels.save("ai", { modelId: "m-1" }, { mode: "keep" })).toEqual({
    ok: true,
  });
  expect(channels.isEnabled("ai")).toBe(true);
  expect(channels.binding("ai")?.config).toEqual({ modelId: "m-1" });

  expect((await channels.add("google-cloud")).ok).toBe(true);
  expect(channels.isEnabled("google-cloud")).toBe(false);
  const saved = await channels.save(
    "google-cloud",
    {},
    { mode: "replace", value: { apiKey: "cloud-key" } },
  );
  expect(saved.ok).toBe(true);
  expect(channels.isEnabled("google-cloud")).toBe(true);
  const credentialRef = channels.binding("google-cloud")?.credentialRef ?? null;
  expect(credentialRef).not.toBeNull();

  const collection = JSON.parse(mem.backing[DETECT_COLLECTION_STORAGE_KEY]!);
  expect(collection.version).toBe(1);
  expect(collection.order).toEqual(["google", "ai", "google-cloud"]);
  expect(collection.channels.google).toEqual({
    enabled: true,
    configured: true,
    config: {},
    credentialRef: null,
  });
  expect(collection.channels.ai).toEqual({
    enabled: true,
    configured: true,
    config: { modelId: "m-1" },
    credentialRef: null,
  });
  expect(collection.channels["google-cloud"].credentialRef).toBe(credentialRef);
  expect(mem.backing[DETECT_COLLECTION_STORAGE_KEY]!.includes("cloud-key")).toBe(false);
  expect(mem.backing[credentialStorageKey(DETECT_CREDENTIAL_NAMESPACE, credentialRef!)]).toBe(
    JSON.stringify({ apiKey: "cloud-key" }),
  );
  expect(await channels.readCredential(credentialRef)).toEqual({ apiKey: "cloud-key" });

  const reopened = createDetectChannels(mem.storage);
  await reopened.load();
  expect(reopened.order()).toEqual(["google", "ai", "google-cloud"]);
  expect(reopened.isEnabled("google")).toBe(true);
  expect(reopened.binding("ai")?.config).toEqual({ modelId: "m-1" });
});

test("detection settings: saving a disabled detector keeps it disabled", async () => {
  const { mem, channels } = createStores();
  await channels.load();

  expect((await channels.save("ai", { modelId: "m-1" }, { mode: "keep" })).ok).toBe(true);
  expect(channels.isEnabled("ai")).toBe(true);
  expect((await channels.setEnabled("ai", false)).ok).toBe(true);

  // enableOnFirstSave applies to the first save only; editing keeps the user's switch.
  expect((await channels.save("ai", { modelId: "m-2" }, { mode: "keep" })).ok).toBe(true);
  expect(channels.binding("ai")?.config).toEqual({ modelId: "m-2" });
  expect(channels.isEnabled("ai")).toBe(false);
  expect(JSON.parse(mem.backing[DETECT_COLLECTION_STORAGE_KEY]!).channels.ai.enabled).toBe(false);
});

test("detection settings: refuses to enable an unconfigured detector and toggles a configured one", async () => {
  const { channels, preferences } = createStores();
  await channels.load();
  await preferences.load();

  const missing = await channels.setEnabled("google-cloud", true);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.key).toBe("channel_unconfigured");

  await channels.add("google");
  expect((await channels.setEnabled("google", false)).ok).toBe(true);
  expect(channels.isEnabled("google")).toBe(false);
  expect(preferences.snapshot().detectors).toEqual([]);
  expect((await channels.setEnabled("google", true)).ok).toBe(true);
  expect(preferences.snapshot().detectors.map((detector) => detector.id)).toEqual(["google"]);

  await channels.add("ai");
  const unconfigured = await channels.setEnabled("ai", true);
  expect(unconfigured.ok).toBe(false);
  expect(preferences.snapshot().detectors.map((detector) => detector.id)).toEqual(["google"]);
});

test("detection settings: reorders detectors, clamps targets, and keeps same-slot moves inert", async () => {
  const { mem, channels } = createStores();
  await channels.load();
  await channels.add("google");
  await channels.save("ai", { modelId: "m-1" }, { mode: "keep" });
  await channels.save("google-cloud", {}, { mode: "replace", value: { apiKey: "cloud-key" } });

  expect(channels.order()).toEqual(["google", "ai", "google-cloud"]);
  const writes = mem.setCalls();
  expect((await channels.moveTo("google", 0)).ok).toBe(true);
  expect((await channels.moveTo("ai", 1)).ok).toBe(true);
  expect(mem.setCalls()).toBe(writes);

  expect((await channels.moveTo("google", 2)).ok).toBe(true);
  expect(channels.order()).toEqual(["ai", "google-cloud", "google"]);
  expect((await channels.moveTo("google", -5)).ok).toBe(true);
  expect(channels.order()).toEqual(["google", "ai", "google-cloud"]);
  expect((await channels.moveTo("google", 99)).ok).toBe(true);
  expect(channels.order()).toEqual(["ai", "google-cloud", "google"]);

  const reopened = createDetectChannels(mem.storage);
  await reopened.load();
  expect(reopened.order()).toEqual(["ai", "google-cloud", "google"]);
});

test("detection settings: removing a detector also clears its stored credential", async () => {
  const { mem, channels } = createStores();
  await channels.load();
  await channels.add("google-cloud");
  await channels.save("google-cloud", {}, { mode: "replace", value: { apiKey: "cloud-key" } });
  const credentialRef = channels.binding("google-cloud")?.credentialRef ?? null;
  const credentialKey = credentialStorageKey(DETECT_CREDENTIAL_NAMESPACE, credentialRef!);
  expect(mem.backing[credentialKey]).toBeDefined();

  expect((await channels.remove("google-cloud")).ok).toBe(true);
  expect(channels.order()).toEqual([]);
  expect(channels.available()).toEqual(["ai", "google", "google-cloud"]);
  expect(channels.binding("google-cloud")).toBeNull();
  expect(channels.isEnabled("google-cloud")).toBe(false);
  expect(mem.removed).toContain(credentialKey);
  expect(mem.backing[credentialKey]).toBeUndefined();
  expect(await channels.readCredential(credentialRef)).toBeNull();

  const reopened = createDetectChannels(mem.storage);
  await reopened.load();
  expect(reopened.order()).toEqual([]);
});

test("detection settings: reports malformed and unsupported stored collections without writing", async () => {
  for (const [raw, key] of [
    ["{ not json", "storage_malformed"],
    [JSON.stringify({ version: 2, order: [], channels: {} }), "storage_unsupported_version"],
    [
      JSON.stringify({ version: 1, order: ["google"], channels: { google: { enabled: true } } }),
      "storage_malformed",
    ],
  ]) {
    const { mem, channels } = createStores({ [DETECT_COLLECTION_STORAGE_KEY]: raw });
    await channels.load();

    expect(channels.loadError()?.key).toBe(key);
    expect(channels.loadError()?.message).toBeTruthy();
    expect(channels.order()).toEqual([]);
    expect(mem.backing[DETECT_COLLECTION_STORAGE_KEY]).toBe(raw);
    expect(mem.setCalls()).toBe(0);
  }
});

test("detection settings: rejects malformed configs and unsupported channel actions", async () => {
  const { mem, channels } = createStores();
  await channels.load();

  const invalid = await channels.save("ai", { modelId: 42 }, { mode: "keep" });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.key).toBe("invalid_config");

  const notConfigurable = await channels.save("google", {}, { mode: "keep" });
  expect(notConfigurable.ok).toBe(false);
  if (!notConfigurable.ok) expect(notConfigurable.key).toBe("channel_not_configurable");

  const unknown = await channels.save("unknown", {}, { mode: "keep" });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.key).toBe("unknown_channel");

  expect(mem.backing[DETECT_COLLECTION_STORAGE_KEY]).toBeUndefined();
});

test("detection settings: counts a stored channel that this build no longer registers", async () => {
  const raw = storedCollection({
    order: ["google", "legacy"],
    channels: {
      google: { enabled: true, configured: true, config: {}, credentialRef: null },
      legacy: { enabled: true, configured: true, config: {}, credentialRef: null },
    },
  });
  const { mem, channels } = createStores({ [DETECT_COLLECTION_STORAGE_KEY]: raw });
  await channels.load();

  expect(channels.loadError()).toBeNull();
  expect(channels.skippedCount()).toBe(1);
  expect(channels.order()).toEqual(["google"]);
  expect(channels.binding("legacy")).toBeNull();
  expect(channels.available()).toEqual(["ai", "google-cloud"]);
  expect(mem.backing[DETECT_COLLECTION_STORAGE_KEY]).toBe(raw);
  expect(mem.setCalls()).toBe(0);
});

test("detection settings: loads preferences independently and snapshots enabled detectors with them", async () => {
  const { mem, channels, preferences } = createStores();
  await preferences.load();

  expect((await preferences.setPreference("nativeLanguage", "zh")).ok).toBe(true);
  expect((await preferences.setPreference("preferredTranslationLanguage", "en")).ok).toBe(true);
  expect(preferences.preferences()).toEqual(PREFERENCES);
  expect(JSON.parse(mem.backing[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]!)).toEqual({
    version: 1,
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });
  expect(preferences.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });

  await channels.load();
  await channels.add("google");
  const snapshot = preferences.snapshot();
  expect(snapshot.detectors.map((detector) => detector.id)).toEqual(["google"]);
  expect(snapshot.detectors[0]!.binding.enabled).toBe(true);
  expect(snapshot).toMatchObject({
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });

  const reopened = createLanguageDetectionPreferencesStore(mem.storage, { channels });
  await reopened.load();
  expect(reopened.preferences()).toEqual(PREFERENCES);
  expect(reopened.loadError()).toBeNull();
});

test("detection settings: rejects invalid and identical preferences without writing", async () => {
  const { mem, preferences } = createStores();
  await preferences.load();

  const automatic = await preferences.setPreference(
    "nativeLanguage",
    "auto" as unknown as LanguageId,
  );
  expect(automatic.ok).toBe(false);
  if (!automatic.ok) expect(automatic.key).toBe("preference_invalid");
  expect(mem.setCalls()).toBe(0);

  expect((await preferences.setPreference("nativeLanguage", "zh")).ok).toBe(true);
  expect(preferences.saveError()).toBeNull();

  const identical = await preferences.setPreference("preferredTranslationLanguage", "zh");
  expect(identical.ok).toBe(false);
  if (!identical.ok) expect(identical.key).toBe("preferences_identical");
  expect(preferences.saveError()).toBeTruthy();
  expect(mem.setCalls()).toBe(1);
  expect(preferences.preferences()).toEqual({
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });

  expect((await preferences.setPreference("preferredTranslationLanguage", "en")).ok).toBe(true);
  expect(preferences.saveError()).toBeNull();
  expect((await preferences.setPreference("nativeLanguage", null)).ok).toBe(true);
  expect(preferences.preferences()).toEqual({
    nativeLanguage: null,
    preferredTranslationLanguage: "en",
  });
});

test("detection settings: keeps the saved preferences when a write fails", async () => {
  const { mem, preferences } = createStores();
  await preferences.load();
  expect((await preferences.setPreference("nativeLanguage", "zh")).ok).toBe(true);

  mem.setSetError(new Error("ERR_NSH_QUOTA_EXCEEDED"));
  const failed = await preferences.setPreference("preferredTranslationLanguage", "en");
  mem.setSetError(null);

  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.key).toBe("storage_write_failed");
  expect(preferences.saveError()).toBeTruthy();
  expect(preferences.preferences()).toEqual({
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
  expect(JSON.parse(mem.backing[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]!)).toEqual({
    version: 1,
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });

  const reopened = createLanguageDetectionPreferencesStore(mem.storage, {
    channels: createDetectChannels(mem.storage),
  });
  await reopened.load();
  expect(reopened.preferences()).toEqual({
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
  });
});

test("detection settings: reports malformed and unsupported preference records without writing", async () => {
  const records: [string, string][] = [
    ["{ not json", "storage_malformed"],
    [
      JSON.stringify({ version: 2, nativeLanguage: null, preferredTranslationLanguage: null }),
      "storage_unsupported_version",
    ],
    [
      JSON.stringify({ version: 1, nativeLanguage: "auto", preferredTranslationLanguage: null }),
      "storage_malformed",
    ],
    [
      JSON.stringify({ version: 1, nativeLanguage: "zh", preferredTranslationLanguage: "zh" }),
      "storage_malformed",
    ],
  ];
  for (const [raw, key] of records) {
    const { mem, preferences } = createStores({
      [LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]: raw,
    });
    await preferences.load();

    expect(preferences.loadError()?.key).toBe(key);
    expect(preferences.loadError()?.message).toBeTruthy();
    expect(preferences.preferences()).toEqual({
      nativeLanguage: null,
      preferredTranslationLanguage: null,
    });
    expect(mem.backing[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]).toBe(raw);
    expect(mem.setCalls()).toBe(0);
  }
});

test("detection settings: reports a collection read failure and keeps detection off", async () => {
  const { mem, channels, preferences } = createStores();
  mem.setGetError(new Error("ERR_NSH_IO"));
  await channels.load();
  await preferences.load();

  expect(channels.loadError()?.key).toBe("storage_read_failed");
  expect(channels.order()).toEqual([]);
  expect(preferences.loadError()?.key).toBe("storage_read_failed");
  expect(preferences.snapshot()).toEqual({
    detectors: [],
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
});
test("pre-acceptance: a failed preferences load blocks changes", async () => {
  const malformed = JSON.stringify({
    version: 1,
    nativeLanguage: "xx",
    preferredTranslationLanguage: null,
  });
  const { mem, preferences } = createStores({
    [LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]: malformed,
  });
  await preferences.load();

  const loadError = preferences.loadError();
  expect(loadError).toMatchObject({ key: "storage_malformed" });
  const before = mem.backing[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY];
  expect(before).toBe(malformed);

  const blocked = await preferences.setPreference("nativeLanguage", "zh");
  expect(blocked).toMatchObject({
    ok: false,
    key: "storage_malformed",
    message: loadError!.message,
  });
  expect(mem.backing[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]).toBe(before);
  expect(mem.setCalls()).toBe(0);
  expect(preferences.preferences()).toEqual({
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });

  mem.backing[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY] = JSON.stringify({
    version: 1,
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  await preferences.load();
  expect(preferences.loadError()).toBeNull();
  expect(await preferences.setPreference("nativeLanguage", "zh")).toEqual({ ok: true });
  expect(mem.setCalls()).toBe(1);
});
