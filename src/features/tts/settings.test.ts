import { expect, test } from "nsh/test";
import { ttsChannelContributions } from "../../contributions/tts";
import { DEFAULT_GOOGLE_VOICE_PREFERENCES } from "../../contributions/tts/vendor/google-preferences";
import {
  createChannelCollection,
  type ChannelCollection,
} from "../../framework/contributions/channel-collection";
import { createCredentialVault } from "../../framework/contributions/credential-vault";
import {
  createContributionRegistry,
  getContributionRegistry,
  setContributionRegistry,
} from "../../framework/contributions/registry";

const STORAGE_KEY = "integrations.tts.v1";
const VAULT_NAMESPACE = "secret.tts";

function memoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  const storage = {
    getItem: async (key: string) => backing[key] ?? null,
    setItem: async (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: async (key: string) => {
      delete backing[key];
    },
  };
  return { backing, storage };
}

function makeStore(initial: Record<string, string> = {}) {
  const memory = memoryStorage(initial);
  const registry = createContributionRegistry();
  for (const contribution of ttsChannelContributions) registry.registerCapability(contribution);
  setContributionRegistry(registry);
  const collection: ChannelCollection = createChannelCollection({
    capability: "tts",
    storage: memory.storage,
    storageKey: STORAGE_KEY,
    vault: createCredentialVault({ storage: memory.storage, namespace: VAULT_NAMESPACE }),
    contributions: () => getContributionRegistry().capabilities("tts"),
    policy: { enableOnFirstSave: false, requireReadableCredentialOnEnable: true },
  });
  return { ...memory, collection };
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
        config: { preferences?: unknown; region?: string };
        credentialRef: string | null;
      }
    >;
  };
}

test("tts store: starts empty and offers both channels", async () => {
  const { backing, collection } = makeStore();
  await collection.load();

  expect(collection.order()).toEqual([]);
  expect(collection.available()).toEqual(["google-cloud", "azure"]);
  expect(collection.activeChannel()).toBeNull();
  expect(collection.loadError()).toBeNull();
  expect(collection.skippedCount()).toBe(0);
  expect(backing[STORAGE_KEY]).toBeUndefined();
});

test("tts store: adding a channel keeps it disabled and persists defaults", async () => {
  const { backing, collection } = makeStore();
  await collection.load();

  expect(await collection.add("azure")).toEqual({ ok: true });
  expect(collection.order()).toEqual(["azure"]);
  expect(collection.available()).toEqual(["google-cloud"]);
  expect(collection.isEnabled("azure")).toBe(false);
  expect(collection.binding("azure")).toEqual({
    enabled: false,
    configured: false,
    config: { region: "" },
    credentialRef: null,
  });

  const record = storedRecord(backing);
  expect(record).toEqual({
    version: 1,
    order: ["azure"],
    channels: {
      azure: { enabled: false, configured: false, config: { region: "" }, credentialRef: null },
    },
  });

  const writes = JSON.stringify(backing);
  await collection.add("azure");
  expect(JSON.stringify(backing)).toBe(writes);
});

test("tts store: saving stores config and credential under enableOnFirstSave false", async () => {
  const { backing, collection } = makeStore();
  await collection.load();
  await collection.add("google-cloud");

  const preferences = {
    ...DEFAULT_GOOGLE_VOICE_PREFERENCES,
    voiceTier: "neural2" as const,
    speakingRate: 1.25,
  };
  expect(
    await collection.save(
      "google-cloud",
      { preferences },
      { mode: "replace", value: { apiKey: "tts-key" } },
    ),
  ).toEqual({ ok: true });

  const binding = collection.binding("google-cloud");
  expect(binding).toMatchObject({ enabled: false, configured: true });
  expect(binding?.config).toEqual({ preferences });
  expect(binding?.credentialRef).not.toBeNull();

  const record = storedRecord(backing);
  expect(record.order).toEqual(["google-cloud"]);
  expect(record.channels["google-cloud"]).toMatchObject({
    enabled: false,
    configured: true,
    config: { preferences },
  });
  const ref = record.channels["google-cloud"].credentialRef!;
  expect(backing[`${VAULT_NAMESPACE}.${ref}`]).toBe(JSON.stringify({ apiKey: "tts-key" }));
  expect(backing[STORAGE_KEY]!.includes("tts-key")).toBe(false);
  expect(collection.activeChannel()).toBeNull();
});

test("tts store: enabling requires a readable saved credential", async () => {
  const { backing, collection } = makeStore();
  await collection.load();
  await collection.add("google-cloud");
  await collection.save(
    "google-cloud",
    { preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES },
    { mode: "replace", value: { apiKey: "tts-key" } },
  );
  const ref = storedRecord(backing).channels["google-cloud"].credentialRef!;

  expect(await collection.setEnabled("google-cloud", true)).toEqual({ ok: true });
  expect(collection.isEnabled("google-cloud")).toBe(true);
  expect(collection.activeChannel()?.id).toBe("google-cloud");

  expect(await collection.setEnabled("google-cloud", false)).toEqual({ ok: true });
  delete backing[`${VAULT_NAMESPACE}.${ref}`];
  const missing = await collection.setEnabled("google-cloud", true);
  expect(missing).toMatchObject({ ok: false, key: "credential_unreadable" });
  expect(collection.isEnabled("google-cloud")).toBe(false);

  backing[`${VAULT_NAMESPACE}.${ref}`] = JSON.stringify({ apiKey: 1 });
  expect(await collection.setEnabled("google-cloud", true)).toMatchObject({
    ok: false,
    key: "credential_unreadable",
  });

  backing[`${VAULT_NAMESPACE}.${ref}`] = JSON.stringify({ apiKey: "tts-key" });
  expect(await collection.setEnabled("google-cloud", true)).toEqual({ ok: true });
});

test("tts store: reorders channels and persists the priority", async () => {
  const { backing, collection } = makeStore();
  await collection.load();
  await collection.add("google-cloud");
  await collection.add("azure");

  expect(await collection.moveTo("azure", 0)).toEqual({ ok: true });
  expect(collection.order()).toEqual(["azure", "google-cloud"]);
  expect(storedRecord(backing).order).toEqual(["azure", "google-cloud"]);

  const reopened = makeStore(backing);
  await reopened.collection.load();
  expect(reopened.collection.order()).toEqual(["azure", "google-cloud"]);
});

test("tts store: removing a channel clears its vault record", async () => {
  const { backing, collection } = makeStore();
  await collection.load();
  await collection.add("azure");
  await collection.save(
    "azure",
    { region: "eastus" },
    { mode: "replace", value: { apiKey: "azure-key" } },
  );
  const ref = storedRecord(backing).channels.azure.credentialRef!;
  expect(backing[`${VAULT_NAMESPACE}.${ref}`]).toBe(JSON.stringify({ apiKey: "azure-key" }));

  expect(await collection.remove("azure")).toEqual({ ok: true });
  expect(collection.order()).toEqual([]);
  expect(collection.binding("azure")).toBeNull();
  expect(storedRecord(backing).channels.azure).toBeUndefined();
  expect(backing[`${VAULT_NAMESPACE}.${ref}`]).toBeUndefined();
});

test("tts store: malformed stored config fails the load without overwriting it", async () => {
  const seed = JSON.stringify({
    version: 1,
    order: ["google-cloud"],
    channels: {
      "google-cloud": {
        enabled: true,
        configured: true,
        config: { preferences: { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, pitch: 99 } },
        credentialRef: null,
      },
    },
  });
  const { backing, collection } = makeStore({ [STORAGE_KEY]: seed });

  await collection.load();

  expect(collection.loadError()).toMatchObject({ key: "storage_malformed" });
  expect(collection.order()).toEqual([]);
  expect(collection.activeChannel()).toBeNull();
  expect(backing[STORAGE_KEY]).toBe(seed);
});

test("tts store: describe formats each saved channel", async () => {
  const { collection } = makeStore();
  await collection.load();
  await collection.add("azure");
  await collection.save(
    "azure",
    { region: "westus2" },
    { mode: "replace", value: { apiKey: "azure-key" } },
  );
  expect(collection.describe("azure")).toBe("westus2");
});
