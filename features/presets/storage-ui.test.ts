import { expect, open, test } from "nsh/test";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { PRESETS_STORAGE_KEY } from "./store";
import type { AiPresetEngine, TranslationPreset } from "./types";

function aiEngine(preset: TranslationPreset): AiPresetEngine {
  if (preset.engine.kind !== "ai") throw new Error("expected an AI preset");
  return preset.engine;
}

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

function makeSamplePreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-1",
    name: "Saved Preset",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
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

test("preset recovery UI: can add a preset when all saved entries were skipped", async () => {
  const legacy = { ...makeSamplePreset(), name: "Unreadable Preset", enabled: "yes" };
  const raw = JSON.stringify({ version: 1, items: [legacy] });
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-ok", displayName: "OpenAI Main", enabled: true })],
      models: [makeModel({ id: "m-1", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true })],
      extra: { [PRESETS_STORAGE_KEY]: raw },
    }),
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:presets-skipped-notice");
  expect(app.texts()).toContain("Skipped 1 unreadable preset. Its data was kept.");
  expect(app.shows("id:presets-retry-button")).toBe(false);
  expect(app.shows("id:preset-item-preset-1")).toBe(false);
  expect(app.enabled("id:add-preset-button")).toBe(true);
  expect(app.storage()[PRESETS_STORAGE_KEY]).toBe(raw);

  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  await app.press("id:preset-type-ai");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-name");
  await app.type("id:preset-name", "Replacement Preset");
  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1]");
  await app.press("role:option[OpenAI Main · gpt-4.1]");
  await app.press("id:preset-save");
  await app.waitUntil(() => app.storage()[PRESETS_STORAGE_KEY] !== raw);
  const saved = app.storage();
  const [unreadable, created] = JSON.parse(saved[PRESETS_STORAGE_KEY]!).items;
  expect(unreadable.enabled).toBe("yes");
  expect(unreadable.sourceLanguage).toBeUndefined();
  expect(created.name).toBe("Replacement Preset");
  expect(created.sourceLanguage).toBeUndefined();
  expect(created.targetLanguage).toBeUndefined();

  const reopened = await open(APP_ENTRY, { ...viewport, storage: saved });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-name");
  expect(reopened.value("id:preset-name")).toBe("Replacement Preset");
  expect(reopened.shows("id:presets-skipped-notice")).toBe(true);
  expect(reopened.shows("id:preset-item-preset-1")).toBe(false);
});

test("preset recovery UI: dismisses the skipped notice across navigation and restart", async () => {
  const raw = JSON.stringify({
    version: 1,
    items: [{ ...makeSamplePreset({ id: "legacy" }), enabled: "yes" }, makeSamplePreset()],
  });
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en", [PRESETS_STORAGE_KEY]: raw },
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:presets-skipped-notice");
  await app.press("role:button[Dismiss skipped presets notice]");
  expect(app.shows("id:presets-skipped-notice")).toBe(false);
  expect(app.shows("id:preset-item-preset-1")).toBe(true);

  await app.press("id:nav-models");
  await app.press("id:nav-presets");
  await app.waitFor("id:preset-item-preset-1");
  expect(app.shows("id:presets-skipped-notice")).toBe(false);

  const saved = app.storage();
  expect(saved[PRESETS_STORAGE_KEY]).toBe(raw);
  const reopened = await open(APP_ENTRY, { ...viewport, storage: saved });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-item-preset-1");
  expect(reopened.shows("id:presets-skipped-notice")).toBe(false);
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

test("presets storage UI: retains bindings on Models load error", async () => {
  const sample = makeSamplePreset({
    id: "p-err",
    name: "Saved During Error",
    engine: {
      ...aiEngine(makeSamplePreset()),
      modelIds: ["m-ch-off", "m-ok"],
    },
  });
  const seededOnError = makeSeedStorage({
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        items: [sample],
      }),
    },
  });
  const errApp = await open(APP_ENTRY, {
    ...viewport,
    storage: seededOnError,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => {
          if (key === "models.v2.providers") {
            throw new Error("Models storage failed");
          }
          return seededOnError[key] ?? null;
        },
        "Storage.setItem": async (key: string, value: string) => {
          seededOnError[key] = value;
        },
        "Storage.removeItem": async (key: string) => {
          delete seededOnError[key];
        },
      },
    },
  });

  await errApp.press("id:nav-presets");
  await errApp.waitFor("id:preset-name");
  expect(errApp.texts()).toContain("Models could not be loaded. Existing bindings are preserved.");
  expect(errApp.texts()).not.toContain("Model no longer exists in Models.");
  expect(errApp.texts().join("\n")).not.toContain("m-ch-off");
  expect(errApp.shows("id:preset-manage-models")).toBe(true);

  await errApp.clear("id:preset-name");
  await errApp.type("id:preset-name", "Renamed Under Models Error");
  await errApp.press("id:preset-save");
  await errApp.waitUntil(() => {
    const raw = seededOnError[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return saved.items[0]?.name === "Renamed Under Models Error";
  });
  const savedAfterErrRename = JSON.parse(seededOnError[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(aiEngine(savedAfterErrRename.items[0]!).modelIds).toEqual(["m-ch-off", "m-ok"]);

  await errApp.press("id:preset-manage-models");
  await errApp.waitFor("id:models-page");
});

test("presets storage UI: blocks leaving during a pending write", async () => {
  let resolveSlowWrite!: () => void;
  const slowBacking: Record<string, string> = makeSeedStorage({
    channels: [makeChannel({ id: "ch-ok", displayName: "OpenAI Ready", enabled: true })],
    models: [makeModel({ id: "m-1", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true })],
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        items: [makeSamplePreset({ id: "p-2", name: "Preset Two" })],
      }),
    },
  });
  let presetWrites = 0;

  const slowApp = await open(APP_ENTRY, {
    ...viewport,
    storage: slowBacking,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => slowBacking[key] ?? null,
        "Storage.setItem": async (key: string, value: string) => {
          if (key === PRESETS_STORAGE_KEY) {
            presetWrites += 1;
            await new Promise<void>((resolve) => {
              resolveSlowWrite = resolve;
            });
          }
          slowBacking[key] = value;
        },
        "Storage.removeItem": async (key: string) => {
          delete slowBacking[key];
        },
      },
    },
  });

  await slowApp.press("id:nav-presets");
  await slowApp.waitFor("id:preset-name");
  await slowApp.type("id:preset-name", " Saving");
  const saveOp = slowApp.press("id:preset-save");
  await slowApp.waitUntil(() => presetWrites === 1);

  expect(slowApp.enabled("id:add-preset-button")).toBe(false);
  expect(slowApp.enabled("id:preset-cancel")).toBe(false);
  await slowApp.press("id:nav-models");
  expect(slowApp.shows("id:presets-page")).toBe(true);
  expect(slowApp.shows("id:models-page")).toBe(false);
  expect(slowApp.shows("id:preset-discard-dialog")).toBe(false);

  resolveSlowWrite();
  await saveOp;
  await slowApp.waitUntil(() => slowApp.enabled("id:add-preset-button"));

  await slowApp.press("id:nav-models");
  await slowApp.waitFor("id:models-page");
});
