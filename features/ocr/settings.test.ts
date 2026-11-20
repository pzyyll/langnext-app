import { expect, test } from "nsh/test";
import {
  createOcrSettingsStore,
  OCR_STORAGE_KEY,
  type OcrServiceBinding,
  type OcrSettingsStorage,
} from "./settings";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let failGetError: Error | null = null;
  let failSetError: Error | null = null;
  let setCalls = 0;

  const storage: OcrSettingsStorage = {
    getItem: async (key) => {
      if (failGetError) throw failGetError;
      return backing[key] ?? null;
    },
    setItem: async (key, value) => {
      setCalls += 1;
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
    getSetCalls: () => setCalls,
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
