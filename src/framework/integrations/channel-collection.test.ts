import { expect, test } from "nsh/test";
import cubeIcon from "../../../assets/icons/cube-outline.svg";
import type { CapabilityChannelDefinition, ConfigSchema } from "./contracts";
import { createChannelCollection, type ChannelCollection } from "./channel-collection";
import { createCredentialVault } from "./credential-vault";

interface TestConfig {
  mode: string;
}

const testConfig: ConfigSchema<TestConfig> = {
  parse: (raw) =>
    typeof raw === "object" && raw !== null && typeof (raw as TestConfig).mode === "string"
      ? { mode: (raw as TestConfig).mode }
      : null,
  defaults: () => ({ mode: "default" }),
};

function channel(
  id: string,
  configurable: boolean,
): CapabilityChannelDefinition<TestConfig, string, string> {
  return {
    id,
    capability: "tts",
    labelKey: `settings.test.${id}`,
    icon: cubeIcon,
    configurable,
    config: testConfig,
    credential: configurable
      ? [{ key: "apiKey", labelKey: "settings.test.apiKey", masked: true }]
      : null,
    describe: (binding) => binding.config.mode,
    readiness: async () => ({ ready: true }),
    execute: async (_binding, input) => input,
    failureKey: () => null,
  };
}

const CHANNELS = [channel("alpha", true), channel("beta", true), channel("free", false)];

function memoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  return {
    backing,
    storage: {
      getItem: async (key: string) => backing[key] ?? null,
      setItem: async (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: async (key: string) => {
        delete backing[key];
      },
    },
  };
}

const STORAGE_KEY = "integrations.test.v1";

function makeCollection(
  options: {
    initial?: Record<string, string>;
    enableOnFirstSave?: boolean;
    requireReadableCredentialOnEnable?: boolean;
    channels?: readonly CapabilityChannelDefinition<TestConfig, string, string>[];
  } = {},
) {
  const memory = memoryStorage(options.initial);
  const vault = createCredentialVault({ storage: memory.storage, namespace: "secret.test" });
  const collection: ChannelCollection = createChannelCollection({
    capability: "tts",
    storage: memory.storage,
    storageKey: STORAGE_KEY,
    vault,
    definitions: () =>
      (options.channels ?? CHANNELS) as unknown as readonly CapabilityChannelDefinition<
        unknown,
        unknown,
        unknown
      >[],
    policy: {
      enableOnFirstSave: options.enableOnFirstSave ?? false,
      requireReadableCredentialOnEnable: options.requireReadableCredentialOnEnable ?? true,
    },
  });
  return { ...memory, vault, collection };
}

function storedRecord(backing: Record<string, string>) {
  return JSON.parse(backing[STORAGE_KEY] ?? "null") as {
    version: number;
    order: string[];
    channels: Record<
      string,
      {
        enabled: boolean;
        configured: boolean;
        config: TestConfig;
        credentialRef: string | null;
      }
    >;
  };
}

test("channel collection: empty storage leaves no order and lists every channel", async () => {
  const { collection } = makeCollection();
  await collection.load();

  expect(collection.order()).toEqual([]);
  expect(collection.available()).toEqual(["alpha", "beta", "free"]);
  expect(collection.skippedCount()).toBe(0);
  expect(collection.loadError()).toBeNull();
});

test("channel collection: add keeps configurable channels off and enables free ones", async () => {
  const { backing, collection } = makeCollection();
  await collection.load();

  expect(await collection.add("alpha")).toEqual({ ok: true });
  expect(collection.binding("alpha")).toEqual({
    enabled: false,
    configured: false,
    config: { mode: "default" },
    credentialRef: null,
  });
  expect(await collection.add("free")).toEqual({ ok: true });
  expect(collection.binding("free")).toEqual({
    enabled: true,
    configured: true,
    config: { mode: "default" },
    credentialRef: null,
  });

  const record = storedRecord(backing);
  expect(record.version).toBe(1);
  expect(record.order).toEqual(["alpha", "free"]);
  expect(record.channels.alpha.enabled).toBe(false);
  expect(record.channels.free.enabled).toBe(true);
});

test("channel collection: save stores config and credential and applies enableOnFirstSave", async () => {
  const { backing, collection } = makeCollection();
  await collection.load();
  await collection.add("alpha");

  expect(
    await collection.save(
      "alpha",
      { mode: "accurate" },
      { mode: "replace", value: { apiKey: "k-1" } },
    ),
  ).toEqual({ ok: true });

  const record = storedRecord(backing);
  expect(record.channels.alpha).toMatchObject({
    enabled: false,
    configured: true,
    config: { mode: "accurate" },
  });
  const credentialRef = record.channels.alpha.credentialRef!;
  expect(backing[`secret.test.${credentialRef}`]).toBe(JSON.stringify({ apiKey: "k-1" }));

  const enabled = makeCollection({ enableOnFirstSave: true });
  await enabled.collection.load();
  await enabled.collection.add("beta");
  expect(
    await enabled.collection.save(
      "beta",
      { mode: "basic" },
      { mode: "replace", value: { apiKey: "k-2" } },
    ),
  ).toEqual({ ok: true });
  expect(enabled.collection.isEnabled("beta")).toBe(true);

  // enableOnFirstSave applies only to the first save; an edited channel keeps its switch.
  await enabled.collection.setEnabled("beta", false);
  await enabled.collection.save("beta", { mode: "accurate" }, { mode: "keep" });
  expect(enabled.collection.isEnabled("beta")).toBe(false);
});

test("channel collection: enabling requires configuration and a readable credential", async () => {
  const { backing, collection } = makeCollection();
  await collection.load();
  await collection.add("alpha");

  expect(await collection.setEnabled("alpha", true)).toMatchObject({
    ok: false,
    key: "channel_unconfigured",
  });

  await collection.save("alpha", { mode: "basic" }, { mode: "clear" });
  expect(await collection.setEnabled("alpha", true)).toMatchObject({
    ok: false,
    key: "credential_unreadable",
  });

  await collection.save("alpha", { mode: "basic" }, { mode: "replace", value: { apiKey: "k" } });
  expect(await collection.setEnabled("alpha", true)).toEqual({ ok: true });
  expect(collection.isEnabled("alpha")).toBe(true);

  const record = storedRecord(backing);
  delete backing[`secret.test.${record.channels.alpha.credentialRef!}`];
  await collection.setEnabled("alpha", false);
  expect(await collection.setEnabled("alpha", true)).toMatchObject({
    ok: false,
    key: "credential_unreadable",
  });
});

test("channel collection: moveTo clamps and keeps the requested order", async () => {
  const { backing, collection } = makeCollection();
  await collection.load();
  await collection.add("alpha");
  await collection.add("beta");
  await collection.add("free");

  await collection.moveTo("free", -5);
  expect(collection.order()).toEqual(["free", "alpha", "beta"]);
  await collection.moveTo("alpha", 99);
  expect(collection.order()).toEqual(["free", "beta", "alpha"]);
  expect(storedRecord(backing).order).toEqual(["free", "beta", "alpha"]);
});

test("channel collection: remove deletes the channel and its credential", async () => {
  const { backing, collection } = makeCollection();
  await collection.load();
  await collection.add("alpha");
  await collection.save("alpha", { mode: "basic" }, { mode: "replace", value: { apiKey: "k" } });
  const ref = storedRecord(backing).channels.alpha.credentialRef!;

  expect(await collection.remove("alpha")).toEqual({ ok: true });

  expect(collection.order()).toEqual([]);
  expect(storedRecord(backing).channels.alpha).toBeUndefined();
  expect(backing[`secret.test.${ref}`]).toBeUndefined();
});

test("channel collection: skips stored channels this build does not know", async () => {
  const seed = JSON.stringify({
    version: 1,
    order: ["alpha", "ghost", "beta"],
    channels: {
      alpha: { enabled: false, configured: true, config: { mode: "basic" }, credentialRef: null },
      ghost: { enabled: true, configured: true, config: { legacy: true }, credentialRef: "r-1" },
      beta: { enabled: false, configured: false, config: { mode: "default" }, credentialRef: null },
    },
  });
  const { backing, collection } = makeCollection({ initial: { [STORAGE_KEY]: seed } });

  await collection.load();

  expect(collection.order()).toEqual(["alpha", "beta"]);
  expect(collection.skippedCount()).toBe(1);
  expect(backing[STORAGE_KEY]).toBe(seed);

  await collection.moveTo("beta", 0);
  const record = storedRecord(backing);
  expect(record.order).toEqual(["beta", "alpha", "ghost"]);
  expect(record.channels.ghost).toEqual({
    enabled: true,
    configured: true,
    config: { legacy: true },
    credentialRef: "r-1",
  });
});

test("channel collection: a malformed record fails the load without overwriting it", async () => {
  const seed = JSON.stringify({
    version: 1,
    order: ["alpha"],
    channels: { alpha: { enabled: false } },
  });
  const { backing, collection } = makeCollection({ initial: { [STORAGE_KEY]: seed } });

  await collection.load();

  expect(collection.loadError()).toMatchObject({ key: "storage_malformed" });
  expect(collection.order()).toEqual([]);
  expect(backing[STORAGE_KEY]).toBe(seed);
});
test("pre-acceptance: a failed collection load blocks writes", async () => {
  const malformed = JSON.stringify({
    version: 1,
    order: ["alpha"],
    channels: { alpha: { enabled: false } },
  });
  const { backing, collection } = makeCollection({ initial: { [STORAGE_KEY]: malformed } });
  await collection.load();
  const loadError = collection.loadError();
  expect(loadError).toMatchObject({ key: "storage_malformed" });
  const before = backing[STORAGE_KEY];

  expect(await collection.add("beta")).toMatchObject({
    ok: false,
    key: "storage_malformed",
    message: loadError!.message,
  });
  expect(
    await collection.save("alpha", { mode: "basic" }, { mode: "replace", value: { apiKey: "k" } }),
  ).toMatchObject({ ok: false, key: "storage_malformed" });
  expect(await collection.setEnabled("alpha", true)).toMatchObject({
    ok: false,
    key: "storage_malformed",
  });
  expect(await collection.moveTo("alpha", 0)).toMatchObject({
    ok: false,
    key: "storage_malformed",
  });
  expect(await collection.remove("alpha")).toMatchObject({
    ok: false,
    key: "storage_malformed",
  });
  expect(backing[STORAGE_KEY]).toBe(before);
  expect(Object.keys(backing).filter((key) => key.startsWith("secret.test."))).toEqual([]);

  // A successful reload clears the error and lets writes through again.
  backing[STORAGE_KEY] = JSON.stringify({
    version: 1,
    order: ["alpha"],
    channels: {
      alpha: { enabled: false, configured: true, config: { mode: "basic" }, credentialRef: null },
    },
  });
  await collection.load();
  expect(collection.loadError()).toBeNull();
  expect(await collection.add("beta")).toEqual({ ok: true });
});
test("pre-acceptance: keep requires a readable saved credential", async () => {
  const seed = JSON.stringify({
    version: 1,
    order: ["alpha"],
    channels: {
      alpha: {
        enabled: false,
        configured: true,
        config: { mode: "basic" },
        credentialRef: "ref-missing",
      },
    },
  });
  const { backing, collection } = makeCollection({ initial: { [STORAGE_KEY]: seed } });
  await collection.load();
  const before = backing[STORAGE_KEY];

  const blocked = await collection.save("alpha", { mode: "basic" }, { mode: "keep" });
  expect(blocked).toMatchObject({ ok: false, key: "credential_unreadable" });
  expect(backing[STORAGE_KEY]).toBe(before);
  expect(Object.keys(backing).filter((key) => key.startsWith("secret.test."))).toEqual([]);

  expect(
    await collection.save(
      "alpha",
      { mode: "accurate" },
      { mode: "replace", value: { apiKey: "k-1" } },
    ),
  ).toEqual({ ok: true });
  const record = storedRecord(backing);
  expect(record.channels.alpha.config).toEqual({ mode: "accurate" });
  const ref = record.channels.alpha.credentialRef!;
  expect(backing[`secret.test.${ref}`]).toBe(JSON.stringify({ apiKey: "k-1" }));

  // A readable record can be kept on a later save.
  expect(await collection.save("alpha", { mode: "basic" }, { mode: "keep" })).toEqual({
    ok: true,
  });
});
