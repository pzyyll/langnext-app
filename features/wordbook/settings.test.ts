import { expect, test } from "nsh/test";
import {
  createWordbookSettingsStore,
  type WordbookAnkiTarget,
  type WordbookSettingsStorage,
} from "./settings";

export const WORDBOOK_ANKI_KEY = "settings.wordbook.anki.v1";

const CREDENTIAL_PREFIX = "settings.wordbook.anki.credentials.";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  const order: string[] = [];
  let failBinding = false;
  let failCredential = false;
  const storage: WordbookSettingsStorage = {
    getItem: async (key) => backing[key] ?? null,
    setItem: async (key, value) => {
      order.push(`set ${key}`);
      if (key === WORDBOOK_ANKI_KEY && failBinding) throw new Error("binding write failed");
      if (key.startsWith(CREDENTIAL_PREFIX) && failCredential) throw new Error("key write failed");
      backing[key] = value;
    },
    removeItem: async (key) => {
      order.push(`remove ${key}`);
      delete backing[key];
    },
  };
  return {
    backing,
    order,
    storage,
    failBindingWrites(next: boolean) {
      failBinding = next;
    },
    failCredentialWrites(next: boolean) {
      failCredential = next;
    },
  };
}

const TARGET: WordbookAnkiTarget = {
  profile: "User 1",
  deckId: "1550000000000",
  deckName: "Vocabulary",
  noteTypeId: "1550000000003",
  noteTypeName: "基础",
  sourceField: "正面",
  translationField: "背面",
};

test("wordbook settings: saves one target and activates it only while enabled", async () => {
  const mem = createMemoryStorage();
  const store = createWordbookSettingsStore(mem.storage);
  expect(await store.load()).toEqual({ target: null, enabled: false, error: null });
  expect(store.activeBinding()).toBeNull();

  expect(await store.save(TARGET)).toEqual({ ok: true });
  expect(store.activeBinding()).toBeNull();
  expect(await store.setEnabled(true)).toEqual({ ok: true });

  const enabled = createWordbookSettingsStore(mem.storage);
  await enabled.load();
  expect(enabled.activeBinding()).toEqual(TARGET);

  expect(await enabled.setEnabled(false)).toEqual({ ok: true });
  const disabled = createWordbookSettingsStore(mem.storage);
  expect(await disabled.load()).toEqual({ target: TARGET, enabled: false, error: null });
  expect(disabled.activeBinding()).toBeNull();

  const stored = JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "") as Record<string, unknown>;
  expect(stored.session).toBeUndefined();
  expect(stored.enabled).toBe(false);
  expect(stored.profile).toBe(TARGET.profile);
  expect(stored.deckId).toBe(TARGET.deckId);
  expect(stored.noteTypeId).toBe(TARGET.noteTypeId);
});

test("wordbook settings: a later save keeps the confirmed enable state", async () => {
  const mem = createMemoryStorage();
  const store = createWordbookSettingsStore(mem.storage);
  await store.load();
  await store.save(TARGET);
  await store.setEnabled(true);
  const renamed = { ...TARGET, deckName: "Words" };
  expect(await store.save(renamed)).toEqual({ ok: true });
  const reloaded = createWordbookSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.activeBinding()).toEqual(renamed);
});

test("wordbook settings: a malformed record stays inactive without throwing", async () => {
  const mem = createMemoryStorage({ [WORDBOOK_ANKI_KEY]: "{" });
  const store = createWordbookSettingsStore(mem.storage);
  const loaded = await store.load();
  expect(loaded.target).toBeNull();
  expect(loaded.enabled).toBe(false);
  expect(loaded.error?.key).toBe("storage_malformed");
  expect(store.activeBinding()).toBeNull();
});

test("wordbook settings: keeps, replaces, and removes an optional key without returning it", async () => {
  const mem = createMemoryStorage();
  const store = createWordbookSettingsStore(mem.storage);
  await store.load();
  expect(await store.save(TARGET, { apiKey: "test-key" })).toEqual({ ok: true });
  expect(store.activeBinding()).toBeNull();
  const binding = JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "") as { credentialRef?: string };
  const ref = binding.credentialRef ?? "";
  expect(ref.length).toBeGreaterThan(0);
  expect(mem.backing[WORDBOOK_ANKI_KEY]).not.toContain("test-key");
  expect(mem.backing[CREDENTIAL_PREFIX + ref]).toBe("test-key");

  expect(await store.save(TARGET, { apiKey: "  " })).toEqual({ ok: true });
  expect(JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "").credentialRef).toBe(ref);
  expect(mem.backing[CREDENTIAL_PREFIX + ref]).toBe("test-key");

  mem.order.length = 0;
  expect(await store.save(TARGET, { apiKey: "next-key" })).toEqual({ ok: true });
  const replaced = JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "") as { credentialRef?: string };
  const nextRef = replaced.credentialRef ?? "";
  expect(nextRef).not.toBe(ref);
  expect(mem.order.map((entry) => entry.split(" ")[0])).toEqual(["set", "set", "remove"]);
  expect(mem.order[0]).toBe(`set ${CREDENTIAL_PREFIX}${nextRef}`);
  expect(mem.order[1]).toBe(`set ${WORDBOOK_ANKI_KEY}`);
  expect(mem.order[2]).toBe(`remove ${CREDENTIAL_PREFIX}${ref}`);
  expect(mem.backing[CREDENTIAL_PREFIX + nextRef]).toBe("next-key");
  expect(mem.backing[CREDENTIAL_PREFIX + ref]).toBeUndefined();

  const reloaded = createWordbookSettingsStore(mem.storage);
  const loaded = await reloaded.load();
  expect(JSON.stringify(loaded)).not.toContain("next-key");
  expect(loaded.target?.credentialRef).toBe(nextRef);

  expect(await reloaded.setEnabled(false)).toEqual({ ok: true });
  expect(mem.backing[CREDENTIAL_PREFIX + nextRef]).toBe("next-key");

  expect(await reloaded.save(TARGET, { removeKey: true })).toEqual({ ok: true });
  const removed = JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "") as { credentialRef?: string };
  expect(removed.credentialRef).toBeUndefined();
  expect(mem.backing[CREDENTIAL_PREFIX + nextRef]).toBeUndefined();
});

test("wordbook settings: a failed key or binding write keeps the previous secret", async () => {
  const mem = createMemoryStorage();
  const store = createWordbookSettingsStore(mem.storage);
  await store.load();
  await store.save(TARGET, { apiKey: "test-key" });
  const ref = (JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "") as { credentialRef: string })
    .credentialRef;

  mem.failCredentialWrites(true);
  const keyFailed = await store.save(TARGET, { apiKey: "next-key" });
  expect(keyFailed.ok).toBe(false);
  if (!keyFailed.ok) expect(keyFailed.key).toBe("storage_write_failed");
  expect(mem.backing[CREDENTIAL_PREFIX + ref]).toBe("test-key");
  expect(JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "").credentialRef).toBe(ref);
  expect(Object.keys(mem.backing).filter((key) => key.startsWith(CREDENTIAL_PREFIX))).toEqual([
    CREDENTIAL_PREFIX + ref,
  ]);

  mem.failCredentialWrites(false);
  mem.failBindingWrites(true);
  const bindingFailed = await store.save({ ...TARGET, deckName: "Words" }, { apiKey: "next-key" });
  expect(bindingFailed.ok).toBe(false);
  if (!bindingFailed.ok) expect(bindingFailed.key).toBe("storage_write_failed");
  expect(mem.backing[CREDENTIAL_PREFIX + ref]).toBe("test-key");
  expect(JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "").credentialRef).toBe(ref);
  expect(JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "").deckName).toBe("Vocabulary");
  expect(Object.values(mem.backing)).not.toContain("next-key");
});

test("wordbook settings: an unreadable key leaves the target editable but inactive", async () => {
  const mem = createMemoryStorage();
  const store = createWordbookSettingsStore(mem.storage);
  await store.load();
  await store.save(TARGET, { apiKey: "test-key" });
  await store.setEnabled(true);
  const ref = (JSON.parse(mem.backing[WORDBOOK_ANKI_KEY] ?? "") as { credentialRef: string })
    .credentialRef;
  delete mem.backing[CREDENTIAL_PREFIX + ref];

  const reloaded = createWordbookSettingsStore(mem.storage);
  const loaded = await reloaded.load();
  expect(loaded.target).toEqual({ ...TARGET, credentialRef: ref });
  expect(loaded.error?.key).toBe("credential_unreadable");
  expect(reloaded.activeBinding()).toBeNull();
  const enable = await reloaded.setEnabled(true);
  expect(enable.ok).toBe(false);
  if (!enable.ok) expect(enable.key).toBe("credential_unreadable");
  expect(reloaded.activeBinding()).toBeNull();
});
