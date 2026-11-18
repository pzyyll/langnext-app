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

test("presets ui: reorders fallbacks and restores them", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-a", providerId: "ch-openai", modelKey: "model-a", enabled: true }),
      makeModel({ id: "m-b", providerId: "ch-openai", modelKey: "model-b", enabled: true }),
      makeModel({ id: "m-c", providerId: "ch-openai", modelKey: "model-c", enabled: true }),
    ],
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seed,
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:preset-name");
  await app.type("id:preset-name", "Ordered Chain");

  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[OpenAI Main · model-a]");
  await app.press("role:option[OpenAI Main · model-a]");

  // Add first fallback (B) and confirm duplicate exclusion of A.
  await app.press("id:preset-add-fallback");
  await app.waitFor("id:preset-fallback-0");
  await app.press("id:preset-fallback-0");
  await app.waitFor("role:option[OpenAI Main · model-b]");
  expect(app.shows("role:option[OpenAI Main · model-a]")).toBe(false);
  await app.press("role:option[OpenAI Main · model-b]");

  // Add second fallback (C) and confirm duplicate exclusion of A and B.
  await app.press("id:preset-add-fallback");
  await app.waitFor("id:preset-fallback-1");
  await app.press("id:preset-fallback-1");
  await app.waitFor("role:option[OpenAI Main · model-c]");
  expect(app.shows("role:option[OpenAI Main · model-a]")).toBe(false);
  expect(app.shows("role:option[OpenAI Main · model-b]")).toBe(false);
  await app.press("role:option[OpenAI Main · model-c]");

  // All 3 models are assigned, so Add fallback disables.
  expect(app.enabled("id:preset-add-fallback")).toBe(false);

  // Boundary move controls respect ends.
  expect(app.enabled("id:preset-fallback-up-0")).toBe(false);
  expect(app.enabled("id:preset-fallback-down-0")).toBe(true);
  expect(app.enabled("id:preset-fallback-up-1")).toBe(true);
  expect(app.enabled("id:preset-fallback-down-1")).toBe(false);

  // Move C up from index 1 -> 0 so order is A, C, B.
  await app.press("id:preset-fallback-up-1");

  await app.type("id:preset-temperature", "0");
  await app.type("id:preset-max-output-tokens", "4096");
  await app.press("id:preset-save");
  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));

  const savedStorage = app.storage();
  const parsed = JSON.parse(savedStorage[PRESETS_STORAGE_KEY]!) as {
    version: number;
    items: TranslationPreset[];
  };
  expect(parsed.items[0]!.engine).toMatchObject({
    modelIds: ["m-a", "m-c", "m-b"],
    temperature: 0,
    maxOutputTokens: 4096,
  });

  // Reopen app and confirm ordered fallbacks and numeric options reload accurately.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: savedStorage,
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-fallback-0");
  expect(reopened.value("id:preset-temperature")).toBe("0");
  expect(reopened.value("id:preset-max-output-tokens")).toBe("4096");
  expect(reopened.shows("id:preset-fallback-1")).toBe(true);

  // Replace second fallback? No, remove B (index 1) -> Add fallback becomes enabled again; then replace fallback 0 with B.
  await reopened.press("id:preset-fallback-remove-1");
  await reopened.waitUntil(() => !reopened.shows("id:preset-fallback-1"));
  expect(reopened.enabled("id:preset-add-fallback")).toBe(true);

  await reopened.press("id:preset-fallback-0");
  await reopened.waitFor("role:option[OpenAI Main · model-b]");
  await reopened.press("role:option[OpenAI Main · model-b]");
  await reopened.press("id:preset-save");

  await reopened.waitUntil(() => {
    const raw = reopened.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const data = JSON.parse(raw) as { items: TranslationPreset[] };
    return data.items[0]?.engine.modelIds.join(",") === "m-a,m-b";
  });
});

function makePresetRecord(id: string, name: string, modelIds: string[]): TranslationPreset {
  return {
    id,
    name,
    enabled: true,
    sourceLanguage: "auto",
    targetLanguage: "zh",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      kind: "ai",
      modelIds,
      temperature: null,
      maxOutputTokens: null,
      templates: [
        {
          id: `${id}-tpl-1`,
          name: "Default",
          systemTemplate: "Translate {{source_language}} to {{target_language}}.",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: `${id}-tpl-1`,
    },
  };
}

test("presets ui: retains unavailable bindings", async () => {
  const chEnabled = makeChannel({ id: "ch-ok", displayName: "OpenAI Ready", enabled: true });
  const chDisabled = makeChannel({ id: "ch-off", displayName: "OpenAI Off", enabled: false });
  const chDeepSeek = makeChannel({
    id: "ch-ds",
    presetId: "deepseek",
    displayName: "DeepSeek",
    adapterId: "openai-chat",
    enabled: true,
  });

  const mOk = makeModel({ id: "m-ok", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true });
  const mChOff = makeModel({
    id: "m-ch-off",
    providerId: "ch-off",
    modelKey: "gpt-4o",
    enabled: true,
  });
  const mDisabled = makeModel({
    id: "m-disabled",
    providerId: "ch-ok",
    modelKey: "gpt-4-disabled",
    enabled: false,
  });
  const mMissing = makeModel({
    id: "m-missing",
    providerId: "ch-ok",
    modelKey: "gpt-4-missing",
    enabled: true,
    syncStatus: "missing",
  });
  const mUnsupported = makeModel({
    id: "m-unsupported",
    providerId: "ch-ds",
    modelKey: "deepseek-chat",
    sourceAdapterId: "openai-chat",
    apiTypeOverride: "gemini",
    enabled: true,
  });

  const presets = [
    makePresetRecord("p-ch-off", "Disabled Channel Preset", ["m-ch-off", "m-raw-deleted"]),
    makePresetRecord("p-disabled", "Disabled Model Preset", ["m-disabled"]),
    makePresetRecord("p-missing", "Missing Model Preset", ["m-missing"]),
    makePresetRecord("p-unsupported", "Unsupported Proto Preset", ["m-unsupported"]),
  ];

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [chEnabled, chDisabled, chDeepSeek],
      models: [mOk, mChOff, mDisabled, mMissing, mUnsupported],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: presets }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-name");

  // 1. Disabled channel primary + deleted fallback without exposing raw missing ID.
  expect(app.shows("id:preset-manage-models")).toBe(true);
  expect(app.texts()).toContain("OpenAI Off · gpt-4o");
  expect(app.texts()).toContain("Owning channel is disabled.");
  expect(app.texts()).toContain("Deleted model");
  expect(app.texts()).toContain("Model no longer exists in Models.");
  expect(app.texts().join("\n")).not.toContain("m-raw-deleted");

  // 2. Disabled model, missing model, unsupported protocol each show exact reasons.
  await app.press("id:preset-item-p-disabled");
  await app.waitUntil(() => app.value("id:preset-name") === "Disabled Model Preset");
  expect(app.texts()).toContain("Model is disabled.");

  await app.press("id:preset-item-p-missing");
  await app.waitUntil(() => app.value("id:preset-name") === "Missing Model Preset");
  expect(app.texts()).toContain("Model was missing in the last channel sync.");

  await app.press("id:preset-item-p-unsupported");
  await app.waitUntil(() => app.value("id:preset-name") === "Unsupported Proto Preset");
  expect(app.texts()).toContain("Provider or API protocol is unsupported in this build.");

  // 3. Returning to p-ch-off: renaming while keeping unavailable bindings saves cleanly.
  await app.press("id:preset-item-p-ch-off");
  await app.waitUntil(() => app.value("id:preset-name") === "Disabled Channel Preset");
  await app.clear("id:preset-name");
  await app.type("id:preset-name", "Renamed Stale Preset");
  await app.press("id:preset-save");
  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return saved.items[0]?.name === "Renamed Stale Preset";
  });
  const afterRename = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(afterRename.items[0]!.engine.modelIds).toEqual(["m-ch-off", "m-raw-deleted"]);

  // 4. Replace primary and remove deleted fallback -> warnings clear cleanly.
  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[OpenAI Ready · gpt-4.1]");
  await app.press("role:option[OpenAI Ready · gpt-4.1]");
  expect(app.shows("id:preset-primary-unavailable")).toBe(false);

  await app.press("id:preset-fallback-remove-0");
  await app.waitUntil(() => !app.shows("id:preset-fallback-0"));
  expect(app.shows("id:preset-fallback-unavailable-0")).toBe(false);
  expect(app.shows("id:preset-manage-models")).toBe(false);

  await app.press("id:preset-save");
  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return saved.items[0]?.engine.modelIds.join(",") === "m-ok";
  });

  // 5. Models load error preserves existing bindings with recovery link and does not report deleted.
  const seededOnError = makeSeedStorage({
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        items: [makePresetRecord("p-err", "Saved During Error", ["m-ch-off", "m-ok"])],
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
  expect(savedAfterErrRename.items[0]!.engine.modelIds).toEqual(["m-ch-off", "m-ok"]);

  await errApp.press("id:preset-manage-models");
  await errApp.waitFor("id:models-page");
});

test("presets ui: saves multiple prompts and the chosen default", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
    ],
  });

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: seed,
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:preset-name");
  await app.type("id:preset-name", "Multi Prompt Preset");
  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.press("role:option[OpenAI Main · gpt-4.1-mini]");

  // Rename and edit the initial prompt template with multi-line Enter/Return input.
  await app.waitFor("id:preset-template-name");
  await app.clear("id:preset-template-name");
  await app.type("id:preset-template-name", "Standard");

  await app.clear("id:preset-template-system");
  await app.type(
    "id:preset-template-system",
    "Line 1\nTranslate {{source_language}} to {{target_language}}.",
  );
  await app.clear("id:preset-template-user");
  await app.type("id:preset-template-user", "Source:\n{{text}}");
  expect(app.value("id:preset-template-system")).toBe(
    "Line 1\nTranslate {{source_language}} to {{target_language}}.",
  );
  expect(app.value("id:preset-template-user")).toBe("Source:\n{{text}}");

  // Add a second template, edit it, and ensure unsaved edits survive template switches.
  await app.press("id:preset-add-template");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Template 2");
  await app.clear("id:preset-template-name");
  await app.type("id:preset-template-name", "Formal");
  await app.clear("id:preset-template-system");
  await app.type("id:preset-template-system", "Formal tone\nNo slang.");

  await app.press("id:preset-template-item-0");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Standard");
  expect(app.value("id:preset-template-system")).toBe(
    "Line 1\nTranslate {{source_language}} to {{target_language}}.",
  );

  await app.press("id:preset-template-item-1");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Formal");
  expect(app.value("id:preset-template-system")).toBe("Formal tone\nNo slang.");

  // Mark Formal as default; only one Default badge appears.
  await app.press("id:preset-template-set-default");
  expect(app.count("id:preset-template-default-badge")).toBe(1);
  expect(app.texts().filter((label) => label === "Default")).toHaveLength(1);

  // Validation error in a non-active template selects it and focuses its invalid field.
  await app.press("id:preset-template-item-0");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Standard");
  await app.clear("id:preset-template-user");
  await app.type("id:preset-template-user", "Missing placeholder");
  await app.press("id:preset-template-item-1");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Formal");

  await app.press("id:preset-save");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Standard");
  expect(app.texts()).toContain("User prompt must contain {{text}} once.");

  // Fix Standard user prompt while verifying focus landed on preset-template-user.
  await app.keyboard.press("x");
  expect(app.value("id:preset-template-user")).toBe("Missing placeholderx");
  await app.clear("id:preset-template-user");
  await app.type("id:preset-template-user", "Source:\n{{text}}");

  await app.press("id:preset-save");
  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));

  const persisted = app.storage();
  const parsed = JSON.parse(persisted[PRESETS_STORAGE_KEY]!) as { items: TranslationPreset[] };
  expect(parsed.items[0]!.engine.templates).toHaveLength(2);
  const formalTpl = parsed.items[0]!.engine.templates.find((tpl) => tpl.name === "Formal");
  expect(formalTpl).toBeDefined();
  expect(parsed.items[0]!.engine.defaultTemplateId).toBe(formalTpl!.id);

  // Reopen app and confirm templates, multi-line bodies, and single Default badge persist.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: persisted,
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-template-name");
  expect(reopened.count("id:preset-template-default-badge")).toBe(1);
  await reopened.press("id:preset-template-item-0");
  await reopened.waitUntil(() => reopened.value("id:preset-template-name") === "Standard");
  expect(reopened.value("id:preset-template-system")).toBe(
    "Line 1\nTranslate {{source_language}} to {{target_language}}.",
  );
  expect(reopened.value("id:preset-template-user")).toBe("Source:\n{{text}}");
  await reopened.press("id:preset-template-item-1");
  await reopened.waitUntil(() => reopened.value("id:preset-template-name") === "Formal");
  expect(reopened.value("id:preset-template-system")).toBe("Formal tone\nNo slang.");
});

test("presets ui: removes only a nondefault prompt", async () => {
  const seedPreset: TranslationPreset = {
    id: "p-templates",
    name: "Template Removal",
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
          name: "Primary",
          systemTemplate: "Primary system",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-2",
          name: "Concise",
          systemTemplate: "Concise system",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
  };

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
      ],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [seedPreset] }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-template-name");
  expect(app.value("id:preset-template-name")).toBe("Primary");
  expect(app.enabled("id:preset-template-remove")).toBe(false);

  // Switch to Concise and make it the default.
  await app.press("id:preset-template-item-1");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Concise");
  await app.press("id:preset-template-set-default");
  expect(app.count("id:preset-template-default-badge")).toBe(1);

  // Former default Primary is now removable, and removing it stays draft-only until Save.
  await app.press("id:preset-template-item-0");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Primary");
  expect(app.enabled("id:preset-template-remove")).toBe(true);
  await app.press("id:preset-template-remove");
  await app.waitUntil(() => app.value("id:preset-template-name") === "Concise");
  expect(app.shows("id:preset-template-item-1")).toBe(false);

  // Storage still retains both templates before Save.
  const beforeSave = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(beforeSave.items[0]!.engine.templates).toHaveLength(2);
  expect(beforeSave.items[0]!.engine.defaultTemplateId).toBe("tpl-1");

  // Single remaining default template cannot be removed.
  expect(app.enabled("id:preset-template-remove")).toBe(false);

  await app.press("id:preset-save");
  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return saved.items[0]?.engine.templates.length === 1;
  });

  const savedData = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(savedData.items[0]!.engine.templates[0]!.id).toBe("tpl-2");
  expect(savedData.items[0]!.engine.defaultTemplateId).toBe("tpl-2");
});
