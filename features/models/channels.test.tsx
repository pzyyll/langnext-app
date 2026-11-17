import { expect, open, test } from "nsh/test";

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
