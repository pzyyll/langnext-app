import { expect, open, test } from "nsh/test";
import { makeChannel, makeSeedStorage, startDraftFromRail } from "./__tests__/fixtures";

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
