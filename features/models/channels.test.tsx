import { expect, open, type StubResponse, test } from "nsh/test";
import { CREDENTIAL_KEY_PREFIX, MODELS_STORAGE_KEY, PROVIDERS_STORAGE_KEY } from "./store";
import type { ProviderModel } from "./types";
import {
  makeChannel,
  makeModel,
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

test("provider channels: models inherit default API until overridden", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "openai");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.press("id:add-model-api-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  expect(app.shows("role:option[Use channel default]")).toBe(true);
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(false);
  expect(app.shows("role:option[Gemini API]")).toBe(false);
  await app.press("role:option[Use channel default]");
  await app.type("id:add-model-key-input", "model-inherited");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "model-chat");
  await app.press("id:add-model-api-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  expect(app.shows("id:model-row-model-inherited >> text:Default (OpenAI Responses)")).toBe(true);
  expect(app.shows("id:model-row-model-chat >> text:OpenAI Chat Completions")).toBe(true);

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");

  expect(app.shows("id:model-row-model-inherited >> text:Default (OpenAI Chat Completions)")).toBe(
    true,
  );
  expect(app.shows("id:model-row-model-chat >> text:OpenAI Chat Completions")).toBe(true);

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Responses]");
  await app.press("role:option[OpenAI Responses]");

  expect(app.shows("id:model-row-model-inherited >> text:Default (OpenAI Responses)")).toBe(true);
  expect(app.shows("id:model-row-model-chat >> text:OpenAI Chat Completions")).toBe(true);
});

test("provider channels: clearing a model override restores inheritance", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "openai");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "model-clearable");
  await app.press("id:add-model-api-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));
  expect(app.shows("id:model-row-model-clearable >> text:OpenAI Chat Completions")).toBe(true);

  await app.press("id:configure-model-model-clearable");
  await app.waitFor("id:edit-model-dialog");
  await app.press("id:edit-model-api-select");
  await app.waitFor("role:option[Use channel default]");
  expect(app.shows("role:option[OpenAI Chat Completions]")).toBe(true);
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(false);
  expect(app.shows("role:option[Gemini API]")).toBe(false);
  await app.press("role:option[Use channel default]");
  await app.press("id:confirm-edit-model");
  await app.waitUntil(() => !app.shows("id:edit-model-dialog"));

  expect(app.shows("id:model-row-model-clearable >> text:Default (OpenAI Responses)")).toBe(true);

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");
  expect(app.shows("id:model-row-model-clearable >> text:Default (OpenAI Chat Completions)")).toBe(
    true,
  );
});

test("provider channels: saved channel editor filters model overrides and preserves inheritance", async () => {
  const channel = makeChannel({
    id: "ch-saved-openai",
    presetId: "openai",
    displayName: "Saved OpenAI",
    adapterId: "openai-responses",
  });
  const inheritedFromChatSource = makeModel({
    id: "m-inherited",
    providerId: channel.id,
    modelKey: "gpt-4.1",
    sourceAdapterId: "openai-compatible",
    apiTypeOverride: null,
    enabled: true,
  });
  const overriddenModel = makeModel({
    id: "m-overridden",
    providerId: channel.id,
    modelKey: "gpt-4o-mini",
    sourceAdapterId: "openai-responses",
    apiTypeOverride: "openai-compatible",
    enabled: true,
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [channel],
      models: [inheritedFromChatSource, overriddenModel],
      credentials: { [channel.id]: "sk-dummy-openai" },
    }),
  });

  expect(app.shows("id:model-row-gpt-4.1 >> text:Default (OpenAI Responses)")).toBe(true);
  expect(app.shows("id:model-row-gpt-4o-mini >> text:OpenAI Chat Completions")).toBe(true);

  await app.press("id:configure-model-gpt-4o-mini");
  await app.waitFor("id:edit-model-dialog");
  await app.press("id:edit-model-api-select");
  await app.waitFor("role:option[Use channel default]");
  expect(app.shows("role:option[OpenAI Chat Completions]")).toBe(true);
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Anthropic Messages]")).toBe(false);
  await app.press("role:option[Use channel default]");
  await app.press("id:confirm-edit-model");
  await app.waitUntil(() => !app.shows("id:edit-model-dialog"));

  expect(app.shows("id:model-row-gpt-4o-mini >> text:Default (OpenAI Responses)")).toBe(true);

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");
  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:save-channel-button"));

  expect(app.shows("id:model-row-gpt-4.1 >> text:Default (OpenAI Chat Completions)")).toBe(true);
  expect(app.shows("id:model-row-gpt-4o-mini >> text:Default (OpenAI Chat Completions)")).toBe(
    true,
  );

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  expect(reopened.shows("id:model-row-gpt-4.1 >> text:Default (OpenAI Chat Completions)")).toBe(
    true,
  );
  expect(reopened.shows("id:model-row-gpt-4o-mini >> text:Default (OpenAI Chat Completions)")).toBe(
    true,
  );
});

test("provider channels: DeepSeek model allows Messages override without Gemini", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "deepseek");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "deepseek-reasoner");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "deepseek-chat");
  await app.press("id:add-model-api-select");
  await app.waitFor("role:option[Anthropic Messages]");
  expect(app.shows("role:option[Use channel default]")).toBe(true);
  expect(app.shows("role:option[OpenAI Chat Completions]")).toBe(true);
  expect(app.shows("role:option[OpenAI Responses]")).toBe(true);
  expect(app.shows("role:option[Gemini API]")).toBe(false);
  expect(app.shows("role:option[DeepSeek]")).toBe(false);
  await app.press("role:option[Anthropic Messages]");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  expect(
    app.shows("id:model-row-deepseek-reasoner >> text:Default (OpenAI Chat Completions)"),
  ).toBe(true);
  expect(app.shows("id:model-row-deepseek-chat >> text:Anthropic Messages")).toBe(true);

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Responses]");
  await app.press("role:option[OpenAI Responses]");

  expect(app.shows("id:model-row-deepseek-reasoner >> text:Default (OpenAI Responses)")).toBe(true);
  expect(app.shows("id:model-row-deepseek-chat >> text:Anthropic Messages")).toBe(true);
});

test("provider channels: draft discovery uses current proxy inputs", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    network: {
      "GET https://proxy.example.com/custom-prefix/models": {
        status: 200,
        body: {
          data: [{ id: "gpt-4.1-mini", display_name: "GPT-4.1 Mini" }],
        },
      },
    },
  });

  await startDraftFromEmptyState(app, "openai");
  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");

  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://proxy.example.com/custom-prefix/");
  await app.type("id:connection-token-input", "sk-draft-proxy-key");

  await app.press("id:get-models-button");
  await app.waitFor("id:model-row-gpt-4.1-mini");

  expect(app.requests()).toHaveLength(1);
  expect(app.requests()[0]!.url).toBe("https://proxy.example.com/custom-prefix/models");
  expect(app.requests()[0]!.headers.authorization).toBe("Bearer sk-draft-proxy-key");
  expect(app.shows("id:model-row-gpt-4.1-mini >> text:Default (OpenAI Chat Completions)")).toBe(
    true,
  );
  expect(app.storage()[PROVIDERS_STORAGE_KEY]).toBeUndefined();
  expect(app.storage()[MODELS_STORAGE_KEY]).toBeUndefined();
});

test("provider channels: dirty saved editor tests and fetches with keep, replace, and clear credentials", async () => {
  const channel = makeChannel({
    id: "ch-dirty-saved",
    presetId: "openai",
    displayName: "Dirty Saved",
    adapterId: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    hasCredential: true,
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [channel],
      credentials: { [channel.id]: "sk-saved-secret" },
    }),
    network: {
      "GET https://proxy.example.com/v1/models": {
        status: 200,
        body: { data: [{ id: "gpt-4.1-mini" }] },
      },
    },
  });

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Responses]");
  await app.press("role:option[OpenAI Responses]");
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://proxy.example.com/v1");

  await app.press("id:test-connection-button");
  await app.waitUntil(() => app.requests().length === 1);
  expect(app.requests()[0]!.url).toBe("https://proxy.example.com/v1/models");
  expect(app.requests()[0]!.headers.authorization).toBe("Bearer sk-saved-secret");

  await app.type("id:connection-token-input", "sk-replacement-secret");
  await app.press("id:test-connection-button");
  await app.waitUntil(() => app.requests().length === 2);
  expect(app.requests()[1]!.headers.authorization).toBe("Bearer sk-replacement-secret");

  await app.press("id:clear-token-button");
  await app.press("id:get-models-button");
  await app.waitFor("id:model-row-gpt-4.1-mini");
  expect(app.requests()).toHaveLength(3);
  expect(app.requests()[2]!.headers.authorization).toBeUndefined();

  const stored = JSON.parse(app.storage()[PROVIDERS_STORAGE_KEY]!) as Array<{
    baseUrl: string | null;
  }>;
  expect(stored[0]!.baseUrl).toBe("https://api.openai.com/v1");
});

test("provider channels: Custom without URL saves locally but rejects network actions", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "custom");
  expect(app.value("id:connection-url-input")).toBe("");

  await app.press("id:test-connection-button");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Base URL is required before testing or fetching models.")),
  );
  expect(app.requests()).toHaveLength(0);

  await app.press("id:get-models-button");
  await app.waitUntil(() =>
    app
      .texts()
      .some((t) =>
        t.includes("Sync error: Base URL is required before testing or fetching models."),
      ),
  );
  expect(app.requests()).toHaveLength(0);

  await app.press("id:save-channel-button");
  await app.waitUntil(() => app.storage()[PROVIDERS_STORAGE_KEY] !== undefined);
  expect(app.requests()).toHaveLength(0);

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  expect(reopened.value("id:connection-url-input")).toBe("");
  await reopened.press("id:test-connection-button");
  await reopened.waitUntil(() =>
    reopened
      .texts()
      .some((t) => t.includes("Base URL is required before testing or fetching models.")),
  );
  expect(reopened.requests()).toHaveLength(0);
});

test("provider channels: resync preserves one configured model per ID", async () => {
  const deepseek = makeChannel({
    id: "ch-deepseek",
    presetId: "deepseek",
    displayName: "DeepSeek",
    adapterId: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [deepseek],
      credentials: { [deepseek.id]: "sk-ds-dummy" },
    }),
    network: {
      "GET https://api.deepseek.com/models": {
        status: 200,
        body: { data: [{ id: "deepseek-chat", display_name: "DeepSeek Chat" }] },
      },
      "GET https://proxy.example.com/ds/models": {
        status: 200,
        body: { data: [{ id: "deepseek-chat", display_name: "DeepSeek V4" }] },
      },
    },
  });

  await app.press("id:get-models-button");
  await app.waitFor("id:model-row-deepseek-chat");

  await app.press("id:toggle-model-deepseek-chat");
  await app.press("id:configure-model-deepseek-chat");
  await app.waitFor("id:edit-model-dialog");
  await app.type("id:edit-model-name-input", "DeepSeek Primary");
  await app.press("id:edit-model-api-select");
  await app.waitFor("role:option[Anthropic Messages]");
  await app.press("role:option[Anthropic Messages]");
  await app.type("id:edit-model-context-input", "128000");
  await app.type("id:edit-model-max-tokens-input", "8192");
  await app.press("id:confirm-edit-model");
  await app.waitUntil(() => !app.shows("id:edit-model-dialog"));

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Responses]");
  await app.press("role:option[OpenAI Responses]");
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://proxy.example.com/ds");

  await app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 2);

  expect(app.count("id:model-row-deepseek-chat")).toBe(1);
  expect(app.texts()).toContain("DeepSeek Primary");
  expect(app.shows("id:model-row-deepseek-chat >> text:Anthropic Messages")).toBe(true);
  expect(app.texts()).toContain("128K ctx");
  expect(app.texts()).toContain("8192 out");

  await app.press("id:models-filter-select");
  await app.waitFor("role:option[Enabled]");
  await app.press("role:option[Enabled]");
  expect(app.count("id:model-row-deepseek-chat")).toBe(1);
});

test("provider channels: resync tracks missing, manual, duplicate IDs, and failed syncs across reopen", async () => {
  const deepseek = makeChannel({
    id: "ch-deepseek",
    presetId: "deepseek",
    displayName: "DeepSeek",
    adapterId: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
  });
  const seededChat = makeModel({
    id: "m-ds-chat",
    providerId: deepseek.id,
    modelKey: "deepseek-chat",
    sourceAdapterId: "openai-compatible",
    origin: "remote",
    syncStatus: "active",
    enabled: true,
    displayName: "DeepSeek Chat",
  });
  const seededLegacy = makeModel({
    id: "m-ds-legacy",
    providerId: deepseek.id,
    modelKey: "legacy-ds",
    sourceAdapterId: "openai-compatible",
    origin: "remote",
    syncStatus: "active",
    enabled: false,
    displayName: "Legacy DS",
  });
  const seededManual = makeModel({
    id: "m-ds-manual",
    providerId: deepseek.id,
    modelKey: "manual-custom",
    sourceAdapterId: "openai-compatible",
    origin: "manual",
    syncStatus: "active",
    enabled: true,
    displayNameOverride: "Manual Custom",
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [deepseek],
      models: [seededChat, seededLegacy, seededManual],
      credentials: { [deepseek.id]: "sk-ds-dummy" },
    }),
    network: {
      "GET https://api.deepseek.com/models": {
        status: 200,
        body: {
          data: [
            { id: "deepseek-chat", display_name: "DeepSeek Chat" },
            { id: "deepseek-reasoner", display_name: "DeepSeek Reasoner" },
          ],
        },
      },
      "GET https://fail.deepseek.example.com/models": {
        status: 500,
        body: { error: { message: "Upstream catalog unavailable" } },
      },
    },
  });

  await app.press("id:get-models-button");
  await app.waitFor("id:model-row-deepseek-reasoner");

  expect(app.shows("id:model-row-legacy-ds >> text:Missing")).toBe(true);
  expect(app.shows("id:model-row-manual-custom")).toBe(true);
  expect(app.shows("id:model-row-manual-custom >> text:Missing")).toBe(false);

  // Adding a manual duplicate ID under a different API override is rejected.
  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "deepseek-chat");
  await app.press("id:add-model-api-select");
  await app.waitFor("role:option[Anthropic Messages]");
  await app.press("role:option[Anthropic Messages]");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes('Model "deepseek-chat" already exists in this channel.')),
  );
  expect(app.shows("id:add-model-dialog")).toBe(true);
  expect(app.count("id:model-row-deepseek-chat")).toBe(1);
  await app.press("id:add-model-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  // A failed fetch preserves the current model list.
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://fail.deepseek.example.com");
  await app.press("id:get-models-button");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Provider returned server error (HTTP 500)")),
  );

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  await reopened.waitFor("id:model-row-deepseek-reasoner");

  expect(reopened.count("id:model-row-deepseek-chat")).toBe(1);
  expect(reopened.shows("id:model-row-legacy-ds >> text:Missing")).toBe(true);
  expect(reopened.shows("id:model-row-manual-custom")).toBe(true);
  expect(reopened.shows("id:model-row-manual-custom >> text:Missing")).toBe(false);

  const persisted = JSON.parse(reopened.storage()[MODELS_STORAGE_KEY]!) as ProviderModel[];
  expect(persisted).toHaveLength(4);
  expect(persisted.find((m) => m.modelKey === "deepseek-chat")?.id).toBe("m-ds-chat");
  expect(persisted.find((m) => m.modelKey === "deepseek-chat")?.enabled).toBe(true);
  expect(persisted.find((m) => m.modelKey === "deepseek-reasoner")?.enabled).toBe(false);
  expect(persisted.find((m) => m.modelKey === "legacy-ds")?.syncStatus).toBe("missing");
  expect(persisted.find((m) => m.modelKey === "manual-custom")?.syncStatus).toBe("active");
});

test("provider channels: saves manual and fetched draft models locally", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    network: {
      "GET https://proxy.example.com/ds/models": {
        status: 200,
        body: {
          data: [{ id: "deepseek-chat", display_name: "DeepSeek Chat" }],
        },
      },
      "GET https://bad.example.com/ds/models": {
        status: 401,
        body: { error: { message: "Invalid API key" } },
      },
    },
  });

  await startDraftFromEmptyState(app, "deepseek");

  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "DeepSeek Draft");

  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Responses]");
  await app.press("role:option[OpenAI Responses]");

  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://proxy.example.com/ds");
  await app.type("id:connection-token-input", "sk-ds-draft");

  // Fetch remote model into the draft.
  await app.press("id:get-models-button");
  await app.waitFor("id:model-row-deepseek-chat");

  // Add a manual model that does not exist remotely.
  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "does-not-exist-v9");
  await app.type("id:add-model-name-input", "Local Nonexistent");
  await app.press("id:add-model-api-select");
  await app.waitFor("role:option[Anthropic Messages]");
  await app.press("role:option[Anthropic Messages]");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));
  await app.waitFor("id:model-row-does-not-exist-v9");

  // Trigger a 401 catalog error before saving.
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://bad.example.com/ds");
  await app.press("id:get-models-button");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Authentication failed (HTTP 401)")),
  );

  const requestsBeforeSave = app.requests().length;
  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  expect(app.requests()).toHaveLength(requestsBeforeSave);

  // Saved channel transition retains connection inputs, and cancelling Connection edits
  // does not roll back model edits.
  expect(app.value("id:connection-url-input")).toBe("https://bad.example.com/ds");
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://changed.example.com");
  await app.press("id:toggle-model-deepseek-chat");
  await app.waitUntil(() =>
    JSON.parse(app.storage()[MODELS_STORAGE_KEY]!).some(
      (m: ProviderModel) => m.modelKey === "deepseek-chat" && m.enabled,
    ),
  );
  await app.press("role:button[Cancel]");
  expect(app.value("id:connection-url-input")).toBe("https://bad.example.com/ds");

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  await reopened.waitFor("id:model-row-does-not-exist-v9");

  expect(reopened.requests()).toHaveLength(0);
  expect(reopened.texts()).toContain("DeepSeek Draft");
  expect(reopened.texts()).toContain("OpenAI Responses");
  expect(reopened.value("id:connection-url-input")).toBe("https://bad.example.com/ds");
  expect(reopened.shows("id:model-row-does-not-exist-v9 >> text:Local Nonexistent")).toBe(true);
  expect(reopened.shows("id:model-row-does-not-exist-v9 >> text:Anthropic Messages")).toBe(true);
  expect(reopened.shows("id:model-row-deepseek-chat")).toBe(true);

  const persisted = JSON.parse(reopened.storage()[MODELS_STORAGE_KEY]!) as ProviderModel[];
  expect(persisted).toHaveLength(2);
  expect(persisted.find((m) => m.modelKey === "deepseek-chat")?.enabled).toBe(true);
  expect(persisted.find((m) => m.modelKey === "does-not-exist-v9")?.enabled).toBe(true);
});

test("provider channels: saves draft offline with empty key after network failure", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    network: {
      "GET https://unreachable.example.com/v1/models": {
        status: 503,
        body: { error: { message: "Service unavailable" } },
      },
    },
  });

  await startDraftFromEmptyState(app, "custom");
  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "Local Custom");
  await app.type("id:connection-url-input", "https://unreachable.example.com/v1");

  await app.press("id:test-connection-button");
  await app.waitUntil(() => app.requests().length === 1);

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "local-gguf");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  expect(app.requests()).toHaveLength(1);
  expect(app.shows("id:model-row-local-gguf")).toBe(true);

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  await reopened.waitFor("id:model-row-local-gguf");
  expect(reopened.requests()).toHaveLength(0);
  expect(reopened.texts()).toContain("Local Custom");
  expect(
    reopened.storage()[
      `${CREDENTIAL_KEY_PREFIX}${JSON.parse(reopened.storage()[PROVIDERS_STORAGE_KEY]!)[0].id}`
    ],
  ).toBeUndefined();
});

test("provider channels: channel switch retains draft until discard", async () => {
  const openai = makeChannel({ id: "ch-openai", presetId: "openai", displayName: "OpenAI Main" });
  const anthropic = makeChannel({
    id: "ch-anthropic",
    presetId: "anthropic",
    displayName: "Anthropic Main",
    adapterId: "anthropic",
    baseUrl: "https://api.anthropic.com",
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [openai, anthropic],
      credentials: { [openai.id]: "sk-oai", [anthropic.id]: "sk-ant" },
    }),
  });

  await startDraftFromRail(app, "deepseek");
  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "DeepSeek Unsaved");
  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Responses]");
  await app.press("role:option[OpenAI Responses]");
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://proxy.example.com/ds");
  await app.type("id:connection-token-input", "sk-draft-secret");
  await app.press("id:channel-enabled-switch");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "draft-local");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  const storageBefore = JSON.stringify(app.storage());

  await app.press("id:channel-item-ch-anthropic");
  await app.waitFor("id:discard-draft-dialog");

  await app.press("id:discard-draft-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));

  expect(app.shows("id:draft-channel-card")).toBe(true);
  expect(app.value("id:channel-name-input")).toBe("DeepSeek Unsaved");
  expect(app.value("id:connection-url-input")).toBe("https://proxy.example.com/ds");
  expect(app.value("id:connection-token-input")).toBe("sk-draft-secret");
  expect(app.shows("id:model-row-draft-local")).toBe(true);

  await app.press("id:channel-item-ch-anthropic");
  await app.waitFor("id:discard-draft-dialog");
  await app.press("id:discard-draft-dialog >> role:button[Discard]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));

  expect(app.shows("id:draft-channel-card")).toBe(false);
  expect(app.texts()).not.toContain("DeepSeek Unsaved");
  expect(app.value("id:connection-url-input")).toBe("https://api.anthropic.com");
  expect(JSON.stringify(app.storage())).toBe(storageBefore);
});

test("provider channels: draft Cancel returns to previous channel or empty state without saving", async () => {
  // Part 1: cancelling a draft when saved channels exist restores the previous channel.
  const openai = makeChannel({
    id: "ch-openai",
    presetId: "openai",
    displayName: "OpenAI Main",
    baseUrl: "https://api.openai.com/v1",
  });
  const appWithChannel = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [openai],
      credentials: { [openai.id]: "sk-oai" },
    }),
  });

  await startDraftFromRail(appWithChannel, "deepseek");
  await appWithChannel.clear("id:channel-name-input");
  await appWithChannel.type("id:channel-name-input", "Cancelled Draft");
  await appWithChannel.press("id:add-model-button");
  await appWithChannel.waitFor("id:add-model-dialog");
  await appWithChannel.type("id:add-model-key-input", "draft-temp");
  await appWithChannel.press("id:confirm-add-model");
  await appWithChannel.waitUntil(() => !appWithChannel.shows("id:add-model-dialog"));

  const storageBefore = JSON.stringify(appWithChannel.storage());

  await appWithChannel.press("id:cancel-channel-button");
  await appWithChannel.waitFor("id:discard-draft-dialog");
  await appWithChannel.press("id:discard-draft-dialog >> role:button[Cancel]");
  await appWithChannel.waitUntil(() => !appWithChannel.shows("id:discard-draft-dialog"));
  expect(appWithChannel.value("id:channel-name-input")).toBe("Cancelled Draft");
  expect(appWithChannel.shows("id:model-row-draft-temp")).toBe(true);

  await appWithChannel.press("id:cancel-channel-button");
  await appWithChannel.waitFor("id:discard-draft-dialog");
  await appWithChannel.press("id:discard-draft-dialog >> role:button[Discard]");
  await appWithChannel.waitUntil(() => !appWithChannel.shows("id:discard-draft-dialog"));

  expect(appWithChannel.shows("id:draft-channel-card")).toBe(false);
  expect(appWithChannel.texts()).toContain("OpenAI Main");
  expect(appWithChannel.value("id:connection-url-input")).toBe("https://api.openai.com/v1");
  expect(JSON.stringify(appWithChannel.storage())).toBe(storageBefore);

  // Part 2: cancelling a draft started from empty state returns to empty state.
  const emptyApp = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await startDraftFromEmptyState(emptyApp, "openai");
  await emptyApp.clear("id:channel-name-input");
  await emptyApp.type("id:channel-name-input", "Empty Draft");
  const emptyStorageBefore = JSON.stringify(emptyApp.storage());

  await emptyApp.press("id:cancel-channel-button");
  await emptyApp.waitFor("id:discard-draft-dialog");
  await emptyApp.press("id:discard-draft-dialog >> role:button[Discard]");
  await emptyApp.waitUntil(() => !emptyApp.shows("id:discard-draft-dialog"));

  expect(emptyApp.shows("id:empty-add-channel-button")).toBe(true);
  expect(emptyApp.texts()).not.toContain("Empty Draft");
  expect(JSON.stringify(emptyApp.storage())).toBe(emptyStorageBefore);
});

test("provider channels: leaving Models waits for discard confirmation", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await startDraftFromEmptyState(app, "openai");
  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "Draft Before Nav");
  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "draft-guard-model");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  // Cancelling a model dialog does not trigger the page-level discard guard.
  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "cancelled-model");
  await app.press("id:add-model-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));
  expect(app.shows("id:discard-draft-dialog")).toBe(false);
  expect(app.shows("id:model-row-draft-guard-model")).toBe(true);

  const storageBefore = JSON.stringify(app.storage());

  // Trying to leave Models keeps Models mounted behind the discard dialog.
  await app.press("id:nav-settings");
  await app.waitFor("id:discard-draft-dialog");
  expect(app.shows("id:models-page")).toBe(true);

  await app.press("id:discard-draft-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));
  expect(app.shows("id:models-page")).toBe(true);
  expect(app.value("id:channel-name-input")).toBe("Draft Before Nav");
  expect(app.shows("id:model-row-draft-guard-model")).toBe(true);

  await app.press("id:nav-settings");
  await app.waitFor("id:discard-draft-dialog");
  await app.press("id:discard-draft-dialog >> role:button[Discard]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));

  await app.waitUntil(() => !app.shows("id:models-page"));
  expect(app.texts()).not.toContain("Draft Before Nav");
  expect(JSON.stringify(app.storage())).toBe(storageBefore);

  // Returning to Models shows clean state with no active leave guard blocking exit.
  await app.press("id:nav-models");
  await app.waitFor("id:models-page");
  expect(app.shows("id:empty-add-channel-button")).toBe(true);

  await app.press("id:nav-settings");
  await app.waitUntil(() => !app.shows("id:models-page"));
  expect(app.shows("id:discard-draft-dialog")).toBe(false);
});

test("provider channels: starting another draft confirms discarding active draft", async () => {
  const openai = makeChannel({ id: "ch-openai", presetId: "openai", displayName: "OpenAI Main" });
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [openai],
      credentials: { [openai.id]: "sk-oai" },
    }),
  });

  await startDraftFromRail(app, "deepseek");
  await app.clear("id:channel-name-input");
  await app.type("id:channel-name-input", "First Draft");
  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "first-draft-model");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  const storageBefore = JSON.stringify(app.storage());

  await app.press("id:add-channel-button");
  await app.waitFor("id:discard-draft-dialog");
  await app.press("id:discard-draft-dialog >> role:button[Cancel]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));

  expect(app.shows("id:add-channel-dialog")).toBe(false);
  expect(app.value("id:channel-name-input")).toBe("First Draft");
  expect(app.shows("id:model-row-first-draft-model")).toBe(true);

  await app.press("id:add-channel-button");
  await app.waitFor("id:discard-draft-dialog");
  await app.press("id:discard-draft-dialog >> role:button[Discard]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));
  await app.waitFor("id:add-channel-dialog");

  await app.press("id:provider-preset-anthropic");
  await app.waitUntil(() => !app.shows("id:add-channel-dialog"));
  expect(app.value("id:channel-name-input")).toBe("Anthropic");
  expect(app.shows("id:model-row-first-draft-model")).toBe(false);
  expect(app.texts()).not.toContain("First Draft");
  expect(JSON.stringify(app.storage())).toBe(storageBefore);
});

test("provider channels: stale catalog cannot populate a replacement draft", async () => {
  const pendingResolvers: Array<(response: StubResponse) => void> = [];

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    network: {
      "GET https://api.openai.com/v1/models": () =>
        new Promise<StubResponse>((resolve) => {
          pendingResolvers.push(resolve);
        }),
    },
  });

  await startDraftFromEmptyState(app, "openai");
  await app.type("id:connection-token-input", "sk-openai-dummy");
  const firstFetch = app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 1);

  // Mid-request input edits invalidate the pending catalog immediately so user can keep working.
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://proxy.example.com/v1");
  await app.waitUntil(() => app.enabled("id:get-models-button"));

  // Switch back to the delayed route to also verify discard -> replacement draft isolation.
  await app.clear("id:connection-url-input");
  await app.type("id:connection-url-input", "https://api.openai.com/v1");
  const secondFetch = app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 2);

  await app.press("id:cancel-channel-button");
  await app.waitFor("id:discard-draft-dialog");
  await app.press("id:discard-draft-dialog >> role:button[Discard]");
  await app.waitUntil(() => !app.shows("id:discard-draft-dialog"));

  await startDraftFromEmptyState(app, "anthropic");

  for (const resolve of pendingResolvers) {
    resolve({
      status: 200,
      body: { data: [{ id: "stale-gpt-model", display_name: "Stale GPT" }] },
    });
  }
  await Promise.all([firstFetch, secondFetch]);
  await app.wait(50);

  expect(app.shows("id:model-row-stale-gpt-model")).toBe(false);
  expect(app.texts()).not.toContain("Stale GPT");
  expect(app.value("id:channel-name-input")).toBe("Anthropic");
  expect(app.value("id:connection-url-input")).toBe("https://api.anthropic.com");
});

test("provider channels: switching saved channels and editing connection mid-request drop stale responses", async () => {
  const pendingResolvers: Array<(response: StubResponse) => void> = [];
  const openai = makeChannel({
    id: "ch-openai",
    presetId: "openai",
    displayName: "OpenAI Main",
    adapterId: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  const anthropic = makeChannel({
    id: "ch-anthropic",
    presetId: "anthropic",
    displayName: "Anthropic Main",
    adapterId: "anthropic",
    baseUrl: "https://api.anthropic.com",
  });
  const existingModel = makeModel({
    id: "m-oai-keep",
    providerId: openai.id,
    modelKey: "gpt-4.1",
    sourceAdapterId: "openai-responses",
    enabled: true,
    displayName: "GPT-4.1",
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [openai, anthropic],
      models: [existingModel],
      credentials: { [openai.id]: "sk-oai", [anthropic.id]: "sk-ant" },
    }),
    network: {
      "GET https://api.openai.com/v1/models": () =>
        new Promise<StubResponse>((resolve) => {
          pendingResolvers.push(resolve);
        }),
    },
  });

  // Changing API type or API key mid-request invalidates the in-flight request.
  const firstFetch = app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 1);
  await app.press("id:connection-adapter-select");
  await app.waitFor("role:option[OpenAI Chat Completions]");
  await app.press("role:option[OpenAI Chat Completions]");
  await app.waitUntil(() => app.enabled("id:get-models-button"));

  const secondFetch = app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 2);
  await app.type("id:connection-token-input", "sk-replacement");
  await app.waitUntil(() => app.enabled("id:get-models-button"));

  // Resolve the first two stale responses with errors/models: neither should apply.
  pendingResolvers[0]?.({ status: 401, body: { error: { message: "Stale 401" } } });
  pendingResolvers[1]?.({ status: 200, body: { data: [{ id: "stale-mid-edit" }] } });
  await Promise.all([firstFetch, secondFetch]);
  await app.wait(50);
  expect(app.shows("id:model-row-stale-mid-edit")).toBe(false);
  expect(app.texts().some((t) => t.includes("HTTP 401"))).toBe(false);

  // Switch saved channels while a request is pending; delayed response must not affect either channel.
  const thirdFetch = app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 3);
  await app.press("id:channel-item-ch-anthropic");
  await app.waitUntil(() => app.value("id:connection-url-input") === "https://api.anthropic.com");

  pendingResolvers[2]?.({
    status: 200,
    body: { data: [{ id: "stale-after-switch" }] },
  });
  await thirdFetch;
  await app.wait(50);

  expect(app.shows("id:model-row-stale-after-switch")).toBe(false);
  await app.press("id:channel-item-ch-openai");
  await app.waitFor("id:model-row-gpt-4.1");
  expect(app.shows("id:model-row-stale-after-switch")).toBe(false);
  expect(JSON.parse(app.storage()[MODELS_STORAGE_KEY]!) as ProviderModel[]).toHaveLength(1);
});

test("provider channels: saving during a pending fetch keeps visible models and lets saved channel fetch again", async () => {
  let callCount = 0;
  let resolveFirst!: (response: StubResponse) => void;

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    network: {
      "GET https://api.openai.com/v1/models": () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise<StubResponse>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return {
          status: 200,
          body: { data: [{ id: "fresh-after-save", display_name: "Fresh After Save" }] },
        };
      },
    },
  });

  await startDraftFromEmptyState(app, "openai");
  await app.type("id:connection-token-input", "sk-oai-draft");

  await app.press("id:add-model-button");
  await app.waitFor("id:add-model-dialog");
  await app.type("id:add-model-key-input", "manual-visible");
  await app.press("id:confirm-add-model");
  await app.waitUntil(() => !app.shows("id:add-model-dialog"));

  // Start slow fetch, then press Save before it resolves.
  const draftFetch = app.press("id:get-models-button");
  await app.waitUntil(() => app.requests().length === 1);

  await app.press("id:save-channel-button");
  await app.waitUntil(() => !app.shows("id:cancel-channel-button"));

  // Late settlement of draft-owned fetch does not leak into the saved channel.
  resolveFirst({
    status: 200,
    body: { data: [{ id: "stale-after-save", display_name: "Stale After Save" }] },
  });
  await draftFetch;
  await app.wait(50);

  expect(app.shows("id:model-row-manual-visible")).toBe(true);
  expect(app.shows("id:model-row-stale-after-save")).toBe(false);

  // Saved channel is unblocked and can run a fresh fetch.
  await app.press("id:get-models-button");
  await app.waitFor("id:model-row-fresh-after-save");
  expect(app.shows("id:model-row-stale-after-save")).toBe(false);
});
