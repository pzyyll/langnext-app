import { expect, open, test } from "nsh/test";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
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

test("presets storage UI: preserves edits after a failed write", async () => {
  const sample = makeSamplePreset();
  const backing: Record<string, string> = makeSeedStorage({
    channels: [makeChannel({ id: "ch-ok", displayName: "OpenAI Main", enabled: true })],
    models: [makeModel({ id: "m-1", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true })],
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [sample] }),
    },
  });
  let writeError: Error | null = new Error("DISK_FULL");

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: backing,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => backing[key] ?? null,
        "Storage.setItem": async (key: string, value: string) => {
          if (key === PRESETS_STORAGE_KEY && writeError) {
            throw writeError;
          }
          backing[key] = value;
        },
        "Storage.removeItem": async (key: string) => {
          delete backing[key];
        },
      },
    },
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-name");
  expect(app.value("id:preset-name")).toBe("Saved Preset");

  // Failed save keeps draft edits and lets the user retry cleanly.
  await app.clear("id:preset-name");
  await app.type("id:preset-name", "Edited Name");
  await app.press("id:preset-save");

  await app.waitFor("id:preset-error-banner");
  expect(app.texts()).toContain("Could not save translation presets (DISK_FULL).");
  expect(app.value("id:preset-name")).toBe("Edited Name");
  expect(app.enabled("id:preset-save")).toBe(true);
  expect(
    (JSON.parse(backing[PRESETS_STORAGE_KEY]!) as { items: TranslationPreset[] }).items[0]!.name,
  ).toBe("Saved Preset");

  writeError = null;
  await app.press("id:preset-save");
  await app.waitUntil(() => !app.shows("id:preset-error-banner"));
  expect(
    (JSON.parse(backing[PRESETS_STORAGE_KEY]!) as { items: TranslationPreset[] }).items[0]!.name,
  ).toBe("Edited Name");

  // Failed delete keeps record, keeps confirmation open with error, and succeeds on retry.
  writeError = new Error("DISK_LOCKED");
  await app.press("id:preset-delete");
  await app.waitFor("id:preset-delete-dialog");
  await app.press("id:preset-delete-confirm");

  await app.waitUntil(() =>
    app.texts().some((text) => text.includes("Could not delete preset (DISK_LOCKED).")),
  );
  expect(app.shows("id:preset-delete-dialog")).toBe(true);
  expect(app.shows("id:preset-item-preset-1")).toBe(true);
  expect(
    (JSON.parse(backing[PRESETS_STORAGE_KEY]!) as { items: TranslationPreset[] }).items,
  ).toHaveLength(1);

  writeError = null;
  await app.press("id:preset-delete-confirm");
  await app.waitUntil(() => !app.shows("id:preset-delete-dialog"));
  await app.waitFor("id:empty-add-preset-button");
  expect(
    (JSON.parse(backing[PRESETS_STORAGE_KEY]!) as { items: TranslationPreset[] }).items,
  ).toHaveLength(0);
});
