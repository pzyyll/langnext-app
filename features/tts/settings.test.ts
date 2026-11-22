import { expect, test } from "nsh/test";
import {
  createTtsSettingsStore,
  TTS_CREDENTIAL_KEY_PREFIX,
  TTS_STORAGE_KEY,
  ttsCredentialStorageKey,
  type TtsSettingsStorage,
} from "./settings";

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
    version: 1,
    order: ["google-cloud", "azure"],
    googleCloud: { enabled: true, credentialRef: saved.binding.credentialRef },
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
    version: 1,
    googleCloud: { enabled: true, credentialRef: saved.credentialRef },
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
    { version: 1 },
    { version: 1, googleCloud: { enabled: "yes", credentialRef: "ref-1" } },
    { version: 1, googleCloud: { enabled: true, credentialRef: "  " } },
    { version: 1, googleCloud: { enabled: true } },
    { version: 1, googleCloud: [] },
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

  const versioned = JSON.stringify({ version: 2, googleCloud: null });
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
      version: 1,
      googleCloud: { enabled: true, credentialRef: "google-ref" },
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
      version: 1,
      googleCloud: { enabled: true, credentialRef: "google-ref" },
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
      version: 1,
      googleCloud: null,
      azure: { enabled: true, credentialRef: "azure-ref", region: "EASTUS" },
    },
    {
      version: 1,
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
