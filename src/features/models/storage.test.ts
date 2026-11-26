import { expect, open, test } from "nsh/test";
import { CREDENTIAL_KEY_PREFIX, MODELS_STORAGE_KEY, PROVIDERS_STORAGE_KEY } from "./store";
import type { ProviderChannel } from "../../modules/ai/contracts/channel";
import type { ProviderModel } from "../../modules/ai/contracts/model";

const APP_ENTRY = "../../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

function createStorageMock(
  initial: Record<string, string> = { "settings.language": "en" },
  onSet?: (key: string, value: string, backing: Record<string, string>) => Promise<void> | void,
) {
  const backing: Record<string, string> = { ...initial };
  return {
    backing,
    modules: {
      nsh: {
        "Storage.getItem": (key: string) => backing[key] ?? null,
        "Storage.setItem": async (key: string, value: string) => {
          if (onSet) {
            await onSet(key, value, backing);
          }
          backing[key] = value;
        },
        "Storage.removeItem": (key: string) => {
          delete backing[key];
        },
      },
    },
  };
}

async function prepareOpenAIDraftWithModel(
  app: Awaited<ReturnType<typeof open>>,
  name: string,
  token: string,
  modelKey: string,
) {
  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press("id:provider-preset-openai");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));

  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", name);
  await app.type("id:connection-token-input", token);

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", modelKey);
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));
}

test("provider storage: partial draft save retains unsaved models", async () => {
  let rejectModelsWrite = true;
  const mock = createStorageMock({ "settings.language": "en" }, (key) => {
    if (key === MODELS_STORAGE_KEY && rejectModelsWrite) {
      rejectModelsWrite = false;
      throw new Error("ERR_NSH_QUOTA_EXCEEDED: storage quota exceeded");
    }
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: mock.backing,
    modules: mock.modules,
  });

  await prepareOpenAIDraftWithModel(app, "OpenAI Partial", "sk-partial", "local-m1");

  // First Save: channel and credential succeed, models write fails.
  await app.press("id:save-channel-button");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Channel settings were saved, but the models")),
  );

  expect(app.shows("id:cancel-channel-button")).toBe(true);
  expect(app.shows("id:model-row-local-m1")).toBe(true);
  expect(app.texts()).not.toContain("Added channel OpenAI Partial");

  const channelsAfterFail = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  expect(channelsAfterFail).toHaveLength(1);
  const partialChannel = channelsAfterFail[0]!;
  expect(mock.backing[`${CREDENTIAL_KEY_PREFIX}${partialChannel.id}`]).toBe("sk-partial");
  expect(mock.backing[MODELS_STORAGE_KEY]).toBeUndefined();

  // Retry Save: finishes remaining unsaved models without duplicating the channel.
  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  const channels = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  const models = JSON.parse(mock.backing[MODELS_STORAGE_KEY]!) as ProviderModel[];
  expect(channels).toHaveLength(1);
  expect(channels[0]!.id).toBe(partialChannel.id);
  expect(models).toHaveLength(1);
  expect(models[0]!.providerId).toBe(partialChannel.id);
  expect(models[0]!.modelKey).toBe("local-m1");
  expect(mock.backing[PROVIDERS_STORAGE_KEY]).not.toContain("sk-partial");
  expect(mock.backing[MODELS_STORAGE_KEY]).not.toContain("sk-partial");
  expect(app.shows("id:model-row-local-m1")).toBe(true);
});

test("provider storage: discarding after partial save preserves already saved channel", async () => {
  const mock = createStorageMock({ "settings.language": "en" }, (key) => {
    if (key === MODELS_STORAGE_KEY) {
      throw new Error("ERR_NSH_QUOTA_EXCEEDED");
    }
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: mock.backing,
    modules: mock.modules,
  });

  await prepareOpenAIDraftWithModel(app, "OpenAI Keep Saved", "sk-keep", "unsaved-m1");

  await app.press("id:save-channel-button");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Channel settings were saved, but the models")),
  );

  await app.press("id:cancel-channel-button");
  await app.waitFor("id:discard-draft-dialog");
  await app.press("id:discard-draft-dialog >> role:button[Discard]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));

  const channels = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  expect(channels).toHaveLength(1);
  expect(channels[0]!.displayName).toBe("OpenAI Keep Saved");
  expect(mock.backing[`${CREDENTIAL_KEY_PREFIX}${channels[0]!.id}`]).toBe("sk-keep");
  expect(mock.backing[MODELS_STORAGE_KEY]).toBeUndefined();
  expect(app.texts()).toContain("OpenAI Keep Saved");
  expect(app.shows("id:model-row-unsaved-m1")).toBe(false);
});

test("provider storage: channel write failure recovers cleanly on retry without duplicate writes", async () => {
  let rejectProviderWrite = true;
  let credentialWrites = 0;
  const mock = createStorageMock({ "settings.language": "en" }, (key) => {
    if (key.startsWith(CREDENTIAL_KEY_PREFIX)) {
      credentialWrites += 1;
    }
    if (key === PROVIDERS_STORAGE_KEY && rejectProviderWrite) {
      rejectProviderWrite = false;
      throw new Error("ERR_NSH_QUOTA_EXCEEDED");
    }
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: mock.backing,
    modules: mock.modules,
  });

  await prepareOpenAIDraftWithModel(app, "OpenAI Channel Retry", "sk-ch-retry", "m-ch-retry");

  await app.press("id:save-channel-button");
  await app.waitUntil(() => app.texts().some((t) => t.includes("API key was saved")));
  expect(mock.backing[PROVIDERS_STORAGE_KEY]).toBeUndefined();
  expect(mock.backing[MODELS_STORAGE_KEY]).toBeUndefined();
  expect(app.texts()).not.toContain("Added channel OpenAI Channel Retry");

  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  const channels = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  const models = JSON.parse(mock.backing[MODELS_STORAGE_KEY]!) as ProviderModel[];
  expect(channels).toHaveLength(1);
  expect(models).toHaveLength(1);
  expect(credentialWrites).toBe(1);
});

test("provider storage: credential write failure leaves storage empty until retry succeeds", async () => {
  let rejectCredentialWrite = true;
  const mock = createStorageMock({ "settings.language": "en" }, (key) => {
    if (key.startsWith(CREDENTIAL_KEY_PREFIX) && rejectCredentialWrite) {
      rejectCredentialWrite = false;
      throw new Error("Keychain unavailable");
    }
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: mock.backing,
    modules: mock.modules,
  });

  await prepareOpenAIDraftWithModel(app, "OpenAI Cred Retry", "sk-cred", "m-cred");

  await app.press("id:save-channel-button");
  await app.waitUntil(() => app.texts().some((t) => t.includes("Could not save the API key")));
  expect(mock.backing[PROVIDERS_STORAGE_KEY]).toBeUndefined();
  expect(mock.backing[MODELS_STORAGE_KEY]).toBeUndefined();

  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  const channels = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  const models = JSON.parse(mock.backing[MODELS_STORAGE_KEY]!) as ProviderModel[];
  expect(channels).toHaveLength(1);
  expect(models).toHaveLength(1);
  expect(mock.backing[`${CREDENTIAL_KEY_PREFIX}${channels[0]!.id}`]).toBe("sk-cred");
});

test("provider storage: delayed duplicate Save disables resubmission without duplicate records", async () => {
  let resolveProvidersWrite!: () => void;
  let providerWriteCount = 0;
  const mock = createStorageMock({ "settings.language": "en" }, (key) => {
    if (key === PROVIDERS_STORAGE_KEY) {
      providerWriteCount += 1;
      if (providerWriteCount === 1) {
        return new Promise<void>((resolve) => {
          resolveProvidersWrite = resolve;
        });
      }
    }
    return undefined;
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: mock.backing,
    modules: mock.modules,
  });

  await prepareOpenAIDraftWithModel(app, "OpenAI Slow Save", "sk-slow", "m-slow");

  const firstSave = app.press("id:save-channel-button");
  await app.waitUntil(() => providerWriteCount === 1);
  expect(app.enabled("id:save-channel-button")).toBe(false);
  await expect(app.press("id:save-channel-button")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_DISABLED",
  });

  resolveProvidersWrite();
  await firstSave;
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  const channels = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  const models = JSON.parse(mock.backing[MODELS_STORAGE_KEY]!) as ProviderModel[];
  expect(channels).toHaveLength(1);
  expect(models).toHaveLength(1);
  expect(providerWriteCount).toBe(1);
});

test("provider storage: clearing key before channel retry removes orphaned credential", async () => {
  let rejectProviderWrite = true;
  const mock = createStorageMock({ "settings.language": "en" }, (key) => {
    if (key === PROVIDERS_STORAGE_KEY && rejectProviderWrite) {
      rejectProviderWrite = false;
      throw new Error("ERR_NSH_QUOTA_EXCEEDED");
    }
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: mock.backing,
    modules: mock.modules,
  });

  await prepareOpenAIDraftWithModel(app, "OpenAI Clear Secret", "sk-orphan", "m-clear");

  await app.press("id:save-channel-button");
  await app.waitUntil(() => app.texts().some((t) => t.includes("API key was saved")));

  // User clears the API key before retrying Save.
  await app.clear("id:connection-token-input");
  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  const channels = JSON.parse(mock.backing[PROVIDERS_STORAGE_KEY]!) as ProviderChannel[];
  expect(channels).toHaveLength(1);
  expect(channels[0]!.hasCredential).toBe(false);
  expect(mock.backing[`${CREDENTIAL_KEY_PREFIX}${channels[0]!.id}`]).toBeUndefined();
});
