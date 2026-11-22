import { expect, test } from "nsh/test";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  type GoogleVoicePreferences,
} from "./google-preferences";
import {
  createTtsSettingsStore,
  TTS_CREDENTIAL_KEY_PREFIX,
  TTS_LEGACY_STORAGE_KEY,
  TTS_STORAGE_KEY,
  ttsCredentialStorageKey,
  type TtsChannelBinding,
  type TtsSettingsStorage,
} from "./settings";

const GOOGLE_PREFERENCES = DEFAULT_GOOGLE_VOICE_PREFERENCES;

function googlePrefsOf(binding: TtsChannelBinding | null): GoogleVoicePreferences | null {
  return binding?.channel === "google-cloud" ? binding.preferences : null;
}

function savedGooglePreferences(
  store: ReturnType<typeof createTtsSettingsStore>,
): GoogleVoicePreferences | null {
  return googlePrefsOf(store.savedBinding("google-cloud"));
}

/** One saved v2 Google binding with normalized voice preferences. */
function googleStored(options: {
  enabled: boolean;
  credentialRef: string;
  preferences?: unknown;
}): Record<string, unknown> {
  return {
    enabled: options.enabled,
    credentialRef: options.credentialRef,
    preferences: options.preferences ?? GOOGLE_PREFERENCES,
  };
}

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let failGetError: Error | null = null;
  let failRemoveError: Error | null = null;
  let setCalls = 0;
  const failSetOnCalls = new Set<number>();
  const gets: string[] = [];

  const storage: TtsSettingsStorage = {
    getItem: async (key) => {
      gets.push(key);
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key, value) => {
      setCalls += 1;
      if (failSetOnCalls.has(setCalls)) throw new Error("disk full");
      backing[key] = value;
    },
    removeItem: async (key) => {
      if (failRemoveError) throw failRemoveError;
      delete backing[key];
    },
  };

  return {
    backing,
    storage,
    setGetError: (err: Error | null) => {
      failGetError = err;
    },
    failSetOnCall: (call: number) => {
      failSetOnCalls.add(call);
    },
    setRemoveError: (err: Error | null) => {
      failRemoveError = err;
    },
    getSetCalls: () => setCalls,
    getGets: () => gets,
  };
}

const FIRST_KEY = "first-cloud-key";
const NEXT_KEY = "next-cloud-key";

test("tts store: starts off, enables only on an explicit switch, and keeps a later key disabled", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);

  expect(store.savedBinding("google-cloud")).toBeNull();
  expect(store.activeBinding()?.channel === "google-cloud").toBe(false);
  expect(store.loadError()).toBeNull();
  const blocked = await store.setEnabled("google-cloud", true);
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("expected an unconfigured channel");
  expect(blocked.key).toBe("channel_unconfigured");
  expect(blocked.message).toBeTruthy();
  expect(store.activeBinding()?.channel === "google-cloud").toBe(false);

  await store.load();
  expect(store.loadError()).toBeNull();
  expect(store.savedBinding("google-cloud")).toBeNull();
  expect(store.activeBinding()?.channel === "google-cloud").toBe(false);

  const blank = await store.saveChannel({ channel: "google-cloud", apiKey: "   " });
  expect(blank.ok).toBe(false);
  if (blank.ok) throw new Error("expected a blank key to be rejected");
  expect(blank.key).toBe("api_key_blank");
  expect(mem.getSetCalls()).toBe(0);

  const saved = await store.saveChannel({ channel: "google-cloud", apiKey: `  ${FIRST_KEY}  ` });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error("expected the first save to succeed");
  expect(saved.binding.enabled).toBe(false);
  expect(store.activeBinding()).toBeNull();
  expect(store.savedBinding("google-cloud")).toEqual(saved.binding);
  expect(JSON.stringify(store.savedBinding("google-cloud"))).not.toContain(FIRST_KEY);
  expect(await store.readKey(saved.binding.credentialRef)).toBe(FIRST_KEY);
  expect(await store.setEnabled("google-cloud", true)).toEqual({ ok: true });
  expect(store.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(JSON.parse(mem.backing[TTS_STORAGE_KEY]!)).toEqual({
    version: 2,
    order: ["google-cloud", "azure"],
    googleCloud: googleStored({
      enabled: true,
      credentialRef: saved.binding.credentialRef,
    }),
    azure: null,
  });
  expect(JSON.parse(mem.backing[ttsCredentialStorageKey(saved.binding.credentialRef)]!)).toEqual({
    apiKey: FIRST_KEY,
  });

  const reloaded = createTtsSettingsStore(mem.storage);
  const getsBefore = mem.getGets().length;
  await reloaded.load();
  expect(reloaded.loadError()).toBeNull();
  expect(reloaded.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(reloaded.savedBinding("google-cloud")).toEqual({ ...saved.binding, enabled: true });
  expect(
    mem
      .getGets()
      .slice(getsBefore)
      .some((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toBe(false);
  expect(await reloaded.readKey(saved.binding.credentialRef)).toBe(FIRST_KEY);

  expect(await reloaded.setEnabled("google-cloud", false)).toEqual({ ok: true });
  expect(reloaded.activeBinding()?.channel === "google-cloud").toBe(false);
  const replaced = await reloaded.saveChannel({ channel: "google-cloud", apiKey: NEXT_KEY });
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) throw new Error("expected the replacement save to succeed");
  expect(replaced.binding.enabled).toBe(false);
  expect(replaced.binding.credentialRef).not.toBe(saved.binding.credentialRef);
  expect(reloaded.activeBinding()?.channel === "google-cloud").toBe(false);

  const afterReplace = createTtsSettingsStore(mem.storage);
  await afterReplace.load();
  expect(afterReplace.activeBinding()?.channel === "google-cloud").toBe(false);
  expect(afterReplace.savedBinding("google-cloud")).toEqual(replaced.binding);
  expect(await afterReplace.readKey(replaced.binding.credentialRef)).toBe(NEXT_KEY);
  expect(mem.backing[ttsCredentialStorageKey(saved.binding.credentialRef)]).toBeUndefined();
});

async function saveKey(store: ReturnType<typeof createTtsSettingsStore>, apiKey: string) {
  const result = await store.saveChannel({ channel: "google-cloud", apiKey });
  if (!result.ok) throw new Error("expected a saved key");
  const enabled = await store.setEnabled("google-cloud", true);
  if (!enabled.ok) throw new Error("expected the saved key to enable");
  const current = store.savedBinding("google-cloud");
  if (current === null) throw new Error("expected the enabled binding");
  return current;
}

test("tts store: a failed credential write keeps the previous key usable", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 1);
  const result = await store.saveChannel({ channel: "google-cloud", apiKey: NEXT_KEY });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(result.message).toBeTruthy();
  expect(store.savedBinding("google-cloud")).toEqual(first);
  expect(store.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(await store.readKey(first.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEY);

  const reloaded = createTtsSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.savedBinding("google-cloud")).toEqual(first);
  expect(await reloaded.readKey(first.credentialRef)).toBe(FIRST_KEY);
});

test("tts store: a failed binding write drops the new key and keeps the old one", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 2);
  const result = await store.saveChannel({ channel: "google-cloud", apiKey: NEXT_KEY });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(store.savedBinding("google-cloud")).toEqual(first);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(await store.readKey(first.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEY);

  const reloaded = createTtsSettingsStore(mem.storage);
  await reloaded.load();
  expect(await reloaded.readKey(first.credentialRef)).toBe(FIRST_KEY);
  expect(reloaded.activeBinding()?.channel === "google-cloud").toBe(true);
});

test("tts store: a failed credential cleanup still keeps the saved replacement", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await saveKey(store, FIRST_KEY);
  mem.setRemoveError(new Error("busy"));

  const replaced = await store.saveChannel({ channel: "google-cloud", apiKey: NEXT_KEY });
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) throw new Error("expected the replacement to succeed");
  expect(store.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(await store.readKey(replaced.binding.credentialRef)).toBe(NEXT_KEY);
  expect(mem.backing[ttsCredentialStorageKey(first.credentialRef)]).toBeDefined();
});

test("tts store: rejects enabling a missing or unreadable key and still allows disabling", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  delete mem.backing[ttsCredentialStorageKey(saved.credentialRef)];

  expect(await store.setEnabled("google-cloud", false)).toEqual({ ok: true });
  const missing = await store.setEnabled("google-cloud", true);
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("expected a missing key to block enabling");
  expect(missing.key).toBe("credential_unreadable");
  expect(missing.message).toBeTruthy();
  expect(store.activeBinding()?.channel === "google-cloud").toBe(false);

  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = "not-json";
  const unreadable = await store.setEnabled("google-cloud", true);
  expect(unreadable.ok).toBe(false);
  if (unreadable.ok) throw new Error("expected an unreadable key to block enabling");
  expect(unreadable.key).toBe("credential_unreadable");
  expect(store.activeBinding()?.channel === "google-cloud").toBe(false);

  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = JSON.stringify({ apiKey: 1 });
  expect((await store.setEnabled("google-cloud", true)).ok).toBe(false);

  mem.backing[TTS_STORAGE_KEY] = JSON.stringify({
    version: 2,
    googleCloud: googleStored({ enabled: true, credentialRef: saved.credentialRef }),
  });
  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = "{not json";
  const broken = createTtsSettingsStore(mem.storage);
  const getsBeforeLoad = mem.getGets().length;
  await broken.load();
  expect(broken.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(broken.loadError()).toBeNull();
  expect(
    mem
      .getGets()
      .slice(getsBeforeLoad)
      .filter((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([]);
  expect(await broken.setEnabled("google-cloud", false)).toEqual({ ok: true });
  expect(broken.activeBinding()?.channel === "google-cloud").toBe(false);
  expect(JSON.parse(mem.backing[TTS_STORAGE_KEY]!).googleCloud.enabled).toBe(false);
});

test("tts store: a failed toggle keeps the last confirmed enabled state", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];
  mem.failSetOnCall(mem.getSetCalls() + 1);

  const toggle = await store.setEnabled("google-cloud", false);
  expect(toggle.ok).toBe(false);
  if (toggle.ok) throw new Error("expected the toggle to fail");
  expect(toggle.key).toBe("storage_write_failed");
  expect(store.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(store.savedBinding("google-cloud")).toEqual(saved);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(
    Object.keys(mem.backing).filter((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([ttsCredentialStorageKey(saved.credentialRef)]);
});

test("tts store: reports malformed settings and a read failure without enabling the channel", async () => {
  const records: unknown[] = [
    "{ not json",
    { version: 2 },
    { version: 2, googleCloud: { enabled: "yes", credentialRef: "ref-1" } },
    { version: 2, googleCloud: { enabled: true, credentialRef: "  " } },
    { version: 2, googleCloud: { enabled: true } },
    { version: 2, googleCloud: [] },
    {
      version: 2,
      googleCloud: googleStored({
        enabled: true,
        credentialRef: "ref-1",
        preferences: { voiceTier: "standard" },
      }),
    },
    {
      version: 2,
      googleCloud: googleStored({
        enabled: true,
        credentialRef: "ref-1",
        preferences: { ...GOOGLE_PREFERENCES, speakingRate: 3 },
      }),
    },
    {
      version: 2,
      googleCloud: googleStored({
        enabled: true,
        credentialRef: "ref-1",
        preferences: { ...GOOGLE_PREFERENCES, voiceOverrides: { nope: "x" } },
      }),
    },
    { googleCloud: null },
  ];
  for (const record of records) {
    const raw = typeof record === "string" ? record : JSON.stringify(record);
    const mem = createMemoryStorage({ [TTS_STORAGE_KEY]: raw });
    const store = createTtsSettingsStore(mem.storage);
    await store.load();
    expect(store.savedBinding("google-cloud")).toBeNull();
    expect(store.activeBinding()?.channel === "google-cloud").toBe(false);
    expect(store.loadError()?.key).toBe("storage_malformed");
    expect(store.loadError()?.message).toBeTruthy();
    expect(mem.backing[TTS_STORAGE_KEY]).toBe(raw);
    expect(mem.getSetCalls()).toBe(0);
  }

  const versioned = JSON.stringify({ version: 3, googleCloud: null });
  const unsupported = createMemoryStorage({ [TTS_STORAGE_KEY]: versioned });
  const versionStore = createTtsSettingsStore(unsupported.storage);
  await versionStore.load();
  expect(versionStore.activeBinding()?.channel === "google-cloud").toBe(false);
  expect(versionStore.loadError()?.key).toBe("storage_unsupported_version");
  expect(unsupported.backing[TTS_STORAGE_KEY]).toBe(versioned);

  const failing = createMemoryStorage();
  failing.setGetError(new Error("unavailable"));
  const failedStore = createTtsSettingsStore(failing.storage);
  await failedStore.load();
  expect(failedStore.savedBinding("google-cloud")).toBeNull();
  expect(failedStore.activeBinding()?.channel === "google-cloud").toBe(false);
  expect(failedStore.loadError()?.key).toBe("storage_read_failed");
  expect(failedStore.loadError()?.message).toBeTruthy();
});

test("tts store: a valid save replaces invalid stored data", async () => {
  const mem = createMemoryStorage({ [TTS_STORAGE_KEY]: "{not json" });
  const store = createTtsSettingsStore(mem.storage);
  await store.load();
  expect(store.loadError()?.key).toBe("storage_malformed");

  const saved = await saveKey(store, FIRST_KEY);
  expect(store.loadError()).toBeNull();
  expect(store.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(store.savedBinding("google-cloud")).toEqual(saved);
});

test("tts store: serializes overlapping saves and keeps only the last key", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = store.saveChannel({ channel: "google-cloud", apiKey: FIRST_KEY });
  const second = store.saveChannel({ channel: "google-cloud", apiKey: NEXT_KEY });
  const savedFirst = await first;
  const savedSecond = await second;
  expect(savedFirst.ok).toBe(true);
  expect(savedSecond.ok).toBe(true);
  if (!savedSecond.ok) throw new Error("expected the second save to succeed");
  expect(await store.setEnabled("google-cloud", true)).toEqual({ ok: true });
  expect(store.activeBinding()?.channel === "google-cloud").toBe(true);
  expect(store.savedBinding("google-cloud")).toEqual({ ...savedSecond.binding, enabled: true });
  expect(await store.readKey(savedSecond.binding.credentialRef)).toBe(NEXT_KEY);
  const credentialKeys = Object.keys(mem.backing).filter((key) =>
    key.startsWith(TTS_CREDENTIAL_KEY_PREFIX),
  );
  expect(credentialKeys).toEqual([ttsCredentialStorageKey(savedSecond.binding.credentialRef)]);
});

test("tts store: saves Azure beside an active Google channel and follows priority order", async () => {
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 2,
      googleCloud: googleStored({ enabled: true, credentialRef: "google-ref" }),
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
  });
  const store = createTtsSettingsStore(mem.storage);
  const getsBeforeLoad = mem.getGets().length;
  await store.load();
  expect(store.loadError()).toBeNull();
  expect(
    mem
      .getGets()
      .slice(getsBeforeLoad)
      .some((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toBe(false);
  expect(store.channelOrder()).toEqual(["google-cloud", "azure"]);
  expect(store.activeBinding()).toEqual({
    channel: "google-cloud",
    enabled: true,
    credentialRef: "google-ref",
    preferences: GOOGLE_PREFERENCES,
  });
  expect(store.savedBinding("azure")).toBeNull();

  const blank = await store.saveChannel({ channel: "azure", apiKey: "  ", region: "eastus" });
  expect(blank.ok).toBe(false);
  if (blank.ok) throw new Error("expected a blank Azure key to be rejected");
  expect(blank.key).toBe("api_key_blank");
  const invalid = await store.saveChannel({
    channel: "azure",
    apiKey: "azure-key",
    region: "https://eastus.tts.speech.microsoft.com",
  });
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error("expected an invalid region to be rejected");
  expect(invalid.key).toBe("invalid_region");
  expect(invalid.message).toBeTruthy();
  expect(store.savedBinding("azure")).toBeNull();
  expect(JSON.stringify(mem.backing)).not.toContain("azure-key");

  const saved = await store.saveChannel({
    channel: "azure",
    apiKey: "  azure-key  ",
    region: "  EASTUS  ",
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error("expected the Azure save to succeed");
  expect(saved.binding).toEqual({
    channel: "azure",
    enabled: false,
    credentialRef: saved.binding.credentialRef,
    region: "eastus",
  });
  expect(store.activeBinding()?.channel).toBe("google-cloud");
  expect(store.savedBinding("google-cloud")?.enabled).toBe(true);
  expect(await store.readKey("google-ref")).toBe("google-key");
  expect(await store.readKey(saved.binding.credentialRef)).toBe("azure-key");

  expect(await store.setEnabled("azure", true)).toEqual({ ok: true });
  expect(store.isEnabled("azure")).toBe(true);
  expect(store.isEnabled("google-cloud")).toBe(true);
  expect(store.activeBinding()).toEqual({
    channel: "google-cloud",
    enabled: true,
    credentialRef: "google-ref",
    preferences: GOOGLE_PREFERENCES,
  });

  expect(await store.moveChannelTo("azure", 0)).toEqual({ ok: true });
  expect(store.channelOrder()).toEqual(["azure", "google-cloud"]);
  expect(store.activeBinding()).toEqual({
    channel: "azure",
    enabled: true,
    credentialRef: saved.binding.credentialRef,
    region: "eastus",
  });

  const reopened = createTtsSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.channelOrder()).toEqual(["azure", "google-cloud"]);
  expect(reopened.activeBinding()?.channel).toBe("azure");
  expect(JSON.parse(mem.backing[TTS_STORAGE_KEY]!).order).toEqual(["azure", "google-cloud"]);

  expect(await reopened.setEnabled("azure", false)).toEqual({ ok: true });
  expect(reopened.activeBinding()?.channel).toBe("google-cloud");
  expect(await reopened.readKey("google-ref")).toBe("google-key");
  expect(await reopened.readKey(saved.binding.credentialRef)).toBe("azure-key");
});

test("tts store: a first Azure save stays off until it is enabled", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await store.saveChannel({
    channel: "azure",
    apiKey: "azure-key",
    region: "westus2",
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok || saved.binding.channel !== "azure") {
    throw new Error("expected the first Azure save to succeed");
  }
  expect(saved.binding.enabled).toBe(false);
  expect(saved.binding.region).toBe("westus2");
  expect(store.activeBinding()).toBeNull();

  expect(await store.setEnabled("azure", true)).toEqual({ ok: true });
  expect(store.activeBinding()).toEqual({ ...saved.binding, enabled: true });
});

test("tts store: a failed Azure switch or replacement keeps the previous channels", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const google = await store.saveChannel({ channel: "google-cloud", apiKey: "google-key" });
  if (!google.ok) throw new Error("expected Google to save");
  const azure = await store.saveChannel({
    channel: "azure",
    apiKey: "azure-key",
    region: "eastus",
  });
  if (!azure.ok) throw new Error("expected Azure to save");
  const before = mem.backing[TTS_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 1);
  const switched = await store.setEnabled("azure", true);
  expect(switched.ok).toBe(false);
  if (switched.ok) throw new Error("expected the switch to fail");
  expect(switched.key).toBe("storage_write_failed");
  expect(store.activeBinding()).toBeNull();
  expect(store.savedBinding("google-cloud")).toEqual(google.binding);
  expect(store.savedBinding("azure")).toEqual(azure.binding);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);

  delete mem.backing[ttsCredentialStorageKey(azure.binding.credentialRef)];
  const unreadable = await store.setEnabled("azure", true);
  expect(unreadable.ok).toBe(false);
  if (unreadable.ok) throw new Error("expected an unreadable Azure key to block enabling");
  expect(unreadable.key).toBe("credential_unreadable");
  expect(store.activeBinding()).toBeNull();
  mem.backing[ttsCredentialStorageKey(azure.binding.credentialRef)] = JSON.stringify({
    apiKey: "azure-key",
  });

  mem.failSetOnCall(mem.getSetCalls() + 2);
  const replaced = await store.saveChannel({
    channel: "azure",
    apiKey: "next-azure-key",
    region: "westus2",
  });
  expect(replaced.ok).toBe(false);
  if (replaced.ok) throw new Error("expected the Azure replacement to fail");
  expect(store.savedBinding("azure")).toEqual(azure.binding);
  expect(store.activeBinding()).toBeNull();
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(await store.readKey(azure.binding.credentialRef)).toBe("azure-key");
  expect(await store.readKey(google.binding.credentialRef)).toBe("google-key");
  expect(JSON.stringify(mem.backing)).not.toContain("next-azure-key");
  expect(JSON.stringify(mem.backing)).not.toContain("westus2");
});

test("tts store: accepts two enabled channels and rejects an invalid stored Azure region", async () => {
  const both = createMemoryStorage({
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 2,
      googleCloud: googleStored({ enabled: true, credentialRef: "google-ref" }),
      azure: { enabled: true, credentialRef: "azure-ref", region: "eastus" },
    }),
  });
  const bothStore = createTtsSettingsStore(both.storage);
  await bothStore.load();
  expect(bothStore.loadError()).toBeNull();
  expect(bothStore.isEnabled("google-cloud")).toBe(true);
  expect(bothStore.isEnabled("azure")).toBe(true);
  expect(bothStore.activeBinding()?.channel).toBe("google-cloud");

  const records = [
    {
      version: 2,
      googleCloud: null,
      azure: { enabled: true, credentialRef: "azure-ref", region: "EASTUS" },
    },
    {
      version: 2,
      googleCloud: null,
      azure: { enabled: true, credentialRef: "azure-ref", region: "east.us" },
    },
  ];
  for (const record of records) {
    const raw = JSON.stringify(record);
    const mem = createMemoryStorage({ [TTS_STORAGE_KEY]: raw });
    const store = createTtsSettingsStore(mem.storage);
    await store.load();
    expect(store.activeBinding()).toBeNull();
    expect(store.savedBinding("google-cloud")).toBeNull();
    expect(store.savedBinding("azure")).toBeNull();
    expect(store.loadError()?.key).toBe("storage_malformed");
    expect(mem.backing[TTS_STORAGE_KEY]).toBe(raw);
    expect(mem.getSetCalls()).toBe(0);
  }
});

const PREFERENCE_DRAFT = {
  voiceTier: "neural2" as const,
  voiceGender: "female" as const,
  voiceOverrides: { en: "en-GB-Neural2-A" },
  speakingRate: 1.25,
  pitch: 2,
};

function prefDraft(value: Record<string, unknown>): unknown {
  return value as unknown;
}

test("tts store: saves Google voice preferences without replacing the saved key", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  const before = JSON.parse(mem.backing[TTS_STORAGE_KEY]!);

  const updated = await store.saveChannel({
    channel: "google-cloud",
    preferences: PREFERENCE_DRAFT,
  });
  expect(updated.ok).toBe(true);
  if (!updated.ok) throw new Error("expected the preference save to succeed");
  expect(updated.binding).toEqual({
    channel: "google-cloud",
    enabled: true,
    credentialRef: saved.credentialRef,
    preferences: PREFERENCE_DRAFT,
  });
  expect(store.activeBinding()).toEqual(updated.binding);
  expect(await store.readKey(saved.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.parse(mem.backing[TTS_STORAGE_KEY]!)).toEqual({
    ...before,
    googleCloud: {
      enabled: true,
      credentialRef: saved.credentialRef,
      preferences: PREFERENCE_DRAFT,
    },
  });
  expect(mem.backing[TTS_STORAGE_KEY]).not.toContain(FIRST_KEY);
  expect(
    Object.keys(mem.backing).filter((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([ttsCredentialStorageKey(saved.credentialRef)]);

  const reloaded = createTtsSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.savedBinding("google-cloud")).toEqual(updated.binding);
  expect(await reloaded.readKey(saved.credentialRef)).toBe(FIRST_KEY);
});

test("tts store: a first Google save still needs a readable key", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);

  const omitted = await store.saveChannel({
    channel: "google-cloud",
    preferences: PREFERENCE_DRAFT,
  });
  expect(omitted.ok).toBe(false);
  if (omitted.ok) throw new Error("expected the first save to need a key");
  expect(omitted.key).toBe("api_key_required");
  expect(omitted.message).toBeTruthy();

  const blank = await store.saveChannel({ channel: "google-cloud", apiKey: "   " });
  expect(blank.ok).toBe(false);
  if (blank.ok) throw new Error("expected a blank key to be rejected");
  expect(blank.key).toBe("api_key_blank");
  expect(mem.getSetCalls()).toBe(0);
  expect(store.savedBinding("google-cloud")).toBeNull();
});

test("tts store: a preference save with an unreadable key asks for the key again", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = "not-json";

  const result = await store.saveChannel({
    channel: "google-cloud",
    preferences: PREFERENCE_DRAFT,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the unreadable key to block the save");
  expect(result.key).toBe("credential_unreadable");
  expect(savedGooglePreferences(store)).toEqual(GOOGLE_PREFERENCES);
});

test("tts store: a Google key replacement keeps the saved preferences", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await store.saveChannel({
    channel: "google-cloud",
    apiKey: FIRST_KEY,
    preferences: PREFERENCE_DRAFT,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("expected the first save to succeed");

  const replaced = await store.saveChannel({ channel: "google-cloud", apiKey: NEXT_KEY });
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) throw new Error("expected the replacement to succeed");
  expect(googlePrefsOf(replaced.binding)).toEqual(PREFERENCE_DRAFT);
  expect(replaced.binding.credentialRef).not.toBe(first.binding.credentialRef);
  expect(await store.readKey(replaced.binding.credentialRef)).toBe(NEXT_KEY);
  expect(savedGooglePreferences(store)).toEqual(PREFERENCE_DRAFT);
});

test("tts store: rejects invalid Google preference drafts", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);

  const cases = [
    prefDraft({ ...GOOGLE_PREFERENCES, voiceTier: "gemini-tts" }),
    prefDraft({ ...GOOGLE_PREFERENCES, voiceTier: "chirp-hd" }),
    prefDraft({ ...GOOGLE_PREFERENCES, voiceGender: "robot" }),
    prefDraft({ ...GOOGLE_PREFERENCES, voiceOverrides: { nope: "en-US-Standard-C" } }),
    prefDraft({ ...GOOGLE_PREFERENCES, voiceOverrides: { en: "en-US-Removed-A" } }),
    prefDraft({ ...GOOGLE_PREFERENCES, voiceOverrides: { en: "fr-FR-Wavenet-A" } }),
    prefDraft({
      ...GOOGLE_PREFERENCES,
      voiceOverrides: { en: "en-US-Standard-C", hr: "hr-HR-Wavenet-A" },
    }),
    prefDraft({ ...GOOGLE_PREFERENCES, speakingRate: 0.1 }),
    prefDraft({ ...GOOGLE_PREFERENCES, speakingRate: 2.5 }),
    prefDraft({ ...GOOGLE_PREFERENCES, speakingRate: Number.POSITIVE_INFINITY }),
    prefDraft({ ...GOOGLE_PREFERENCES, pitch: 1.5 }),
    prefDraft({ ...GOOGLE_PREFERENCES, pitch: 21 }),
  ];
  const expectedKeys = [
    "invalid_voice_tier",
    "invalid_voice_tier",
    "invalid_voice_gender",
    "invalid_voice_override",
    "invalid_voice_override",
    "invalid_voice_override",
    "invalid_voice_override",
    "invalid_speaking_rate",
    "invalid_speaking_rate",
    "invalid_speaking_rate",
    "invalid_pitch",
    "invalid_pitch",
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const result = await store.saveChannel({
      channel: "google-cloud",
      preferences: cases[index] as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the draft to be rejected");
    expect(result.key).toBe(expectedKeys[index]);
    expect(result.message).toBeTruthy();
  }
  expect(store.savedBinding("google-cloud")).toEqual(saved);
  expect(store.isEnabled("google-cloud")).toBe(true);
});

test("tts store: keeps a saved voice that left the catalog until the user changes it", async () => {
  const unresolved: GoogleVoicePreferences = {
    voiceTier: "chirp-hd",
    voiceGender: "any",
    voiceOverrides: { en: "en-US-Removed-A" },
    speakingRate: 1,
    pitch: 0,
  };
  const mem = createMemoryStorage({
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 2,
      googleCloud: googleStored({
        enabled: true,
        credentialRef: "google-ref",
        preferences: unresolved,
      }),
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
  });
  const store = createTtsSettingsStore(mem.storage);
  await store.load();
  expect(store.loadError()).toBeNull();
  expect(savedGooglePreferences(store)).toEqual(unresolved);

  const retained = await store.saveChannel({
    channel: "google-cloud",
    preferences: unresolved,
  });
  expect(retained.ok).toBe(true);
  if (!retained.ok) throw new Error("expected the retained voice to save");
  expect(googlePrefsOf(retained.binding)).toEqual(unresolved);

  const cleared = await store.saveChannel({
    channel: "google-cloud",
    preferences: { ...unresolved, voiceOverrides: {} },
  });
  expect(cleared.ok).toBe(true);
  if (!cleared.ok) throw new Error("expected the cleared override to save");
  expect(googlePrefsOf(cleared.binding)?.voiceOverrides).toEqual({});
});

test("tts store: a failed preference write keeps the previous preferences and key", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];
  mem.failSetOnCall(mem.getSetCalls() + 1);

  const result = await store.saveChannel({
    channel: "google-cloud",
    preferences: PREFERENCE_DRAFT,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the write to fail");
  expect(result.key).toBe("storage_write_failed");
  expect(store.savedBinding("google-cloud")).toEqual(saved);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(await store.readKey(saved.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.stringify(mem.backing[TTS_STORAGE_KEY])).not.toContain("en-GB-Neural2-A");
});

test("tts store: version 1 records do not load and stay untouched", async () => {
  const legacy = JSON.stringify({
    version: 1,
    googleCloud: { enabled: true, credentialRef: "legacy-ref" },
    azure: { enabled: true, credentialRef: "legacy-azure", region: "eastus" },
  });
  const mem = createMemoryStorage({
    [TTS_LEGACY_STORAGE_KEY]: legacy,
    [ttsCredentialStorageKey("legacy-ref")]: JSON.stringify({ apiKey: "legacy-key" }),
  });
  const store = createTtsSettingsStore(mem.storage);
  const getsBefore = mem.getGets().length;
  await store.load();
  expect(store.loadError()).toBeNull();
  expect(store.savedBinding("google-cloud")).toBeNull();
  expect(store.savedBinding("azure")).toBeNull();
  expect(store.activeBinding()).toBeNull();
  expect(mem.backing[TTS_LEGACY_STORAGE_KEY]).toBe(legacy);
  expect(mem.getSetCalls()).toBe(0);
  expect(
    mem
      .getGets()
      .slice(getsBefore)
      .filter((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([]);
  expect(await store.readKey("legacy-ref")).toBe("legacy-key");
});
