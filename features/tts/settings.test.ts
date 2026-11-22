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

test("tts store: starts off, enables on the first save, and keeps a later key disabled", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);

  expect(store.savedBinding()).toBeNull();
  expect(store.isEnabled()).toBe(false);
  expect(store.loadError()).toBeNull();
  const blocked = await store.setEnabled(true);
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("expected an unconfigured channel");
  expect(blocked.key).toBe("channel_unconfigured");
  expect(blocked.message).toBeTruthy();
  expect(store.isEnabled()).toBe(false);

  await store.load();
  expect(store.loadError()).toBeNull();
  expect(store.savedBinding()).toBeNull();
  expect(store.isEnabled()).toBe(false);

  const blank = await store.saveGoogleCloud({ apiKey: "   " });
  expect(blank.ok).toBe(false);
  if (blank.ok) throw new Error("expected a blank key to be rejected");
  expect(blank.key).toBe("api_key_blank");
  expect(mem.getSetCalls()).toBe(0);

  const saved = await store.saveGoogleCloud({ apiKey: `  ${FIRST_KEY}  ` });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error("expected the first save to succeed");
  expect(saved.binding.enabled).toBe(true);
  expect(store.isEnabled()).toBe(true);
  expect(store.savedBinding()).toEqual(saved.binding);
  expect(JSON.stringify(store.savedBinding())).not.toContain(FIRST_KEY);
  expect(await store.readGoogleCloudKey(saved.binding.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.parse(mem.backing[TTS_STORAGE_KEY]!)).toEqual({
    version: 1,
    googleCloud: { enabled: true, credentialRef: saved.binding.credentialRef },
  });
  expect(JSON.parse(mem.backing[ttsCredentialStorageKey(saved.binding.credentialRef)]!)).toEqual({
    apiKey: FIRST_KEY,
  });

  const reloaded = createTtsSettingsStore(mem.storage);
  const getsBefore = mem.getGets().length;
  await reloaded.load();
  expect(reloaded.loadError()).toBeNull();
  expect(reloaded.isEnabled()).toBe(true);
  expect(reloaded.savedBinding()).toEqual(saved.binding);
  expect(
    mem
      .getGets()
      .slice(getsBefore)
      .some((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toBe(false);
  expect(await reloaded.readGoogleCloudKey(saved.binding.credentialRef)).toBe(FIRST_KEY);

  expect(await reloaded.setEnabled(false)).toEqual({ ok: true });
  expect(reloaded.isEnabled()).toBe(false);
  const replaced = await reloaded.saveGoogleCloud({ apiKey: NEXT_KEY });
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) throw new Error("expected the replacement save to succeed");
  expect(replaced.binding.enabled).toBe(false);
  expect(replaced.binding.credentialRef).not.toBe(saved.binding.credentialRef);
  expect(reloaded.isEnabled()).toBe(false);

  const afterReplace = createTtsSettingsStore(mem.storage);
  await afterReplace.load();
  expect(afterReplace.isEnabled()).toBe(false);
  expect(afterReplace.savedBinding()).toEqual(replaced.binding);
  expect(await afterReplace.readGoogleCloudKey(replaced.binding.credentialRef)).toBe(NEXT_KEY);
  expect(mem.backing[ttsCredentialStorageKey(saved.binding.credentialRef)]).toBeUndefined();
});

async function saveKey(store: ReturnType<typeof createTtsSettingsStore>, apiKey: string) {
  const result = await store.saveGoogleCloud({ apiKey });
  if (!result.ok) throw new Error("expected a saved key");
  return result.binding;
}

test("tts store: a failed credential write keeps the previous key usable", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 1);
  const result = await store.saveGoogleCloud({ apiKey: NEXT_KEY });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(result.message).toBeTruthy();
  expect(store.savedBinding()).toEqual(first);
  expect(store.isEnabled()).toBe(true);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(await store.readGoogleCloudKey(first.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEY);

  const reloaded = createTtsSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.savedBinding()).toEqual(first);
  expect(await reloaded.readGoogleCloudKey(first.credentialRef)).toBe(FIRST_KEY);
});

test("tts store: a failed binding write drops the new key and keeps the old one", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 2);
  const result = await store.saveGoogleCloud({ apiKey: NEXT_KEY });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(store.savedBinding()).toEqual(first);
  expect(mem.backing[TTS_STORAGE_KEY]).toBe(before);
  expect(await store.readGoogleCloudKey(first.credentialRef)).toBe(FIRST_KEY);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEY);

  const reloaded = createTtsSettingsStore(mem.storage);
  await reloaded.load();
  expect(await reloaded.readGoogleCloudKey(first.credentialRef)).toBe(FIRST_KEY);
  expect(reloaded.isEnabled()).toBe(true);
});

test("tts store: a failed credential cleanup still keeps the saved replacement", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = await saveKey(store, FIRST_KEY);
  mem.setRemoveError(new Error("busy"));

  const replaced = await store.saveGoogleCloud({ apiKey: NEXT_KEY });
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) throw new Error("expected the replacement to succeed");
  expect(store.isEnabled()).toBe(true);
  expect(await store.readGoogleCloudKey(replaced.binding.credentialRef)).toBe(NEXT_KEY);
  expect(mem.backing[ttsCredentialStorageKey(first.credentialRef)]).toBeDefined();
});

test("tts store: rejects enabling a missing or unreadable key and still allows disabling", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  delete mem.backing[ttsCredentialStorageKey(saved.credentialRef)];

  expect(await store.setEnabled(false)).toEqual({ ok: true });
  const missing = await store.setEnabled(true);
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("expected a missing key to block enabling");
  expect(missing.key).toBe("credential_unreadable");
  expect(missing.message).toBeTruthy();
  expect(store.isEnabled()).toBe(false);

  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = "not-json";
  const unreadable = await store.setEnabled(true);
  expect(unreadable.ok).toBe(false);
  if (unreadable.ok) throw new Error("expected an unreadable key to block enabling");
  expect(unreadable.key).toBe("credential_unreadable");
  expect(store.isEnabled()).toBe(false);

  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = JSON.stringify({ apiKey: 1 });
  expect((await store.setEnabled(true)).ok).toBe(false);

  mem.backing[TTS_STORAGE_KEY] = JSON.stringify({
    version: 1,
    googleCloud: { enabled: true, credentialRef: saved.credentialRef },
  });
  mem.backing[ttsCredentialStorageKey(saved.credentialRef)] = "{not json";
  const broken = createTtsSettingsStore(mem.storage);
  const getsBeforeLoad = mem.getGets().length;
  await broken.load();
  expect(broken.isEnabled()).toBe(true);
  expect(broken.loadError()).toBeNull();
  expect(
    mem
      .getGets()
      .slice(getsBeforeLoad)
      .filter((key) => key.startsWith(TTS_CREDENTIAL_KEY_PREFIX)),
  ).toEqual([]);
  expect(await broken.setEnabled(false)).toEqual({ ok: true });
  expect(broken.isEnabled()).toBe(false);
  expect(JSON.parse(mem.backing[TTS_STORAGE_KEY]!).googleCloud.enabled).toBe(false);
});

test("tts store: a failed toggle keeps the last confirmed enabled state", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const saved = await saveKey(store, FIRST_KEY);
  const before = mem.backing[TTS_STORAGE_KEY];
  mem.failSetOnCall(mem.getSetCalls() + 1);

  const toggle = await store.setEnabled(false);
  expect(toggle.ok).toBe(false);
  if (toggle.ok) throw new Error("expected the toggle to fail");
  expect(toggle.key).toBe("storage_write_failed");
  expect(store.isEnabled()).toBe(true);
  expect(store.savedBinding()).toEqual(saved);
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
    expect(store.savedBinding()).toBeNull();
    expect(store.isEnabled()).toBe(false);
    expect(store.loadError()?.key).toBe("storage_malformed");
    expect(store.loadError()?.message).toBeTruthy();
    expect(mem.backing[TTS_STORAGE_KEY]).toBe(raw);
    expect(mem.getSetCalls()).toBe(0);
  }

  const versioned = JSON.stringify({ version: 2, googleCloud: null });
  const unsupported = createMemoryStorage({ [TTS_STORAGE_KEY]: versioned });
  const versionStore = createTtsSettingsStore(unsupported.storage);
  await versionStore.load();
  expect(versionStore.isEnabled()).toBe(false);
  expect(versionStore.loadError()?.key).toBe("storage_unsupported_version");
  expect(unsupported.backing[TTS_STORAGE_KEY]).toBe(versioned);

  const failing = createMemoryStorage();
  failing.setGetError(new Error("unavailable"));
  const failedStore = createTtsSettingsStore(failing.storage);
  await failedStore.load();
  expect(failedStore.savedBinding()).toBeNull();
  expect(failedStore.isEnabled()).toBe(false);
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
  expect(store.isEnabled()).toBe(true);
  expect(store.savedBinding()).toEqual(saved);
});

test("tts store: serializes overlapping saves and keeps only the last key", async () => {
  const mem = createMemoryStorage();
  const store = createTtsSettingsStore(mem.storage);
  const first = store.saveGoogleCloud({ apiKey: FIRST_KEY });
  const second = store.saveGoogleCloud({ apiKey: NEXT_KEY });
  const savedFirst = await first;
  const savedSecond = await second;
  expect(savedFirst.ok).toBe(true);
  expect(savedSecond.ok).toBe(true);
  if (!savedSecond.ok) throw new Error("expected the second save to succeed");
  expect(store.isEnabled()).toBe(true);
  expect(store.savedBinding()).toEqual(savedSecond.binding);
  expect(await store.readGoogleCloudKey(savedSecond.binding.credentialRef)).toBe(NEXT_KEY);
  const credentialKeys = Object.keys(mem.backing).filter((key) =>
    key.startsWith(TTS_CREDENTIAL_KEY_PREFIX),
  );
  expect(credentialKeys).toEqual([ttsCredentialStorageKey(savedSecond.binding.credentialRef)]);
});
