import { expect, open, test } from "nsh/test";
import { PRESETS_STORAGE_KEY } from "./store";
import type { TranslationPreset } from "./types";

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

function makeSamplePreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-1",
    name: "Saved Preset",
    enabled: true,
    sourceLanguage: "auto",
    targetLanguage: "zh",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
      templates: [
        {
          id: "tpl-1",
          name: "Default",
          systemTemplate: "Translate from {{source_language}} to {{target_language}}.",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
    ...overrides,
  };
}

test("presets storage UI: retries a failed load", async () => {
  const sample = makeSamplePreset();
  const backing: Record<string, string> = {
    "settings.language": "en",
    [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [sample] }),
  };
  let failPresetsRead = true;

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: backing,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => {
          if (key === PRESETS_STORAGE_KEY && failPresetsRead) {
            throw new Error("Storage read unavailable");
          }
          return backing[key] ?? null;
        },
        "Storage.setItem": async (key: string, value: string) => {
          backing[key] = value;
        },
        "Storage.removeItem": async (key: string) => {
          delete backing[key];
        },
      },
    },
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:presets-page");

  await app.waitFor("id:presets-retry-button");
  expect(app.texts()).not.toContain("No presets yet");
  expect(app.texts().some((text) => text.includes("Storage read unavailable"))).toBe(true);
  expect(app.enabled("id:add-preset-button")).toBe(false);
  expect(app.shows("id:empty-add-preset-button")).toBe(false);

  failPresetsRead = false;
  await app.press("id:presets-retry-button");
  await app.waitUntil(() => !app.shows("id:presets-retry-button"));

  expect(app.enabled("id:add-preset-button")).toBe(true);
  expect(app.texts()).toContain("Saved Preset");
});
