import { expect, test } from "nsh/test";
import {
  createOcrSettingsStore,
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

test("ocr store: saves one AI binding and restores it from the same storage", async () => {
  const mem = createMemoryStorage();
  const store1 = createOcrSettingsStore(mem.storage);

  expect(store1.settings()).toBeNull();
  expect(store1.loadError()).toBeNull();

  await store1.load();
  expect(store1.loadError()).toBeNull();
  expect(store1.settings()).toBeNull();

  const result = await store1.save(VISION_BINDING);
  expect(result.ok).toBe(true);
  expect(store1.settings()).toEqual(VISION_BINDING);

  const store2 = createOcrSettingsStore(mem.storage);
  await store2.load();
  expect(store2.loadError()).toBeNull();
  expect(store2.settings()).toEqual(VISION_BINDING);

  const raw = JSON.parse(mem.backing[OCR_STORAGE_KEY]!);
  expect(raw.version).toBe(1);
  expect(raw.kind).toBe("ai");
  expect(raw.modelId).toBe("vision-model");
});

test("ocr store: rejects a blank model ID and keeps the active binding", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.save(VISION_BINDING);

  const result = await store.save({ kind: "ai", modelId: "   " });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("model_id_blank");
  expect(result.message).toBeTruthy();
  expect(store.settings()).toEqual(VISION_BINDING);
  expect(mem.getSetCalls()).toBe(1);
});

test("ocr store: keeps the active binding when the write fails", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  await store.save(VISION_BINDING);

  mem.setSetError(new Error("disk full"));
  const result = await store.save({ kind: "ai", modelId: "other-vision-model" });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejected save");
  expect(result.key).toBe("storage_write_failed");
  expect(result.message).toBeTruthy();
  expect(store.settings()).toEqual(VISION_BINDING);
});

test("ocr store: reports malformed storage and leaves no usable binding", async () => {
  const raw = "{ not json";
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: raw });
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.settings()).toBeNull();
  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(store.loadError()?.message).toBeTruthy();
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(raw);
  expect(mem.getSetCalls()).toBe(0);
});

test("ocr store: rejects an unknown storage version with a visible load error", async () => {
  const raw = JSON.stringify({ version: 2, kind: "ai", modelId: "vision-model" });
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: raw });
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.settings()).toBeNull();
  expect(store.loadError()?.key).toBe("storage_unsupported_version");
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(raw);
});

test("ocr store: rejects a stored shape without a nonblank model", async () => {
  const raw = JSON.stringify({ version: 1, kind: "ai", modelId: "" });
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: raw });
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.settings()).toBeNull();
  expect(store.loadError()?.key).toBe("storage_malformed");
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(raw);
});

test("ocr store: reports a read failure without a usable binding", async () => {
  const mem = createMemoryStorage();
  mem.setGetError(new Error("unavailable"));
  const store = createOcrSettingsStore(mem.storage);

  await store.load();

  expect(store.settings()).toBeNull();
  expect(store.loadError()?.key).toBe("storage_read_failed");
  expect(store.loadError()?.message).toBeTruthy();
});

test("ocr store: a valid save replaces invalid stored data", async () => {
  const mem = createMemoryStorage({ [OCR_STORAGE_KEY]: '{"version":1,"kind":"ai"}' });
  const store = createOcrSettingsStore(mem.storage);
  await store.load();
  expect(store.loadError()?.key).toBe("storage_malformed");

  const result = await store.save(VISION_BINDING);

  expect(result.ok).toBe(true);
  expect(store.settings()).toEqual(VISION_BINDING);
  expect(store.loadError()).toBeNull();

  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.loadError()).toBeNull();
  expect(reloaded.settings()).toEqual(VISION_BINDING);
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
  expect(store1.settings()).toEqual(result.binding);
  expect(JSON.stringify(result.binding)).not.toContain(apiKey);
  expect(JSON.stringify(result.binding)).not.toContain(secretKey);
  expect(JSON.stringify(store1.settings())).not.toContain(apiKey);

  const raw = mem.backing[OCR_STORAGE_KEY]!;
  expect(raw).not.toContain(apiKey);
  expect(raw).not.toContain(secretKey);
  expect(JSON.parse(raw)).toEqual({
    version: 1,
    kind: "baidu",
    operation: "accurate",
    credentialRef: ref,
  });
  expect(JSON.parse(mem.backing[`settings.ocr.credentials.${ref}`]!)).toEqual({
    apiKey,
    secretKey,
  });

  const store2 = createOcrSettingsStore(mem.storage);
  await store2.load();
  expect(store2.loadError()).toBeNull();
  expect(store2.settings()).toEqual({ kind: "baidu", operation: "accurate", credentialRef: ref });
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
  expect(store.settings()).toEqual(first);
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
  expect(store.settings()).toEqual(first);
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
  expect(store.settings()).toEqual(second);
  expect(mem.backing["settings.ocr.credentials." + first.credentialRef]).toBeUndefined();
  expect(await store.readBaiduCredentials(first.credentialRef)).toBeNull();
  expect(await store.readBaiduCredentials(second.credentialRef)).toEqual(NEXT_KEYS);
  expect(JSON.stringify(store.settings())).not.toContain(NEXT_KEYS.apiKey);
});

test("ocr store: saving AI removes the Baidu credential entry", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS);

  const result = await store.save(VISION_BINDING);

  expect(result.ok).toBe(true);
  expect(store.settings()).toEqual(VISION_BINDING);
  expect(mem.backing["settings.ocr.credentials." + first.credentialRef]).toBeUndefined();
  expect(await store.readBaiduCredentials(first.credentialRef)).toBeNull();
  expect(JSON.stringify(mem.backing)).not.toContain(FIRST_KEYS.apiKey);
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
    expect(store.settings()).toEqual(second);
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
  expect(store.settings()).toEqual(result.binding);
  expect(mem.getSetCalls()).toBe(writesBefore + 1);
  expect(await store.readBaiduCredentials(first.credentialRef)).toEqual(FIRST_KEYS);
  expect(
    Object.keys(mem.backing).filter((key) => key.startsWith("settings.ocr.credentials.")),
  ).toEqual(["settings.ocr.credentials." + first.credentialRef]);

  const getsBeforeLoad = mem.getGets().length;
  const reloaded = createOcrSettingsStore(mem.storage);
  await reloaded.load();
  expect(reloaded.settings()).toEqual(result.binding);
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
  expect(store.settings()).toEqual(first);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(before);
});

test("ocr store: unknown modes, malformed bindings, and a first save without keys stay inactive", async () => {
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
  expect(store.settings()).toBeNull();
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
  expect(store.settings()).toBeNull();
  expect(mem.getSetCalls()).toBe(0);

  const badMode = JSON.stringify({
    version: 1,
    kind: "baidu",
    operation: "premium",
    credentialRef: "ref-1",
  });
  const badStore = createOcrSettingsStore(
    createMemoryStorage({ [OCR_STORAGE_KEY]: badMode }).storage,
  );
  await badStore.load();
  expect(badStore.settings()).toBeNull();
  expect(badStore.loadError()?.key).toBe("storage_malformed");

  const blankRef = JSON.stringify({
    version: 1,
    kind: "baidu",
    operation: "accurate",
    credentialRef: " ",
  });
  const blankRefStore = createOcrSettingsStore(
    createMemoryStorage({ [OCR_STORAGE_KEY]: blankRef }).storage,
  );
  await blankRefStore.load();
  expect(blankRefStore.settings()).toBeNull();
  expect(blankRefStore.loadError()?.key).toBe("storage_malformed");
});

test("ocr store: switching back to Baidu after AI requires both keys again", async () => {
  const mem = createMemoryStorage();
  const store = createOcrSettingsStore(mem.storage);
  const first = await saveBaidu(store, FIRST_KEYS);
  const baiduRaw = mem.backing[OCR_STORAGE_KEY];

  expect(store.settings()).toEqual(first);
  expect(mem.backing[OCR_STORAGE_KEY]).toBe(baiduRaw);

  const ai = await store.save(VISION_BINDING);
  expect(ai.ok).toBe(true);
  expect(store.settings()).toEqual(VISION_BINDING);

  const kept = await store.save({
    kind: "baidu",
    operation: "accurate",
    credentials: { kind: "keep" },
  });
  expect(kept.ok).toBe(false);
  if (kept.ok) throw new Error("expected a rejected save");
  expect(kept.key).toBe("baidu_keys_required");
  expect(store.settings()).toEqual(VISION_BINDING);
  expect(JSON.parse(mem.backing[OCR_STORAGE_KEY]!).kind).toBe("ai");

  const again = await saveBaidu(store, NEXT_KEYS, "accurate");
  expect(again.credentialRef).not.toBe(first.credentialRef);
  expect(await store.readBaiduCredentials(again.credentialRef)).toEqual(NEXT_KEYS);
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
