import { expect, open, test } from "nsh/test";
import { CREDENTIAL_KEY_PREFIX, MODELS_STORAGE_KEY, PROVIDERS_STORAGE_KEY } from "./store";
import {
  makeChannel,
  makeSeedStorage,
  startDraftFromEmptyState,
  startDraftFromRail,
} from "./__tests__/fixtures";

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

test("provider channels: saves an empty OpenAI draft offline", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");

  await app.press("id:provider-preset-openai");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");

  expect(app.storage()["models.v2.providers"]).toBeUndefined();
  expect(app.requests()).toHaveLength(0);

  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "OpenAI Direct");

  await app.press("id:save-channel-button");
  await app.waitUntil(() => app.storage()["models.v2.providers"] !== undefined);

  expect(app.requests()).toHaveLength(0);

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  expect(reopened.shows("id:provider-editor")).toBe(true);
  expect(reopened.texts()).toContain("OpenAI Direct");
  expect(reopened.texts()).toContain("OpenAI Responses");
  expect(reopened.texts()).toContain("No models yet");
  expect(reopened.requests()).toHaveLength(0);
});

test("provider channels: Gemini has one fixed default API", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press("id:provider-preset-gemini");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");

  expect(app.value("id:channel-name-input")).toBe("Google Gemini");
  expect(app.value("id:connection-url-input")).toBe("https://generativelanguage.googleapis.com");
  expect(app.shows("id:connection-adapter-select")).toBe(false);
  expect(app.texts()).toContain("Gemini API");
  expect(app.texts()).not.toContain("OpenAI Chat Completions");
  expect(app.texts()).not.toContain("OpenAI Responses");
  expect(app.texts()).not.toContain("Anthropic Messages");
});

test("provider channels: Anthropic has one fixed default API", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press("id:provider-preset-anthropic");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");

  expect(app.value("id:channel-name-input")).toBe("Anthropic");
  expect(app.value("id:connection-url-input")).toBe("https://api.anthropic.com");
  expect(app.shows("id:connection-adapter-select")).toBe(false);
  expect(app.texts()).toContain("Anthropic Messages");
  expect(app.texts()).not.toContain("OpenAI Chat Completions");
  expect(app.texts()).not.toContain("Gemini API");
});

test("provider channels: OpenAI defaults to Responses and allows only Chat and Responses", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press("id:provider-preset-openai");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");

  expect(app.value("id:channel-name-input")).toBe("OpenAI");
  expect(app.value("id:connection-url-input")).toBe("https://api.openai.com/v1");
  expect(app.shows("id:connection-adapter-select")).toBe(true);
  expect(app.texts()).toContain("OpenAI Responses");

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(false);
  expect(app.shows("role:option[Gemini API]")).toBe(false);
  expect(app.shows("role:option[DeepSeek]")).toBe(false);
});

test("provider channels: DeepSeek allows Chat, Responses, and Messages without DeepSeek protocol", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press("id:provider-preset-deepseek");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");

  expect(app.value("id:channel-name-input")).toBe("DeepSeek");
  expect(app.value("id:connection-url-input")).toBe("https://api.deepseek.com");
  expect(app.texts()).toContain("OpenAI Chat Completions");

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(true);
  expect(app.shows("role:option[Gemini API]")).toBe(false);
  expect(app.shows("role:option[DeepSeek]")).toBe(false);
});

test("provider channels: Custom allows all four protocols with no preset URL", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:empty-add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  await app.press("id:provider-preset-custom");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  await app.waitFor("id:provider-editor");

  expect(app.value("id:channel-name-input")).toBe("Custom");
  expect(app.value("id:connection-url-input")).toBe("");
  expect(app.texts()).toContain("OpenAI Chat Completions");

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(true);
  expect(app.shows("role:option[Gemini API]")).toBe(true);
  expect(app.shows("role:option[DeepSeek]")).toBe(false);
});

test("provider channels: picker dismissal keeps selection and proxy URL keeps preset", async () => {
  const emptyApp = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await emptyApp.press("id:empty-add-channel-button");
  await emptyApp.waitFor("id:add-channel-dialog");
  expect(emptyApp.texts()).not.toContain("Base URL");
  expect(emptyApp.texts()).not.toContain("API Key");
  await emptyApp.press("role:button[Cancel]");
  await emptyApp.waitUntil(() => !emptyApp.shows("id:add-channel-dialog"));
  expect(emptyApp.shows("id:empty-add-channel-button")).toBe(true);
  expect(emptyApp.shows("id:provider-editor")).toBe(false);

  const savedChannel = makeChannel({ id: "ch-saved", displayName: "Saved OpenAI" });
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [savedChannel],
      credentials: { "ch-saved": "sk-dummy-saved" },
    }),
  });

  await app.press("id:add-channel-button");
  await app.waitFor("id:add-channel-dialog");
  expect(app.shows("id:connection-url-input")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  expect(app.texts()).toContain("Saved OpenAI");
  expect(app.shows("id:draft-channel-card")).toBe(false);

  await startDraftFromRail(app, "openai");
  expect(app.shows("id:draft-channel-card")).toBe(true);

  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://api.anthropic.com/gateway");
  expect(app.texts()).toContain("OpenAI");

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(false);
  expect(app.shows("role:option[Gemini API]")).toBe(false);
});

test("provider channels: edits manual models before first save", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "openai");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "not-a-real-model");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));
  await app.waitFor("id:model-row-not-a-real-model");

  await app.press("id:configure-model-not-a-real-model");
  await app.waitFor("id:edit-model-dialog");
  await app.type("id:edit-model-name-input", "Custom Offline Model");
  await app.press("id:edit-model-cap-image");
  await app.press("id:edit-model-cap-pdf");
  await app.type("id:edit-model-context-input", "64000");
  await app.type("id:edit-model-max-tokens-input", "4096");
  await app.press("id:confirm-edit-model");
  await app.waitUntil(() => !app.shows("id:edit-model-dialog"));

  expect(app.texts()).toContain("Custom Offline Model");
  expect(app.texts()).toContain("64K ctx");
  expect(app.texts()).toContain("4096 out");

  // Manual models start enabled; toggling updates in memory and stays persisted-free.
  await app.press("id:toggle-model-not-a-real-model");
  await app.press("id:models-filter-select");
  await app.waitFor("role:option[Disabled]");
  await app.press("role:option[Disabled]");
  expect(app.shows("id:model-row-not-a-real-model")).toBe(true);

  await app.press("id:toggle-model-not-a-real-model");
  expect(app.shows("id:model-row-not-a-real-model")).toBe(false);
  await app.press("id:models-filter-select");
  await app.waitFor("role:option[All]");
  await app.press("role:option[All]");
  expect(app.shows("id:model-row-not-a-real-model")).toBe(true);

  const storage = app.storage();
  expect(storage[PROVIDERS_STORAGE_KEY]).toBeUndefined();
  expect(storage[MODELS_STORAGE_KEY]).toBeUndefined();
  expect(Object.keys(storage).some((k) => k.startsWith(CREDENTIAL_KEY_PREFIX))).toBe(false);
});

test("provider channels: removes draft model entries without writing storage", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "openai");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "draft-model-1");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "draft-model-2");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  expect(app.shows("id:model-row-draft-model-1")).toBe(true);
  expect(app.shows("id:model-row-draft-model-2")).toBe(true);

  await app.press("id:select-models-button");
  await app.press("id:select-model-draft-model-1");
  await app.press("id:bulk-delete-models-button");
  await app.waitFor("id:bulk-delete-models-dialog");
  await app.press("role:button[Delete]");
  await app.waitUntil(() => !app.shows("id:bulk-delete-models-dialog"));

  expect(app.shows("id:model-row-draft-model-1")).toBe(false);
  expect(app.shows("id:model-row-draft-model-2")).toBe(true);

  const storage = app.storage();
  expect(storage[PROVIDERS_STORAGE_KEY]).toBeUndefined();
  expect(storage[MODELS_STORAGE_KEY]).toBeUndefined();
  expect(Object.keys(storage).some((k) => k.startsWith(CREDENTIAL_KEY_PREFIX))).toBe(false);
});

test("provider channels: closing model dialogs keeps channel draft intact", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "openai");
  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "My Draft Channel");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "never-added-model");
  await app.press("id:add-model-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  expect(app.shows("id:draft-channel-card")).toBe(true);
  expect(app.value("id:channel-name-input")).toBe("My Draft Channel");
  expect(app.shows("id:model-row-never-added-model")).toBe(false);

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "kept-draft-model");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  await app.press("id:configure-model-kept-draft-model");
  await app.waitFor("id:edit-model-dialog");
  await app.type("id:edit-model-name-input", "Ignored Name");
  await app.press("id:edit-model-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:edit-model-dialog"));

  expect(app.shows("id:draft-channel-card")).toBe(true);
  expect(app.value("id:channel-name-input")).toBe("My Draft Channel");
  expect(app.shows("id:model-row-kept-draft-model")).toBe(true);
  expect(app.texts()).not.toContain("Ignored Name");
  expect(app.storage()[PROVIDERS_STORAGE_KEY]).toBeUndefined();
  expect(app.storage()[MODELS_STORAGE_KEY]).toBeUndefined();
});
