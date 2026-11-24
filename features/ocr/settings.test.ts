import { expect, test } from "nsh/test";
import {
  baiduCredentialStorageKey,
  createOcrSettingsStore,
  googleCloudCredentialStorageKey,
  OCR_STORAGE_KEY,
  type BaiduOcrOperation,
  type OcrServiceBinding,
  type OcrSettingsStorage,
} from "./settings";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let failRemoveError: Error | null = null;
  let setCalls = 0;
  const failSetOnCalls = new Set<number>();
  const gets: string[] = [];

  const storage: OcrSettingsStorage = {
    getItem: async (key) => {
      gets.push(key);
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key, value) => {
      setCalls += 1;
      if (failSetError || failSetOnCalls.has(setCalls)) throw new Error("disk full");
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
    setSetError: (err: Error | null) => {
      failSetError = err;
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

const VISION_BINDING: OcrServiceBinding = { kind: "ai", modelId: "vision-model" };

test("ocr store: starts with no added channels and every kind available", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);

  expect(store.channelOrder()).toEqual([]);
  expect(store.availableChannels()).toEqual(["ai", "baidu", "google-cloud"]);
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.isEnabled("baidu")).toBe(false);
  expect(store.enabledBindings()).toEqual([]);
  expect(store.savedAiBinding()).toBeNull();
  expect(store.savedBaiduBinding()).toBeNull();
  expect(store.loadError()).toBeNull();

  await store.load();
  expect(store.loadError()).toBeNull();
  expect(store.channelOrder()).toEqual([]);
  expect(store.availableChannels()).toEqual(["ai", "baidu", "google-cloud"]);
  expect(store.enabledBindings()).toEqual([]);
  expect(mem.getSetCalls()).toBe(0);
});

test("ocr store: adds channels without enabling them and persists the added order", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.load();

  expect((await store.addChannel("baidu")).ok).toBe(true);
  expect(store.channelOrder()).toEqual(["baidu"]);
  expect(store.availableChannels()).toEqual(["ai", "google-cloud"]);
  expect(store.isEnabled("baidu")).toBe(false);
  expect(store.enabledBindings()).toEqual([]);

  expect((await store.addChannel("ai")).ok).toBe(true);
  expect(store.channelOrder()).toEqual(["baidu", "ai"]);
  expect(store.availableChannels()).toEqual(["google-cloud"]);

  // Re-adding an already added channel is a no-op without writing again.
  const writes = mem.getSetCalls();
  expect((await store.addChannel("baidu")).ok).toBe(true);
  expect(mem.getSetCalls()).toBe(writes);

  expect(JSON.parse(mem.backing[OCR_STORAGE_KEY]!)).toEqual({
    version: 4,
    order: ["baidu", "ai"],
    enabled: { ai: false, baidu: false, "google-cloud": false },
    ai: null,
    baidu: null,
    "google-cloud": null,
  });

  const reopened = createOcrSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.channelOrder()).toEqual(["baidu", "ai"]);
  expect(reopened.availableChannels()).toEqual(["google-cloud"]);
});

test("ocr store: removes a channel with its binding and Baidu credential, and offers it again", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.load();

  await store.addChannel("ai");
  await store.addChannel("baidu");
  const baidu = await saveBaidu(store, FIRST_KEYS);
  await store.save(VISION_BINDING);
  expect(store.channelOrder()).toEqual(["ai", "baidu"]);
  expect(store.availableChannels()).toEqual(["google-cloud"]);

  expect((await store.removeChannel("baidu")).ok).toBe(true);
  expect(store.channelOrder()).toEqual(["ai"]);
  expect(store.availableChannels()).toEqual(["baidu", "google-cloud"]);
  expect(store.savedBaiduBinding()).toBeNull();
  expect(store.isEnabled("baidu")).toBe(false);
  expect(store.enabledBindings()).toEqual([VISION_BINDING]);
  expect(mem.backing[baiduCredentialStorageKey(baidu.credentialRef)]).toBeUndefined();
  expect(await store.readBaiduCredentials(baidu.credentialRef)).toBeNull();

  expect((await store.removeChannel("ai")).ok).toBe(true);
  expect(store.channelOrder()).toEqual([]);
  expect(store.savedAiBinding()).toBeNull();
  expect(store.enabledBindings()).toEqual([]);

  // Removing a channel that is not in the list is a no-op without writing again.
  const writes = mem.getSetCalls();
  expect((await store.removeChannel("ai")).ok).toBe(true);
  expect(mem.getSetCalls()).toBe(writes);

  const reopened = createOcrSettingsStore(mem.storage);
  await reopened.load();
  expect(reopened.channelOrder()).toEqual([]);
  expect(reopened.availableChannels()).toEqual(["ai", "baidu", "google-cloud"]);
});

test("ocr store: saves one AI binding, auto-enables it, and restores it from storage", async () => {
  const mem = createMemoryStorage();
  const store1 = createOcrSettingsStore(mem.storage);

  expect(store1.channelOrder()).toEqual([]);
  expect(store1.isEnabled("ai")).toBe(false);
  expect(store1.isEnabled("baidu")).toBe(false);
  expect(store1.enabledBindings()).toEqual([]);
  expect(store1.savedAiBinding()).toBeNull();
  expect(store1.savedBaiduBinding()).toBeNull();
  expect(store1.loadError()).toBeNull();

  await store1.load();
  expect(store1.loadError()).toBeNull();
  expect(store1.enabledBindings()).toEqual([]);

  const result = await store1.save(VISION_BINDING);
  expect(result.ok).toBe(true);
  expect(store1.channelOrder()).toEqual(["ai"]);
  expect(store1.availableChannels()).toEqual(["baidu", "google-cloud"]);
  expect(store1.isEnabled("ai")).toBe(true);
  expect(store1.isEnabled("baidu")).toBe(false);
  expect(store1.enabledBindings()).toEqual([VISION_BINDING]);
  expect(store1.savedAiBinding()).toEqual(VISION_BINDING);
  expect(store1.savedBaiduBinding()).toBeNull();

  const store2 = createOcrSettingsStore(mem.storage);
  await store2.load();
  expect(store2.loadError()).toBeNull();
  expect(store2.channelOrder()).toEqual(["ai"]);
  expect(store2.isEnabled("ai")).toBe(true);
  expect(store2.enabledBindings()).toEqual([VISION_BINDING]);
  expect(store2.savedAiBinding()).toEqual(VISION_BINDING);
  expect(store2.savedBaiduBinding()).toBeNull();

  expect(JSON.parse(mem.backing[OCR_STORAGE_KEY]!)).toEqual({
    version: 4,
    order: ["ai"],
    enabled: { ai: true, baidu: false, "google-cloud": false },
    ai: { modelId: "vision-model" },
    baidu: null,
    "google-cloud": null,
  });
});

test("ocr store: rejects a blank model ID and keeps the saved bindings", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.save(VISION_BINDING);

  const result = await store.save({ kind: "ai", modelId: "   " });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("model_id_blank");
  expect(result.message).toBeTruthy();
  expect(store.enabledBindings()).toEqual([VISION_BINDING]);
  expect(mem.getSetCalls()).toBe(1);
});

test("ocr store: keeps the saved bindings when a write fails", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.save(VISION_BINDING);

  mem.setSetError(new Error("disk full"));
  const result = await store.save({ kind: "ai", modelId: "other-vision-model" });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(result.message).toBeTruthy();
  expect(store.enabledBindings()).toEqual([VISION_BINDING]);
});

test("ocr store: reports malformed storage and leaves no enabled binding", async () => {
  const raw = "{ not json";
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: raw });
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.enabledBindings()).toEqual([]);
  expect(store.savedAiBinding()).toBeNull();
  expect(store.savedBaiduBinding()).toBeNull();
  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(store.loadError()?.message).toBeTruthy();
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("ocr store: rejects an unknown storage version with a visible load error", async () => {
  const raw = JSON.stringify({
    version: 2,
    active: "ai",
    ai: { modelId: "vision-model" },
    baidu: null,
  });
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: raw });
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.enabledBindings()).toEqual([]);
  expect(store.loadError()?.key).toBe("storage_unsupported_version");
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(raw);
});

test("ocr store: rejects malformed v4 records and inconsistent channel state", async () => {
  const records = [
    {
      version: 4,
      order: ["ai", "baidu"],
      enabled: { ai: true, baidu: false },
      ai: null,
      baidu: null,
    },
    {
      version: 4,
      order: ["ai", "baidu"],
      enabled: { ai: false, baidu: true },
      ai: { modelId: "vision-model" },
      baidu: null,
    },
    {
      version: 4,
      order: [],
      enabled: { ai: true, baidu: false },
      ai: { modelId: "vision-model" },
      baidu: null,
    },
    {
      version: 4,
      order: ["ai", "ai"],
      enabled: { ai: false, baidu: false },
      ai: null,
      baidu: null,
    },
    {
      version: 4,
      order: ["ai", "google"],
      enabled: { ai: false, baidu: false },
      ai: null,
      baidu: null,
    },
    {
      version: 4,
      order: ["ai", "baidu"],
      enabled: { ai: "yes", baidu: false },
      ai: null,
      baidu: null,
    },
    {
      version: 4,
      order: ["ai", "baidu"],
      enabled: { ai: true, baidu: false },
      ai: { modelId: "" },
      baidu: null,
    },
    {
      version: 4,
      order: ["ai", "baidu"],
      enabled: { ai: true, baidu: false },
      ai: { modelId: "vision-model" },
      baidu: { operation: "premium", credentialRef: "ref-1" },
    },
    {
      version: 4,
      order: ["ai"],
      enabled: { ai: false, baidu: false },
      ai: null,
      baidu: { operation: "accurate", credentialRef: "ref-1" },
    },
  ];

  for (const record of records) {
    const store = createOcrSettingsStore(
      createMemoryStorage({ [OCR_STORAGE_KEY]: JSON.stringify(record) }).storage,
    );
    await store.load();
    expect(store.enabledBindings()).toEqual([]);
    expect(store.savedAiBinding()).toBeNull();
    expect(store.savedBaiduBinding()).toBeNull();
    expect(store.loadError()?.key).toBe("storage_malformed");
  }
});

test("ocr store: reports a read failure without any enabled binding", async () => {
  const mem = createMemoryStorage();
  mem.setGetError(new Error("unavailable"));
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.enabledBindings()).toEqual([]);
  expect(store.loadError()?.key).toBe("storage_read_failed");
  expect(store.loadError()?.message).toBeTruthy();
});

test("ocr store: a valid save replaces invalid stored data", async () => {
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: '{"version":4,"order":["ai"]}' });
  const store = createOcrSettingsStore(mem.storage);
  await store.load();
  expect(store.loadError()?.key).toBe("storage_malformed");

  const result = await store.save(VISION_BINDING);

  expect(result.ok).toBe(true);
  expect(store.enabledBindings()).toEqual([VISION_BINDING]);
  expect(store.loadError()).toBeNull();

  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.loadError()).toBeNull();
  expect(reloaded.enabledBindings()).toEqual([VISION_BINDING]);
});

test("ocr store: saves a Baidu binding by reference and restores the credential pair", async () => {
  const apiKey = "synthetic-api-key";
  const secretKey = "synthetic-secret-key";
  const mem = createMemoryStorage();
  const store1 = createOcrSettingsStore(mem.storage);

  const result = await store1.save({
    kind: "baidu",
    operation: "accurate",
    credentials: { kind: "replace", apiKey: `  ${apiKey}  `, secretKey: `  ${secretKey}  ` },
  });

  expect(result.ok).toBe(true);
  if (!result.ok || result.binding.kind !== "baidu") throw new Error("expected a Baidu binding");
  const ref = result.binding.credentialRef;
  expect(ref.trim().length).toBeGreaterThan(0);
  expect(result.binding).toEqual({ kind: "baidu", operation: "accurate", credentialRef: ref });
  expect(store1.isEnabled("baidu")).toBe(true);
  expect(store1.enabledBindings()).toEqual([result.binding]);
  expect(store1.savedBaiduBinding()).toEqual(result.binding);
  expect(store1.savedAiBinding()).toBeNull();
  expect(JSON.stringify(result.binding)).not.toContain(apiKey);
  expect(JSON.stringify(result.binding)).not.toContain(secretKey);
  expect(JSON.stringify(store1.enabledBindings())).not.toContain(apiKey);

  const raw = mem.backing[OCR_STORAGE_KEY]!;
  expect(raw).not.toContain(apiKey);
  expect(raw).not.toContain(secretKey);
  expect(JSON.parse(raw)).toEqual({
    version: 4,
    order: ["baidu"],
    enabled: { ai: false, baidu: true, "google-cloud": false },
    ai: null,
    baidu: { operation: "accurate", credentialRef: ref },
    "google-cloud": null,
  });
  expect(JSON.parse(mem.backing[`settings.ocr.credentials.${ref}`]!)).toEqual({
    apiKey,
    secretKey,
  });

  const store2 = createOcrSettingsStore(mem.storage);
  await store2.load();
  expect(store2.loadError()).toBeNull();
  expect(store2.enabledBindings()).toEqual([
    { kind: "baidu", operation: "accurate", credentialRef: ref },
  ]);
  expect(store2.savedBaiduBinding()).toEqual(result.binding);
  expect(await store2.readBaiduCredentials(ref)).toEqual({ apiKey, secretKey });
});

const FIRST_KEYS = { apiKey: "synthetic-api-key", secretKey: "synthetic-secret-key" };
const NEXT_KEYS = { apiKey: "replacement-api-key", secretKey: "replacement-secret-key" };

async function saveBaidu(
  store: ReturnType<typeof createOcrSettingsStore>,
  keys: { apiKey: string; secretKey: string },
  operation: BaiduOcrOperation = "accurate",
) {
  const result = await store.save({
    kind: "baidu",
    operation,
    credentials: { kind: "replace", apiKey: keys.apiKey, secretKey: keys.secretKey },
  });
  if (!result.ok || result.binding.kind !== "baidu") throw new Error("expected a Baidu binding");
  return result.binding;
}

test("ocr store: a failed credential write keeps the previous Baidu binding and pair", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS);
  const before = mem.backing[OCR_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 1);
  const result = await store.save({
    kind: "baidu",
    operation: "general",
    credentials: { kind: "replace", ...NEXT_KEYS },
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(store.enabledBindings()).toEqual([first]);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);
  expect(await store.readBaiduCredentials(first.credentialRef)).toEqual(FIRST_KEYS);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEYS.apiKey);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEYS.secretKey);
});

test("ocr store: a failed binding write drops the new pair and keeps the old one", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS);
  const before = mem.backing[OCR_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 2);
  const result = await store.save({
    kind: "baidu",
    operation: "general",
    credentials: { kind: "replace", ...NEXT_KEYS },
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(store.enabledBindings()).toEqual([first]);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);
  expect(await store.readBaiduCredentials(first.credentialRef)).toEqual(FIRST_KEYS);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEYS.apiKey);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_KEYS.secretKey);
});

test("ocr store: replacing Baidu keys removes the previous credential entry", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS, "accurate");
  const second = await saveBaidu(store, NEXT_KEYS, "general");

  expect(second.credentialRef).not.toBe(first.credentialRef);
  expect(second.operation).toBe("general");
  expect(store.enabledBindings()).toEqual([second]);
  expect(mem.backing["settings.ocr.credentials." + first.credentialRef]).toBeUndefined();
  expect(await store.readBaiduCredentials(first.credentialRef)).toBeNull();
  expect(await store.readBaiduCredentials(second.credentialRef)).toEqual(NEXT_KEYS);
  expect(JSON.stringify(store.enabledBindings())).not.toContain(NEXT_KEYS.apiKey);
});

test("ocr store: saving both channels keeps both enabled in priority order", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const ai = await store.save(VISION_BINDING);
  const baidu = await saveBaidu(store, FIRST_KEYS);

  expect(ai.ok).toBe(true);
  expect(store.channelOrder()).toEqual(["ai", "baidu"]);
  expect(store.isEnabled("ai")).toBe(true);
  expect(store.isEnabled("baidu")).toBe(true);
  expect(store.enabledBindings()).toEqual([VISION_BINDING, baidu]);
  expect(store.savedAiBinding()).toEqual(VISION_BINDING);
  expect(store.savedBaiduBinding()).toEqual(baidu);
  expect(await store.readBaiduCredentials(baidu.credentialRef)).toEqual(FIRST_KEYS);

  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.enabledBindings()).toEqual([VISION_BINDING, baidu]);
  expect(reloaded.savedBaiduBinding()).toEqual(baidu);
  expect(await reloaded.readBaiduCredentials(baidu.credentialRef)).toEqual(FIRST_KEYS);
});

test("ocr store: reordering channels updates priority order and persists", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.save(VISION_BINDING);
  const baidu = await saveBaidu(store, FIRST_KEYS);

  expect(store.channelOrder()).toEqual(["ai", "baidu"]);
  expect(store.enabledBindings()).toEqual([VISION_BINDING, baidu]);

  // Keeping a channel in its position does not write to storage.
  const writesBefore = mem.getSetCalls();
  expect(await store.moveChannelTo("ai", 0)).toEqual({ ok: true });
  expect(await store.moveChannelTo("baidu", 1)).toEqual({ ok: true });
  expect(mem.getSetCalls()).toBe(writesBefore);

  expect(await store.moveChannelTo("baidu", 0)).toEqual({ ok: true });
  expect(store.channelOrder()).toEqual(["baidu", "ai"]);
  expect(store.enabledBindings()).toEqual([baidu, VISION_BINDING]);

  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.channelOrder()).toEqual(["baidu", "ai"]);
  expect(reloaded.enabledBindings()).toEqual([baidu, VISION_BINDING]);

  // A target past the end clamps to the last position.
  expect(await reloaded.moveChannelTo("baidu", 99)).toEqual({ ok: true });
  expect(reloaded.channelOrder()).toEqual(["ai", "baidu"]);
  expect(reloaded.enabledBindings()).toEqual([VISION_BINDING, baidu]);
});

test("ocr store: toggling preserves saved configs, rejects unconfigured enable, and preserves disabled state on edit", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);

  const unconfigured = await store.setEnabled("ai", true);
  expect(unconfigured.ok).toBe(false);
  if (unconfigured.ok) throw new Error("expected rejection");
  expect(unconfigured.key).toBe("channel_unconfigured");
  expect(mem.getSetCalls()).toBe(0);

  await store.save(VISION_BINDING);
  const baidu = await saveBaidu(store, FIRST_KEYS, "accurate");
  expect(store.enabledBindings()).toEqual([VISION_BINDING, baidu]);

  // Disabling AI keeps its saved config and drops it from enabledBindings.
  expect(await store.setEnabled("ai", false)).toEqual({ ok: true });
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.savedAiBinding()).toEqual(VISION_BINDING);
  expect(store.enabledBindings()).toEqual([baidu]);

  // Editing an already-configured disabled channel preserves its disabled state.
  const editedAi = await store.save({ kind: "ai", modelId: "vision-model-2" });
  expect(editedAi.ok).toBe(true);
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.savedAiBinding()).toEqual({ kind: "ai", modelId: "vision-model-2" });
  expect(store.enabledBindings()).toEqual([baidu]);

  // Disabling Baidu keeps its credentials; re-enabling both restores full order.
  expect(await store.setEnabled("baidu", false)).toEqual({ ok: true });
  expect(store.enabledBindings()).toEqual([]);
  expect(await store.readBaiduCredentials(baidu.credentialRef)).toEqual(FIRST_KEYS);

  expect(await store.setEnabled("ai", true)).toEqual({ ok: true });
  expect(await store.setEnabled("baidu", true)).toEqual({ ok: true });
  expect(store.enabledBindings()).toEqual([{ kind: "ai", modelId: "vision-model-2" }, baidu]);
});

test("ocr store: failed toggle or reorder write keeps previous state", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.save(VISION_BINDING);
  const baidu = await saveBaidu(store, FIRST_KEYS);
  const before = mem.backing[OCR_STORAGE_KEY];

  mem.setSetError(new Error("disk full"));
  const toggleErr = await store.setEnabled("ai", false);
  expect(toggleErr.ok).toBe(false);
  if (toggleErr.ok) throw new Error("expected failure");
  expect(toggleErr.key).toBe("storage_write_failed");
  expect(store.isEnabled("ai")).toBe(true);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);

  const moveErr = await store.moveChannelTo("baidu", 0);
  expect(moveErr.ok).toBe(false);
  if (moveErr.ok) throw new Error("expected failure");
  expect(moveErr.key).toBe("storage_write_failed");
  expect(store.channelOrder()).toEqual(["ai", "baidu"]);
  expect(store.enabledBindings()).toEqual([VISION_BINDING, baidu]);
});

test("ocr store: a cleanup failure keeps the committed binding and omits secrets", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS);
  mem.setRemoveError(new Error("could not delete " + FIRST_KEYS.apiKey));

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((part) => String(part)).join(" "));
  };
  try {
    const second = await saveBaidu(store, NEXT_KEYS, "accurate_basic");
    expect(second.credentialRef).not.toBe(first.credentialRef);
    expect(store.enabledBindings()).toEqual([second]);
    expect(await store.readBaiduCredentials(second.credentialRef)).toEqual(NEXT_KEYS);
  } finally {
    console.warn = originalWarn;
  }

  const warningText = warnings.join(" ");
  expect(warningText.length).toBeGreaterThan(0);
  expect(warningText).not.toContain(FIRST_KEYS.apiKey);
  expect(warningText).not.toContain(FIRST_KEYS.secretKey);
  expect(warningText).not.toContain(NEXT_KEYS.apiKey);
  expect(warningText).not.toContain(NEXT_KEYS.secretKey);
  expect(warningText).not.toContain("could not delete");
});

test("ocr store: a mode-only save reuses a readable Baidu credential", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS, "accurate");
  const writesBefore = mem.getSetCalls();

  const result = await store.save({
    kind: "baidu",
    operation: "general_basic",
    credentials: { kind: "keep" },
  });

  expect(result.ok).toBe(true);
  if (!result.ok || result.binding.kind !== "baidu") throw new Error("expected a Baidu binding");
  expect(result.binding).toEqual({
    kind: "baidu",
    operation: "general_basic",
    credentialRef: first.credentialRef,
  });
  expect(store.enabledBindings()).toEqual([result.binding]);
  expect(mem.getSetCalls()).toBe(writesBefore + 1);
  expect(await store.readBaiduCredentials(first.credentialRef)).toEqual(FIRST_KEYS);
  expect(
    Object.keys(mem.backing).filter((key) => key.startsWith("settings.ocr.credentials.")),
  ).toEqual(["settings.ocr.credentials." + first.credentialRef]);

  const getsBeforeLoad = mem.getGets().length;
  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.enabledBindings()).toEqual([result.binding]);
  expect(
    mem
      .getGets()
      .slice(getsBeforeLoad)
      .some((key) => key.startsWith("settings.ocr.credentials.")),
  ).toBe(false);
});

test("ocr store: keep requires both keys when the stored pair cannot be read", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS);
  const before = mem.backing[OCR_STORAGE_KEY];
  mem.backing["settings.ocr.credentials." + first.credentialRef] = JSON.stringify({ apiKey: 1 });

  const result = await store.save({
    kind: "baidu",
    operation: "general",
    credentials: { kind: "keep" },
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("baidu_keys_required");
  expect(result.message).toBeTruthy();
  expect(store.enabledBindings()).toEqual([first]);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);
});

test("ocr store: unknown modes and a first save without keys stay inactive", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);

  const missing = await store.save({
    kind: "baidu",
    operation: "accurate",
    credentials: { kind: "keep" },
  });
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("expected a rejected save");
  expect(missing.key).toBe("baidu_keys_required");

  const blank = await store.save({
    kind: "baidu",
    operation: "accurate",
    credentials: { kind: "replace", apiKey: "  ", secretKey: "secret" },
  });
  expect(blank.ok).toBe(false);
  if (blank.ok) throw new Error("expected a rejected save");
  expect(blank.key).toBe("baidu_keys_required");
  expect(store.enabledBindings()).toEqual([]);
  expect(mem.getSetCalls()).toBe(0);
  expect(mem.backing[OCR_STORAGE_KEY]).toBeUndefined();

  const unknown = await store.save({
    kind: "baidu",
    operation: "premium" as "accurate",
    credentials: { kind: "replace", ...FIRST_KEYS },
  });
  expect(unknown.ok).toBe(false);
  if (unknown.ok) throw new Error("expected a rejected save");
  expect(unknown.key).toBe("baidu_operation_invalid");
  expect(store.enabledBindings()).toEqual([]);
  expect(mem.getSetCalls()).toBe(0);
});

test("ocr store: readBaiduCredentials returns null when the pair is missing, invalid, or unreadable", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  expect(await store.readBaiduCredentials("missing-ref")).toBeNull();

  mem.backing["settings.ocr.credentials.bad"] = "not-json";
  expect(await store.readBaiduCredentials("bad")).toBeNull();

  mem.backing["settings.ocr.credentials.blank"] = JSON.stringify({
    apiKey: " ",
    secretKey: "secret",
  });
  expect(await store.readBaiduCredentials("blank")).toBeNull();

  mem.setGetError(new Error("unavailable"));
  expect(await store.readBaiduCredentials("missing-ref")).toBeNull();
});

const VISION_KEY = "synthetic-vision-key";
const NEXT_VISION_KEY = "replacement-vision-key";

function twoChannelRecord(): string {
  return JSON.stringify({
    version: 4,
    order: ["baidu", "ai"],
    enabled: { ai: false, baidu: true },
    ai: { modelId: "vision-model" },
    baidu: { operation: "accurate", credentialRef: "baidu-ref" },
  });
}

test("ocr store: loads a two-channel record without inserting Google Cloud", async () => {
  const raw = twoChannelRecord();
  const mem = createMemoryStorage({
    [OCR_STORAGE_KEY]: raw,
    [baiduCredentialStorageKey("baidu-ref")]: JSON.stringify(FIRST_KEYS),
  });
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.loadError()).toBeNull();
  expect(store.channelOrder()).toEqual(["baidu", "ai"]);
  expect(store.availableChannels()).toEqual(["google-cloud"]);
  expect(store.isEnabled("google-cloud")).toBe(false);
  expect(store.isEnabled("baidu")).toBe(true);
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.savedGoogleCloudBinding()).toBeNull();
  expect(store.enabledBindings().map((binding) => binding.kind)).toEqual(["baidu"]);
  expect(mem.getSetCalls()).toBe(0);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(raw);
  expect(mem.getGets().some((key) => key.startsWith("settings.ocr.googleCloudKeys."))).toBe(false);
});

test("ocr store: first Vision save enables Google Cloud without changing the other channels", async () => {
  const mem = createMemoryStorage({
    [OCR_STORAGE_KEY]: twoChannelRecord(),
    [baiduCredentialStorageKey("baidu-ref")]: JSON.stringify(FIRST_KEYS),
  });
  const store = createOcrSettingsStore(mem.storage);
  await store.load();

  const saved = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: `  ${VISION_KEY}  ` },
  });

  expect(saved.ok).toBe(true);
  if (!saved.ok || saved.binding.kind !== "google-cloud") {
    throw new Error("expected a Google Cloud binding");
  }
  expect(store.channelOrder()).toEqual(["baidu", "ai", "google-cloud"]);
  expect(store.isEnabled("baidu")).toBe(true);
  expect(store.isEnabled("ai")).toBe(false);
  expect(store.isEnabled("google-cloud")).toBe(true);
  expect(store.savedGoogleCloudBinding()).toEqual(saved.binding);
  expect(JSON.stringify(saved.binding)).not.toContain(VISION_KEY);
  expect(mem.backing[OCR_STORAGE_KEY]).not.toContain(VISION_KEY);
  expect(
    JSON.parse(mem.backing[googleCloudCredentialStorageKey(saved.binding.credentialRef)]!),
  ).toEqual({
    apiKey: VISION_KEY,
  });

  const getsBeforeLoad = mem.getGets().length;
  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.channelOrder()).toEqual(["baidu", "ai", "google-cloud"]);
  expect(reloaded.isEnabled("google-cloud")).toBe(true);
  expect(reloaded.savedGoogleCloudBinding()).toEqual(saved.binding);
  expect(
    mem
      .getGets()
      .slice(getsBeforeLoad)
      .some((key) => key.startsWith("settings.ocr.googleCloudKeys.")),
  ).toBe(false);
  expect(await reloaded.readGoogleCloudCredential(saved.binding.credentialRef)).toBe(VISION_KEY);
});

test("ocr store: replacing a Vision key keeps order and a disabled channel, and drops the old key", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: VISION_KEY },
  });
  if (!first.ok || first.binding.kind !== "google-cloud") throw new Error("expected a binding");
  expect(await store.setEnabled("google-cloud", false)).toEqual({ ok: true });
  await store.addChannel("ai");

  const second = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: NEXT_VISION_KEY },
  });
  if (!second.ok || second.binding.kind !== "google-cloud") throw new Error("expected a binding");

  expect(second.binding.credentialRef).not.toBe(first.binding.credentialRef);
  expect(store.isEnabled("google-cloud")).toBe(false);
  expect(store.channelOrder()).toEqual(["google-cloud", "ai"]);
  expect(store.enabledBindings()).toEqual([]);
  expect(mem.backing[googleCloudCredentialStorageKey(first.binding.credentialRef)]).toBeUndefined();
  expect(await store.readGoogleCloudCredential(second.binding.credentialRef)).toBe(NEXT_VISION_KEY);
  expect(JSON.stringify(store.savedGoogleCloudBinding())).not.toContain(NEXT_VISION_KEY);
});

test("ocr store: a failed Vision key write keeps the previous key", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: VISION_KEY },
  });
  if (!first.ok || first.binding.kind !== "google-cloud") throw new Error("expected a binding");
  const before = mem.backing[OCR_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 1);
  const result = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: NEXT_VISION_KEY },
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);
  expect(await store.readGoogleCloudCredential(first.binding.credentialRef)).toBe(VISION_KEY);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_VISION_KEY);
});

test("ocr store: a failed Vision record write drops the new key and keeps the old one", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: VISION_KEY },
  });
  if (!first.ok || first.binding.kind !== "google-cloud") throw new Error("expected a binding");
  const before = mem.backing[OCR_STORAGE_KEY];

  mem.failSetOnCall(mem.getSetCalls() + 2);
  const result = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: NEXT_VISION_KEY },
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(store.savedGoogleCloudBinding()).toEqual(first.binding);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);
  expect(await store.readGoogleCloudCredential(first.binding.credentialRef)).toBe(VISION_KEY);
  expect(JSON.stringify(mem.backing)).not.toContain(NEXT_VISION_KEY);
});

test("ocr store: disabling Google Cloud leaves its key, and reorder persists", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.addChannel("ai");
  const saved = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: VISION_KEY },
  });
  if (!saved.ok || saved.binding.kind !== "google-cloud") throw new Error("expected a binding");
  expect(store.channelOrder()).toEqual(["ai", "google-cloud"]);

  expect(await store.setEnabled("google-cloud", false)).toEqual({ ok: true });
  expect(store.isEnabled("google-cloud")).toBe(false);
  expect(await store.readGoogleCloudCredential(saved.binding.credentialRef)).toBe(VISION_KEY);

  expect(await store.moveChannelTo("google-cloud", 0)).toEqual({ ok: true });
  expect(store.channelOrder()).toEqual(["google-cloud", "ai"]);

  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.channelOrder()).toEqual(["google-cloud", "ai"]);
  expect(reloaded.isEnabled("google-cloud")).toBe(false);
  expect(reloaded.savedGoogleCloudBinding()).toEqual(saved.binding);
  expect(await reloaded.readGoogleCloudCredential(saved.binding.credentialRef)).toBe(VISION_KEY);
});

test("ocr store: rejects a blank or spaced Vision key and requires a readable key to keep it", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);

  for (const apiKey of ["", "   ", "vision key", "vision\nkey"]) {
    const rejected = await store.save({
      kind: "google-cloud",
      credentials: { kind: "replace", apiKey },
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected a rejected save");
    expect(rejected.key).toBe("google_cloud_key_required");
  }
  expect(mem.getSetCalls()).toBe(0);
  expect(store.savedGoogleCloudBinding()).toBeNull();

  const saved = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: "AIza-synthetic" },
  });
  if (!saved.ok || saved.binding.kind !== "google-cloud") throw new Error("expected a binding");
  mem.backing[googleCloudCredentialStorageKey(saved.binding.credentialRef)] = JSON.stringify({
    apiKey: "has space",
  });
  const kept = await store.save({ kind: "google-cloud", credentials: { kind: "keep" } });
  expect(kept.ok).toBe(false);
  if (kept.ok) throw new Error("expected a rejected save");
  expect(kept.key).toBe("google_cloud_key_required");
  expect(store.savedGoogleCloudBinding()).toEqual(saved.binding);
});

test("ocr store: removing Google Cloud deletes its key and a cleanup warning has no secret", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const saved = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: VISION_KEY },
  });
  if (!saved.ok || saved.binding.kind !== "google-cloud") throw new Error("expected a binding");

  expect((await store.removeChannel("google-cloud")).ok).toBe(true);
  expect(store.channelOrder()).toEqual([]);
  expect(store.savedGoogleCloudBinding()).toBeNull();
  expect(mem.backing[googleCloudCredentialStorageKey(saved.binding.credentialRef)]).toBeUndefined();

  const again = await store.save({
    kind: "google-cloud",
    credentials: { kind: "replace", apiKey: VISION_KEY },
  });
  if (!again.ok || again.binding.kind !== "google-cloud") throw new Error("expected a binding");
  mem.setRemoveError(new Error("could not delete " + VISION_KEY));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((part) => String(part)).join(" "));
  };
  try {
    const replaced = await store.save({
      kind: "google-cloud",
      credentials: { kind: "replace", apiKey: NEXT_VISION_KEY },
    });
    expect(replaced.ok).toBe(true);
  } finally {
    console.warn = originalWarn;
  }
  const warningText = warnings.join(" ");
  expect(warningText.length).toBeGreaterThan(0);
  expect(warningText).not.toContain(VISION_KEY);
  expect(warningText).not.toContain(NEXT_VISION_KEY);
  expect(warningText).not.toContain("could not delete");
});
