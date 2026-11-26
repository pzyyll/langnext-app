// ABOUTME: Store tests for the OCR channel collection: storage key, vault namespace, and enable policy.
import { expect, test } from "nsh/test";
import { registerOcrIntegrations } from "../../integrations/ocr";
import { createIntegrationRegistry, setIntegrationRegistry } from "../../framework/integrations";
import {
  createOcrChannelCollection,
  OCR_CHANNELS_STORAGE_KEY,
  OCR_CREDENTIAL_NAMESPACE,
} from "./store";

const registry = createIntegrationRegistry();
registerOcrIntegrations(registry);
setIntegrationRegistry(registry);

interface StoredChannel {
  enabled: boolean;
  configured: boolean;
  config: unknown;
  credentialRef: string | null;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  let writes = 0;
  return {
    backing,
    writes: () => writes,
    storage: {
      getItem: async (key: string) => backing[key] ?? null,
      setItem: async (key: string, value: string) => {
        writes += 1;
        backing[key] = value;
      },
      removeItem: async (key: string) => {
        delete backing[key];
      },
    },
  };
}

function makeStore(initial: Record<string, string> = {}) {
  const memory = memoryStorage(initial);
  return { ...memory, collection: createOcrChannelCollection(memory.storage) };
}

function storedRecord(backing: Record<string, string>) {
  return JSON.parse(backing[OCR_CHANNELS_STORAGE_KEY] ?? "null") as {
    version: number;
    order: string[];
    channels: Record<string, StoredChannel>;
  };
}

const API_KEY = "synthetic-api-key";
const SECRET_KEY = "synthetic-secret-key";

test("ocr store: an empty load offers every channel and writes nothing", async () => {
  const { collection, backing, writes } = makeStore();

  await collection.load();

  expect(collection.order()).toEqual([]);
  expect(collection.available()).toEqual(["ai", "baidu", "google-cloud"]);
  expect(collection.skippedCount()).toBe(0);
  expect(collection.loadError()).toBeNull();
  expect(backing[OCR_CHANNELS_STORAGE_KEY]).toBeUndefined();
  expect(writes()).toBe(0);
});

test("ocr store: add appends a channel that stays off until it is configured", async () => {
  const memory = memoryStorage();
  const collection = createOcrChannelCollection(memory.storage);
  await collection.load();

  expect(await collection.add("baidu")).toEqual({ ok: true });
  expect(collection.order()).toEqual(["baidu"]);
  expect(collection.available()).toEqual(["ai", "google-cloud"]);
  expect(collection.binding("baidu")).toEqual({
    enabled: false,
    configured: false,
    config: { operation: "accurate" },
    credentialRef: null,
  });
  expect(await collection.add("ai")).toEqual({ ok: true });
  expect(collection.order()).toEqual(["baidu", "ai"]);
  expect(collection.available()).toEqual(["google-cloud"]);

  const writes = memory.writes();
  expect(await collection.add("baidu")).toEqual({ ok: true });
  expect(memory.writes()).toBe(writes);

  const record = storedRecord(memory.backing);
  expect(record.version).toBe(1);
  expect(record.order).toEqual(["baidu", "ai"]);
  expect(record.channels.baidu).toEqual({
    enabled: false,
    configured: false,
    config: { operation: "accurate" },
    credentialRef: null,
  });
  expect(record.channels.ai).toEqual({
    enabled: false,
    configured: false,
    config: { modelId: "" },
    credentialRef: null,
  });

  const reopened = createOcrChannelCollection(memory.storage);
  await reopened.load();
  expect(reopened.order()).toEqual(["baidu", "ai"]);
  expect(reopened.available()).toEqual(["google-cloud"]);
});

test("ocr store: the first save enables a channel and the toggle persists", async () => {
  const memory = memoryStorage();
  const collection = createOcrChannelCollection(memory.storage);
  await collection.load();

  expect(await collection.save("ai", { modelId: "m-vision" }, { mode: "keep" })).toEqual({
    ok: true,
  });
  expect(collection.isEnabled("ai")).toBe(true);
  expect(collection.binding("ai")).toEqual({
    enabled: true,
    configured: true,
    config: { modelId: "m-vision" },
    credentialRef: null,
  });
  expect(storedRecord(memory.backing).channels.ai).toEqual({
    enabled: true,
    configured: true,
    config: { modelId: "m-vision" },
    credentialRef: null,
  });

  const reopened = createOcrChannelCollection(memory.storage);
  await reopened.load();
  expect(reopened.isEnabled("ai")).toBe(true);
  expect(await reopened.setEnabled("ai", false)).toEqual({ ok: true });
  expect(reopened.isEnabled("ai")).toBe(false);

  const again = createOcrChannelCollection(memory.storage);
  await again.load();
  expect(again.isEnabled("ai")).toBe(false);
  expect(again.binding("ai")?.config).toEqual({ modelId: "m-vision" });
});

test("ocr store: a saved Baidu pair lives in the vault, not in the collection record", async () => {
  const memory = memoryStorage();
  const collection = createOcrChannelCollection(memory.storage);
  await collection.load();

  expect(
    await collection.save(
      "baidu",
      { operation: "accurate_basic" },
      { mode: "replace", value: { apiKey: API_KEY, secretKey: SECRET_KEY } },
    ),
  ).toEqual({ ok: true });

  const binding = collection.binding("baidu")!;
  expect(binding.enabled).toBe(true);
  expect(binding.config).toEqual({ operation: "accurate_basic" });
  const ref = binding.credentialRef!;
  expect(ref.length).toBeGreaterThan(0);
  expect(memory.backing[`${OCR_CREDENTIAL_NAMESPACE}.${ref}`]).toBe(
    JSON.stringify({ apiKey: API_KEY, secretKey: SECRET_KEY }),
  );
  expect(memory.backing[OCR_CHANNELS_STORAGE_KEY]).not.toContain(API_KEY);
  expect(memory.backing[OCR_CHANNELS_STORAGE_KEY]).not.toContain(SECRET_KEY);
  expect(await collection.readCredential(ref)).toEqual({
    apiKey: API_KEY,
    secretKey: SECRET_KEY,
  });

  expect(
    await collection.save(
      "baidu",
      { operation: "general" },
      { mode: "replace", value: { apiKey: "next-key", secretKey: "next-secret" } },
    ),
  ).toEqual({ ok: true });
  const nextRef = collection.binding("baidu")!.credentialRef!;
  expect(nextRef).not.toBe(ref);
  expect(memory.backing[`${OCR_CREDENTIAL_NAMESPACE}.${ref}`]).toBeUndefined();
  expect(await collection.readCredential(ref)).toBeNull();
  expect(await collection.readCredential(nextRef)).toEqual({
    apiKey: "next-key",
    secretKey: "next-secret",
  });
});

test("ocr store: reorder persists the priority order and clamps a target past the end", async () => {
  const memory = memoryStorage();
  const collection = createOcrChannelCollection(memory.storage);
  await collection.load();
  await collection.add("ai");
  await collection.add("baidu");

  const writes = memory.writes();
  expect(await collection.moveTo("ai", 0)).toEqual({ ok: true });
  expect(memory.writes()).toBe(writes);

  expect(await collection.moveTo("baidu", 0)).toEqual({ ok: true });
  expect(collection.order()).toEqual(["baidu", "ai"]);

  const reopened = createOcrChannelCollection(memory.storage);
  await reopened.load();
  expect(reopened.order()).toEqual(["baidu", "ai"]);

  expect(await reopened.moveTo("baidu", 99)).toEqual({ ok: true });
  expect(reopened.order()).toEqual(["ai", "baidu"]);
});

test("ocr store: remove clears the vault record and offers the channel again", async () => {
  const memory = memoryStorage();
  const collection = createOcrChannelCollection(memory.storage);
  await collection.load();

  expect(
    await collection.save(
      "google-cloud",
      {},
      { mode: "replace", value: { apiKey: "AIza-synthetic" } },
    ),
  ).toEqual({ ok: true });
  const ref = collection.binding("google-cloud")!.credentialRef!;
  expect(memory.backing[`${OCR_CREDENTIAL_NAMESPACE}.${ref}`]).toBeDefined();

  expect(await collection.remove("google-cloud")).toEqual({ ok: true });
  expect(collection.order()).toEqual([]);
  expect(collection.available()).toEqual(["ai", "baidu", "google-cloud"]);
  expect(collection.binding("google-cloud")).toBeNull();
  expect(memory.backing[`${OCR_CREDENTIAL_NAMESPACE}.${ref}`]).toBeUndefined();
  expect(await collection.readCredential(ref)).toBeNull();
  expect(storedRecord(memory.backing).order).toEqual([]);
});

test("ocr store: a stored channel this build does not know is counted and left on disk", async () => {
  const raw = JSON.stringify({
    version: 1,
    order: ["ai", "legacy"],
    channels: {
      ai: { enabled: false, configured: false, config: { modelId: "" }, credentialRef: null },
      legacy: { enabled: true, configured: true, config: {}, credentialRef: null },
    },
  });
  const memory = memoryStorage({ [OCR_CHANNELS_STORAGE_KEY]: raw });
  const collection = createOcrChannelCollection(memory.storage);

  await collection.load();

  expect(collection.loadError()).toBeNull();
  expect(collection.order()).toEqual(["ai"]);
  expect(collection.skippedCount()).toBe(1);
  expect(memory.backing[OCR_CHANNELS_STORAGE_KEY]).toBe(raw);
});
