import { t } from "nsh/i18n";
import { expect, open, test, type App } from "nsh/test";
import { SPLIT_RAIL_STORAGE_KEYS } from "../../components/layout/split-rail";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { googleCloudUsageStorageKey, nextUsageReset, usageMonthKey } from "./google-cloud-usage";
import {
  deepLCredentialStorageKey,
  DEEPLX_TOKEN_KEY_PREFIX,
  deeplxTokenStorageKey,
  googleCloudCredentialStorageKey,
  PRESETS_STORAGE_KEY,
} from "./store";
import type { AiPresetEngine, TranslationPreset } from "./types";

const DEEPL_USAGE_ROUTE = "GET https://api-free.deepl.com/v2/usage";

function makeDeepLPresetRecord(id: string, name: string, credentialRef: string): TranslationPreset {
  return {
    id,
    name,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: { kind: "deepl", credentialRef },
  };
}

function makeGoogleCloudPresetRecord(
  id: string,
  name: string,
  credentialRef: string,
): TranslationPreset {
  return {
    id,
    name,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: { kind: "google-cloud", credentialRef },
  };
}

/** Picks a preset type in the Add Preset picker and waits for the editor. */
async function choosePresetType(
  app: App,
  kind: "ai" | "deepl" | "deeplx" | "google-cloud" | "google-web",
) {
  await app.waitFor("id:add-preset-dialog");
  await app.press(`id:preset-type-${kind}`);
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
}

/** Waits for the preset editor detail pane. */
async function waitForPresetEditor(app: App) {
  await app.waitFor("id:preset-title");
}

/** The selected preset's title, as the editor header shows it. */
function presetTitle(app: App): string {
  return app.accessibility("id:preset-title")?.name ?? "";
}

/** Renames the selected preset in the header, which persists at once. */
async function renamePreset(app: App, name: string) {
  await app.press("id:rename-preset-button");
  await app.waitFor("id:rename-preset-input");
  await app.clear("id:rename-preset-input");
  await app.type("id:rename-preset-input", name);
  await app.press("id:confirm-rename-preset");
  await app.waitUntil(() => !app.shows("id:rename-preset-input"));
}

function aiEngine(preset: TranslationPreset): AiPresetEngine {
  if (preset.engine.kind !== "ai") throw new Error("expected an AI preset");
  return preset.engine;
}

const APP_ENTRY = "../../../App.tsx";
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
  await choosePresetType(app, "ai");
  await app.waitFor("id:preset-name");

  // Name field takes focus automatically when creating a new draft.
  await app.keyboard.press("a");
  expect(app.value("id:preset-name")).toBe("a");
  await app.clear("id:preset-name");
  await app.type("id:preset-name", "Technical EN to ZH");

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
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
    },
  });
  const savedEngine = aiEngine(parsed.items[0]!);
  expect(savedEngine.templates).toHaveLength(1);
  expect(savedEngine.defaultTemplateId).toBe(savedEngine.templates[0]!.id);

  // Reopen the app from persisted storage and confirm fields reload faithfully.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: persisted,
  });
  await reopened.press("id:nav-presets");
  await waitForPresetEditor(reopened);
  expect(presetTitle(reopened)).toBe("Technical EN to ZH");
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4.1-mini");

  // With zero eligible models, Save is blocked on a new draft and Manage Models offers recovery.
  const emptyModelsApp = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await emptyModelsApp.press("id:nav-presets");
  await emptyModelsApp.waitFor("id:presets-page");
  await emptyModelsApp.press("id:empty-add-preset-button");
  await choosePresetType(emptyModelsApp, "ai");
  await emptyModelsApp.waitFor("id:preset-name");
  expect(emptyModelsApp.enabled("id:preset-save")).toBe(false);
  expect(emptyModelsApp.shows("id:preset-manage-models")).toBe(true);

  await emptyModelsApp.press("id:preset-manage-models");
  await emptyModelsApp.waitFor("id:models-page");
});

test("presets ui: no languages", async () => {
  const savedPreset = makePresetRecord("p-language-free", "Language Free", ["m-1"]);
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({
          id: "m-1",
          providerId: "ch-openai",
          modelKey: "gpt-4.1",
          enabled: true,
        }),
      ],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [savedPreset] }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);

  // A saved AI preset shows its engine configuration only.
  expect(presetTitle(app)).toBe("Language Free");
  expect(app.shows("id:preset-source-language")).toBe(false);
  expect(app.shows("id:preset-target-language")).toBe(false);
  expect(app.texts()).not.toContain("Languages");
  expect(app.shows("id:preset-enabled")).toBe(true);
  expect(app.shows("id:preset-primary-model")).toBe(true);
  expect(app.shows("id:preset-template-name")).toBe(true);

  // A new AI draft saves engine configuration without a language selection.
  await app.press("id:add-preset-button");
  await choosePresetType(app, "ai");
  await app.waitFor("id:preset-name");
  expect(app.shows("id:preset-source-language")).toBe(false);
  expect(app.shows("id:preset-target-language")).toBe(false);
  await app.type("id:preset-name", "No Languages Draft");
  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1]");
  await app.press("role:option[OpenAI Main · gpt-4.1]");
  await app.press("id:preset-save");
  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return saved.items.some((item) => item.name === "No Languages Draft");
  });
});

test("presets ui: preset type", async () => {
  const preset = makePresetRecord("p-type", "Type Preset", ["m-1"]);
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1", enabled: true }),
      ],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);
  expect(presetTitle(app)).toBe("Type Preset");
  expect(app.shows("id:preset-name")).toBe(false);

  // The rail entry point opens the picker before any draft exists.
  await app.press("id:add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  expect(presetTitle(app)).toBe("Type Preset");
  expect(app.shows("id:preset-draft-item")).toBe(false);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  expect(presetTitle(app)).toBe("Type Preset");

  // Dismissing the picker with a dirty draft changes nothing and asks no confirmation.
  await app.press("id:preset-enabled");
  await app.press("id:add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  await app.press("id:preset-type-cancel");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  expect(presetTitle(app)).toBe("Type Preset");
  expect(app.accessibility("id:preset-enabled")?.checked).toBe("false");
  expect(app.shows("id:preset-discard-dialog")).toBe(false);

  // Choosing a type closes the picker first, then runs the dirty-draft guard.
  await app.press("id:add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  await app.press("id:preset-type-ai");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-keep-editing");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(presetTitle(app)).toBe("Type Preset");
  expect(app.accessibility("id:preset-enabled")?.checked).toBe("false");

  // Discarding opens the AI editor with the name focused and no language controls.
  await app.press("id:add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  await app.press("id:preset-type-ai");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  await app.waitFor("id:preset-name");
  expect(app.shows("id:preset-draft-item")).toBe(true);
  expect(app.value("id:preset-name")).toBe("");
  // A new draft types its title in the body; only a saved preset renames in the header.
  expect(app.shows("id:rename-preset-button")).toBe(false);
  expect(app.shows("id:preset-source-language")).toBe(false);
  expect(app.shows("id:preset-target-language")).toBe(false);
  await app.keyboard.press("a");
  expect(app.value("id:preset-name")).toBe("a");

  // The empty-state entry point uses the same picker.
  const emptyApp = await open(APP_ENTRY, { ...viewport, storage: makeSeedStorage({}) });
  await emptyApp.press("id:nav-presets");
  await emptyApp.waitFor("id:empty-add-preset-button");
  await emptyApp.press("id:empty-add-preset-button");
  await emptyApp.waitFor("id:add-preset-dialog");
  expect(emptyApp.shows("id:preset-type-ai")).toBe(true);
  expect(emptyApp.shows("id:preset-type-deepl")).toBe(true);
  expect(emptyApp.shows("id:preset-type-google-cloud")).toBe(true);
  expect(emptyApp.shows("id:preset-type-google-web")).toBe(true);
  await emptyApp.press("id:preset-type-cancel");
  await emptyApp.waitUntil(() => !emptyApp.shows("id:add-preset-dialog"));
  expect(emptyApp.shows("id:empty-add-preset-button")).toBe(true);
});

test("presets ui: renames a preset in the header and saves at once", async () => {
  const preset = makePresetRecord("p-rename", "Original Name", ["m-1"]);
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1", enabled: true }),
      ],
      extra: { [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }) },
    }),
  });

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);
  expect(presetTitle(app)).toBe("Original Name");

  // Cancel leaves the stored title untouched.
  await app.press("id:rename-preset-button");
  await app.waitFor("id:rename-preset-input");
  expect(app.value("id:rename-preset-input")).toBe("Original Name");
  await app.clear("id:rename-preset-input");
  await app.type("id:rename-preset-input", "Discarded Name");
  await app.press("id:cancel-rename-preset");
  await app.waitUntil(() => !app.shows("id:rename-preset-input"));
  expect(presetTitle(app)).toBe("Original Name");

  // An empty title cannot be saved.
  await app.press("id:rename-preset-button");
  await app.waitFor("id:rename-preset-input");
  await app.clear("id:rename-preset-input");
  expect(app.enabled("id:confirm-rename-preset")).toBe(false);
  await app.press("id:cancel-rename-preset");
  await app.waitUntil(() => !app.shows("id:rename-preset-input"));

  // Saving the title writes at once: no form save follows, and the editor stays clean.
  await renamePreset(app, "Renamed Preset");
  expect(presetTitle(app)).toBe("Renamed Preset");
  expect(app.shows("id:preset-save")).toBe(false);
  expect(app.shows("id:preset-delete")).toBe(true);
  expect(app.shows("id:preset-item-p-rename >> text:Renamed Preset")).toBe(true);
  const stored = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(stored.items[0]!.name).toBe("Renamed Preset");

  // A rename survives a restart.
  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-presets");
  await waitForPresetEditor(reopened);
  expect(presetTitle(reopened)).toBe("Renamed Preset");
});

test("presets ui: DeepL editor", async () => {
  const usageBody = { character_count: 180118, character_limit: 1250000 };
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({}),
    network: { [DEEPL_USAGE_ROUTE]: { status: 200, body: usageBody } },
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  await app.press("id:preset-type-deepl");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-deepl-api-key");

  // A DeepL preset needs no AI model and shows no languages, models, or prompts.
  expect(app.shows("id:preset-source-language")).toBe(false);
  expect(app.shows("id:preset-target-language")).toBe(false);
  expect(app.shows("id:preset-primary-model")).toBe(false);
  expect(app.shows("id:preset-temperature")).toBe(false);
  expect(app.shows("id:preset-template-name")).toBe(false);
  expect(app.shows("id:preset-manage-models")).toBe(false);
  expect(app.value("id:preset-deepl-api-key")).toBe("");
  expect(app.texts()).toContain(t("presets.deepl.keyLabel"));
  // Usage needs a stored key, so a new draft shows no usage section.
  expect(app.shows("id:preset-deepl-usage")).toBe(false);

  await app.type("id:preset-name", "DeepL Free");

  // A missing key fails with the localized field error and focuses the key input.
  await app.press("id:preset-save");
  await app.waitUntil(() => app.texts().includes(t("presets.error.deeplKeyRequired")));
  expect(app.storage()[PRESETS_STORAGE_KEY]).toBeUndefined();
  await app.keyboard.press("d");
  expect(app.value("id:preset-deepl-api-key")).toBe("d");
  await app.clear("id:preset-deepl-api-key");
  await app.type("id:preset-deepl-api-key", "deepl-test:fx");

  await app.press("id:preset-save");
  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));
  await app.waitUntil(() => app.shows("id:preset-deepl-usage-count"));
  expect(app.requests()).toHaveLength(1);
  expect(app.requests()[0]!.method).toBe("GET");
  expect(app.requests()[0]!.url).toBe("https://api-free.deepl.com/v2/usage");
  expect(app.requests()[0]!.headers.authorization).toBe("DeepL-Auth-Key deepl-test:fx");
  expect(app.texts()).toContain("180,118");
  expect(app.texts()).toContain("DeepL API");
  const raw = app.storage()[PRESETS_STORAGE_KEY]!;
  expect(raw).not.toContain("deepl-test:fx");
  const savedItems = JSON.parse(raw).items as TranslationPreset[];
  expect(savedItems[0]!.engine.kind).toBe("deepl");

  // Reopening shows the stored-key placeholder state, not the key; a replacement is dirty.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: app.storage(),
    network: { [DEEPL_USAGE_ROUTE]: { status: 200, body: usageBody } },
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-deepl-api-key");
  expect(reopened.value("id:preset-deepl-api-key")).toBe("");
  expect(reopened.shows("id:preset-save")).toBe(false);
  expect(reopened.texts()).toContain("DeepL API");
  await reopened.waitUntil(() => reopened.shows("id:preset-deepl-usage-count"));
  expect(reopened.requests()).toHaveLength(1);
  await reopened.type("id:preset-deepl-api-key", "deepl-replacement:fx");
  expect(reopened.enabled("id:preset-save")).toBe(true);
  expect(reopened.storage()[PRESETS_STORAGE_KEY]).not.toContain("deepl-replacement:fx");

  // Replacing the key reads usage again with the new key.
  await reopened.press("id:preset-save");
  await reopened.waitUntil(() => reopened.requests().length === 2);
  expect(reopened.requests()[1]!.headers.authorization).toBe("DeepL-Auth-Key deepl-replacement:fx");
});

test("presets ui: DeepL usage", async () => {
  const preset = makeDeepLPresetRecord("p-deepl", "DeepL Free", "ref-usage");
  let reads = 0;
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [deepLCredentialStorageKey("ref-usage")]: "deepl-test:fx",
      },
    }),
    network: {
      [DEEPL_USAGE_ROUTE]: () => {
        reads += 1;
        return {
          status: 200,
          body:
            reads === 1
              ? { character_count: 180118, character_limit: 1250000 }
              : {
                  character_count: 5947223,
                  character_limit: 1000000000000,
                  api_key_character_count: 636,
                  end_time: "2026-02-15T12:00:00Z",
                },
        };
      },
    },
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-deepl-usage-count");
  expect(app.requests()).toHaveLength(1);
  expect(app.requests()[0]!.method).toBe("GET");
  expect(app.requests()[0]!.url).toBe("https://api-free.deepl.com/v2/usage");
  expect(app.requests()[0]!.headers.authorization).toBe("DeepL-Auth-Key deepl-test:fx");
  expect(app.texts()).toContain("180,118");
  expect(app.texts()).toContain("/ 1,250,000 characters");
  expect(app.shows("id:preset-deepl-usage-bar")).toBe(true);
  expect(app.shows("id:preset-deepl-usage-reset")).toBe(false);
  expect(app.shows("id:preset-deepl-usage-key")).toBe(false);

  // Refresh reads again and renders a Pro account with no limit and a key count.
  await app.press("id:preset-deepl-usage-refresh");
  await app.waitUntil(() => app.texts().includes("5,947,223"));
  expect(app.requests()).toHaveLength(2);
  expect(app.texts()).toContain("characters");
  expect(app.texts()).toContain("Key: 636 characters");
  expect(app.shows("id:preset-deepl-usage-bar")).toBe(false);
  expect(app.shows("id:preset-deepl-usage-reset")).toBe(true);
});

test("presets ui: DeepL usage reports a rejected key and retries", async () => {
  const preset = makeDeepLPresetRecord("p-deepl", "DeepL Free", "ref-error");
  let reads = 0;
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [deepLCredentialStorageKey("ref-error")]: "deepl-test:fx",
      },
    }),
    network: {
      [DEEPL_USAGE_ROUTE]: () => {
        reads += 1;
        return reads === 1
          ? { status: 403 }
          : { status: 200, body: { character_count: 42, character_limit: 500000 } };
      },
    },
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-deepl-usage-error");
  expect(app.texts()).toContain(t("deepl.error.auth"));
  expect(app.shows("id:preset-deepl-usage-bar")).toBe(false);
  expect(app.enabled("id:preset-deepl-usage-refresh")).toBe(true);

  await app.press("id:preset-deepl-usage-refresh");
  await app.waitUntil(() => app.texts().includes("/ 500,000 characters"));
  expect(app.requests()).toHaveLength(2);
  expect(app.shows("id:preset-deepl-usage-error")).toBe(false);
  expect(app.shows("id:preset-deepl-usage-bar")).toBe(true);
  expect(app.texts()).toContain("42");
});

test("presets ui: Google Cloud character usage counts the current month only", async () => {
  const preset = makeGoogleCloudPresetRecord("p-google", "Google Cloud", "ref-google-usage");
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [googleCloudUsageStorageKey("p-google")]: JSON.stringify({
          version: 1,
          month: usageMonthKey(),
          characters: 123456,
        }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-google-cloud-usage-count");
  expect(app.accessibility("id:preset-google-cloud-usage-count")?.name).toBe("123,456");
  expect(app.accessibility("id:preset-google-cloud-usage-scope")?.name).toBe(
    t("presets.googleCloud.usage.scope"),
  );
  expect(app.enabled("id:preset-google-cloud-usage-refresh")).toBe(true);
  const reset = t("presets.googleCloud.usage.resets", {
    date: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
      nextUsageReset(),
    ),
  });
  expect(app.accessibility("id:preset-google-cloud-usage-reset")?.name).toBe(reset);

  // A record from an earlier month starts the count over at zero.
  const stale = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [googleCloudUsageStorageKey("p-google")]: JSON.stringify({
          version: 1,
          month: "2000-01",
          characters: 42,
        }),
      },
    }),
  });
  await stale.press("id:nav-presets");
  await stale.waitFor("id:preset-google-cloud-usage-count");
  expect(stale.accessibility("id:preset-google-cloud-usage-count")?.name).toBe("0");
});

test("presets ui: picker and DeepL editor fit compact dark zh-CN with reduced motion", async () => {
  const app = await open(APP_ENTRY, {
    width: 720,
    height: 520,
    platform: "windows",
    colorScheme: "dark",
    reducedMotion: true,
    storage: { ...makeSeedStorage({}), "settings.language": "zh-CN" },
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  expect(app.shows("id:preset-type-ai >> text:AI 翻译")).toBe(true);
  expect(app.shows("id:preset-type-deepl >> text:DeepL API")).toBe(true);
  expect(app.shows("id:preset-type-google-cloud >> text:Google Cloud 翻译")).toBe(true);

  await app.press("id:preset-type-deepl");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-deepl-api-key");
  expect(app.value("id:preset-name")).toBe("");
  expect(app.enabled("id:preset-save")).toBe(true);
  expect(app.texts()).toContain("API 密钥");
  expect(app.shows("id:preset-source-language")).toBe(false);
  expect(app.shows("id:preset-primary-model")).toBe(false);
  expect(app.shows("id:preset-template-name")).toBe(false);
  expect(app.shows("id:preset-deepl-usage")).toBe(false);
});

test("presets ui: does not promote a fallback into an empty primary slot", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel()],
      models: [makeModel({ enabled: true })],
    }),
  });
  await app.press("id:nav-presets");
  await app.press("id:empty-add-preset-button");
  await choosePresetType(app, "ai");
  await app.type("id:preset-name", "Fallback only");
  await app.press("id:preset-add-fallback");
  await app.press("id:preset-fallback-0");
  await app.press("role:option[OpenAI Main · gpt-4o]");
  await app.press("id:preset-save");
  expect(app.storage()[PRESETS_STORAGE_KEY]).toBeUndefined();
  expect(app.shows("id:preset-fallback-0")).toBe(true);
  expect(app.texts()).toContain("Select a primary model.");
});

test("presets ui: steps temperature between 0.0 and 2.0", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel()],
      models: [makeModel({ enabled: true })],
    }),
  });
  const temperature = "id:preset-temperature";
  const increase = "id:preset-temperature-up";
  const decrease = "id:preset-temperature-down";
  await app.press("id:nav-presets");
  await app.press("id:empty-add-preset-button");
  await choosePresetType(app, "ai");
  await app.type("id:preset-name", "Temperature");
  await app.press("id:preset-primary-model");
  await app.press("role:option[OpenAI Main · gpt-4o]");
  expect(app.texts()).not.toContain("0.0–2.0");
  expect(app.value(temperature)).toBe("");
  expect(app.enabled(decrease)).toBe(false);

  await app.press(increase);
  expect(app.value(temperature)).toBe("0.0");
  await app.press(increase);
  expect(app.value(temperature)).toBe("0.1");
  await app.press(decrease);
  expect(app.value(temperature)).toBe("0.0");
  expect(app.enabled(decrease)).toBe(false);

  await app.clear(temperature);
  await app.type(temperature, "1.9");
  await app.press(increase);
  expect(app.value(temperature)).toBe("2.0");
  expect(app.enabled(increase)).toBe(false);
  await app.press(decrease);
  expect(app.value(temperature)).toBe("1.9");

  await app.press("id:preset-save");
  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));
  expect(JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!).items[0].engine.temperature).toBe(1.9);
  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-presets");
  expect(reopened.value(temperature)).toBe("1.9");
});

test("presets ui: rejects invalid temperature edits", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: makeSeedStorage({}) });
  const temperature = "id:preset-temperature";
  await app.press("id:nav-presets");
  await app.press("id:empty-add-preset-button");
  await choosePresetType(app, "ai");
  await app.type(temperature, "3");
  expect(app.value(temperature)).toBe("");
  await app.type(temperature, "2.1");
  expect(app.value(temperature)).toBe("2.");
  await app.type("id:preset-name", "Blur temperature");
  expect(app.value(temperature)).toBe("2.0");

  await app.clear(temperature);
  await app.type(temperature, "0.15");
  expect(app.value(temperature)).toBe("0.1");
  await app.type(temperature, "e2");
  expect(app.value(temperature)).toBe("0.1");
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
  await choosePresetType(app, "ai");
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
  expect(reopened.value("id:preset-temperature")).toBe("0.0");
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
    return aiEngine(data.items[0]!).modelIds.join(",") === "m-a,m-b";
  });
});

function makePresetRecord(id: string, name: string, modelIds: string[]): TranslationPreset {
  return {
    id,
    name,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      kind: "ai",
      modelIds,
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
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

test("presets ui: toggles the reasoning switch and saves it", async () => {
  const preset = makePresetRecord("preset-a", "Reasoning", ["m-1"]);
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({
          id: "m-1",
          providerId: "ch-openai",
          modelKey: "gpt-4.1-mini",
          enabled: true,
        }),
      ],
      extra: { [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }) },
    }),
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:preset-disable-reasoning");
  await app.press("id:preset-disable-reasoning");
  await app.press("id:preset-save");

  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const data = JSON.parse(raw) as { items: TranslationPreset[] };
    return aiEngine(data.items[0]!).disableReasoning === false;
  });

  // Reopening shows the stored choice and saving it again keeps it.
  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-disable-reasoning");
  await reopened.press("id:preset-disable-reasoning");
  await reopened.press("id:preset-save");
  await reopened.waitUntil(() => {
    const raw = reopened.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const data = JSON.parse(raw) as { items: TranslationPreset[] };
    return aiEngine(data.items[0]!).disableReasoning === true;
  });
});

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
  await waitForPresetEditor(app);

  // 1. Disabled channel primary + deleted fallback without exposing raw missing ID.
  expect(app.shows("id:preset-manage-models")).toBe(true);
  expect(app.texts()).toContain("OpenAI Off · gpt-4o");
  expect(app.texts()).toContain("Owning channel is disabled.");
  expect(app.texts()).toContain("Deleted model");
  expect(app.texts()).toContain("Model no longer exists in Models.");
  expect(app.texts().join("\n")).not.toContain("m-raw-deleted");

  // 2. Disabled model, missing model, unsupported protocol each show exact reasons.
  await app.press("id:preset-item-p-disabled");
  await app.waitUntil(() => presetTitle(app) === "Disabled Model Preset");
  expect(app.texts()).toContain("Model is disabled.");

  await app.press("id:preset-item-p-missing");
  await app.waitUntil(() => presetTitle(app) === "Missing Model Preset");
  expect(app.texts()).toContain("Model was missing in the last channel sync.");

  await app.press("id:preset-item-p-unsupported");
  await app.waitUntil(() => presetTitle(app) === "Unsupported Proto Preset");
  expect(app.texts()).toContain("Provider or API protocol is unsupported in this build.");

  // 3. Returning to p-ch-off: renaming keeps the unavailable bindings intact.
  await app.press("id:preset-item-p-ch-off");
  await app.waitUntil(() => presetTitle(app) === "Disabled Channel Preset");
  await renamePreset(app, "Renamed Stale Preset");
  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return saved.items[0]?.name === "Renamed Stale Preset";
  });
  const afterRename = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(aiEngine(afterRename.items[0]!).modelIds).toEqual(["m-ch-off", "m-raw-deleted"]);

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
    return aiEngine(saved.items[0]!).modelIds.join(",") === "m-ok";
  });
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
  await choosePresetType(app, "ai");
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
  expect(aiEngine(parsed.items[0]!).templates).toHaveLength(2);
  const formalTpl = aiEngine(parsed.items[0]!).templates.find((tpl) => tpl.name === "Formal");
  expect(formalTpl).toBeDefined();
  expect(aiEngine(parsed.items[0]!).defaultTemplateId).toBe(formalTpl!.id);

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
  expect(aiEngine(beforeSave.items[0]!).templates).toHaveLength(2);
  expect(aiEngine(beforeSave.items[0]!).defaultTemplateId).toBe("tpl-1");

  // Single remaining default template cannot be removed.
  expect(app.enabled("id:preset-template-remove")).toBe(false);

  await app.press("id:preset-save");
  await app.waitUntil(() => {
    const raw = app.storage()[PRESETS_STORAGE_KEY];
    if (!raw) return false;
    const saved = JSON.parse(raw) as { items: TranslationPreset[] };
    return aiEngine(saved.items[0]!).templates.length === 1;
  });

  const savedData = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!) as {
    items: TranslationPreset[];
  };
  expect(aiEngine(savedData.items[0]!).templates[0]!.id).toBe("tpl-2");
  expect(aiEngine(savedData.items[0]!).defaultTemplateId).toBe("tpl-2");
});

test("presets ui: guards dirty navigation", async () => {
  const chOk = makeChannel({ id: "ch-ok", displayName: "OpenAI Ready", enabled: true });
  const chOff = makeChannel({ id: "ch-off", displayName: "OpenAI Off", enabled: false });
  const mOk = makeModel({ id: "m-1", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true });
  const mOff = makeModel({ id: "m-off", providerId: "ch-off", modelKey: "gpt-4o", enabled: true });

  const p1 = makePresetRecord("p-1", "Preset One", ["m-off"]);
  const p2 = makePresetRecord("p-2", "Preset Two", ["m-1"]);

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [chOk, chOff],
      models: [mOk, mOff],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [p1, p2] }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);

  // Clean saved editor switches/navigates with no confirmation prompt.
  await app.press("id:preset-item-p-2");
  await app.waitUntil(() => presetTitle(app) === "Preset Two");
  expect(app.shows("id:preset-discard-dialog")).toBe(false);

  await app.press("id:preset-item-p-1");
  await app.waitUntil(() => presetTitle(app) === "Preset One");

  await app.press("id:nav-settings");
  await app.waitFor("text:Appearance");
  expect(app.shows("id:preset-discard-dialog")).toBe(false);

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);
  await app.press("id:preset-manage-models");
  await app.waitFor("id:models-page");
  expect(app.shows("id:preset-discard-dialog")).toBe(false);

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);

  // 1. Cancel guard: Escape keeps the edits; Discard reverts them.
  await app.press("id:preset-enabled");
  expect(app.enabled("id:preset-save")).toBe(true);
  await app.press("id:preset-cancel");
  await app.waitFor("id:preset-discard-dialog");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(presetTitle(app)).toBe("Preset One");
  expect(app.accessibility("id:preset-enabled")?.checked).toBe("false");

  await app.press("id:preset-cancel");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(app.accessibility("id:preset-enabled")?.checked).toBe("true");
  expect(app.shows("id:preset-save")).toBe(false);

  // 2. Switch preset guard: Keep Editing keeps the edits; Discard switches.
  await app.press("id:preset-enabled");
  await app.press("id:preset-item-p-2");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-keep-editing");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(presetTitle(app)).toBe("Preset One");
  expect(app.accessibility("id:preset-enabled")?.checked).toBe("false");

  await app.press("id:preset-item-p-2");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => presetTitle(app) === "Preset Two");

  // 3. Add Preset guard: Discard opens a fresh draft; a clean draft cancels without a prompt.
  await app.press("id:preset-item-p-1");
  await app.waitUntil(() => presetTitle(app) === "Preset One");
  await app.press("id:preset-enabled");
  await app.press("id:add-preset-button");
  await choosePresetType(app, "ai");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(app.shows("id:preset-draft-item")).toBe(true);
  expect(app.value("id:preset-name")).toBe("");
  await app.press("id:preset-cancel");
  await app.waitUntil(() => !app.shows("id:preset-draft-item"));
  expect(app.shows("id:preset-discard-dialog")).toBe(false);

  // 4. Sidebar nav guard.
  await app.press("id:preset-item-p-1");
  await app.waitUntil(() => presetTitle(app) === "Preset One");
  await app.press("id:preset-enabled");
  await app.press("id:nav-settings");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-keep-editing");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(app.shows("id:presets-page")).toBe(true);
  await app.press("id:nav-models");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitFor("id:models-page");

  // 5. Manage Models guard.
  await app.press("id:nav-presets");
  await waitForPresetEditor(app);
  expect(presetTitle(app)).toBe("Preset One");
  await app.press("id:preset-enabled");
  await app.press("id:preset-manage-models");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitFor("id:models-page");
});

test("presets ui: confirms delete and selects the next preset", async () => {
  const chOk = makeChannel({ id: "ch-ok", displayName: "OpenAI Main", enabled: true });
  const mOk = makeModel({ id: "m-1", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true });
  const p1 = makePresetRecord("p-1", "Alpha", ["m-1"]);
  const p2 = makePresetRecord("p-2", "Beta", ["m-1"]);
  const p3 = makePresetRecord("p-3", "Gamma", ["m-1"]);

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [chOk],
      models: [mOk],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [p1, p2, p3] }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);
  expect(presetTitle(app)).toBe("Alpha");

  // A dirty preset swaps Delete for Cancel/Save, as a channel does.
  await app.press("id:preset-enabled");
  expect(app.shows("id:preset-delete")).toBe(false);
  expect(app.enabled("id:preset-save")).toBe(true);
  await app.press("id:preset-cancel");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(app.shows("id:preset-delete")).toBe(true);

  // Cancelling Delete keeps the saved preset.
  await app.press("id:preset-delete");
  await app.waitFor("id:preset-delete-dialog");
  await app.press("id:preset-delete-cancel");
  await app.waitUntil(() => !app.shows("id:preset-delete-dialog"));
  expect(presetTitle(app)).toBe("Alpha");
  expect(app.shows("id:preset-item-p-1")).toBe(true);

  // Confirming deletion of first row selects the next row (Beta).
  await app.press("id:preset-delete");
  await app.waitFor("id:preset-delete-dialog");
  await app.press("id:preset-delete-confirm");
  await app.waitUntil(() => !app.shows("id:preset-delete-dialog"));
  await app.waitUntil(() => presetTitle(app) === "Beta");
  expect(app.shows("id:preset-item-p-1")).toBe(false);

  // Confirming deletion of the last row (Gamma) selects the previous row (Beta).
  await app.press("id:preset-item-p-3");
  await app.waitUntil(() => presetTitle(app) === "Gamma");
  await app.press("id:preset-delete");
  await app.waitFor("id:preset-delete-dialog");
  await app.press("id:preset-delete-confirm");
  await app.waitUntil(() => !app.shows("id:preset-delete-dialog"));
  await app.waitUntil(() => presetTitle(app) === "Beta");
  expect(app.shows("id:preset-item-p-3")).toBe(false);

  // Reopen app to verify remaining preset persists, then delete last preset to empty state.
  const persisted = app.storage();
  const parsed = JSON.parse(persisted[PRESETS_STORAGE_KEY]!) as { items: TranslationPreset[] };
  expect(parsed.items.map((item) => item.id)).toEqual(["p-2"]);

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: persisted,
  });
  await reopened.press("id:nav-presets");
  await waitForPresetEditor(reopened);
  expect(presetTitle(reopened)).toBe("Beta");

  await reopened.press("id:preset-delete");
  await reopened.waitFor("id:preset-delete-dialog");
  await reopened.press("id:preset-delete-confirm");
  await reopened.waitUntil(() => !reopened.shows("id:preset-delete-dialog"));
  await reopened.waitUntil(() => reopened.shows("id:empty-add-preset-button"));
  expect(reopened.texts()).toContain("No presets yet");

  await reopened.press("id:empty-add-preset-button");
  await choosePresetType(reopened, "ai");
  await reopened.waitFor("id:preset-name");
  await reopened.keyboard.press("x");
  expect(reopened.value("id:preset-name")).toBe("x");
});

test("presets ui: resizes the presets split divider and persists width independently", async () => {
  const chOk = makeChannel({ id: "ch-ok", displayName: "OpenAI Main", enabled: true });
  const mOk = makeModel({ id: "m-1", providerId: "ch-ok", modelKey: "gpt-4.1", enabled: true });
  const preset = makePresetRecord("p-1", "Technical EN to ZH", ["m-1"]);

  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [chOk],
      models: [mOk],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [SPLIT_RAIL_STORAGE_KEYS.models]: "210",
      },
    }),
  });

  await app.press("id:nav-presets");
  await app.waitFor("id:presets-rail");
  await app.waitFor("label:Resize presets panel");

  await app.drag("label:Resize presets panel", { x: 70 });
  await app.waitUntil(() => Boolean(app.storage()[SPLIT_RAIL_STORAGE_KEYS.presets]));
  const resized = Number(app.storage()[SPLIT_RAIL_STORAGE_KEYS.presets]);
  expect(resized).toBeGreaterThan(240);
  expect(resized).toBeLessThanOrEqual(360);
  expect(app.storage()[SPLIT_RAIL_STORAGE_KEYS.models]).toBe("210");

  // Reopening preserves both split widths independently.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:presets-rail");
  expect(reopened.storage()[SPLIT_RAIL_STORAGE_KEYS.presets]).toBe(String(resized));
  expect(reopened.storage()[SPLIT_RAIL_STORAGE_KEYS.models]).toBe("210");
});

test("presets ui: Google Cloud", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({}),
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  expect(app.shows("id:preset-type-google-cloud")).toBe(true);
  await app.press("id:preset-type-google-cloud");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-google-cloud-api-key");

  // A Google Cloud preset needs no model, language, or prompt input.
  expect(app.shows("id:preset-primary-model")).toBe(false);
  expect(app.shows("id:preset-temperature")).toBe(false);
  expect(app.shows("id:preset-template-name")).toBe(false);
  expect(app.shows("id:preset-source-language")).toBe(false);
  // Usage needs a saved preset, so a new draft shows no usage section.
  expect(app.shows("id:preset-google-cloud-usage")).toBe(false);
  expect(app.value("id:preset-google-cloud-api-key")).toBe("");
  expect(app.requests()).toHaveLength(0);

  await app.type("id:preset-name", "Google Cloud");

  // Saving without a key focuses the key field and writes no preset.
  await app.press("id:preset-save");
  await app.waitUntil(() => app.texts().includes(t("presets.error.googleCloudKeyRequired")));
  expect(app.storage()[PRESETS_STORAGE_KEY]).toBeUndefined();
  await app.keyboard.press("g");
  expect(app.value("id:preset-google-cloud-api-key")).toBe("g");
  await app.clear("id:preset-google-cloud-api-key");
  await app.type("id:preset-google-cloud-api-key", "google-test-key");

  await app.press("id:preset-save");
  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));
  expect(app.requests()).toHaveLength(0);
  expect(app.texts()).toContain("Google Cloud Translation");
  await app.waitFor("id:preset-google-cloud-usage-count");
  expect(app.accessibility("id:preset-google-cloud-usage-count")?.name).toBe("0");
  const raw = app.storage()[PRESETS_STORAGE_KEY]!;
  expect(raw).not.toContain("google-test-key");
  const items = JSON.parse(raw).items as TranslationPreset[];
  expect(items[0]!.engine.kind).toBe("google-cloud");
  const ref = items[0]!.engine.kind === "google-cloud" ? items[0]!.engine.credentialRef : "";
  expect(ref.length).toBeGreaterThan(0);
  expect(app.storage()[googleCloudCredentialStorageKey(ref)]).toBe("google-test-key");

  // Reopening shows the stored-key state, not the key, and stays clean.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: app.storage(),
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-google-cloud-api-key");
  expect(reopened.value("id:preset-google-cloud-api-key")).toBe("");
  expect(reopened.shows("id:preset-save")).toBe(false);
  expect(reopened.texts()).toContain("Google Cloud Translation");
  expect(reopened.requests()).toHaveLength(0);
});

test("presets ui: Google Web", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({}),
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  expect(app.shows("id:preset-type-google-cloud")).toBe(true);
  expect(app.shows("id:preset-type-google-web")).toBe(true);
  await app.press("id:preset-type-google-web");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-name");

  // Google Web has no key, model, template, language, or usage control.
  expect(app.shows("id:preset-google-cloud-api-key")).toBe(false);
  expect(app.shows("id:preset-deepl-api-key")).toBe(false);
  expect(app.shows("id:preset-primary-model")).toBe(false);
  expect(app.shows("id:preset-temperature")).toBe(false);
  expect(app.shows("id:preset-template-name")).toBe(false);
  expect(app.shows("id:preset-source-language")).toBe(false);
  expect(app.shows("id:preset-google-cloud-usage")).toBe(false);
  expect(app.texts()).toContain(t("presets.googleWeb.disclosure"));
  expect(app.requests()).toHaveLength(0);

  await app.type("id:preset-name", "Google Web");
  await app.press("id:preset-save");
  await app.waitUntil(() => Boolean(app.storage()[PRESETS_STORAGE_KEY]));
  expect(app.requests()).toHaveLength(0);

  const items = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!).items as TranslationPreset[];
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ name: "Google Web", enabled: true });
  expect(items[0]!.engine).toEqual({ kind: "google-web" });
  expect(app.texts()).toContain("Google Web");
  expect(app.shows(`id:preset-item-${items[0]!.id} >> id:preset-item-mark-google-web`)).toBe(true);

  // Reopening loads the name, the enabled switch, and the same engine without a request.
  const reopened = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: app.storage(),
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-google-web-disclosure");
  expect(presetTitle(reopened)).toBe("Google Web");
  expect(reopened.accessibility("id:preset-enabled")?.checked).toBe("true");
  expect(reopened.shows("id:preset-save")).toBe(false);
  expect(reopened.texts()).toContain(t("presets.googleWeb.disclosure"));
  expect(reopened.requests()).toHaveLength(0);
});

test("presets ui: Google Web localizes the engine label and disclosure", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "zh-CN",
    storage: makeSeedStorage({ extra: { "settings.language": "zh-CN" } }),
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  expect(app.shows("id:preset-type-google-web >> text:Google 网页翻译")).toBe(true);
  await app.press("id:preset-type-google-web");
  await app.waitUntil(() => !app.shows("id:add-preset-dialog"));
  await app.waitFor("id:preset-google-web-disclosure");
  expect(app.texts()).toContain("使用谷歌网页版未公开的翻译接口，不保证稳定性");
  expect(app.requests()).toHaveLength(0);
});

test("presets ui: rail summaries lead with the channel mark", async () => {
  const deepseek = makeChannel({
    id: "ch-deepseek",
    presetId: "deepseek",
    displayName: "DeepSeek",
    enabled: true,
  });
  const deepseekModel = makeModel({
    id: "m-deepseek",
    providerId: "ch-deepseek",
    modelKey: "deepseek-chat",
    enabled: true,
  });
  const googlePreset: TranslationPreset = {
    id: "p-google",
    name: "Google Cloud",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: { kind: "google-cloud", credentialRef: "ref-google" },
  };
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [deepseek],
      models: [deepseekModel],
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({
          version: 1,
          items: [
            makePresetRecord("p-ai", "AI DeepSeek", ["m-deepseek"]),
            makeDeepLPresetRecord("p-deepl", "DeepL Free", "ref-deepl"),
            googlePreset,
            makePresetRecord("p-missing", "Removed Model", ["m-gone"]),
          ],
        }),
      },
    }),
  });

  await app.press("id:nav-presets");
  await waitForPresetEditor(app);

  // An AI preset leads with its primary model channel; DeepL and Google Cloud with their service.
  expect(app.shows("id:preset-item-p-ai >> id:preset-item-mark")).toBe(true);
  expect(app.shows("id:preset-item-p-deepl >> id:preset-item-mark")).toBe(true);
  expect(app.shows("id:preset-item-p-google >> id:preset-item-mark")).toBe(true);
  // A binding this build cannot resolve keeps the summary text and shows no mark.
  expect(app.shows("id:preset-item-p-missing >> id:preset-item-mark")).toBe(false);

  // A new draft gains its mark as soon as the primary model is chosen.
  await app.press("id:add-preset-button");
  await choosePresetType(app, "ai");
  await app.waitFor("id:preset-draft-item");
  expect(app.shows("id:preset-draft-item >> id:preset-draft-mark")).toBe(false);
  await app.press("id:preset-primary-model");
  await app.waitFor("role:option[DeepSeek · deepseek-chat]");
  await app.press("role:option[DeepSeek · deepseek-chat]");
  expect(app.shows("id:preset-draft-item >> id:preset-draft-mark")).toBe(true);
});

test("presets ui: DeepLX editor saves an endpoint without a token or network request", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({}),
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:empty-add-preset-button");
  await app.press("id:empty-add-preset-button");
  await app.waitFor("id:add-preset-dialog");
  expect(app.shows("id:preset-type-deeplx")).toBe(true);
  await choosePresetType(app, "deeplx");
  await app.waitFor("id:preset-deeplx-endpoint");

  // A DeepLX preset needs no model, prompt, usage, or server contact.
  expect(app.shows("id:preset-primary-model")).toBe(false);
  expect(app.shows("id:preset-temperature")).toBe(false);
  expect(app.shows("id:preset-template-name")).toBe(false);
  expect(app.shows("id:preset-manage-models")).toBe(false);
  expect(app.shows("id:preset-deepl-usage")).toBe(false);
  expect(app.shows("id:preset-google-cloud-usage")).toBe(false);
  expect(app.value("id:preset-deeplx-endpoint")).toBe("");
  expect(app.value("id:preset-deeplx-token")).toBe("");
  expect(app.shows("id:preset-deeplx-remove-token")).toBe(false);
  expect(app.texts()).toContain(t("presets.deeplx.endpointLabel"));
  expect(app.texts()).toContain(t("presets.deeplx.tokenLabel"));
  expect(app.shows("id:preset-deeplx-disclosure")).toBe(false);

  await app.type("id:preset-name", "DeepLX Local");

  // A non-loopback HTTP URL fails, saves nothing, and focuses the endpoint field.
  await app.type("id:preset-deeplx-endpoint", "http://example.com/translate");
  await app.press("id:preset-save");
  await app.waitUntil(() => app.texts().includes(t("presets.error.deeplxEndpointInvalid")));
  expect(app.storage()[PRESETS_STORAGE_KEY]).toBeUndefined();
  await app.keyboard.press("x");
  expect(app.value("id:preset-deeplx-endpoint")).toBe("http://example.com/translatex");

  // A fresh window types the canonical URL once, saves it, and reopens the record.
  const saved = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({}),
  });
  await saved.press("id:nav-presets");
  await saved.waitFor("id:empty-add-preset-button");
  await saved.press("id:empty-add-preset-button");
  await choosePresetType(saved, "deeplx");
  await saved.waitFor("id:preset-deeplx-endpoint");
  await saved.type("id:preset-name", "DeepLX Local");
  await saved.type("id:preset-deeplx-endpoint", "http://localhost:1188/translate");
  await saved.press("id:preset-save");
  await saved.waitUntil(() => Boolean(saved.storage()[PRESETS_STORAGE_KEY]));
  expect(saved.requests()).toHaveLength(0);

  const items = JSON.parse(saved.storage()[PRESETS_STORAGE_KEY]!).items as TranslationPreset[];
  expect(items[0]!.engine).toEqual({
    kind: "deeplx",
    endpointUrl: "http://localhost:1188/translate",
    credentialRef: null,
  });
  expect(Object.keys(saved.storage()).some((key) => key.startsWith(DEEPLX_TOKEN_KEY_PREFIX))).toBe(
    false,
  );
  expect(saved.texts()).toContain(t("presets.engine.deeplx"));

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: saved.storage(),
  });
  await reopened.press("id:nav-presets");
  await reopened.waitFor("id:preset-deeplx-endpoint");
  expect(reopened.value("id:preset-deeplx-endpoint")).toBe("http://localhost:1188/translate");
  expect(reopened.value("id:preset-deeplx-token")).toBe("");
  expect(reopened.shows("id:preset-deeplx-remove-token")).toBe(false);
  expect(reopened.requests()).toHaveLength(0);
});

test("presets ui: DeepLX endpoint change warns and Cancel discards a token removal", async () => {
  const preset: TranslationPreset = {
    id: "p-deeplx",
    name: "DeepLX Local",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      kind: "deeplx",
      endpointUrl: "http://localhost:1188/translate",
      credentialRef: "dlx-ref",
    },
  };
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [deeplxTokenStorageKey("dlx-ref")]: "stored-token",
      },
    }),
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:preset-deeplx-endpoint");

  // A stored token shows only its placeholder state and never the value.
  expect(app.value("id:preset-deeplx-token")).toBe("");
  expect(app.texts()).not.toContain("stored-token");
  expect(app.shows("id:preset-deeplx-remove-token")).toBe(true);

  await app.clear("id:preset-deeplx-endpoint");
  await app.type("id:preset-deeplx-endpoint", "http://127.0.0.1:1188/translate");
  await app.waitFor("id:preset-deeplx-token-warning");
  expect(app.texts()).toContain(t("presets.deeplx.tokenWillBeRemoved"));

  // Cancel restores the saved endpoint and drops the pending change.
  await app.press("id:preset-cancel");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => !app.shows("id:preset-discard-dialog"));
  expect(app.value("id:preset-deeplx-endpoint")).toBe("http://localhost:1188/translate");
  expect(app.shows("id:preset-deeplx-token-warning")).toBe(false);

  // Removing the token changes the draft; Cancel commits nothing.
  await app.press("id:preset-deeplx-remove-token");
  await app.waitUntil(() => !app.shows("id:preset-deeplx-remove-token"));
  await app.press("id:preset-cancel");
  await app.waitFor("id:preset-discard-dialog");
  await app.press("id:preset-discard-confirm");
  await app.waitUntil(() => app.shows("id:preset-deeplx-remove-token"));
  expect(app.storage()[deeplxTokenStorageKey("dlx-ref")]).toBe("stored-token");
  expect(app.requests()).toHaveLength(0);
});

test("presets ui: DeepLX token removal, replacement, and endpoint change persist", async () => {
  const preset: TranslationPreset = {
    id: "p-deeplx",
    name: "DeepLX Local",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    engine: {
      kind: "deeplx",
      endpointUrl: "http://localhost:1188/translate",
      credentialRef: "dlx-ref",
    },
  };
  const app = await open(APP_ENTRY, {
    ...viewport,
    locale: "en-US",
    storage: makeSeedStorage({
      extra: {
        [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [preset] }),
        [deeplxTokenStorageKey("dlx-ref")]: "stored-token",
      },
    }),
  });
  await app.press("id:nav-presets");
  await app.waitFor("id:preset-deeplx-endpoint");

  // Remove saved token commits the record first, then drops the stored token.
  await app.press("id:preset-deeplx-remove-token");
  await app.press("id:preset-save");
  await app.waitUntil(() => app.storage()[deeplxTokenStorageKey("dlx-ref")] === undefined);
  let saved = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!).items as TranslationPreset[];
  expect(saved[0]!.engine).toEqual({
    kind: "deeplx",
    endpointUrl: "http://localhost:1188/translate",
    credentialRef: null,
  });
  expect(app.shows("id:preset-deeplx-remove-token")).toBe(false);

  // A new token gets its own storage entry; the preset record keeps only the reference.
  await app.type("id:preset-deeplx-token", "replacement-token");
  await app.press("id:preset-save");
  await app.waitUntil(() =>
    Object.keys(app.storage()).some((key) => key.startsWith(DEEPLX_TOKEN_KEY_PREFIX)),
  );
  saved = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!).items as TranslationPreset[];
  const firstEngine = saved[0]!.engine as { credentialRef: string | null };
  expect(firstEngine.credentialRef).not.toBeNull();
  expect(app.storage()[deeplxTokenStorageKey(firstEngine.credentialRef!)]).toBe(
    "replacement-token",
  );
  expect(app.storage()[PRESETS_STORAGE_KEY]).not.toContain("replacement-token");

  // Typing another token replaces the entry after the commit.
  await app.type("id:preset-deeplx-token", "second-token");
  await app.press("id:preset-save");
  await app.waitUntil(() => {
    const keys = Object.keys(app.storage()).filter((key) =>
      key.startsWith(DEEPLX_TOKEN_KEY_PREFIX),
    );
    return keys.length === 1 && app.storage()[keys[0]!] === "second-token";
  });

  // A changed endpoint clears the stored token after the record commits.
  await app.clear("id:preset-deeplx-endpoint");
  await app.type("id:preset-deeplx-endpoint", "http://127.0.0.1:1188/translate");
  await app.waitFor("id:preset-deeplx-token-warning");
  await app.press("id:preset-save");
  await app.waitUntil(() =>
    Object.keys(app.storage()).every((key) => !key.startsWith(DEEPLX_TOKEN_KEY_PREFIX)),
  );
  saved = JSON.parse(app.storage()[PRESETS_STORAGE_KEY]!).items as TranslationPreset[];
  expect(saved[0]!.engine).toEqual({
    kind: "deeplx",
    endpointUrl: "http://127.0.0.1:1188/translate",
    credentialRef: null,
  });
  expect(app.requests()).toHaveLength(0);
});
