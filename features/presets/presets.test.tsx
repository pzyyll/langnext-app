import { expect, open, test } from "nsh/test";
import {
  emptyCatalogCache,
  makeChannel,
  makeModel,
  makeSeedStorage,
} from "../models/__tests__/fixtures";
import { PRESETS_STORAGE_KEY } from "./store";
import type { TranslationPreset } from "./types";

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

test("presets ui: saves a new preset", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({
        id: "m-1",
        providerId: "ch-openai",
        modelKey: "gpt-4.1-mini",
        enabled: true,
      }),
    ],
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seed,
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:presets-page");

  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:preset-name");

  // Name field takes focus automatically when creating a new draft.
  await app.keyboard.press("a");
  expect(app.value("id:preset-name")).toBe("a");
  await app.clear("id:preset-name");
  await app.type("id:preset-name", "Technical EN to ZH");

  await app.press("id:preset-source-language");
  await app.waitFor("role:option[Auto]");
  await app.press("role:option[English]");

  await app.press("id:preset-target-language");
  await app.waitFor("role:option[Chinese]");
  expect(app.shows("role:option[Auto]")).toBe(false);
  expect(app.shows("role:option[No preference]")).toBe(true);
  await app.press("role:option[Chinese]");

  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.press("role:option[OpenAI Main · gpt-4.1-mini]");

  await app.press("id:preset-enabled");
  await app.press("id:preset-save");

  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));
  expect(app.requests()).toHaveLength(0);

  const persisted = app.storage();
  const parsed = JSON.parse(persisted[PRESETS_STORAGE_KEY]!) as {
    version: number;
    items: TranslationPreset[];
  };
  expect(parsed.version).toBe(1);
  expect(parsed.items).toHaveLength(1);
  expect(parsed.items[0]).toMatchObject({
    name: "Technical EN to ZH",
    enabled: false,
    sourceLanguage: "en",
    targetLanguage: "zh",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
    },
  });
  expect(parsed.items[0]!.engine.templates).toHaveLength(1);
  expect(parsed.items[0]!.engine.defaultTemplateId).toBe(parsed.items[0]!.engine.templates[0]!.id);

  // Reopen the app from persisted storage and confirm fields reload faithfully.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: persisted,
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-name");
  expect(reopened.value("id:preset-name")).toBe("Technical EN to ZH");
  expect(reopened.texts()).toContain("English");
  expect(reopened.texts()).toContain("Chinese");
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4.1-mini");

  // With zero eligible models, Save is blocked on a new draft and Manage Models offers recovery.
  const emptyModelsApp = await open(APP_ENTRY, {
    ...viewport,
    storage: { ...emptyCatalogCache(), "settings.language": "en" },
  });
  await emptyModelsApp.press("id:nav-presets");
  await emptyModelsApp.waitFor("id:presets-page");
  await emptyModelsApp.press("id:empty-add-preset-button");
  await emptyModelsApp.waitFor("id:preset-name");
  expect(emptyModelsApp.enabled("id:preset-save")).toBe(false);
  expect(emptyModelsApp.shows("id:preset-manage-models")).toBe(true);

  await emptyModelsApp.press("id:preset-manage-models");
  await emptyModelsApp.waitFor("id:models-page");
});
