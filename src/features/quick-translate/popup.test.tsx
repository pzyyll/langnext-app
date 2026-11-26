import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { initializeAiModules } from "../../app/ai-setup";
import { GOOGLE_CLOUD_TTS_URL } from "../../integrations/tts/vendor/google-cloud";
import { DEFAULT_GOOGLE_VOICE_PREFERENCES } from "../../integrations/tts/vendor/google-preferences";
import { LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY } from "../language-detection/preferences";
import { DETECT_COLLECTION_STORAGE_KEY } from "../language-detection/store";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { credentialStorageKey, MODELS_STORAGE_KEY, PROVIDERS_STORAGE_KEY } from "../models/store";
import { getLanguageLabel, getTargetLanguageLabel } from "../../framework/languages";
import {
  deepLCredentialStorageKey,
  googleCloudCredentialStorageKey,
  PRESETS_STORAGE_KEY,
} from "../presets/store";
import type { TranslationPreset } from "../presets/types";
import { QUICK_TRANSLATE_PREFERENCES_KEY } from "./preferences";

initializeAiModules();

const POPUP_HARNESS = "./__tests__/popup-harness.tsx";
const POPUP_HARNESS_MODE_KEY = "__test.qt.popupMode";
const viewport = { width: 520, height: 520, platform: "windows" as const };

function makePreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-1",
    name: "Default EN to FR",
    enabled: true,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
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

/** Popup selections live in the popup's own preferences, never in preset records. */
const DEFAULT_POPUP_LANGUAGES = { sourceLanguage: "en", targetLanguage: "fr" } as const;
const TTS_STORAGE_KEY = "integrations.tts.v1";
const TTS_CREDENTIAL_NAMESPACE = "secret.tts";

function ttsCredentialStorageKey(credentialRef: string): string {
  return `${TTS_CREDENTIAL_NAMESPACE}.${credentialRef}`;
}

/** Saved detector channels plus the Automatic-target preferences the popup reads. */
function detectionSeed(options: { aiEnabled: boolean }): Record<string, string> {
  return {
    [DETECT_COLLECTION_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["ai", "google", "google-cloud"],
      channels: {
        ai: {
          enabled: options.aiEnabled,
          configured: true,
          config: { modelId: "det-1" },
          credentialRef: null,
        },
        google: { enabled: false, configured: true, config: {}, credentialRef: null },
        "google-cloud": { enabled: false, configured: false, config: {}, credentialRef: null },
      },
    }),
    [LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY]: JSON.stringify({
      version: 1,
      nativeLanguage: "zh",
      preferredTranslationLanguage: "en",
    }),
  };
}

function aiEngine(preset: TranslationPreset) {
  if (preset.engine.kind !== "ai") throw new Error("expected an AI preset");
  return preset.engine;
}

function aiTemplates(preset: TranslationPreset) {
  return aiEngine(preset).templates;
}

function seedWithPresets(
  presets: TranslationPreset[],
  extra: Record<string, string> = {},
): Record<string, string> {
  const channel = makeChannel({
    id: "ch-1",
    presetId: "openai",
    adapterId: "openai-compatible",
    enabled: true,
  });
  const model = makeModel({
    id: "m-1",
    providerId: "ch-1",
    modelKey: "gpt-4.1-mini",
    enabled: true,
  });
  return makeSeedStorage({
    channels: [channel],
    models: [model],
    credentials: { "ch-1": "sk-test" },
    extra: {
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        ...DEFAULT_POPUP_LANGUAGES,
        cards: [],
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: presets }),
      ...extra,
    },
  });
}

interface SavedCardSeed {
  id: string;
  presetId: string;
  templateId: string | null;
  collapsed: boolean;
}

/** Seeds the popup with saved cards; their list order is the card order. */
function seedWithSavedCards(
  presets: TranslationPreset[],
  cards: SavedCardSeed[],
): Record<string, string> {
  return seedWithPresets(presets, {
    [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
      version: 1,
      doubleCopyEnabled: false,
      autoTranslate: false,
      ...DEFAULT_POPUP_LANGUAGES,
      cards,
    }),
  });
}

/** The saved card ids, in popup order. */
function savedCardIds(storage: Record<string, string>): string[] {
  const raw = storage[QUICK_TRANSLATE_PREFERENCES_KEY];
  if (raw === undefined) return [];
  return (JSON.parse(raw) as { cards: { id: string }[] }).cards.map((card) => card.id);
}

test("desktop: quick popup translates on Enter, preserves Shift+Enter newline, and copies successful result", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  expect(app.shows("id:quick-translate-submit")).toBe(false);
  expect(app.shows("id:quick-translate-swap-languages")).toBe(true);
  expect(app.shows("id:quick-translate-speak-source")).toBe(false);
  expect(app.shows("id:quick-translate-speak-result")).toBe(false);
  expect(app.shows("id:quick-translate-copy")).toBe(false);

  // Whitespace-only Enter shows blank validation error, hides speech placeholder, and sends 0 requests.
  await app.type("id:quick-translate-source", "   ");
  expect(app.shows("id:quick-translate-speak-source")).toBe(false);
  await app.keyboard.press("enter");
  expect(app.texts()).toContain(t("quickTranslate.error.blankInput"));
  expect(app.requests()).toHaveLength(0);

  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  expect(app.shows("id:quick-translate-speak-source")).toBe(true);
  expect(app.enabled("id:quick-translate-speak-source")).toBe(false);
  await app.keyboard.press("enter");

  await app.waitFor("id:quick-translate-copy");
  expect(app.texts()).toContain("Bonjour");
  expect(app.shows("id:quick-translate-speak-result")).toBe(true);
  expect(app.enabled("id:quick-translate-speak-result")).toBe(false);
  expect(app.requests()).toHaveLength(1);

  await app.press("id:quick-translate-copy");
  expect(app.clipboard()).toBe("Bonjour");
  expect(app.shows(`role:button[${t("quickTranslate.copied")}]`)).toBe(true);

  // Shift+Enter inserts a newline without submitting.
  await app.type("id:quick-translate-source", "");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("backspace");
  await app.type("id:quick-translate-source", "Line 1");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Line 2");
  expect(app.texts()).toContain("Line 1");
  expect(app.texts()).toContain("Line 2");
  expect(app.texts()).toContain("13");
  expect(app.requests()).toHaveLength(1);
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.requests().length === 2);
  expect(app.requests()[1]!.body).toContain("Line 1\\nLine 2");
});

test("quick popup: collapses a non-empty source into a one-line preview and returns to the editor", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
  });

  await app.waitFor("id:quick-translate-source");
  // The collapse action exists only while the field has content.
  expect(app.shows("id:quick-translate-collapse-source")).toBe(false);

  await app.type("id:quick-translate-source", "First line");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Second line");
  expect(app.shows("id:quick-translate-collapse-source")).toBe(true);

  await app.hover("id:quick-translate-collapse-source");
  await app.waitFor(`text:${t("quickTranslate.collapseSource")}`);

  // Collapsed: one preview line, the source actions stay, and no translation starts.
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source-preview");
  expect(app.shows("id:quick-translate-source")).toBe(false);
  expect(app.texts()).toContain("First line");
  expect(app.texts()).not.toContain("Second line");
  expect(app.shows("id:quick-translate-source-actions")).toBe(true);
  expect(app.requests()).toHaveLength(0);

  // The pointer stayed on the toggle after the collapse; leave it so the hover enters again.
  await app.hover("id:quick-translate-source-preview");
  await app.hover("id:quick-translate-collapse-source");
  await app.waitFor(`text:${t("quickTranslate.editSource")}`);

  // Pressing the preview returns to the editor with the whole draft.
  await app.press("id:quick-translate-source-preview");
  await app.waitFor("id:quick-translate-source");
  expect(app.texts()).toContain("First line");
  expect(app.texts()).toContain("Second line");
  expect(app.texts()).toContain("22");
  expect(app.shows("id:quick-translate-source-preview")).toBe(false);

  // An empty field always shows the editor again.
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source-preview");
  await app.press("id:quick-translate-clear");
  await app.waitFor("id:quick-translate-source");
  expect(app.texts()).not.toContain("First line");
  expect(app.shows("id:quick-translate-collapse-source")).toBe(false);
});

test("quick popup: shows the source character count in the input's bottom toolbar", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
  });

  await app.waitFor("id:quick-translate-source");
  expect(app.shows("id:quick-translate-source-count")).toBe(false);

  await app.type("id:quick-translate-source", "Hello world");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-source-count")).toBe(
    true,
  );
  expect(app.shows("text:11")).toBe(true);
  expect(app.accessibility("id:quick-translate-source-count")?.label).toBe(
    t("quickTranslate.sourceCharacters", { count: 11 }),
  );

  // The count follows the draft.
  await app.type("id:quick-translate-source", "!");
  expect(app.shows("text:12")).toBe(true);

  await app.clear("id:quick-translate-source");
  expect(app.shows("id:quick-translate-source-count")).toBe(false);
});

test("quick popup: places the source edit toggle right of the character count", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello world");

  // The toggle joins the input's bottom toolbar, right of the count, not the top actions.
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-collapse-source")).toBe(
    true,
  );
  expect(app.shows("id:quick-translate-source-actions >> id:quick-translate-collapse-source")).toBe(
    false,
  );

  const toggle = app.layout("id:quick-translate-collapse-source");
  const count = app.layout("id:quick-translate-source-count");
  const section = app.layout("id:quick-translate-source-section");
  if (toggle === null || count === null || section === null) {
    throw new Error("expected the source toggle, its count, and the section to be laid out");
  }
  expect(count.x + count.width).toBeLessThanOrEqual(toggle.x);
  expect(toggle.x - (count.x + count.width)).toBeLessThanOrEqual(8);
  expect(Math.abs(toggle.y + toggle.height / 2 - (count.y + count.height / 2))).toBeLessThanOrEqual(
    1,
  );
  const trailingGap = section.x + section.width - (toggle.x + toggle.width);
  expect(Math.abs(trailingGap - 16)).toBeLessThanOrEqual(1);

  // The same toggle collapses the editor and expands the preview.
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source-preview");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-collapse-source")).toBe(
    true,
  );
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source");
});

test("quick popup: renders streamed text while translating and keeps partial text on failure", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], { [POPUP_HARNESS_MODE_KEY]: "streaming" }),
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");

  await app.waitUntil(() => app.texts().includes("Bon"));
  expect(app.shows("id:quick-translate-result-text")).toBe(true);
  expect(app.texts()).not.toContain(t("quickTranslate.translating"));
  expect(app.shows("id:quick-translate-copy")).toBe(false);

  await app.press("id:harness-complete-stream");
  await app.waitFor("id:quick-translate-copy");
  expect(app.texts()).toContain("Bonjour");
  expect(app.texts()).not.toContain(t("quickTranslate.translating"));

  // A stream that stops after partial text keeps that text beside the error.
  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello again");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().includes("Bon"));
  await app.press("id:harness-fail-stream");
  await app.waitFor("id:quick-translate-error");
  expect(app.texts()).toContain(t("protocol.error.streamInterrupted"));
  expect(app.shows("id:quick-translate-partial-text")).toBe(true);
  expect(app.texts()).toContain("Bon");
  expect(app.shows("id:quick-translate-copy")).toBe(false);
});

test("quick popup: shows localized tooltips for icon-only toolbar and card action buttons", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-copy");

  await app.hover("id:quick-translate-clear");
  await app.waitFor(`text:${t("common.clearInput")}`);

  await app.hover("id:quick-translate-swap-languages");
  await app.waitFor(`text:${t("quickTranslate.swapLanguages")}`);

  await app.hover("id:quick-translate-retry");
  await app.waitFor(`text:${t("common.retry")}`);

  await app.hover("id:quick-translate-copy");
  await app.waitFor(`text:${t("quickTranslate.copy")}`);

  await app.press("id:quick-translate-copy");
  await app.hover("id:quick-translate-retry");
  await app.hover("id:quick-translate-copy");
  await app.waitFor(`text:${t("quickTranslate.copied")}`);
});

test("quick popup: header language capsules show their full label in a hover tooltip", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
  });

  await app.waitFor("id:quick-translate-language-bar");
  await app.hover("id:quick-translate-source-language");
  await app.waitFor(
    `id:quick-translate-source-language-label-tooltip >> text:${getLanguageLabel("en")}`,
  );
  await app.hover("id:quick-translate-target-language");
  await app.waitFor(
    `id:quick-translate-target-language-label-tooltip >> text:${getTargetLanguageLabel("fr")}`,
  );

  // Leaving the capsule takes the tooltip away.
  await app.hover("id:harness-toggle-auto");
  await app.waitUntil(() => !app.shows("id:quick-translate-target-language-label-tooltip"));

  // The keyboard focus never opens it: closing the list with Escape brings the focus back to
  // the trigger without arming a tooltip that takes the Escape meant for the window.
  await app.press("id:quick-translate-target-language");
  await app.waitFor(`role:option[${getLanguageLabel("de")}]`);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows(`role:option[${getLanguageLabel("de")}]`));
  expect(app.shows("id:quick-translate-target-language-label-tooltip")).toBe(false);
  expect(app.shows("id:quick-translate-target-language >> text:French")).toBe(true);
});

test("quick popup: ignores Enter submission while an IME composition is active", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Salut" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.compose("id:quick-translate-source", "ni");
  await app.keyboard.press("enter");
  expect(app.requests()).toHaveLength(0);

  await app.compose("id:quick-translate-source", "");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-copy");
  expect(app.requests()).toHaveLength(1);
});

test("desktop: quick popup handles no enabled presets, preset load error with retry, and clipboard write failure", async () => {
  const disabledOnly = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset({ enabled: false })]),
  });
  await disabledOnly.waitFor("id:quick-translate-no-presets");
  expect(disabledOnly.texts()).toContain(t("quickTranslate.noEnabledPresets"));
  expect(disabledOnly.shows("id:quick-translate-submit")).toBe(false);
  await disabledOnly.type("id:quick-translate-source", "Hello");
  await disabledOnly.keyboard.press("enter");
  expect(disabledOnly.requests()).toHaveLength(0);

  const loadErr = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      [POPUP_HARNESS_MODE_KEY]: "preset-load-error-then-recover",
    }),
  });
  await loadErr.waitFor("id:quick-translate-retry-presets");
  expect(loadErr.texts().some((line) => line.includes("Presets disk failure"))).toBe(true);
  await loadErr.press("id:harness-fix-storage");
  await loadErr.press("id:quick-translate-retry-presets");
  await loadErr.waitFor("id:quick-translate-preset");
  expect(loadErr.shows("id:quick-translate-retry-presets")).toBe(false);

  const copyErr = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      [POPUP_HARNESS_MODE_KEY]: "clipboard-error",
    }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });
  await copyErr.waitFor("id:quick-translate-source");
  await copyErr.type("id:quick-translate-source", "Hello");
  await copyErr.keyboard.press("enter");
  await copyErr.waitFor("id:quick-translate-copy");
  await copyErr.press("id:quick-translate-copy");
  await copyErr.waitFor("id:quick-translate-copy-error");
  expect(copyErr.texts()).toContain(t("quickTranslate.error.copyFailed"));
  expect(copyErr.texts()).toContain("Bonjour");
});

test("quick popup: debounces 500ms opt-in auto-translate, preserves Shift+Enter newline, keeps preset change manual, and lets Enter bypass timer", async () => {
  const secondPreset = makePreset({
    id: "preset-2",
    name: "Preset Two",
  });
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    clock: {},
    storage: seedWithPresets([makePreset(), secondPreset]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Ok" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.clock!.runFor(1000);
  expect(app.requests()).toHaveLength(0);

  // Enable opt-in auto-translate and type: waits 500 ms before translating.
  await app.press("id:harness-toggle-auto");
  await app.type("id:quick-translate-source", "!");
  await app.clock!.runFor(499);
  expect(app.requests()).toHaveLength(0);
  await app.clock!.runFor(1);
  await app.waitFor("id:quick-translate-copy");
  expect(app.requests()).toHaveLength(1);

  // In automatic mode, Shift+Enter inserts newline without submitting early.
  await app.keyboard.press("shift+enter");
  expect(app.texts()).toContain("Hello!");
  expect(app.texts()).toContain("7");
  await app.clock!.runFor(400);
  expect(app.requests()).toHaveLength(1);
  await app.clock!.runFor(100);
  await app.waitUntil(() => app.requests().length === 2);
  expect(app.requests()[1]!.body).toContain("Hello!\\n");

  // Language change from header bar re-runs after 500 ms.
  await app.press("id:quick-translate-target-language");
  await app.waitFor(`role:option[${getTargetLanguageLabel("ja")}]`);
  await app.press(`role:option[${getTargetLanguageLabel("ja")}]`);
  expect(app.shows("id:quick-translate-copy")).toBe(false);
  expect(app.requests()).toHaveLength(2);
  await app.clock!.runFor(200);
  expect(app.requests()).toHaveLength(2);
  await app.clock!.runFor(350);
  expect(app.requests()).toHaveLength(3);

  // Changing preset alone invalidates result and does NOT trigger translation.
  await app.press("id:quick-translate-preset");
  await app.waitFor("role:option[Preset Two]");
  await app.press("role:option[Preset Two]");
  expect(app.shows("id:quick-translate-copy")).toBe(false);
  await app.clock!.runFor(1000);
  expect(app.requests()).toHaveLength(3);

  // Enter in input box bypasses debounce timer without a duplicate second call.
  await app.type("id:quick-translate-source", " Go");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-copy");
  expect(app.requests()).toHaveLength(4);
  await app.clock!.runFor(600);
  expect(app.requests()).toHaveLength(4);
});

test("quick popup: ignores out-of-order stale completion and clears state and timers on close", async () => {
  const outOfOrder = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      [POPUP_HARNESS_MODE_KEY]: "out-of-order",
    }),
  });

  await outOfOrder.waitFor("id:quick-translate-source");
  await outOfOrder.type("id:quick-translate-source", "First");
  await outOfOrder.keyboard.press("enter");

  await outOfOrder.type("id:quick-translate-source", " Second");
  await outOfOrder.waitUntil(() =>
    outOfOrder.texts().some((line) => line.includes("aborts=aborted-1")),
  );
  await outOfOrder.keyboard.press("enter");

  await outOfOrder.press("id:harness-resolve-second");
  await outOfOrder.waitUntil(() => outOfOrder.texts().includes("Result 2"));

  // Resolving older deferred request #1 must not overwrite Result 2.
  await outOfOrder.press("id:harness-resolve-first");
  expect(outOfOrder.texts()).toContain("Result 2");
  expect(outOfOrder.texts()).not.toContain("Result 1");

  // Close clears draft, results, and pending timers even if provider finishes later.
  const lateClose = await open(POPUP_HARNESS, {
    ...viewport,
    clock: {},
    storage: seedWithPresets([makePreset()], {
      [POPUP_HARNESS_MODE_KEY]: "late-after-close",
    }),
  });
  await lateClose.waitFor("id:quick-translate-source");
  await lateClose.type("id:quick-translate-source", "Closing draft");
  await lateClose.keyboard.press("enter");
  await lateClose.press("id:harness-toggle-open");
  await lateClose.press("id:harness-resolve-late");
  await lateClose.clock!.runFor(1000);
  expect(lateClose.texts()).not.toContain("Stale Late Result");

  await lateClose.press("id:harness-toggle-open");
  await lateClose.waitFor("id:quick-translate-source");
  expect(lateClose.value("id:quick-translate-source")).toBe("");
  expect(lateClose.shows("id:quick-translate-copy")).toBe(false);
});

test("quick popup: startup loads shared presets once without duplicate read on Presets navigation", async () => {
  const seed = seedWithPresets([makePreset()]);
  let presetReadCount = 0;
  let failPresetsRead = false;

  const app = await open("../../../App.tsx", {
    width: 1040,
    height: 720,
    platform: "windows",
    storage: seed,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => {
          if (key === PRESETS_STORAGE_KEY) {
            presetReadCount += 1;
            if (failPresetsRead) {
              throw new Error("Simulated preset failure");
            }
          }
          return seed[key] ?? null;
        },
        "Storage.setItem": async (key: string, value: string) => {
          seed[key] = value;
        },
        "Storage.removeItem": async (key: string) => {
          delete seed[key];
        },
      },
    },
  });

  expect(presetReadCount).toBe(1);
  await app.press("id:nav-presets");
  await app.waitFor("id:presets-page");
  expect(presetReadCount).toBe(1);
  expect(app.texts()).toContain("Default EN to FR");

  // Retry remains explicit on error.
  failPresetsRead = true;
  const failedApp = await open("../../../App.tsx", {
    width: 1040,
    height: 720,
    platform: "windows",
    storage: seed,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => {
          if (key === PRESETS_STORAGE_KEY) {
            presetReadCount += 1;
            if (failPresetsRead) {
              throw new Error("Simulated preset failure");
            }
          }
          return seed[key] ?? null;
        },
        "Storage.setItem": async () => {},
        "Storage.removeItem": async () => {},
      },
    },
  });
  expect(presetReadCount).toBe(2);
  await failedApp.press("id:nav-presets");
  await failedApp.waitFor("id:presets-retry-button");
  expect(presetReadCount).toBe(2);
  failPresetsRead = false;
  await failedApp.press("id:presets-retry-button");
  await failedApp.waitUntil(() => !failedApp.shows("id:presets-retry-button"));
  expect(presetReadCount).toBe(3);
});

test("preset cards: runs duplicate preset cards independently with template overrides, collapse/expand, retry, copy, removal, and auto-mode isolation", async () => {
  const multiTemplatePreset = makePreset({
    id: "preset-1",
    name: "Default EN to FR",
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
          systemTemplate: "Default {{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-2",
          name: "Formal",
          systemTemplate: "Formal {{source_language}}->{{target_language}}",
          userTemplate: "Formal: {{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
  });

  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets(
      [multiTemplatePreset, makePreset({ id: "preset-2", name: "Preset Two" })],
      {
        [POPUP_HARNESS_MODE_KEY]: "multi-card",
      },
    ),
  });

  await app.waitFor("id:quick-translate-card-card-1");
  // Add a second card of the same preset and assign a different template override in manual mode.
  await app.press("id:quick-translate-add-preset");
  await app.waitFor("role:menuitem[Default EN to FR]");
  await app.press("role:menuitem[Default EN to FR]");
  await app.waitFor("id:quick-translate-card-card-2");
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-template");
  await app.waitFor("role:option[Formal]");
  await app.press("role:option[Formal]");

  // Adding a card and selecting a template with no input sends no requests.
  expect(app.texts().some((line) => line.includes("calls=0|"))).toBe(true);

  await app.type("id:quick-translate-source", "Hello world");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((line) => line.includes("calls=2|")));

  // Complete card 2 BEFORE card 1 fails: card order stays card-1 then card-2.
  await app.press("id:harness-resolve-second");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  await app.press("id:harness-fail-first");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-retry");

  const textsAfter = app.texts();
  expect(textsAfter).toContain("Request timed out for card 1");
  expect(textsAfter).toContain("Card 2 Formal Result");
  const card1Idx = textsAfter.indexOf("Request timed out for card 1");
  const card2Idx = textsAfter.indexOf("Card 2 Formal Result");
  expect(card1Idx).toBeLessThan(card2Idx);

  // Copy affects only card 2.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(app.clipboard()).toBe("Card 2 Formal Result");
  expect(app.shows("id:quick-translate-card-card-2 >> role:button[Copied]")).toBe(true);
  expect(app.shows("id:quick-translate-card-card-1 >> role:button[Copied]")).toBe(false);

  // Retry on card 1 affects only card 1 without resending card 2.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry");
  await app.waitUntil(() => app.texts().some((line) => line.includes("calls=3|")));
  await app.press("id:harness-resolve-third");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(app.texts()).toContain("Card 1 Retry Result");
  expect(app.texts()).toContain("Card 2 Formal Result");

  // Start another run on card 2, remove card 2 mid-flight, then resolve late: card 2 stays gone & card 1 stays intact.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-retry");
  await app.waitUntil(() => app.texts().some((line) => line.includes("calls=4|")));
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-remove");
  expect(app.shows("id:quick-translate-card-card-2")).toBe(false);
  await app.waitUntil(() => app.texts().some((line) => line.includes("aborts=aborted-4")));
  await app.press("id:harness-resolve-fourth");
  expect(app.texts()).not.toContain("Stale Card 2 Late Result");
  expect(app.texts()).toContain("Card 1 Retry Result");

  // Collapse keeps the result; expanding restores it without sending a request again.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-result-text")).toBe(false);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(app.texts().some((line) => line.includes("calls=4|"))).toBe(true);

  // Once the input changes, expanding translates it again, even with Auto-translate off.
  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Changed input");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.waitUntil(() => app.texts().some((line) => line.includes("calls=5|")));
  await app.press("id:harness-resolve-fifth");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(app.texts()).toContain("Card 1 Expanded Result");
});

test("preset cards: drags a card above the previous one, keeps its result, and saves the order", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithSavedCards(
      [makePreset(), makePreset({ id: "preset-2", name: "Preset Two" })],
      [
        { id: "card-1", presetId: "preset-1", templateId: null, collapsed: false },
        { id: "card-2", presetId: "preset-2", templateId: null, collapsed: false },
      ],
    ),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-2");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(app.requests()).toHaveLength(2);

  // Cards render in their saved order: card 1 first.
  const before = app.texts();
  expect(before.indexOf("Default EN to FR")).toBeLessThan(before.indexOf("Preset Two"));

  // Dragging the second card's header above the first reorders the list, result included.
  await app.drag("id:quick-translate-card-header-card-2", { x: 0, y: -80 });
  await app.waitUntil(() => savedCardIds(app.storage())[0] === "card-2");
  expect(savedCardIds(app.storage())).toEqual(["card-2", "card-1"]);
  expect(app.requests()).toHaveLength(2);
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-result-text");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  const after = app.texts();
  expect(after.indexOf("Preset Two")).toBeLessThan(after.indexOf("Default EN to FR"));

  // Reopening restores the dragged order from the saved preferences.
  const reopened = await open(POPUP_HARNESS, { ...viewport, storage: app.storage() });
  await reopened.waitFor("id:quick-translate-card-card-2");
  expect(savedCardIds(reopened.storage())).toEqual(["card-2", "card-1"]);
});

test("preset cards: reorders with the grip arrow keys and keeps the focus", async () => {
  // A Linux host delivers raw keys to the focused view, as a desktop does.
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    platform: "linux",
    storage: seedWithSavedCards(
      [makePreset(), makePreset({ id: "preset-2", name: "Preset Two" })],
      [
        { id: "card-1", presetId: "preset-1", templateId: null, collapsed: false },
        { id: "card-2", presetId: "preset-2", templateId: null, collapsed: false },
      ],
    ),
  });

  await app.waitFor("id:quick-translate-card-grip-card-2");
  await app.press("id:quick-translate-card-grip-card-2");
  await app.keyboard.press("arrowup");
  await app.waitUntil(() => savedCardIds(app.storage())[0] === "card-2");

  // The grip keeps the focus across the reorder, so the next key moves it back.
  await app.keyboard.press("arrowdown");
  await app.waitUntil(() => savedCardIds(app.storage())[0] === "card-1");
});

test("preset cards: hides the reorder grip while a single card is shown", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithSavedCards(
      [makePreset()],
      [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
    ),
  });

  await app.waitFor("id:quick-translate-card-card-1");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-card-grip-card-1")).toBe(
    false,
  );
});

test("preset cards: reveals the reorder grip only while its card header is hovered", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithSavedCards(
      [makePreset(), makePreset({ id: "preset-2", name: "Preset Two" })],
      [
        { id: "card-1", presetId: "preset-1", templateId: null, collapsed: false },
        { id: "card-2", presetId: "preset-2", templateId: null, collapsed: false },
      ],
    ),
  });

  const gripOpacity = (cardId: string) =>
    app.viewStyle(`id:quick-translate-card-grip-${cardId}`)?.opacity;
  await app.waitFor("id:quick-translate-card-grip-card-2");
  await app.hover("id:quick-translate-footer");
  expect(gripOpacity("card-1")).toBe(0);
  expect(gripOpacity("card-2")).toBe(0);

  // Hovering one card's header reveals that card's grip and leaves the others at rest.
  await app.hover("id:quick-translate-card-header-card-1");
  expect(gripOpacity("card-1")).toBe(1);
  expect(gripOpacity("card-2")).toBe(0);
  await app.hover("id:quick-translate-card-header-card-2");
  expect(gripOpacity("card-1")).toBe(0);
  expect(gripOpacity("card-2")).toBe(1);
});

test("preset cards: toggles collapse from the card header and keeps drag separate", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithSavedCards(
      [makePreset({ name: "PT" }), makePreset({ id: "preset-2", name: "P2" })],
      [
        { id: "card-1", presetId: "preset-1", templateId: null, collapsed: false },
        { id: "card-2", presetId: "preset-2", templateId: null, collapsed: false },
      ],
    ),
  });

  await app.waitFor("id:quick-translate-card-card-2");

  // The empty part of the header toggles the card.
  await app.press("id:quick-translate-card-header-card-1");
  await app.waitFor("id:quick-translate-card-card-1 >> label:Expand card");
  await app.press("id:quick-translate-card-header-card-1");
  await app.waitFor("id:quick-translate-card-card-1 >> label:Collapse card");

  // A drag on the header reorders without collapsing either card.
  await app.drag("id:quick-translate-card-header-card-2", { x: 0, y: -80 });
  await app.waitUntil(() => savedCardIds(app.storage())[0] === "card-2");
  expect(app.shows("id:quick-translate-card-card-1 >> label:Collapse card")).toBe(true);
  expect(app.shows("id:quick-translate-card-card-2 >> label:Collapse card")).toBe(true);

  // The preset chip keeps its own action: it opens the menu instead of toggling the card.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-preset");
  await app.waitFor("role:option[P2]");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("role:option[P2]"));
  expect(app.shows("id:quick-translate-card-card-1 >> label:Collapse card")).toBe(true);
});

test("preset cards: template switches reuse pending and completed queries for the current input", async () => {
  const preset = makePreset();
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets(
      [
        {
          ...preset,
          engine: {
            ...aiEngine(preset),
            templates: [
              ...aiTemplates(preset),
              {
                id: "tpl-2",
                name: "Formal",
                systemTemplate: "Translate in a formal style.",
                userTemplate: "{{text}}",
              },
            ],
          },
        },
      ],
      { [POPUP_HARNESS_MODE_KEY]: "out-of-order" },
    ),
  });
  const callCountIs = (count: number) =>
    app.texts().some((line) => line.includes(`calls=${count}|`));
  const selectTemplate = async (name: string) => {
    await app.press("id:quick-translate-template");
    await app.waitFor(`role:option[${name}]`);
    await app.press(`role:option[${name}]`);
  };

  await app.waitFor("id:quick-translate-template");
  await app.type("id:quick-translate-source", "Hello world");
  await selectTemplate("Formal");
  await app.waitUntil(() => callCountIs(1));
  await selectTemplate("Default");
  await app.waitUntil(() => callCountIs(2));
  await selectTemplate("Formal");
  await app.waitFor("id:quick-translate-status");
  expect(callCountIs(2)).toBe(true);

  // The hidden template can finish without replacing the selected template's output.
  await app.press("id:harness-resolve-second");
  expect(app.shows("id:quick-translate-status")).toBe(true);
  expect(app.texts()).not.toContain("Result 2");
  await app.press("id:harness-resolve-first");
  await app.waitFor("text:Result 1");
  await selectTemplate("Default");
  await app.waitFor("text:Result 2");
  await selectTemplate("Formal");
  await app.waitFor("text:Result 1");
  expect(callCountIs(2)).toBe(true);

  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "New input");
  await selectTemplate("Default");
  await app.waitUntil(() => callCountIs(3));
  expect(app.shows("id:quick-translate-status")).toBe(true);
  expect(app.texts()).not.toContain("Result 2");
});

test("preset cards: automatic mode schedules eligible cards on shared input and runs only targeted card on add or template override", async () => {
  const multiTemplatePreset = makePreset({
    id: "preset-1",
    name: "Preset Alpha",
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
          systemTemplate: "Default {{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-2",
          name: "Concise",
          systemTemplate: "Concise {{source_language}}->{{target_language}}",
          userTemplate: "Short: {{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
  });

  const autoApp = await open(POPUP_HARNESS, {
    ...viewport,
    clock: {},
    storage: seedWithPresets([
      multiTemplatePreset,
      makePreset({ id: "preset-2", name: "Preset Beta" }),
    ]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Translated ok" } }] },
      },
    },
  });

  await autoApp.waitFor("id:quick-translate-card-card-1");
  await autoApp.press("id:harness-toggle-auto");
  await autoApp.type("id:quick-translate-source", "Good morning");
  await autoApp.clock!.runFor(500);
  await autoApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(autoApp.requests()).toHaveLength(1);

  // Add card in auto mode -> runs ONLY newly added card 2 (total 2 requests).
  await autoApp.press("id:quick-translate-add-preset");
  await autoApp.waitFor("role:menuitem[Preset Beta]");
  await autoApp.press("role:menuitem[Preset Beta]");
  await autoApp.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(autoApp.requests()).toHaveLength(2);

  // Shared language remains preserved across preset card add/change.
  expect(
    autoApp.shows(`id:quick-translate-source-language >> text:${getLanguageLabel("en")}`),
  ).toBe(true);
  expect(
    autoApp.shows(`id:quick-translate-target-language >> text:${getTargetLanguageLabel("fr")}`),
  ).toBe(true);

  // Change template override ONLY on card 1 -> runs ONLY card 1 (total 3 requests).
  await autoApp.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await autoApp.waitFor("role:option[Concise]");
  await autoApp.press("role:option[Concise]");
  await autoApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(autoApp.requests()).toHaveLength(3);

  // Switching before the typing debounce queries card 1 now, without repeating it later.
  await autoApp.type("id:quick-translate-source", "!");
  await autoApp.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await autoApp.waitFor("role:option[Default]");
  await autoApp.press("role:option[Default]");
  await autoApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(autoApp.requests()).toHaveLength(4);
  await autoApp.clock!.runFor(500);
  await autoApp.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(autoApp.requests()).toHaveLength(5);
});

test("preset cards: collapsed cards stay idle in automatic mode and translate when expanded", async () => {
  const twoTemplatePreset = makePreset({
    id: "preset-2",
    name: "Preset Beta",
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
          systemTemplate: "Default {{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-2",
          name: "Formal",
          systemTemplate: "Formal {{source_language}}->{{target_language}}",
          userTemplate: "Formal: {{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
  });

  const app = await open(POPUP_HARNESS, {
    ...viewport,
    clock: {},
    storage: seedWithPresets([
      makePreset({
        id: "preset-1",
        name: "Preset Alpha",
      }),
      twoTemplatePreset,
    ]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.press("id:harness-toggle-auto");
  await app.press("id:quick-translate-add-preset");
  await app.waitFor("role:menuitem[Preset Beta]");
  await app.press("role:menuitem[Preset Beta]");
  await app.waitFor("id:quick-translate-card-card-2");

  // A collapsed card ignores template overrides and shared-input auto translation.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-template");
  await app.waitFor("role:option[Formal]");
  await app.press("role:option[Formal]");
  await app.type("id:quick-translate-source", "Good morning");
  await app.clock!.runFor(500);
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(app.requests()).toHaveLength(1);

  // Expanding the collapsed card translates the current input at once.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(app.requests()).toHaveLength(2);

  // Expanding a card whose result answers the current input keeps it without a request.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(app.requests()).toHaveLength(2);

  // Every card collapsed: nothing runs on shared input or manual Enter.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Next line");
  await app.keyboard.press("enter");
  await app.clock!.runFor(500);
  expect(app.requests()).toHaveLength(2);
});

test("preset cards: manual translation skips collapsed cards and translates them on expand", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([
      makePreset({
        id: "preset-1",
        name: "Preset Alpha",
      }),
      makePreset({
        id: "preset-2",
        name: "Preset Beta",
      }),
    ]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.press("id:quick-translate-add-preset");
  await app.waitFor("role:menuitem[Preset Beta]");
  await app.press("role:menuitem[Preset Beta]");
  await app.waitFor("id:quick-translate-card-card-2");

  await app.type("id:quick-translate-source", "Hello");
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.submit("id:quick-translate-source");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(app.requests()).toHaveLength(1);

  // Expanding translates the current input even with Auto-translate off.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(app.requests()).toHaveLength(2);
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");

  // With every card collapsed Enter has nothing to run.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  expect(app.shows("id:quick-translate-card-card-1 >> label:Expand card")).toBe(true);
  await app.submit("id:quick-translate-source");
  expect(app.requests()).toHaveLength(2);
});

test("quick reopen: restores valid cards, fallback template, languages, and auto mode without stale text or requests, and handles corrupt or failing storage", async () => {
  const presetKeep = makePreset({
    id: "preset-keep",
    name: "Keep Preset",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-default",
          name: "Default",
          systemTemplate: "Default {{source_language}}->{{target_language}}",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-formal",
          name: "Formal",
          systemTemplate: "Formal {{source_language}}->{{target_language}}",
          userTemplate: "Formal: {{text}}",
        },
      ],
      defaultTemplateId: "tpl-default",
    },
  });
  const presetDrop = makePreset({
    id: "preset-drop",
    name: "Drop Later",
    enabled: true,
  });

  const session1 = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([presetKeep, presetDrop]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Secret output response" } }] },
      },
    },
  });

  await session1.waitFor("id:quick-translate-card-card-1");
  await session1.press("id:quick-translate-source-language");
  await session1.waitFor(`role:option[${getLanguageLabel("en")}]`);
  await session1.press(`role:option[${getLanguageLabel("en")}]`);
  await session1.press("id:quick-translate-target-language");
  await session1.waitFor(`role:option[${getTargetLanguageLabel("ja")}]`);
  await session1.press(`role:option[${getTargetLanguageLabel("ja")}]`);
  await session1.press("id:harness-toggle-auto");
  await session1.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await session1.waitFor("role:option[Formal]");
  await session1.press("role:option[Formal]");
  await session1.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");

  await session1.press("id:quick-translate-add-preset");
  await session1.waitFor("role:menuitem[Drop Later]");
  await session1.press("role:menuitem[Drop Later]");
  await session1.waitFor("id:quick-translate-card-card-2");

  // Collapsed card 1 stays out of translation; only expanded card 2 sends a request.
  await session1.type("id:quick-translate-source", "Secret draft source");
  await session1.waitUntil(() => session1.requests().length >= 1);
  expect(session1.requests()).toHaveLength(1);
  const rawPrefs = session1.storage()["quickTranslate.preferences.v1"]!;
  expect(rawPrefs).toBeDefined();
  expect(rawPrefs).not.toContain("Secret draft source");
  expect(rawPrefs).not.toContain("Secret output response");
  expect(rawPrefs).not.toContain("sk-test");
  expect(rawPrefs).not.toContain("pinned");

  // Disable preset-drop and remove tpl-formal override on preset-keep before reopening.
  const modifiedPresetKeep: TranslationPreset = {
    ...presetKeep,
    engine: {
      ...aiEngine(presetKeep),
      templates: [aiTemplates(presetKeep)[0]!],
    },
  };
  const modifiedPresetDrop: TranslationPreset = { ...presetDrop, enabled: false };
  const reopenedStorage = seedWithPresets([modifiedPresetKeep, modifiedPresetDrop], {
    "quickTranslate.preferences.v1": rawPrefs,
  });

  const session2 = await open(POPUP_HARNESS, {
    ...viewport,
    storage: reopenedStorage,
  });

  await session2.waitFor("id:quick-translate-card-card-1");
  expect(session2.shows("id:quick-translate-card-card-2")).toBe(false);
  expect(
    session2.shows(`id:quick-translate-source-language >> text:${getLanguageLabel("en")}`),
  ).toBe(true);
  expect(
    session2.shows(`id:quick-translate-target-language >> text:${getTargetLanguageLabel("ja")}`),
  ).toBe(true);
  expect(session2.texts()).toContain("Disable automatic translation");
  expect(session2.value("id:quick-translate-source")).toBe("");
  expect(session2.shows("id:quick-translate-result-text")).toBe(false);
  expect(session2.requests()).toHaveLength(0);
  expect(session2.shows("id:quick-translate-card-card-1 >> label:Expand card")).toBe(true);

  // Expanding collapsed card 1 reveals Default template fallback (not missing Formal).
  await session2.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  expect(session2.shows("id:quick-translate-card-card-1 >> label:Collapse card")).toBe(true);
  expect(
    session2.shows("id:quick-translate-card-card-1 >> id:quick-translate-template >> text:Default"),
  ).toBe(true);

  // Failed explicit save surfaces localized error alert without claiming saved.
  await session2.press("id:harness-toggle-prefs-write-fail");
  await session2.press("id:quick-translate-target-language");
  await session2.waitFor(`role:option[${getTargetLanguageLabel("fr")}]`);
  await session2.press(`role:option[${getTargetLanguageLabel("fr")}]`);
  await session2.waitFor("id:quick-translate-preferences-error");
  expect(session2.texts()).toContain(t("quickTranslate.error.savePreferences"));

  // Corrupt storage retains defaults and permits a subsequent explicit save.
  const corrupt = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([modifiedPresetKeep], {
      "quickTranslate.preferences.v1": "{corrupt!",
    }),
  });
  await corrupt.waitFor("id:quick-translate-card-card-1");
  expect(corrupt.texts()).toContain("Enable automatic translation");
  await corrupt.press("id:harness-toggle-auto");
  await corrupt.waitUntil(() =>
    Boolean(corrupt.storage()["quickTranslate.preferences.v1"]?.includes('"autoTranslate":true')),
  );
});

/** Checks whether the header language bar shows the expected source and target labels. */
function showsLanguagePair(
  app: Awaited<ReturnType<typeof open>>,
  sourceLanguage: Parameters<typeof getLanguageLabel>[0],
  targetLanguage: Parameters<typeof getTargetLanguageLabel>[0],
): boolean {
  const sourceText =
    sourceLanguage === "auto" ? t("quickTranslate.autoDetect") : getLanguageLabel(sourceLanguage);
  return (
    app.shows(`id:quick-translate-source-language >> text:${sourceText}`) &&
    app.shows(
      `id:quick-translate-target-language >> text:${getTargetLanguageLabel(targetLanguage)}`,
    )
  );
}

test("quick languages: owns its saved pair regardless of presets or cards", async () => {
  // A preset's legacy language values never seed the popup selections.
  const legacyPreset = makePreset({ id: "preset-legacy", name: "Legacy Preset" });
  const withoutSavedPair = seedWithPresets([legacyPreset]);
  delete withoutSavedPair[QUICK_TRANSLATE_PREFERENCES_KEY];
  // Older storage could carry language fields on the preset; the popup must not read them.
  withoutSavedPair[PRESETS_STORAGE_KEY] = JSON.stringify({
    version: 1,
    items: [{ ...legacyPreset, sourceLanguage: "en", targetLanguage: "fr" }],
  });

  const fresh = await open(POPUP_HARNESS, {
    ...viewport,
    storage: withoutSavedPair,
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await fresh.waitFor("id:quick-translate-card-card-1");
  expect(showsLanguagePair(fresh, "auto", "auto")).toBe(true);
  expect(showsLanguagePair(fresh, "en", "fr")).toBe(false);

  // Saved selections come back even when no preset is enabled to supply cards.
  const savedPairApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset({ id: "preset-off", name: "Off", enabled: false })]),
  });
  await savedPairApp.waitFor("id:quick-translate-no-presets");
  expect(showsLanguagePair(savedPairApp, "en", "fr")).toBe(true);

  // Switching presets keeps the saved pair and the next request uses it.
  const switchApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([
      makePreset({ id: "preset-alpha", name: "Alpha" }),
      makePreset({ id: "preset-beta", name: "Beta" }),
    ]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
    },
  });

  await switchApp.waitFor("id:quick-translate-card-card-1");
  await switchApp.type("id:quick-translate-source", "Hello");
  await switchApp.keyboard.press("enter");
  await switchApp.waitFor("id:quick-translate-copy");
  const firstBody = JSON.parse(switchApp.requests()[0]!.body!) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(firstBody.messages[0]!.content).toContain(getLanguageLabel("en"));
  expect(firstBody.messages[0]!.content).toContain(getLanguageLabel("fr"));

  await switchApp.press("id:quick-translate-preset");
  await switchApp.waitFor("role:option[Beta]");
  await switchApp.press("role:option[Beta]");
  expect(showsLanguagePair(switchApp, "en", "fr")).toBe(true);
  await switchApp.submit("id:quick-translate-source");
  await switchApp.waitUntil(() => switchApp.requests().length === 2);
  const secondBody = JSON.parse(switchApp.requests()[1]!.body!) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(secondBody.messages[0]!.content).toContain(getLanguageLabel("en"));
  expect(secondBody.messages[0]!.content).toContain(getLanguageLabel("fr"));
});

const DETECT_URL = "POST https://detect.example.com/v1/chat/completions";
const TRANSLATE_URL = "POST https://translate.example.com/v1/chat/completions";

interface StubbedRequest {
  method: string;
  url: string;
  body?: string | null;
  headers?: Record<string, string>;
}

function requestsTo(app: { requests(): StubbedRequest[] }, url: string): StubbedRequest[] {
  const [method, target] = url.split(" ");
  return app.requests().filter((request) => request.method === method && request.url === target);
}

function translateBodies(app: { requests(): StubbedRequest[] }) {
  return requestsTo(app, TRANSLATE_URL).map((request) => JSON.parse(request.body!));
}

/** Seeds one automatic-source, automatic-target preset with the requested cards and popup mode. */
function seedAutoPair(collapsed: readonly boolean[], mode = "live"): Record<string, string> {
  const detectChannel = makeChannel({
    id: "ch-detect",
    presetId: "openai",
    adapterId: "openai-compatible",
    baseUrl: "https://detect.example.com/v1",
    displayName: "Detector",
    enabled: true,
    sortOrder: 0,
  });
  const translateChannel = makeChannel({
    id: "ch-translate",
    presetId: "openai",
    adapterId: "openai-compatible",
    baseUrl: "https://translate.example.com/v1",
    displayName: "Translator",
    enabled: true,
    sortOrder: 1,
  });
  const detector = makeModel({
    id: "det-1",
    providerId: "ch-detect",
    modelKey: "detect-mini",
    enabled: true,
  });
  const translator = makeModel({
    id: "tr-1",
    providerId: "ch-translate",
    modelKey: "translate-mini",
    enabled: true,
  });
  const pairPreset = makePreset({
    id: "preset-auto",
    name: "Auto pair",
    engine: {
      kind: "ai",
      modelIds: ["tr-1"],
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
  });
  const cards = collapsed.map((isCollapsed, index) => ({
    id: `card-${index + 1}`,
    presetId: pairPreset.id,
    templateId: null,
    collapsed: isCollapsed,
  }));
  return makeSeedStorage({
    channels: [detectChannel, translateChannel],
    models: [detector, translator],
    credentials: { "ch-detect": "sk-detect", "ch-translate": "sk-translate" },
    extra: {
      [POPUP_HARNESS_MODE_KEY]: mode,
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [pairPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: "auto",
        targetLanguage: "auto",
        cards,
      }),
      ...detectionSeed({ aiEnabled: true }),
    },
  });
}

test("language resolution: one detection request serves both expanded cards", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false, false], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.waitFor("id:quick-translate-card-card-2");
  expect(
    app.shows(`id:quick-translate-source-language >> text:${t("quickTranslate.autoDetect")}`),
  ).toBe(true);
  expect(app.shows("id:quick-translate-source-detection")).toBe(false);

  await app.type("id:quick-translate-source", "Bonjour");
  expect(app.shows("id:quick-translate-source-actions >> id:quick-translate-clear")).toBe(true);
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));

  // Both cards wait on the same run: header source capsule shows Detecting while toolbar stays free of detection text.
  expect(app.texts().some((text) => text.startsWith("calls=0|"))).toBe(true);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(0);
  expect(app.texts()).toContain(t("quickTranslate.translating"));
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);
  expect(
    app.shows(`id:quick-translate-source-toolbar >> text:${t("quickTranslate.detectingLanguage")}`),
  ).toBe(false);

  await app.press("id:harness-resolve-language-fr");
  await app.waitUntil(() => requestsTo(app, TRANSLATE_URL).length === 2);
  await app.waitFor("id:quick-translate-result-text");

  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.autoDetectDetected", { language: getLanguageLabel("fr") })}`,
    ),
  ).toBe(true);
  expect(app.shows("id:quick-translate-source-detection")).toBe(false);

  const prompts = translateBodies(app);
  expect(prompts).toHaveLength(2);
  for (const body of prompts) {
    expect(body.messages[0].content).toContain(getLanguageLabel("fr"));
    expect(body.messages[0].content).toContain(getLanguageLabel("zh"));
    expect(body.messages[1].content).toBe("Bonjour");
  }
  expect(app.texts().some((text) => text.startsWith("calls=2|"))).toBe(true);
});

test("language resolution: the source language list names the detected language on its automatic item", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));

  // The trigger reports progress; the list keeps naming the choice, not the progress.
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);
  await app.press("id:quick-translate-source-language");
  await app.waitFor(`role:option[${t("quickTranslate.autoDetect")}]`);
  await app.press(`role:option[${t("quickTranslate.autoDetect")}]`);
  await app.waitUntil(() => !app.shows(`role:option[${t("quickTranslate.autoDetect")}]`));

  await app.press("id:harness-resolve-language-fr");
  const detected = t("quickTranslate.autoDetectDetected", { language: getLanguageLabel("fr") });
  await app.waitUntil(() => app.shows(`id:quick-translate-source-language >> text:${detected}`));

  await app.press("id:quick-translate-source-language");
  await app.waitFor(`role:option[${detected}]`);
  expect(app.shows(`role:option[${t("quickTranslate.autoDetect")}]`)).toBe(false);
  await app.press(`role:option[${detected}]`);
  await app.waitUntil(() => !app.shows(`role:option[${detected}]`));
  expect(app.shows(`id:quick-translate-source-language >> text:${detected}`)).toBe(true);
});

test("language resolution: the popup detection uses the saved detector endpoint", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false, false]),
    network: {
      [DETECT_URL]: { status: 200, body: { choices: [{ message: { content: "fr" } }] } },
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => requestsTo(app, TRANSLATE_URL).length === 2);
  await app.waitFor("id:quick-translate-result-text");

  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(2);
});

test("detector storage: a credential read failure shows a recoverable card error", async () => {
  const storage = seedAutoPair([false]);
  const readError = "Private credential storage error";
  let failCredentialRead = true;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    modules: {
      nsh: {
        "Storage.getItem": (key: string) => {
          if (failCredentialRead && key === credentialStorageKey("ch-detect")) {
            throw new Error(readError);
          }
          return storage[key] ?? null;
        },
      },
    },
    network: {
      [DETECT_URL]: { status: 200, body: { choices: [{ message: { content: "fr" } }] } },
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-retry");
  expect(app.texts()).toContain(t("languageDetection.failure.failed"));
  expect(app.texts()).not.toContain(readError);
  expect(app.requests()).toHaveLength(0);

  failCredentialRead = false;
  await app.press("id:quick-translate-retry");
  await app.waitFor("id:quick-translate-result-text");
  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(1);
});

test("language resolution: a collapsed card neither starts nor joins the run", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false, true], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  await app.press("id:harness-resolve-language-fr");
  await app.waitUntil(() => requestsTo(app, TRANSLATE_URL).length === 1);
  await app.waitFor("id:quick-translate-result-text");

  expect(app.texts().some((text) => text.startsWith("calls=1|"))).toBe(true);
  expect(app.texts().some((text) => text.includes("detects=1|"))).toBe(true);
});

test("language resolution: a later card expand reuses the detection of the same input", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false, true], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.waitFor("id:quick-translate-card-card-2");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  await app.press("id:harness-resolve-language-fr");
  await app.waitUntil(() => requestsTo(app, TRANSLATE_URL).length === 1);
  await app.waitFor("id:quick-translate-result-text");

  // The collapsed card starts later on the same input: no second detector request.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.waitUntil(() => requestsTo(app, TRANSLATE_URL).length === 2);
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-result-text");

  expect(app.texts().some((text) => text.startsWith("calls=2|"))).toBe(true);
  expect(app.texts().some((text) => text.includes("detects=1|"))).toBe(true);
});

test("language resolution: blocked detection shows the same recovery text on every card without translation traffic", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false, false], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "???");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  await app.press("id:harness-resolve-language-und");

  const message = t("languageDetection.failure.unknownLanguage");
  await app.waitUntil(() => app.texts().filter((text) => text === message).length === 2);

  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(0);
});

test("language resolution: the last consumer leaving aborts the shared detection", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false, false], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);

  await app.press("id:quick-translate-clear");
  expect(
    app.shows(`id:quick-translate-source-language >> text:${t("quickTranslate.autoDetect")}`),
  ).toBe(true);
  await app.waitUntil(() => app.texts().some((text) => text.includes("detectAborts=aborted-1")));
  await app.press("id:harness-resolve-language-fr");
  await app.wait(50);

  expect(
    app.shows(`id:quick-translate-source-language >> text:${t("quickTranslate.autoDetect")}`),
  ).toBe(true);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(0);
  expect(app.shows("id:quick-translate-result-text")).toBe(false);
  expect(app.shows("id:quick-translate-error")).toBe(false);
});

test("language resolution: retrying after a failure starts a new detection run", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false], "language-resolution"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "Bonjour!" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  await app.press("id:harness-resolve-language-und");
  await app.waitFor("id:quick-translate-retry");
  expect(
    app.shows(`id:quick-translate-source-language >> text:${t("quickTranslate.autoDetect")}`),
  ).toBe(true);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(0);

  await app.press("id:quick-translate-retry");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=2|")));
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);
  await app.press("id:harness-resolve-language-fr");
  await app.waitFor("id:quick-translate-result-text");

  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(1);
  expect(app.texts()).toContain("Bonjour!");
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.autoDetectDetected", { language: getLanguageLabel("fr") })}`,
    ),
  ).toBe(true);
});

const DEEPL_URL = "POST https://api-free.deepl.com/v2/translate";
const DEEPL_KEY_REF = "deepl-ref-1";

function makeDeepLPreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-deepl",
    name: "DeepL Card",
    enabled: true,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    engine: { kind: "deepl", credentialRef: DEEPL_KEY_REF },
    ...overrides,
  };
}

interface DeepLSeedOptions {
  sourceLanguage?: "auto" | "en";
  targetLanguage?: "auto" | "ja" | "de" | "zh";
  detectionMode?: "ai" | "off";
  cards?: readonly ("ai" | "deepl")[];
  aiModels?: boolean;
  /** A stale saved template override that a DeepL card must ignore. */
  deeplTemplateId?: string | null;
}

/** Seeds an AI card and/or a DeepL card with one detector and the stored DeepL key. */
function seedDeepLCards(options: DeepLSeedOptions = {}): Record<string, string> {
  const detectChannel = makeChannel({
    id: "ch-detect",
    presetId: "openai",
    adapterId: "openai-compatible",
    baseUrl: "https://detect.example.com/v1",
    displayName: "Detector",
    enabled: true,
    sortOrder: 0,
  });
  const translateChannel = makeChannel({
    id: "ch-translate",
    presetId: "openai",
    adapterId: "openai-compatible",
    baseUrl: "https://translate.example.com/v1",
    displayName: "Translator",
    enabled: true,
    sortOrder: 1,
  });
  const detector = makeModel({
    id: "det-1",
    providerId: "ch-detect",
    modelKey: "detect-mini",
    enabled: true,
  });
  const translator = makeModel({
    id: "tr-1",
    providerId: "ch-translate",
    modelKey: "translate-mini",
    enabled: true,
  });
  const aiPreset = makePreset({
    id: "preset-ai",
    name: "AI Card",
    engine: {
      kind: "ai",
      modelIds: ["tr-1"],
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
  });
  const cards = (options.cards ?? ["ai", "deepl"]).map((kind, index) => ({
    id: `card-${index + 1}`,
    presetId: kind === "ai" ? aiPreset.id : "preset-deepl",
    templateId: kind === "deepl" ? (options.deeplTemplateId ?? null) : null,
    collapsed: false,
  }));
  const items = options.aiModels === false ? [makeDeepLPreset()] : [aiPreset, makeDeepLPreset()];
  const storage = makeSeedStorage({
    ...(options.aiModels === false
      ? {}
      : {
          channels: [detectChannel, translateChannel],
          models: [detector, translator],
          credentials: { "ch-detect": "sk-detect", "ch-translate": "sk-translate" },
        }),
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: options.sourceLanguage ?? "auto",
        targetLanguage: options.targetLanguage ?? "ja",
        cards,
      }),
      [deepLCredentialStorageKey(DEEPL_KEY_REF)]: "deepl-key:fx",
      ...detectionSeed({ aiEnabled: (options.detectionMode ?? "ai") === "ai" }),
    },
  });
  if (options.aiModels === false) {
    delete storage[MODELS_STORAGE_KEY];
    delete storage[PROVIDERS_STORAGE_KEY];
  }
  return storage;
}

function deepLNetwork(detectorAnswer = "fr") {
  return {
    [DETECT_URL]: {
      status: 200,
      body: { choices: [{ message: { content: detectorAnswer } }] },
    },
    [TRANSLATE_URL]: {
      status: 200,
      body: { choices: [{ message: { content: "译文" } }] },
    },
    [DEEPL_URL]: {
      status: 200,
      body: { translations: [{ detected_source_language: "FR", text: "DeepL 译文" }] },
    },
  };
}

test("DeepL card: one detection run serves an AI card and a DeepL card the same pair", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedDeepLCards({ targetLanguage: "ja", deeplTemplateId: "tpl-stale" }),
    network: deepLNetwork(),
  });

  await app.waitFor("id:quick-translate-card-card-2");
  // The template selector stays an AI-only control.
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-template")).toBe(true);
  expect(app.shows("id:quick-translate-card-card-2 >> id:quick-translate-template")).toBe(false);

  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(
    () => requestsTo(app, DEEPL_URL).length === 1 && requestsTo(app, TRANSLATE_URL).length === 1,
  );
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-result-text");

  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  expect(app.texts()).toContain("DeepL 译文");

  const aiBody = JSON.parse(requestsTo(app, TRANSLATE_URL)[0]!.body!) as {
    messages: Array<{ content: string }>;
  };
  expect(aiBody.messages[0]!.content).toContain(getLanguageLabel("fr"));
  expect(aiBody.messages[0]!.content).toContain(getLanguageLabel("ja"));

  const deeplRequest = requestsTo(app, DEEPL_URL)[0]!;
  expect(deeplRequest.headers?.authorization).toBe("DeepL-Auth-Key deepl-key:fx");
  expect(JSON.parse(deeplRequest.body!)).toEqual({
    text: ["Bonjour"],
    source_lang: "FR",
    target_lang: "JA",
  });
});

test("DeepL card: an automatic target resolves once for both engines", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedDeepLCards({ targetLanguage: "auto" }),
    network: deepLNetwork(),
  });

  await app.waitFor("id:quick-translate-card-card-2");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(
    () => requestsTo(app, DEEPL_URL).length === 1 && requestsTo(app, TRANSLATE_URL).length === 1,
  );

  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  const deeplBody = JSON.parse(requestsTo(app, DEEPL_URL)[0]!.body!) as {
    source_lang: string;
    target_lang: string;
  };
  expect(deeplBody.source_lang).toBe("FR");
  expect(deeplBody.target_lang).toBe("ZH-HANS");

  const aiBody = JSON.parse(requestsTo(app, TRANSLATE_URL)[0]!.body!) as {
    messages: Array<{ content: string }>;
  };
  expect(aiBody.messages[0]!.content).toContain(getLanguageLabel("fr"));
  expect(aiBody.messages[0]!.content).toContain(getLanguageLabel("zh"));
});

test("DeepL card: explicit selections need no detector for either engine", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedDeepLCards({
      sourceLanguage: "en",
      targetLanguage: "de",
      detectionMode: "off",
    }),
    network: deepLNetwork(),
  });

  await app.waitFor("id:quick-translate-card-card-2");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitUntil(
    () => requestsTo(app, DEEPL_URL).length === 1 && requestsTo(app, TRANSLATE_URL).length === 1,
  );

  expect(requestsTo(app, DETECT_URL)).toHaveLength(0);
  expect(JSON.parse(requestsTo(app, DEEPL_URL)[0]!.body!)).toMatchObject({
    source_lang: "EN",
    target_lang: "DE",
  });
});

test("DeepL card: detection off or failed blocks both engines without a fallback detector", async () => {
  const off = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedDeepLCards({ targetLanguage: "ja", detectionMode: "off" }),
    network: deepLNetwork(),
  });
  await off.waitFor("id:quick-translate-card-card-2");
  await off.type("id:quick-translate-source", "Bonjour");
  await off.keyboard.press("enter");
  const unconfigured = t("languageDetection.failure.unconfigured");
  await off.waitUntil(() => off.texts().filter((text) => text === unconfigured).length === 2);
  expect(requestsTo(off, TRANSLATE_URL)).toHaveLength(0);
  expect(requestsTo(off, DEEPL_URL)).toHaveLength(0);

  const failed = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedDeepLCards({ targetLanguage: "ja" }),
    network: deepLNetwork("und"),
  });
  await failed.waitFor("id:quick-translate-card-card-2");
  await failed.type("id:quick-translate-source", "??");
  await failed.keyboard.press("enter");
  const unknown = t("languageDetection.failure.unknownLanguage");
  await failed.waitUntil(() => failed.texts().filter((text) => text === unknown).length === 2);
  expect(requestsTo(failed, TRANSLATE_URL)).toHaveLength(0);
  expect(requestsTo(failed, DEEPL_URL)).toHaveLength(0);
});

test("DeepL card: a DeepL-only action translates without AI models", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedDeepLCards({
      cards: ["deepl"],
      sourceLanguage: "en",
      targetLanguage: "zh",
      detectionMode: "off",
      aiModels: false,
    }),
    network: {
      [DEEPL_URL]: {
        status: 200,
        body: { translations: [{ detected_source_language: "EN", text: "你好，团队" }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Hello team");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");

  expect(app.texts()).toContain("你好，团队");
  expect(requestsTo(app, DEEPL_URL)).toHaveLength(1);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(0);
  expect(requestsTo(app, DETECT_URL)).toHaveLength(0);
});

test("quick popup: separates header detection status from OCR status priority in the bottom-left toolbar", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false], "ocr-status"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-source");
  expect(app.enabled("id:quick-translate-source")).toBe(true);
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    false,
  );
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy")).toBe(false);
  expect(app.shows("id:quick-translate-source-detection")).toBe(false);

  // 1. Empty input with OCR error shows the alert in the bottom-left toolbar.
  await app.press("id:harness-ocr-error");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
  expect(app.texts()).toContain(t("ocr.failure.malformedAnswer"));
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy")).toBe(false);

  // 2. Clear OCR status, enter source text, and start language detection in the header capsule.
  await app.press("id:harness-ocr-idle");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    false,
  );
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  await app.waitFor(
    `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
  );
  expect(app.shows("id:quick-translate-source-detection")).toBe(false);

  // 3. Entering OCR recognizing leaves header Detecting intact, shows busy below source, and
  //    makes the source wait for the answer.
  await app.press("id:harness-ocr-recognizing");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  expect(app.enabled("id:quick-translate-source")).toBe(false);
  // The field keeps its text but takes no edits until recognition ends.
  await app.type("id:quick-translate-source", "x").catch((error: unknown) => {
    expect(String(error)).toMatch(/disabled|not editable/i);
  });
  expect(app.texts()).toContain("Bonjour");
  expect(app.texts()).toContain("7");
  expect(app.texts()).toContain(t("quickTranslate.ocrRecognizing"));
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    false,
  );

  // 4. Entering OCR error replaces busy inside the source toolbar and frees the source.
  await app.press("id:harness-ocr-error");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
  expect(app.enabled("id:quick-translate-source")).toBe(true);
  expect(app.texts()).toContain(t("ocr.failure.malformedAnswer"));
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy")).toBe(false);

  // 5. Collapsing the source input keeps the OCR alert and speech placeholder visible.
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source-preview");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    true,
  );
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-speak-source")).toBe(
    true,
  );
  expect(app.texts()).toContain(t("ocr.failure.malformedAnswer"));

  // 6. Returning OCR to idle clears the alert, and resolution updates only the header capsule.
  await app.press("id:harness-ocr-idle");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    false,
  );
  await app.press("id:harness-resolve-language-fr");
  await app.waitUntil(() =>
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.autoDetectDetected", { language: getLanguageLabel("fr") })}`,
    ),
  );
  expect(app.shows("id:quick-translate-source-detection")).toBe(false);
});

test("quick popup: swap button swaps explicit or auto-detected languages and ignores unresolved auto", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false], "ocr-status"),
    network: {
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "译文" } }] } },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  // Set target to English while source remains unresolved auto; swap must remain disabled.
  await app.press("id:quick-translate-target-language");
  await app.waitFor(`role:option[${getTargetLanguageLabel("en")}]`);
  await app.press(`role:option[${getTargetLanguageLabel("en")}]`);
  expect(app.enabled("id:quick-translate-swap-languages")).toBe(false);
  expect(showsLanguagePair(app, "auto", "en")).toBe(true);

  // Setting source to English makes source === target, so swap stays disabled.
  await app.press("id:quick-translate-source-language");
  await app.waitFor(`role:option[${getLanguageLabel("en")}]`);
  await app.press(`role:option[${getLanguageLabel("en")}]`);
  expect(app.enabled("id:quick-translate-swap-languages")).toBe(false);
  expect(showsLanguagePair(app, "en", "en")).toBe(true);

  // Changing target to German enables swap and exchanges them cleanly.
  await app.press("id:quick-translate-target-language");
  await app.waitFor(`role:option[${getTargetLanguageLabel("de")}]`);
  await app.press(`role:option[${getTargetLanguageLabel("de")}]`);
  expect(app.enabled("id:quick-translate-swap-languages")).toBe(true);
  await app.press("id:quick-translate-swap-languages");
  expect(showsLanguagePair(app, "de", "en")).toBe(true);

  // Auto-detected source resolves effective language for swapping.
  await app.press("id:quick-translate-source-language");
  await app.waitFor(`role:option[${t("quickTranslate.autoDetect")}]`);
  await app.press(`role:option[${t("quickTranslate.autoDetect")}]`);
  expect(app.enabled("id:quick-translate-swap-languages")).toBe(false);
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);
  await app.press("id:harness-resolve-language-fr");
  await app.waitUntil(() =>
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.autoDetectDetected", { language: getLanguageLabel("fr") })}`,
    ),
  );
  expect(app.enabled("id:quick-translate-swap-languages")).toBe(true);

  await app.press("id:quick-translate-swap-languages");
  expect(showsLanguagePair(app, "en", "fr")).toBe(true);
});

const QUICK_TTS_URL = "POST " + GOOGLE_CLOUD_TTS_URL;
const QUICK_TTS_MP3 = {
  audioContent: Buffer.from(Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00])).toString("base64"),
};

function enabledTtsStorage(enabled = true): Record<string, string> {
  return {
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["google-cloud"],
      channels: {
        "google-cloud": {
          enabled,
          configured: true,
          config: { preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES },
          credentialRef: "tts-ref",
        },
      },
    }),
    [ttsCredentialStorageKey("tts-ref")]: JSON.stringify({ apiKey: "tts-key" }),
  };
}

function ttsVoice(requestBody: string | null | undefined): { languageCode: string; name: string } {
  return JSON.parse(requestBody ?? "").voice;
}

test("quick tts: speaks the full source before translation and one selected result", async () => {
  const source = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: { [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 } },
  });
  await source.waitFor("id:quick-translate-source");
  await source.type("id:quick-translate-source", "Hello");
  await source.keyboard.press("shift+enter");
  await source.type("id:quick-translate-source", "world");
  await source.waitUntil(() => source.enabled("id:quick-translate-speak-source"));
  await source.press("id:quick-translate-speak-source");
  await source.waitUntil(() => source.requests().length === 1);
  const spoken = source.requests()[0]!;
  expect(spoken.url).toBe(GOOGLE_CLOUD_TTS_URL);
  expect(JSON.parse(spoken.body ?? "").input.text).toBe("Hello\nworld");
  expect(ttsVoice(spoken.body)).toEqual({ languageCode: "en-US", name: "en-US-Standard-C" });
  expect(spoken.headers["x-goog-api-key"] ?? spoken.headers["X-Goog-Api-Key"]).toBe("tts-key");

  const result = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 },
    },
  });
  await result.waitFor("id:quick-translate-source");
  await result.type("id:quick-translate-source", "Hello");
  await result.keyboard.press("enter");
  await result.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  expect(result.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);
  await result.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await result.waitUntil(() =>
    result.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL),
  );
  const speech = result.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL);
  expect(speech).toHaveLength(1);
  expect(JSON.parse(speech[0]!.body ?? "").input.text).toBe("Bonjour");
  expect(ttsVoice(speech[0]!.body)).toEqual({ languageCode: "fr-FR", name: "fr-FR-Standard-F" });
  expect(result.requests().some((request) => request.url.includes("chat/completions"))).toBe(true);
});

const AZURE_QUICK_TTS_URL = "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1";

function azureActiveStorage(): Record<string, string> {
  return {
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["google-cloud", "azure"],
      channels: {
        "google-cloud": {
          enabled: false,
          configured: true,
          config: { preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES },
          credentialRef: "google-ref",
        },
        azure: {
          enabled: true,
          configured: true,
          config: { region: "eastus" },
          credentialRef: "azure-ref",
        },
      },
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
    [ttsCredentialStorageKey("azure-ref")]: JSON.stringify({ apiKey: "azure-key" }),
  };
}

test("quick tts: speaks through Azure and shows a rate limit without fallback", async () => {
  const source = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], azureActiveStorage()),
    network: { ["POST " + AZURE_QUICK_TTS_URL]: { status: 200, body: "ID3azure" } },
  });
  await source.waitFor("id:quick-translate-source");
  await source.type("id:quick-translate-source", "Hello");
  await source.keyboard.press("shift+enter");
  await source.type("id:quick-translate-source", "world");
  await source.waitUntil(() => source.enabled("id:quick-translate-speak-source"));
  await source.press("id:quick-translate-speak-source");
  await source.waitUntil(() => source.requests().length === 1);
  const spoken = source.requests()[0]!;
  expect(spoken.url).toBe(AZURE_QUICK_TTS_URL);
  expect(spoken.body).toContain("Hello\nworld");
  expect(spoken.body).toContain("en-US-JennyNeural");
  expect(
    spoken.headers["ocp-apim-subscription-key"] ?? spoken.headers["Ocp-Apim-Subscription-Key"],
  ).toBe("azure-key");
  expect(source.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);

  const result = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], azureActiveStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 200, body: "ID3azure" },
    },
  });
  await result.waitFor("id:quick-translate-source");
  await result.type("id:quick-translate-source", "Hello");
  await result.keyboard.press("enter");
  await result.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  expect(result.requests().some((request) => request.url === AZURE_QUICK_TTS_URL)).toBe(false);
  await result.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await result.waitUntil(() =>
    result.requests().some((request) => request.url === AZURE_QUICK_TTS_URL),
  );
  const speech = result.requests().filter((request) => request.url === AZURE_QUICK_TTS_URL);
  expect(speech).toHaveLength(1);
  expect(speech[0]!.body).toContain("Bonjour");
  expect(speech[0]!.body).toContain("fr-FR-DeniseNeural");
  expect(result.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);

  const limited = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], azureActiveStorage()),
    network: {
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 429, body: "quota exceeded secret" },
    },
  });
  await limited.waitFor("id:quick-translate-source");
  await limited.type("id:quick-translate-source", "Hello");
  await limited.press("id:quick-translate-speak-source");
  await limited.waitUntil(() =>
    limited.texts().includes("Azure is limiting requests. Try again later."),
  );
  expect(limited.texts()).not.toContain("quota exceeded secret");
  expect(limited.texts().join(" ")).not.toMatch(/allowance/i);
  expect(limited.audio()).toEqual([]);
  expect(limited.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);
});

test("quick tts: switching channels drops a late Azure response and stops playback", async () => {
  const storage = seedWithPresets([makePreset()], {
    ...azureActiveStorage(),
    [POPUP_HARNESS_MODE_KEY]: "tts-switch",
  });
  const loading = await open(POPUP_HARNESS, {
    ...viewport,
    storage,
    network: {
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 200, delay: 800, body: "ID3late" },
    },
  });
  await loading.waitFor("id:quick-translate-source");
  await loading.type("id:quick-translate-source", "Hello");
  await loading.waitUntil(() => loading.enabled("id:quick-translate-speak-source"));
  await loading.press("id:quick-translate-speak-source");
  await loading.waitFor("role:button[Cancel]");
  await loading.press("id:harness-activate-google-tts");
  await loading.waitFor("role:button[Read aloud]");
  await loading.wait(900);
  expect(loading.audio().some((call) => call.command === "open")).toBe(false);
  expect(loading.texts()).not.toContain("Could not play the audio. Try again.");
  expect(loading.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);

  const playing = await open(POPUP_HARNESS, {
    ...viewport,
    storage,
    network: {
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 200, body: "ID3azure" },
    },
  });
  await playing.waitFor("id:quick-translate-source");
  await playing.type("id:quick-translate-source", "Hello");
  await playing.waitUntil(() => playing.enabled("id:quick-translate-speak-source"));
  await playing.press("id:quick-translate-speak-source");
  await playing.waitFor("role:button[Stop]");
  await playing.press("id:harness-activate-google-tts");
  await playing.waitFor("role:button[Read aloud]");
  expect(playing.audio().some((call) => call.command === "close")).toBe(true);
  expect(playing.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);
  expect(playing.requests().filter((request) => request.url === AZURE_QUICK_TTS_URL)).toHaveLength(
    1,
  );

  const inactive = await open(POPUP_HARNESS, {
    ...viewport,
    storage,
    network: {
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 200, body: "ID3azure" },
    },
  });
  await inactive.waitFor("id:quick-translate-source");
  await inactive.type("id:quick-translate-source", "Hello");
  await inactive.waitUntil(() => inactive.enabled("id:quick-translate-speak-source"));
  await inactive.press("id:quick-translate-speak-source");
  await inactive.waitFor("role:button[Stop]");
  await inactive.press("id:harness-save-inactive-google");
  await inactive.wait(300);
  expect(inactive.shows("role:button[Stop]")).toBe(true);
  expect(inactive.audio().some((call) => call.command === "close")).toBe(false);
  expect(inactive.requests().filter((request) => request.url === AZURE_QUICK_TTS_URL)).toHaveLength(
    1,
  );
});

test("quick tts: Azure authentication stays next to the text and does not open a player", async () => {
  const auth = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], azureActiveStorage()),
    network: {
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 401, body: "provider secret text" },
    },
  });
  await auth.waitFor("id:quick-translate-source");
  await auth.type("id:quick-translate-source", "Hello");
  await auth.press("id:quick-translate-speak-source");
  await auth.waitFor("id:quick-translate-speak-source-error");
  expect(auth.texts()).toContain("Check the Speech resource key and region.");
  expect(auth.texts()).not.toContain("provider secret text");
  expect(auth.audio()).toEqual([]);
  expect(auth.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);
});

test("quick tts: refuses a disabled channel, an unsupported language, and unresolved Auto", async () => {
  const off = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage(false)),
    network: { [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 } },
  });
  await off.waitFor("id:quick-translate-source");
  await off.type("id:quick-translate-source", "Hello");
  expect(off.enabled("id:quick-translate-speak-source")).toBe(false);
  expect(off.requests()).toHaveLength(0);

  const unsupported = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      ...enabledTtsStorage(),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: "hr",
        targetLanguage: "en",
        cards: [],
      }),
    }),
    network: { [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 } },
  });
  await unsupported.waitFor("id:quick-translate-source");
  await unsupported.type("id:quick-translate-source", "Bok");
  await unsupported.press("id:quick-translate-speak-source");
  await unsupported.waitFor("id:quick-translate-speak-source-error");
  expect(unsupported.texts()).toContain(t("quickTranslate.speakVoiceNeedsSettings"));
  expect(unsupported.requests()).toHaveLength(0);

  const unresolved = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      ...enabledTtsStorage(),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: "auto",
        targetLanguage: "en",
        cards: [],
      }),
    }),
    network: { [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 } },
  });
  await unresolved.waitFor("id:quick-translate-source");
  await unresolved.type("id:quick-translate-source", "Bonjour");
  await unresolved.press("id:quick-translate-speak-source");
  await unresolved.waitFor("id:quick-translate-speak-source-error");
  expect(unresolved.texts()).toContain(t("quickTranslate.speakChooseSource"));
  expect(unresolved.requests()).toHaveLength(0);
});

test("quick tts: reading an Automatic source detects once and translation reuses it", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: {
      ...seedAutoPair([false], "ocr-status"),
      ...enabledTtsStorage(),
    },
    network: {
      [TRANSLATE_URL]: {
        status: 200,
        body: { choices: [{ message: { content: "\u8bd1\u6587" } }] },
      },
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 },
    },
  });
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Bonjour");

  // Reading waits for the source detection, then speaks in the detected language.
  await app.press("id:quick-translate-speak-source");
  await app.waitUntil(() => app.texts().some((text) => text.includes("detects=1|")));
  await app.press("id:harness-resolve-language-fr");
  await app.waitUntil(() => app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL));
  const sourceSpeech = app.requests().find((request) => request.url === GOOGLE_CLOUD_TTS_URL)!;
  expect(JSON.parse(sourceSpeech.body ?? "").input.text).toBe("Bonjour");
  expect(ttsVoice(sourceSpeech.body)).toEqual({ languageCode: "fr-FR", name: "fr-FR-Standard-F" });
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.autoDetectDetected", { language: getLanguageLabel("fr") })}`,
    ),
  ).toBe(true);

  // The translation of the same input reuses the detection.
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-result-text");
  expect(app.texts().some((text) => text.includes("detects=1|"))).toBe(true);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(1);
  const body = JSON.parse(requestsTo(app, TRANSLATE_URL)[0]!.body!) as {
    messages: Array<{ content: string }>;
  };
  expect(body.messages[0]!.content).toContain(getLanguageLabel("fr"));
  expect(body.messages[0]!.content).toContain(getLanguageLabel("zh"));

  // A result reads in its own target language without another detection.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await app.waitUntil(
    () => app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL).length === 2,
  );
  const resultSpeech = app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL)[1]!;
  expect(JSON.parse(resultSpeech.body ?? "").input.text).toBe("\u8bd1\u6587");
  expect(ttsVoice(resultSpeech.body)).toEqual({
    languageCode: "cmn-CN",
    name: "cmn-CN-Standard-A",
  });
  expect(app.texts().some((text) => text.includes("detects=1|"))).toBe(true);
});

test("quick tts: a later speaker replaces a delayed request, and Stop closes playback", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
      [QUICK_TTS_URL]: { status: 200, delay: 400, body: QUICK_TTS_MP3 },
    },
  });
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await app.press("id:quick-translate-speak-source");
  await app.waitFor("role:button[Cancel]");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await app.waitFor("id:quick-translate-card-card-1 >> role:button[Stop]");
  await app.wait(500);
  const opens = app.audio().filter((call) => call.command === "open");
  expect(opens).toHaveLength(1);
  const speech = app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL);
  expect(speech.some((request) => JSON.parse(request.body ?? "").input.text === "Bonjour")).toBe(
    true,
  );
  expect(app.texts()).not.toContain(t("quickTranslate.speakPlayback"));

  const beforeStop = app.requests().length;
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await app.waitFor("id:quick-translate-card-card-1 >> role:button[Read aloud]");
  expect(app.requests()).toHaveLength(beforeStop);
  expect(app.audio().some((call) => call.command === "close")).toBe(true);
});

function googleTtsStorage(): Record<string, string> {
  return {
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["google-cloud"],
      channels: {
        "google-cloud": {
          enabled: true,
          configured: true,
          config: {
            preferences: {
              ...DEFAULT_GOOGLE_VOICE_PREFERENCES,
              voiceOverrides: { en: "en-GB-Wavenet-A", fr: "fr-CA-Standard-A" },
              speakingRate: 1.25,
              pitch: -2,
            },
          },
          credentialRef: "tts-ref",
        },
      },
    }),
    [ttsCredentialStorageKey("tts-ref")]: JSON.stringify({ apiKey: "tts-key" }),
  };
}

test("quick tts: saved Google voices and audio values apply to the source and the result", async () => {
  const source = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], googleTtsStorage()),
    network: { [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 } },
  });
  await source.waitFor("id:quick-translate-source");
  await source.type("id:quick-translate-source", "Hello");
  await source.waitUntil(() => source.enabled("id:quick-translate-speak-source"));
  await source.press("id:quick-translate-speak-source");
  await source.waitUntil(() => source.requests().length === 1);
  const spoken = source.requests()[0]!;
  expect(JSON.parse(spoken.body ?? "").voice).toEqual({
    languageCode: "en-GB",
    name: "en-GB-Wavenet-A",
  });
  expect(JSON.parse(spoken.body ?? "").audioConfig).toEqual({
    audioEncoding: "MP3",
    speakingRate: 1.25,
    pitch: -2,
  });

  const result = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], googleTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Bonjour" } }] },
      },
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 },
    },
  });
  await result.waitFor("id:quick-translate-source");
  await result.type("id:quick-translate-source", "Hello");
  await result.keyboard.press("enter");
  await result.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await result.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await result.waitUntil(() =>
    result.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL),
  );
  const speech = result.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL);
  expect(speech).toHaveLength(1);
  expect(JSON.parse(speech[0]!.body ?? "").input.text).toBe("Bonjour");
  expect(JSON.parse(speech[0]!.body ?? "").voice).toEqual({
    languageCode: "fr-CA",
    name: "fr-CA-Standard-A",
  });
});

test("quick tts: a Google preference change during synthesis drops the obsolete request", async () => {
  const storage = seedWithPresets([makePreset()], {
    ...googleTtsStorage(),
    [POPUP_HARNESS_MODE_KEY]: "tts-switch",
  });
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage,
    network: {
      [QUICK_TTS_URL]: { status: 200, delay: 800, body: QUICK_TTS_MP3 },
    },
  });
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.waitUntil(() => app.enabled("id:quick-translate-speak-source"));
  await app.press("id:quick-translate-speak-source");
  await app.waitFor("role:button[Cancel]");
  await app.press("id:harness-change-google-preferences");
  await app.waitFor("role:button[Read aloud]");
  await app.wait(900);
  expect(app.audio().some((call) => call.command === "open")).toBe(false);
  expect(app.texts()).not.toContain("Could not play the audio. Try again.");
  const saved = JSON.parse(app.storage()[TTS_STORAGE_KEY]!).channels["google-cloud"].config
    .preferences;
  expect(saved.speakingRate).toBe(1.5);
});

const GOOGLE_TRANSLATE_URL = "POST https://translation.googleapis.com/language/translate/v2";
const GOOGLE_KEY_REF = "google-ref-1";

function makeGoogleCloudPreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-google",
    name: "Google Card",
    enabled: true,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    engine: { kind: "google-cloud", credentialRef: GOOGLE_KEY_REF },
    ...overrides,
  };
}

interface GoogleCardSeedOptions {
  sourceLanguage?: "auto" | "en";
  targetLanguage?: "auto" | "ja" | "de" | "zh";
  detectionMode?: "ai" | "off";
  cards?: readonly ("google" | "deepl")[];
  aiModels?: boolean;
  /** A stale saved template override that a Google card must ignore. */
  googleTemplateId?: string | null;
  extra?: Record<string, string>;
}

/** Seeds Google Cloud and DeepL cards with the stored keys and an optional AI detector. */
function seedGoogleCards(options: GoogleCardSeedOptions = {}): Record<string, string> {
  const detectChannel = makeChannel({
    id: "ch-detect",
    presetId: "openai",
    adapterId: "openai-compatible",
    baseUrl: "https://detect.example.com/v1",
    displayName: "Detector",
    enabled: true,
    sortOrder: 0,
  });
  const detector = makeModel({
    id: "det-1",
    providerId: "ch-detect",
    modelKey: "detect-mini",
    enabled: true,
  });
  const googlePreset = makeGoogleCloudPreset();
  const deeplPreset = makeDeepLPreset();
  const cards = (options.cards ?? ["google", "deepl"]).map((kind, index) => ({
    id: `card-${index + 1}`,
    presetId: kind === "google" ? googlePreset.id : deeplPreset.id,
    templateId: kind === "google" ? (options.googleTemplateId ?? null) : null,
    collapsed: false,
  }));
  const storage = makeSeedStorage({
    ...(options.aiModels === false ? {} : { channels: [detectChannel], models: [detector] }),
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        items: [googlePreset, deeplPreset],
      }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: options.sourceLanguage ?? "auto",
        targetLanguage: options.targetLanguage ?? "ja",
        cards,
      }),
      [googleCloudCredentialStorageKey(GOOGLE_KEY_REF)]: "google-key-1",
      [deepLCredentialStorageKey("deepl-ref-1")]: "deepl-key:fx",
      ...detectionSeed({ aiEnabled: (options.detectionMode ?? "ai") === "ai" }),
      ...options.extra,
    },
  });
  if (options.aiModels === false) {
    delete storage[MODELS_STORAGE_KEY];
    delete storage[PROVIDERS_STORAGE_KEY];
  }
  return storage;
}

function googleCardNetwork(detectorAnswer = "fr") {
  return {
    [DETECT_URL]: {
      status: 200,
      body: { choices: [{ message: { content: detectorAnswer } }] },
    },
    [GOOGLE_TRANSLATE_URL]: {
      status: 200,
      body: { data: { translations: [{ translatedText: "谷歌译文" }] } },
    },
    [DEEPL_URL]: {
      status: 200,
      body: { translations: [{ detected_source_language: "FR", text: "DeepL 译文" }] },
    },
  };
}

test("Google Cloud card: preset options repeat the card's engine mark", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({ detectionMode: "off" }),
  });

  await app.waitFor("id:quick-translate-card-card-1");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-preset-mark-google")).toBe(
    true,
  );

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-preset");
  await app.waitFor("role:option[Google Card]");

  expect(
    app.shows("role:option[Google Card] >> id:quick-translate-preset-option-mark-preset-google"),
  ).toBe(true);
  expect(
    app.shows("role:option[DeepL Card] >> id:quick-translate-preset-option-mark-preset-deepl"),
  ).toBe(true);
});

test("add preset menu: options repeat the card preset engine marks", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({ detectionMode: "off" }),
  });

  await app.waitFor("id:quick-translate-add-preset");
  await app.press("id:quick-translate-add-preset");
  await app.waitFor("role:menuitem[Google Card]");

  expect(
    app.shows(
      "role:menuitem[Google Card] >> id:quick-translate-add-preset-option-mark-preset-google",
    ),
  ).toBe(true);
  expect(
    app.shows(
      "role:menuitem[DeepL Card] >> id:quick-translate-add-preset-option-mark-preset-deepl",
    ),
  ).toBe(true);
});

test("Google Cloud card: one detection run serves a Google and a DeepL card the same pair", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({ targetLanguage: "ja", googleTemplateId: "tpl-stale" }),
    network: googleCardNetwork(),
  });

  await app.waitFor("id:quick-translate-card-card-2");
  // The template selector stays an AI-only control, even with a stale override.
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-template")).toBe(false);
  expect(app.shows("id:quick-translate-card-card-2 >> id:quick-translate-template")).toBe(false);
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-preset-mark-google")).toBe(
    true,
  );

  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitUntil(
    () =>
      requestsTo(app, GOOGLE_TRANSLATE_URL).length === 1 && requestsTo(app, DEEPL_URL).length === 1,
  );
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");

  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  expect(app.texts()).toContain("谷歌译文");
  expect(app.texts()).toContain("DeepL 译文");

  const googleRequest = requestsTo(app, GOOGLE_TRANSLATE_URL)[0]!;
  expect(googleRequest.headers?.["x-goog-api-key"]).toBe("google-key-1");
  expect(JSON.parse(googleRequest.body!)).toEqual({
    q: ["Bonjour"],
    source: "fr",
    target: "ja",
    format: "text",
  });

  const deeplBody = JSON.parse(requestsTo(app, DEEPL_URL)[0]!.body!) as {
    source_lang: string;
    target_lang: string;
  };
  expect(deeplBody.source_lang).toBe("FR");
  expect(deeplBody.target_lang).toBe("JA");
});

test("Google Cloud card: an explicit pair needs no detector or AI models", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({
      cards: ["google"],
      sourceLanguage: "en",
      targetLanguage: "de",
      detectionMode: "off",
      aiModels: false,
    }),
    network: {
      [GOOGLE_TRANSLATE_URL]: {
        status: 200,
        body: { data: { translations: [{ translatedText: "Guten Morgen" }] } },
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");

  expect(app.texts()).toContain("Guten Morgen");
  expect(requestsTo(app, DETECT_URL)).toHaveLength(0);
  expect(requestsTo(app, TRANSLATE_URL)).toHaveLength(0);
  expect(JSON.parse(requestsTo(app, GOOGLE_TRANSLATE_URL)[0]!.body!)).toMatchObject({
    source: "en",
    target: "de",
  });
});

test("Google Cloud card: a rejected request fails only its card and retry follows the card action", async () => {
  let googleCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({
      sourceLanguage: "en",
      targetLanguage: "ja",
      detectionMode: "off",
    }),
    network: {
      [GOOGLE_TRANSLATE_URL]: () => {
        googleCalls += 1;
        return googleCalls === 1
          ? { status: 503, body: { error: { code: 503, message: "backend unavailable" } } }
          : {
              status: 200,
              body: { data: { translations: [{ translatedText: "再試行" }] } },
            };
      },
      [DEEPL_URL]: {
        status: 200,
        body: { translations: [{ detected_source_language: "EN", text: "DeepL 译文" }] },
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-2");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-error");

  expect(app.texts()).toContain(t("googleCloud.error.server"));
  expect(app.texts()).not.toContain("backend unavailable");
  expect(app.texts()).toContain("DeepL 译文");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry");
  await app.waitUntil(() => app.texts().includes("再試行"));
  expect(requestsTo(app, GOOGLE_TRANSLATE_URL)).toHaveLength(2);
  expect(requestsTo(app, DEEPL_URL)).toHaveLength(1);
});

test("Google Cloud card: a late result cannot replace a newer result or repopulate a closed popup", async () => {
  const outOfOrder = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({
      cards: ["google"],
      sourceLanguage: "en",
      targetLanguage: "ja",
      detectionMode: "off",
      extra: { [POPUP_HARNESS_MODE_KEY]: "out-of-order" },
    }),
  });

  await outOfOrder.waitFor("id:quick-translate-source");
  await outOfOrder.type("id:quick-translate-source", "First");
  await outOfOrder.keyboard.press("enter");
  await outOfOrder.type("id:quick-translate-source", " Second");
  await outOfOrder.waitUntil(() =>
    outOfOrder.texts().some((line) => line.includes("aborts=aborted-1")),
  );
  await outOfOrder.keyboard.press("enter");
  await outOfOrder.press("id:harness-resolve-second");
  await outOfOrder.waitUntil(() => outOfOrder.texts().includes("Result 2"));
  await outOfOrder.press("id:harness-resolve-first");
  expect(outOfOrder.texts()).toContain("Result 2");
  expect(outOfOrder.texts()).not.toContain("Result 1");

  const lateClose = await open(POPUP_HARNESS, {
    ...viewport,
    clock: {},
    storage: seedGoogleCards({
      cards: ["google"],
      sourceLanguage: "en",
      targetLanguage: "ja",
      detectionMode: "off",
      extra: { [POPUP_HARNESS_MODE_KEY]: "late-after-close" },
    }),
  });
  await lateClose.waitFor("id:quick-translate-source");
  await lateClose.type("id:quick-translate-source", "Closing draft");
  await lateClose.keyboard.press("enter");
  await lateClose.press("id:harness-toggle-open");
  await lateClose.press("id:harness-resolve-late");
  lateClose.clock!.runFor(1000);
  expect(lateClose.texts()).not.toContain("Stale Late Result");

  await lateClose.press("id:harness-toggle-open");
  await lateClose.waitFor("id:quick-translate-source");
  expect(lateClose.value("id:quick-translate-source")).toBe("");
  expect(lateClose.shows("id:quick-translate-copy")).toBe(false);
});

test("back-translation: request translates a completed AI result in reverse without the selected grammar template", async () => {
  const grammarPreset = makePreset({
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: 0.3,
      maxOutputTokens: 128,
      disableReasoning: false,
      templates: [
        {
          id: "tpl-1",
          name: "Default",
          systemTemplate: "Translate from {{source_language}} to {{target_language}}.",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-grammar",
          name: "Grammar Check",
          systemTemplate:
            "GRAMMAR_ONLY_MARKER Check grammar for {{source_language}} to {{target_language}}.",
          userTemplate: "Grammar: {{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
  });

  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([grammarPreset]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: aiCalls === 1 ? "Bonjour" : "Hello" } }] },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await app.waitFor("role:option[Grammar Check]");
  await app.press("role:option[Grammar Check]");

  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");

  expect(app.requests()).toHaveLength(1);
  const forwardBody = JSON.parse(app.requests()[0]!.body!) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(forwardBody.messages[0]!.content).toContain("GRAMMAR_ONLY_MARKER");
  expect(forwardBody.messages[1]!.content).toBe("Grammar: Good morning");

  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translate")).toBe(
    true,
  );
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello");

  expect(app.requests()).toHaveLength(2);
  const reverseBody = JSON.parse(app.requests()[1]!.body!) as {
    model: string;
    temperature?: number;
    max_completion_tokens?: number;
    messages: Array<{ role: string; content: string }>;
  };
  expect(reverseBody.model).toBe("gpt-4.1-mini");
  expect(reverseBody.temperature).toBe(0.3);
  expect(reverseBody.max_completion_tokens).toBe(128);
  expect(reverseBody.messages[0]!.content).not.toContain("GRAMMAR_ONLY_MARKER");
  expect(reverseBody.messages[0]!.content).toContain(getLanguageLabel("fr"));
  expect(reverseBody.messages[0]!.content).toContain(getLanguageLabel("en"));
  expect(reverseBody.messages[0]!.content.indexOf(getLanguageLabel("fr"))).toBeLessThan(
    reverseBody.messages[0]!.content.indexOf(getLanguageLabel("en")),
  );
  expect(reverseBody.messages[1]!.content).toBe("Bonjour");

  expect(app.shows("id:quick-translate-card-card-1 >> text:Bonjour")).toBe(true);
  expect(app.shows("id:quick-translate-card-card-1 >> text:Hello")).toBe(true);
  expect(showsLanguagePair(app, "en", "fr")).toBe(true);
});

test("back-translation: request reverses Auto source and target without a second detector call and checks tooltip and loading copy", async () => {
  let translateCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false]),
    network: {
      [DETECT_URL]: { status: 200, body: { choices: [{ message: { content: "fr" } }] } },
      [TRANSLATE_URL]: () => {
        translateCalls += 1;
        return translateCalls === 1
          ? { status: 200, body: { choices: [{ message: { content: "早上好" } }] } }
          : {
              status: 200,
              delay: 700,
              body: { choices: [{ message: { content: "Bonjour encore" } }] },
            };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  await app.hover("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor(`text:${t("quickTranslate.backTranslate")}`);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor(
    `id:quick-translate-card-card-1 >> text:${t("quickTranslate.backTranslating")}`,
  );
  await app.waitFor("id:quick-translate-card-card-1 >> text:Bonjour encore");

  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  const bodies = translateBodies(app);
  expect(bodies).toHaveLength(2);
  expect(bodies[1].messages[0].content).toContain(getLanguageLabel("zh"));
  expect(bodies[1].messages[0].content).toContain(getLanguageLabel("fr"));
  expect(bodies[1].messages[0].content.indexOf(getLanguageLabel("zh"))).toBeLessThan(
    bodies[1].messages[0].content.indexOf(getLanguageLabel("fr")),
  );
  expect(bodies[1].messages[1].content).toBe("早上好");
});

test("back-translation: request supports DeepL and Google Cloud cards with saved credentials and reversed wire codes", async () => {
  let googleCalls = 0;
  let deeplCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({
      cards: ["google", "deepl"],
      sourceLanguage: "en",
      targetLanguage: "zh",
      detectionMode: "off",
      aiModels: false,
    }),
    network: {
      [GOOGLE_TRANSLATE_URL]: () => {
        googleCalls += 1;
        return {
          status: 200,
          body: {
            data: {
              translations: [{ translatedText: googleCalls === 1 ? "早上好" : "Good morning" }],
            },
          },
        };
      },
      [DEEPL_URL]: () => {
        deeplCalls += 1;
        return {
          status: 200,
          body: {
            translations: [
              {
                detected_source_language: deeplCalls === 1 ? "EN" : "ZH",
                text: deeplCalls === 1 ? "早安" : "Morning",
              },
            ],
          },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-2");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Good morning");
  const googleReqs = requestsTo(app, GOOGLE_TRANSLATE_URL);
  expect(googleReqs).toHaveLength(2);
  expect(googleReqs[1]!.headers?.["x-goog-api-key"]).toBe("google-key-1");
  expect(JSON.parse(googleReqs[1]!.body!)).toEqual({
    q: ["早上好"],
    source: "zh-CN",
    target: "en",
    format: "text",
  });

  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-2 >> text:Morning");
  const deeplReqs = requestsTo(app, DEEPL_URL);
  expect(deeplReqs).toHaveLength(2);
  expect(deeplReqs[1]!.headers?.authorization).toBe("DeepL-Auth-Key deepl-key:fx");
  expect(JSON.parse(deeplReqs[1]!.body!)).toEqual({
    text: ["早安"],
    source_lang: "ZH",
    target_lang: "EN-US",
  });
});

test("back-translation: request hides reply for idle, streaming, failed, blank, and same-language results and never publishes partial reverse output", async () => {
  // 1. Streaming forward hides reply; streaming reverse never publishes partial text.
  const streamApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], { [POPUP_HARNESS_MODE_KEY]: "streaming" }),
  });
  await streamApp.waitFor("id:quick-translate-card-card-1");
  expect(streamApp.shows("id:quick-translate-back-translate")).toBe(false);

  await streamApp.type("id:quick-translate-source", "Hello");
  await streamApp.keyboard.press("enter");
  await streamApp.waitUntil(() => streamApp.texts().includes("Bon"));
  expect(streamApp.shows("id:quick-translate-back-translate")).toBe(false);

  await streamApp.press("id:harness-complete-stream");
  await streamApp.waitFor("id:quick-translate-back-translate");
  await streamApp.press("id:quick-translate-back-translate");
  await streamApp.waitFor(`text:${t("quickTranslate.backTranslating")}`);
  expect(streamApp.texts()).not.toContain("Bon");
  await streamApp.press("id:harness-complete-stream");
  await streamApp.waitFor("id:quick-translate-back-translation-text");

  // 2. Failed forward hides reply.
  const failedApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 500,
        body: { error: { message: "server down" } },
      },
    },
  });
  await failedApp.waitFor("id:quick-translate-source");
  await failedApp.type("id:quick-translate-source", "Hello");
  await failedApp.keyboard.press("enter");
  await failedApp.waitFor("id:quick-translate-error");
  expect(failedApp.shows("id:quick-translate-back-translate")).toBe(false);

  // 3. Blank forward result hides reply (DeepL/Google Cloud can return blank text).
  const blankApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({
      cards: ["deepl"],
      sourceLanguage: "en",
      targetLanguage: "zh",
      detectionMode: "off",
      aiModels: false,
    }),
    network: {
      [DEEPL_URL]: {
        status: 200,
        body: { translations: [{ detected_source_language: "EN", text: "   " }] },
      },
    },
  });
  await blankApp.waitFor("id:quick-translate-source");
  await blankApp.type("id:quick-translate-source", "Hello");
  await blankApp.keyboard.press("enter");
  await blankApp.waitFor("id:quick-translate-copy");
  expect(blankApp.shows("id:quick-translate-speak-result")).toBe(false);
  expect(blankApp.shows("id:quick-translate-back-translate")).toBe(false);

  // 4. Same source and target language hides reply (explicit en -> en and detected fr -> fr).
  const sameExplicit = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: "en",
        targetLanguage: "en",
        cards: [],
      }),
    }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Hello" } }] },
      },
    },
  });
  await sameExplicit.waitFor("id:quick-translate-source");
  await sameExplicit.type("id:quick-translate-source", "Hello");
  await sameExplicit.keyboard.press("enter");
  await sameExplicit.waitFor("id:quick-translate-copy");
  expect(sameExplicit.shows("id:quick-translate-back-translate")).toBe(false);

  const sameDetected = await open(POPUP_HARNESS, {
    ...viewport,
    storage: {
      ...seedAutoPair([false]),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: "auto",
        targetLanguage: "fr",
        cards: [{ id: "card-1", presetId: "preset-auto", templateId: null, collapsed: false }],
      }),
    },
    network: {
      [DETECT_URL]: { status: 200, body: { choices: [{ message: { content: "fr" } }] } },
      [TRANSLATE_URL]: { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } },
    },
  });
  await sameDetected.waitFor("id:quick-translate-source");
  await sameDetected.type("id:quick-translate-source", "Bonjour");
  await sameDetected.keyboard.press("enter");
  await sameDetected.waitFor("id:quick-translate-copy");
  expect(sameDetected.shows("id:quick-translate-back-translate")).toBe(false);
});

test("back-translation: lifetime closes completed lower area without closing forward result and reopens from memory", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: aiCalls === 1 ? "Bonjour" : "Hello" } }] },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-text");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-title"),
  ).toBe(true);
  expect(app.texts()).toContain(t("quickTranslate.backTranslationTitle"));
  expect(app.shows(`role:button[${t("quickTranslate.backTranslate")}]`)).toBe(true);
  expect(app.texts()).not.toContain(t("quickTranslate.backTranslate"));
  await app.hover("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  await app.hover("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor(`text:${t("quickTranslate.closeBackTranslation")}`);
  expect(app.requests()).toHaveLength(2);

  // Clicking the selected back-translate icon button toggles the embedded card closed while keeping memory.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  expect(app.shows(`role:button[${t("quickTranslate.backTranslate")}]`)).toBe(true);
  expect(app.requests()).toHaveLength(2);

  // Clicking Back-translate again reopens from memory without making a request.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello");
  expect(app.requests()).toHaveLength(2);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-result-text")).toBe(true);
  expect(app.texts()).toContain("Bonjour");
  expect(app.texts()).not.toContain("Hello");

  // Reopening after Close makes no request either.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello");
  expect(app.requests()).toHaveLength(2);
});

test("back-translation: lifetime cancels a loading reverse request on close, ignores late response, and starts fresh on reopen", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        if (aiCalls === 1) {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } };
        }
        if (aiCalls === 2) {
          return {
            status: 200,
            delay: 600,
            body: { choices: [{ message: { content: "Stale Reverse" } }] },
          };
        }
        return { status: 200, body: { choices: [{ message: { content: "Fresh Reverse" } }] } };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor(
    `id:quick-translate-card-card-1 >> text:${t("quickTranslate.backTranslating")}`,
  );

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );

  await app.wait(700);
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );
  expect(app.texts()).not.toContain("Stale Reverse");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Fresh Reverse");
  expect(app.requests()).toHaveLength(3);
});

test("back-translation: lifetime handles reverse failure, blank response, close-discard, retry, and focus return", async () => {
  // 1. AI provider error -> retry -> close -> discard failure -> reopen fresh; plus focus return on close.
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    platform: "linux",
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        if (aiCalls === 1) {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } };
        }
        if (aiCalls === 2 || aiCalls === 3) {
          return { status: 500, body: { error: { message: "reverse error" } } };
        }
        return { status: 200, body: { choices: [{ message: { content: "Hello back" } }] } };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-error");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-result-text")).toBe(true);
  expect(app.texts()).toContain("Bonjour");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation"),
  ).toBe(true);
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation"),
  ).toBe(true);

  // Check retry tooltip & accessible name.
  await app.hover("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation");
  await app.waitFor(`text:${t("quickTranslate.retryBackTranslation")}`);
  expect(app.shows(`role:button[${t("quickTranslate.retryBackTranslation")}]`)).toBe(true);
  expect(app.shows(`role:button[${t("quickTranslate.closeBackTranslation")}]`)).toBe(true);

  // Retry repeats ONLY the reverse request (call 3 fails too).
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation");
  await app.waitUntil(() => app.requests().length === 3);
  expect(JSON.parse(app.requests()[2]!.body!).messages[1].content).toBe("Bonjour");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-error");

  // Closing an error discards failure; focus returns to reply; pressing space/enter starts a fresh attempt.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  await app.keyboard.press("space");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello back");
  expect(app.requests()).toHaveLength(4);

  // Closing a success returns focus to reply; pressing enter reopens from memory with no request.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello back");
  expect(app.requests()).toHaveLength(4);

  // 2. Blank reverse response (via DeepL) shows emptyBackTranslation error and retry.
  let deeplCalls = 0;
  const blankReverseApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedGoogleCards({
      cards: ["deepl"],
      sourceLanguage: "en",
      targetLanguage: "zh",
      detectionMode: "off",
      aiModels: false,
    }),
    network: {
      [DEEPL_URL]: () => {
        deeplCalls += 1;
        return {
          status: 200,
          body: {
            translations: [
              {
                detected_source_language: deeplCalls === 1 ? "EN" : "ZH",
                text: deeplCalls === 1 ? "早上好" : deeplCalls === 2 ? "   " : "Good morning",
              },
            ],
          },
        };
      },
    },
  });
  await blankReverseApp.waitFor("id:quick-translate-card-card-1");
  await blankReverseApp.type("id:quick-translate-source", "Good morning");
  await blankReverseApp.keyboard.press("enter");
  await blankReverseApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-back-translate",
  );

  await blankReverseApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-back-translate",
  );
  await blankReverseApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-back-translation-error",
  );
  expect(blankReverseApp.texts()).toContain(t("quickTranslate.error.emptyBackTranslation"));

  await blankReverseApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation",
  );
  await blankReverseApp.waitFor("id:quick-translate-card-card-1 >> text:Good morning");
});

test("back-translation: lifetime retries a completed result without retranslating the forward card or re-detecting", async () => {
  let translateCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedAutoPair([false]),
    network: {
      [DETECT_URL]: { status: 200, body: { choices: [{ message: { content: "fr" } }] } },
      [TRANSLATE_URL]: () => {
        translateCalls += 1;
        if (translateCalls === 1) {
          return { status: 200, body: { choices: [{ message: { content: "早上好" } }] } };
        }
        if (translateCalls === 2) {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour encore" } }] } };
        }
        if (translateCalls === 3) {
          return {
            status: 200,
            delay: 700,
            body: { choices: [{ message: { content: "Bonjour retried" } }] },
          };
        }
        if (translateCalls === 4) {
          return { status: 500, body: { error: { message: "retry fail" } } };
        }
        return { status: 200, body: { choices: [{ message: { content: "Bonjour fresh" } }] } };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Bonjour");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Bonjour encore");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation"),
  ).toBe(true);
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation"),
  ).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");
  expect(app.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation");
  await app.waitFor(
    `id:quick-translate-card-card-1 >> text:${t("quickTranslate.backTranslating")}`,
  );
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation"),
  ).toBe(false);
  expect(app.texts()).toContain("早上好");

  await app.waitFor("id:quick-translate-card-card-1 >> text:Bonjour retried");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation"),
  ).toBe(true);
  expect(app.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(false);
  expect(requestsTo(app, DETECT_URL)).toHaveLength(1);
  expect(translateBodies(app)).toHaveLength(3);
  expect(translateBodies(app)[2]!.messages[1]!.content).toBe("早上好");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Bonjour retried");
  expect(translateBodies(app)).toHaveLength(3);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-error");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation"),
  ).toBe(true);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Bonjour fresh");
  expect(translateBodies(app)).toHaveLength(5);
});

const BACK_TRANSLATION_ALPHA_PRESET = makePreset({
  id: "preset-1",
  name: "Preset Alpha",
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
        systemTemplate: "Default {{source_language}}->{{target_language}}",
        userTemplate: "{{text}}",
      },
      {
        id: "tpl-2",
        name: "Formal",
        systemTemplate: "Formal {{source_language}}->{{target_language}}",
        userTemplate: "Formal: {{text}}",
      },
    ],
    defaultTemplateId: "tpl-1",
  },
});

const BACK_TRANSLATION_BETA_PRESET = makePreset({ id: "preset-2", name: "Preset Beta" });

test("back-translation: lifetime invalidates on forward retry, template, preset, input, language, and collapse", async () => {
  // 1. Forward retry, template change, preset change, input change, language change, collapse/expand.
  let reverseSeq = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([BACK_TRANSLATION_ALPHA_PRESET, BACK_TRANSLATION_BETA_PRESET]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": (req) => {
        const body = JSON.parse(req.body!) as { messages: Array<{ content: string }> };
        // Keep forward output identical ("Bonjour") across retries to prove binding is by query identity, not text.
        if (body.messages[1]!.content !== "Bonjour") {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } };
        }
        reverseSeq += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: `Reverse-${reverseSeq}` } }] },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse-1");

  // Forward retry clears lower result even when forward returns the same text ("Bonjour").
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry");
  await app.waitUntil(() => app.requests().length === 3);
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );
  // Re-opening after forward retry must run a fresh request (not reuse Reverse-1).
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse-2");

  // Template switch clears lower result, even if switching back to Default.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await app.waitFor("role:option[Formal]");
  await app.press("role:option[Formal]");
  await app.waitUntil(() => app.requests().length === 5);
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await app.waitFor("role:option[Default]");
  await app.press("role:option[Default]");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );

  // Open lower result again, then collapse & expand: lower area closes on collapse and reopens from memory on reply!
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse-3");
  const countBeforeCollapse = app.requests().length;
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-collapse");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse-3");
  expect(app.requests()).toHaveLength(countBeforeCollapse);

  // Language change clears lower result.
  await app.press("id:quick-translate-target-language");
  await app.waitFor(`role:option[${getTargetLanguageLabel("de")}]`);
  await app.press(`role:option[${getTargetLanguageLabel("de")}]`);
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );

  // Translate again, open reverse, then input change clears it.
  await app.submit("id:quick-translate-source");
  await app.waitUntil(() => app.requests().length === countBeforeCollapse + 1);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse-4");
  await app.type("id:quick-translate-source", "!");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );

  // Translate again, open reverse, then preset change clears it.
  await app.submit("id:quick-translate-source");
  await app.waitUntil(() => app.requests().length === countBeforeCollapse + 3);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse-5");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-preset");
  await app.waitFor("role:option[Preset Beta]");
  await app.press("role:option[Preset Beta]");
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation")).toBe(
    false,
  );
});

test("back-translation: lifetime isolates multi-card results, preserves reorder, and handles remove", async () => {
  const multiApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithSavedCards(
      [BACK_TRANSLATION_ALPHA_PRESET, BACK_TRANSLATION_BETA_PRESET],
      [
        { id: "card-1", presetId: "preset-1", templateId: null, collapsed: false },
        { id: "card-2", presetId: "preset-2", templateId: null, collapsed: false },
      ],
    ),
    network: {
      "POST https://api.openai.com/v1/chat/completions": (req) => {
        const body = JSON.parse(req.body!) as { messages: Array<{ content: string }> };
        if (body.messages[1]!.content === "Hello") {
          return {
            status: 200,
            body: {
              choices: [
                {
                  message: {
                    content: body.messages[0]!.content.includes("Default") ? "Bonjour" : "Salut",
                  },
                },
              ],
            },
          };
        }
        return {
          status: 200,
          body: { choices: [{ message: { content: `Back:${body.messages[1]!.content}` } }] },
        };
      },
    },
  });

  await multiApp.waitFor("id:quick-translate-card-card-2");
  await multiApp.type("id:quick-translate-source", "Hello");
  await multiApp.keyboard.press("enter");
  await multiApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await multiApp.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");

  await multiApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await multiApp.waitFor("id:quick-translate-card-card-1 >> text:Back:Bonjour");
  await multiApp.press("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await multiApp.waitFor("id:quick-translate-card-card-2 >> text:Back:Salut");

  // Reordering keeps both cards' lower results intact.
  await multiApp.drag("id:quick-translate-card-header-card-2", { x: 0, y: -220 });
  await multiApp.waitUntil(() => savedCardIds(multiApp.storage())[0] === "card-2");
  expect(multiApp.shows("id:quick-translate-card-card-1 >> text:Back:Bonjour")).toBe(true);
  expect(multiApp.shows("id:quick-translate-card-card-2 >> text:Back:Salut")).toBe(true);

  // Acting on card 2 (closing/removing) leaves card 1's lower result intact.
  await multiApp.press(
    "id:quick-translate-card-card-2 >> id:quick-translate-close-back-translation",
  );
  expect(multiApp.shows("id:quick-translate-card-card-1 >> text:Back:Bonjour")).toBe(true);
  await multiApp.press("id:quick-translate-card-card-2 >> id:quick-translate-remove");
  expect(multiApp.shows("id:quick-translate-card-card-2")).toBe(false);
  expect(multiApp.shows("id:quick-translate-card-card-1 >> text:Back:Bonjour")).toBe(true);
});

test("back-translation: lifetime guards late resolution across reopen, collapse, and popup close", async () => {
  const lateStorage = seedWithSavedCards(
    [BACK_TRANSLATION_ALPHA_PRESET, BACK_TRANSLATION_BETA_PRESET],
    [
      { id: "card-1", presetId: "preset-1", templateId: null, collapsed: false },
      { id: "card-2", presetId: "preset-2", templateId: null, collapsed: false },
    ],
  );
  lateStorage[POPUP_HARNESS_MODE_KEY] = "multi-card";
  const lateApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: lateStorage,
  });
  await lateApp.waitFor("id:quick-translate-card-card-2");
  await lateApp.type("id:quick-translate-source", "Hello");
  await lateApp.keyboard.press("enter");
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("calls=2|")));

  await lateApp.press("id:harness-resolve-second");
  await lateApp.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");

  // Start reverse request #3 on card 2, close it, reopen reverse request #4, then resolve #3 late.
  await lateApp.press("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("calls=3|")));
  await lateApp.press(
    "id:quick-translate-card-card-2 >> id:quick-translate-close-back-translation",
  );
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("aborted-3")));

  await lateApp.press("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("calls=4|")));
  await lateApp.press("id:harness-resolve-third");
  expect(lateApp.texts()).not.toContain("Card 1 Retry Result");
  expect(
    lateApp.shows(`id:quick-translate-card-card-2 >> text:${t("quickTranslate.backTranslating")}`),
  ).toBe(true);

  // Collapsing card 2 aborts reverse request #4; expanding keeps it closed and late resolution is ignored.
  await lateApp.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("aborted-4")));
  await lateApp.press("id:harness-resolve-fourth");
  await lateApp.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await lateApp.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  expect(lateApp.texts()).not.toContain("Stale Card 2 Late Result");
  expect(
    lateApp.shows("id:quick-translate-card-card-2 >> id:quick-translate-back-translation"),
  ).toBe(false);

  // Start reverse request #5 on card 2, then close the popup: aborts #5 and ignores late resolve.
  await lateApp.press("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("calls=5|")));
  await lateApp.press("id:harness-toggle-open");
  await lateApp.waitUntil(() => lateApp.texts().some((line) => line.includes("aborted-5")));
  await lateApp.press("id:harness-resolve-fifth");
  expect(lateApp.texts()).not.toContain("Card 1 Expanded Result");
});

test("back-translation: copy copies only the lower text with isolated checkmark feedback", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: {
            choices: [{ message: { content: aiCalls === 1 ? "Bonjour" : "Hello back" } }],
          },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-card-card-1");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation"),
  ).toBe(false);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");
  expect(app.clipboard()).toBe("Hello back");
  expect(app.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(true);
  expect(app.shows(`role:button[${t("quickTranslate.copied")}]`)).toBe(false);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(app.clipboard()).toBe("Bonjour");
  expect(app.shows(`role:button[${t("quickTranslate.copied")}]`)).toBe(true);
  expect(app.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(true);
});

test("back-translation: copy hides button on loading/error, resets checkmark timer, isolates copy error, and ignores late clipboard settle", async () => {
  // 1. Copy button hidden during loading and error; checkmark resets after 1500 ms.
  let aiCalls = 0;
  const timedApp = await open(POPUP_HARNESS, {
    ...viewport,
    clock: {},
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        if (aiCalls === 1) {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } };
        }
        if (aiCalls === 2) {
          return { status: 500, body: { error: { message: "fail" } } };
        }
        return {
          status: 200,
          delay: 700,
          body: { choices: [{ message: { content: "Hello back" } }] },
        };
      },
    },
  });
  await timedApp.waitFor("id:quick-translate-card-card-1");
  await timedApp.type("id:quick-translate-source", "Good morning");
  await timedApp.keyboard.press("enter");
  await timedApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  await timedApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await timedApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-back-translation-error",
  );
  expect(
    timedApp.shows("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation"),
  ).toBe(false);

  await timedApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation",
  );
  await timedApp.waitFor(`text:${t("quickTranslate.backTranslating")}`);
  expect(
    timedApp.shows("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation"),
  ).toBe(false);
  await timedApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );

  await timedApp.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  await timedApp.waitFor(`text:${t("quickTranslate.copyBackTranslation")}`);
  await timedApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  expect(timedApp.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(true);
  await timedApp.clock!.runFor(1500);
  expect(timedApp.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(false);
  expect(timedApp.shows(`role:button[${t("quickTranslate.copyBackTranslation")}]`)).toBe(true);

  // 2. Copy failure shows localized lower copy error without setting forward copy error.
  let errCalls = 0;
  const copyErr = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], { [POPUP_HARNESS_MODE_KEY]: "clipboard-error" }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        errCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: errCalls === 1 ? "Bonjour" : "Hello back" } }] },
        };
      },
    },
  });
  await copyErr.waitFor("id:quick-translate-source");
  await copyErr.type("id:quick-translate-source", "Good morning");
  await copyErr.keyboard.press("enter");
  await copyErr.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await copyErr.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await copyErr.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );

  await copyErr.press("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");
  await copyErr.waitFor("id:quick-translate-copy-back-translation-error");
  expect(copyErr.texts()).toContain(t("quickTranslate.error.copyBackTranslationFailed"));
  expect(copyErr.shows("id:quick-translate-copy-error")).toBe(false);

  // Closing clears lower copy error.
  await copyErr.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation",
  );
  await copyErr.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await copyErr.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  expect(copyErr.shows("id:quick-translate-copy-back-translation-error")).toBe(false);
});

test("back-translation: copy ignores late clipboard resolve or reject after close and reopen", async () => {
  let lateCalls = 0;
  const lateCopy = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], { [POPUP_HARNESS_MODE_KEY]: "clipboard-deferred" }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        lateCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: lateCalls === 1 ? "Bonjour" : "Hello back" } }] },
        };
      },
    },
  });
  await lateCopy.waitFor("id:quick-translate-source");
  await lateCopy.type("id:quick-translate-source", "Good morning");
  await lateCopy.keyboard.press("enter");
  await lateCopy.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await lateCopy.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await lateCopy.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );

  await lateCopy.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  await lateCopy.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation",
  );
  await lateCopy.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await lateCopy.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  await lateCopy.press("id:harness-resolve-clipboard");
  expect(lateCopy.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(false);

  await lateCopy.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  await lateCopy.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation",
  );
  await lateCopy.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await lateCopy.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation",
  );
  await lateCopy.press("id:harness-reject-clipboard");
  expect(lateCopy.shows("id:quick-translate-copy-back-translation-error")).toBe(false);
});

test("back-translation: speech reads the lower text aloud in the stored source language without playing on open", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: aiCalls === 1 ? "Bonjour" : "Hello again" } }] },
        };
      },
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation");
  expect(app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);
  expect(app.audio()).toEqual([]);

  expect(
    app.shows(
      `id:quick-translate-card-card-1 >> role:button[${t("quickTranslate.speakBackTranslation")}]`,
    ),
  ).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation");
  await app.waitUntil(() => app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL));
  const speechReqs = app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL);
  expect(speechReqs).toHaveLength(1);
  expect(JSON.parse(speechReqs[0]!.body ?? "").input.text).toBe("Hello again");
  expect(ttsVoice(speechReqs[0]!.body)).toEqual({
    languageCode: "en-US",
    name: "en-US-Standard-C",
  });
  await app.waitFor(`id:quick-translate-card-card-1 >> role:button[${t("settings.tts.stop")}]`);
  await app.endAudio();
  await app.waitFor(
    `id:quick-translate-card-card-1 >> role:button[${t("quickTranslate.speakBackTranslation")}]`,
  );
});

test("back-translation: speech drops delayed TTS response on close and stops active playback on close", async () => {
  // 1. Closing during delayed TTS response prevents audio from opening.
  let loadingAiCalls = 0;
  const loadingApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        loadingAiCalls += 1;
        return {
          status: 200,
          body: {
            choices: [{ message: { content: loadingAiCalls === 1 ? "Bonjour" : "Hello again" } }],
          },
        };
      },
      [QUICK_TTS_URL]: { status: 200, delay: 600, body: QUICK_TTS_MP3 },
    },
  });
  await loadingApp.waitFor("id:quick-translate-source");
  await loadingApp.type("id:quick-translate-source", "Good morning");
  await loadingApp.keyboard.press("enter");
  await loadingApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await loadingApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await loadingApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );

  await loadingApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  await loadingApp.waitFor(`id:quick-translate-card-card-1 >> role:button[${t("common.cancel")}]`);
  await loadingApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation",
  );
  await loadingApp.wait(700);
  expect(loadingApp.audio().some((call) => call.command === "open")).toBe(false);
  expect(loadingApp.texts()).not.toContain(t("quickTranslate.speakPlayback"));

  // 2. Closing during playback stops audio immediately.
  let playingAiCalls = 0;
  const playingApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        playingAiCalls += 1;
        return {
          status: 200,
          body: {
            choices: [{ message: { content: playingAiCalls === 1 ? "Bonjour" : "Hello again" } }],
          },
        };
      },
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 },
    },
  });
  await playingApp.waitFor("id:quick-translate-source");
  await playingApp.type("id:quick-translate-source", "Good morning");
  await playingApp.keyboard.press("enter");
  await playingApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await playingApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await playingApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );

  await playingApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  await playingApp.waitFor(
    `id:quick-translate-card-card-1 >> role:button[${t("settings.tts.stop")}]`,
  );
  await playingApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation",
  );
  await playingApp.waitUntil(() => playingApp.audio().some((call) => call.command === "close"));
  expect(playingApp.audio().some((call) => call.command === "close")).toBe(true);
});

test("back-translation: speech handles Auto stored language, player replacement, isolated errors, disabled TTS, and keeps forward speech on lower close", async () => {
  // 1. Auto-detected source language is reused without re-detecting; replacing forward speech; closing lower leaves forward speech playing.
  let translateCalls = 0;
  const autoApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: {
      ...seedAutoPair([false]),
      ...enabledTtsStorage(),
    },
    network: {
      [DETECT_URL]: { status: 200, body: { choices: [{ message: { content: "fr" } }] } },
      [TRANSLATE_URL]: () => {
        translateCalls += 1;
        return {
          status: 200,
          body: {
            choices: [{ message: { content: translateCalls === 1 ? "早上好" : "Bonjour encore" } }],
          },
        };
      },
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_MP3 },
    },
  });
  await autoApp.waitFor("id:quick-translate-source");
  await autoApp.type("id:quick-translate-source", "Bonjour");
  await autoApp.keyboard.press("enter");
  await autoApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await autoApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await autoApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );

  // Start speaking forward result, then switch to lower speech -> single active player.
  await autoApp.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await autoApp.waitFor(`id:quick-translate-card-card-1 >> role:button[${t("settings.tts.stop")}]`);
  await autoApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  await autoApp.waitUntil(
    () => autoApp.requests().filter((req) => req.url === GOOGLE_CLOUD_TTS_URL).length === 2,
  );
  const lowerReq = autoApp.requests().filter((req) => req.url === GOOGLE_CLOUD_TTS_URL)[1]!;
  expect(JSON.parse(lowerReq.body ?? "").input.text).toBe("Bonjour encore");
  expect(ttsVoice(lowerReq.body)).toEqual({ languageCode: "fr-FR", name: "fr-FR-Standard-F" });
  expect(requestsTo(autoApp, DETECT_URL)).toHaveLength(1);
  expect(
    autoApp.shows(`id:quick-translate-card-card-1 >> role:button[${t("quickTranslate.speak")}]`),
  ).toBe(true);

  // Stop lower speech via Stop button.
  await autoApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  await autoApp.waitFor(
    `id:quick-translate-card-card-1 >> role:button[${t("quickTranslate.speakBackTranslation")}]`,
  );

  // Closing the lower area while FORWARD result is speaking must keep forward speech playing!
  const closesBefore = autoApp.audio().filter((call) => call.command === "close").length;
  await autoApp.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await autoApp.waitFor(`id:quick-translate-card-card-1 >> role:button[${t("settings.tts.stop")}]`);
  await autoApp.press(
    "id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation",
  );
  await autoApp.waitUntil(
    () => !autoApp.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  expect(autoApp.audio().filter((call) => call.command === "close").length).toBe(closesBefore);
  expect(
    autoApp.shows(`id:quick-translate-card-card-1 >> role:button[${t("settings.tts.stop")}]`),
  ).toBe(true);

  // 2. Disabled TTS disables lower speak button with localized tooltip/label.
  let offCalls = 0;
  const offApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage(false)),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        offCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: offCalls === 1 ? "Bonjour" : "Hello back" } }] },
        };
      },
    },
  });
  await offApp.waitFor("id:quick-translate-source");
  await offApp.type("id:quick-translate-source", "Good morning");
  await offApp.keyboard.press("enter");
  await offApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await offApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await offApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  expect(
    offApp.enabled("id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation"),
  ).toBe(false);

  // 3. Lower TTS error stays scoped to lower area and clears on close.
  let errCalls = 0;
  const errApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], azureActiveStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        errCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: errCalls === 1 ? "Bonjour" : "Hello back" } }] },
        };
      },
      ["POST " + AZURE_QUICK_TTS_URL]: { status: 401, body: "secret error" },
    },
  });
  await errApp.waitFor("id:quick-translate-source");
  await errApp.type("id:quick-translate-source", "Good morning");
  await errApp.keyboard.press("enter");
  await errApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await errApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await errApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  await errApp.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation");
  await errApp.waitFor("id:quick-translate-speak-back-translation-error");
  expect(errApp.texts()).toContain(t("settings.tts.failure.azureAuth"));
  expect(errApp.shows("id:quick-translate-speak-result-error")).toBe(false);
  expect(errApp.shows("id:quick-translate-speak-source-error")).toBe(false);

  await errApp.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await errApp.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await errApp.waitFor(
    "id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation",
  );
  expect(errApp.shows("id:quick-translate-speak-back-translation-error")).toBe(false);
});

test("back-translation: keyboard Tab and Enter/Space open, speak, copy, retry, and close while returning focus to reply", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], enabledTtsStorage()),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  content:
                    aiCalls === 1 ? "Bonjour" : aiCalls === 2 ? "Hello keyboard" : "Hello retried",
                },
              },
            ],
          },
        };
      },
      [QUICK_TTS_URL]: { status: 200, delay: 1200, body: QUICK_TTS_MP3 },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");

  // Tab from source input past source actions, card header controls, aligned result preview, and upper speak/copy to the back-translate pill.
  for (let step = 0; step < 12; step += 1) {
    await app.keyboard.press("tab");
  }
  await app.keyboard.press("space");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-back-translation");
  expect(app.requests().filter((r) => r.url.includes("chat/completions"))).toHaveLength(2);

  // Shift+Tab from the active pill walks back past upper Copy (1), upper Speak (2),
  // embedded Close (3), embedded Retry (4), embedded Copy (5) to embedded Speak (6).
  for (let step = 0; step < 6; step += 1) {
    await app.keyboard.press("shift+tab");
  }
  await app.keyboard.press("space");
  await app.waitFor(`id:quick-translate-card-card-1 >> role:button[${t("common.cancel")}]`);
  await app.keyboard.press("space");
  await app.waitFor(
    `id:quick-translate-card-card-1 >> role:button[${t("quickTranslate.speakBackTranslation")}]`,
  );

  // Tab to embedded Copy, activate with Enter.
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  expect(app.clipboard()).toBe("Hello keyboard");
  expect(app.shows(`role:button[${t("quickTranslate.backTranslationCopied")}]`)).toBe(true);

  // Tab past embedded Retry (1) to embedded Close (2), activate with Enter; focus returns to the pill (Space reopens without request).
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  await app.keyboard.press("space");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello keyboard");
  expect(app.requests().filter((r) => r.url.includes("chat/completions"))).toHaveLength(2);

  // From focused active pill, Shift+Tab across upper Copy (1), upper Speak (2), embedded Close (3) to embedded Retry (4).
  for (let step = 0; step < 4; step += 1) {
    await app.keyboard.press("shift+tab");
  }
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Hello retried");
  expect(app.requests().filter((r) => r.url.includes("chat/completions"))).toHaveLength(3);
});

test("back-translation: renders zh-CN localization across states and actions", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    locale: "zh-CN",
    storage: seedWithPresets([makePreset()], {
      ...enabledTtsStorage(),
      "settings.language": "zh-CN",
    }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        if (aiCalls === 1) {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } };
        }
        if (aiCalls === 2) {
          return { status: 500, body: { error: { message: "err" } } };
        }
        return { status: 200, delay: 700, body: { choices: [{ message: { content: "Hello" } }] } };
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Good morning");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  expect(app.shows("role:button[回译]")).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-error");
  expect(app.shows("role:button[回译]")).toBe(true);
  expect(app.shows("role:button[重试回译]")).toBe(true);
  expect(app.shows("role:button[关闭回译]")).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry-back-translation");
  await app.waitFor("id:quick-translate-card-card-1 >> text:正在回译…");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");
  expect(app.shows("role:button[回译]")).toBe(true);
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation-title"),
  ).toBe(true);
  expect(app.texts()).toContain("回译");
  expect(
    app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translate >> text:回译"),
  ).toBe(false);
  expect(app.texts()).not.toContain("已回译");
  expect(app.shows("role:button[朗读回译文]")).toBe(true);
  expect(app.shows("role:button[复制回译文]")).toBe(true);
  expect(app.shows("role:button[关闭回译]")).toBe(true);
  expect(app.shows("role:button[重试回译]")).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");
  expect(app.shows("role:button[已复制回译文]")).toBe(true);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.waitUntil(
    () => !app.shows("id:quick-translate-card-card-1 >> id:quick-translate-back-translation"),
  );
  await app.waitFor("role:button[回译]");
  expect(app.texts()).not.toContain("回译");
});

test("sentence highlight live: plain text highlights matched source sentence on hover, clears across collapse and copy", async () => {
  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: "今天用 NSH。第二句草稿有效。" } }] },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Use NSH today. Second draft works.");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(aiCalls).toBe(1);

  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  const resultBg = app.spanStyle(
    "id:quick-translate-card-card-1 >> id:result-seg-1",
  ).backgroundColor;
  expect(resultBg).toBeTruthy();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toEqual(resultBg);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Use NSH today.").backgroundColor,
  ).toBeUndefined();

  await app.press("id:quick-translate-collapse-source");
  await app.waitUntil(() => !app.shows("id:quick-translate-source"));
  await app.hover("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> text:第二句草稿有效。").backgroundColor,
  ).toBeUndefined();

  await app.press("id:quick-translate-source-preview");
  await app.waitFor("id:quick-translate-source");
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toBeUndefined();

  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toEqual(resultBg);
  expect(aiCalls).toBe(1);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(app.clipboard()).toBe("今天用 NSH。第二句草稿有效。");
  expect(aiCalls).toBe(1);
});

test("sentence highlight live: clears on source edit, retry, template change, card move, scroll, and hide across AI, DeepL, and Google Cloud", async () => {
  const aiPreset = makePreset({
    id: "preset-1",
    name: "AI Preset",
    engine: {
      kind: "ai",
      modelIds: ["det-1"],
      temperature: null,
      maxOutputTokens: null,
      disableReasoning: true,
      templates: [
        {
          id: "tpl-1",
          name: "Default",
          systemTemplate: "Translate normally.",
          userTemplate: "{{text}}",
        },
        {
          id: "tpl-2",
          name: "Formal",
          systemTemplate: "Translate formally.",
          userTemplate: "{{text}}",
        },
      ],
      defaultTemplateId: "tpl-1",
    },
  });
  const googlePreset = makeGoogleCloudPreset();
  const deeplPreset = makeDeepLPreset();
  const storage = seedGoogleCards({
    sourceLanguage: "en",
    targetLanguage: "zh",
    detectionMode: "off",
    aiModels: true,
    extra: {
      [PRESETS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        items: [aiPreset, deeplPreset, googlePreset],
      }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        sourceLanguage: "en",
        targetLanguage: "zh",
        cards: [
          { id: "card-1", presetId: aiPreset.id, templateId: null, collapsed: false },
          { id: "card-2", presetId: deeplPreset.id, templateId: null, collapsed: false },
          { id: "card-3", presetId: googlePreset.id, templateId: null, collapsed: false },
        ],
      }),
    },
  });

  let aiCalls = 0;
  const app = await open(POPUP_HARNESS, {
    width: 520,
    height: 360,
    platform: "windows",
    storage,
    network: {
      "POST https://detect.example.com/v1/chat/completions": ({ body }) => {
        aiCalls += 1;
        const parsed = JSON.parse(body ?? "{}") as { messages?: { content?: string }[] };
        const sys = parsed.messages?.[0]?.content ?? "";
        const text = sys.includes("formally")
          ? "NSH 正式版首句。正式版次句。"
          : "今天用 NSH。第二句草稿有效。";
        return { status: 200, body: { choices: [{ message: { content: text } }] } };
      },
      [DEEPL_URL]: {
        status: 200,
        body: {
          translations: [
            { detected_source_language: "EN", text: "今日使用 NSH。DeepL 译文通过。" },
          ],
        },
      },
      [GOOGLE_TRANSLATE_URL]: {
        status: 200,
        body: {
          data: {
            translations: [
              {
                translatedText:
                  "今天使用 NSH。Google 译文通过，并且这一句携带足够长的连续说明文字用于在窄宽度弹窗内自动换行成多行以便触发外层滚动容器产生真实的垂直滚动高度！",
              },
            ],
          },
        },
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Use NSH today. Second draft works.");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-3 >> id:quick-translate-copy");
  expect(aiCalls).toBe(1);

  // Move preview cleanly across AI -> DeepL -> Google Cloud cards.
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  const resultBg = app.spanStyle(
    "id:quick-translate-card-card-1 >> id:result-seg-1",
  ).backgroundColor;
  expect(resultBg).toBeTruthy();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toEqual(resultBg);

  // Outer Scroll movement clears active preview.
  await app.scroll("id:harness-popup-scroll", 40);
  await app.waitUntil(
    () =>
      app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor ===
      undefined,
  );
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toBeUndefined();

  await app.hover(
    "id:quick-translate-card-card-2 >> id:quick-translate-result-text >> text:DeepL 译文通过。",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-card-card-2 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toEqual(resultBg);

  await app.hover(
    "id:quick-translate-card-card-3 >> id:quick-translate-result-text >> text:Google 译文通过，并且这一句携带足够长的连续说明文字用于在窄宽度弹窗内自动换行成多行以便触发外层滚动容器产生真实的垂直滚动高度！",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-2 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-card-card-3 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);

  await app.scroll("id:harness-popup-scroll", -60);
  await app.waitUntil(
    () =>
      app.spanStyle("id:quick-translate-card-card-3 >> id:result-seg-1").backgroundColor ===
      undefined,
  );

  // Hover Card 1 cleanly, then hide/show window clears preview.
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);

  await app.press("id:harness-toggle-window-visible");
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> text:第二句草稿有效。").backgroundColor,
  ).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toBeUndefined();
  await app.press("id:harness-toggle-window-visible");
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();

  // Retry returns the identical text with a fresh resultId and starts cleared until hovered again.
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(aiCalls).toBe(2);
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toBeUndefined();

  // Switching template clears preview, serves the new template, and reuses the first query on switch back.
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await app.waitFor("role:option[Formal]");
  await app.press("role:option[Formal]");
  await app.waitFor("id:quick-translate-card-card-1 >> text:正式版次句。");
  expect(aiCalls).toBe(3);
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();

  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:正式版次句。",
  );
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toEqual(resultBg);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await app.waitFor("role:option[Default]");
  await app.press("role:option[Default]");
  await app.waitFor("id:quick-translate-card-card-1 >> text:第二句草稿有效。");
  expect(aiCalls).toBe(3);
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toBeUndefined();

  // Editing source during preview clears it and stops matching stale results.
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:第二句草稿有效。",
  );
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);
  await app.type("id:quick-translate-source", "?");
  await app.waitUntil(() => app.texts().includes("Use NSH today. Second draft works.?"));
  expect(app.shows("id:quick-translate-card-card-1 >> id:quick-translate-result-text")).toBe(false);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.?").backgroundColor,
  ).toBeUndefined();
});

test("sentence highlight live: drops late completion after popup close without stale preview", async () => {
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      [POPUP_HARNESS_MODE_KEY]: "late-after-close",
    }),
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Use NSH today. Second draft works.");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.texts().some((line) => line.includes("calls=1|")));

  await app.press("id:harness-toggle-open");
  await app.waitUntil(() => !app.shows("id:quick-translate-source"));
  await app.press("id:harness-resolve-late");
  await app.press("id:harness-toggle-open");
  await app.waitFor("id:quick-translate-source");
  expect(app.texts()).not.toContain("Stale Late Result");
});

test("sentence highlight markdown: highlights formatted spans across TextView blocks, toggles with plain text, and preserves copy", async () => {
  let aiCalls = 0;
  const markdownReply = [
    "## Summary V1",
    "",
    "First **bold** _italic_ [link 42](https://example.com) sentence. Second sentence follows.",
    "",
    "- List point A1.",
    "",
    "| Header |",
    "| --- |",
    "| Table cell B2. |",
    "",
    "```ts",
    "const raw = 42;",
    "```",
  ].join("\n");

  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      [QUICK_TRANSLATE_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        doubleCopyEnabled: false,
        autoTranslate: false,
        markdownEnabled: true,
        sourceLanguage: "en",
        targetLanguage: "zh",
        cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
      }),
    }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: { choices: [{ message: { content: markdownReply } }] },
        };
      },
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Summary V1");
  await app.keyboard.press("shift+enter");
  await app.keyboard.press("shift+enter");
  await app.type(
    "id:quick-translate-source",
    "First sentence has bold italic link details 42. Second sentence follows.",
  );
  await app.keyboard.press("shift+enter");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "List point A1.");
  await app.keyboard.press("shift+enter");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Table cell B2.");
  await app.keyboard.press("enter");

  await app.waitFor("id:quick-translate-card-card-1 >> text:const raw = 42;");
  expect(aiCalls).toBe(1);

  await app.hover("id:quick-translate-card-card-1 >> id:result-seg-1");
  const fragBg = app.viewStyle(
    "id:quick-translate-card-card-1 >> id:result-seg-1",
  )?.backgroundColor;
  expect(fragBg).toBeTruthy();
  expect(
    app.viewStyle("id:quick-translate-card-card-1 >> id:result-seg-1-frag-1")?.backgroundColor,
  ).toEqual(fragBg);
  expect(
    app.viewStyle("id:quick-translate-card-card-1 >> id:result-seg-1-frag-3")?.backgroundColor,
  ).toEqual(fragBg);
  expect(
    app.viewStyle("id:quick-translate-card-card-1 >> id:result-seg-1-frag-5")?.backgroundColor,
  ).toEqual(fragBg);
  expect(
    app.viewStyle("id:quick-translate-card-card-1 >> id:result-seg-2")?.backgroundColor,
  ).toBeUndefined();
  expect(
    app.spanStyle(
      "id:quick-translate-source >> text:First sentence has bold italic link details 42.",
    ).backgroundColor,
  ).toEqual(fragBg);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second sentence follows.").backgroundColor,
  ).toBeUndefined();

  await app.hover("id:quick-translate-card-card-1 >> id:result-seg-3");
  expect(app.spanStyle("id:quick-translate-source >> text:List point A1.").backgroundColor).toEqual(
    fragBg,
  );

  await app.hover("id:quick-translate-card-card-1 >> id:result-seg-4");
  expect(app.spanStyle("id:quick-translate-source >> text:Table cell B2.").backgroundColor).toEqual(
    fragBg,
  );

  // Copy copies the raw Markdown result while keeping fenced code block intact.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(app.clipboard()).toBe(markdownReply);

  // Toggling Markdown off clears active preview and switches without retranslating.
  await app.press("id:harness-toggle-markdown");
  await app.waitUntil(
    () =>
      app.spanStyle("id:quick-translate-source >> text:Table cell B2.").backgroundColor ===
      undefined,
  );
  expect(aiCalls).toBe(1);

  await app.press("id:harness-toggle-markdown");
  await app.hover("id:quick-translate-card-card-1 >> id:result-seg-0");
  expect(app.spanStyle("id:quick-translate-source >> text:Summary V1").backgroundColor).toEqual(
    fragBg,
  );
  expect(aiCalls).toBe(1);
});

test("sentence highlight keyboard: tabs to eligible results, steps Left/Right with live announcement, clears on blur, and skips unmapped results", async () => {
  let replyMode: "aligned" | "unmapped" | "markdown" = "aligned";
  const app = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()]),
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => ({
        status: 200,
        body: {
          choices: [
            {
              message: {
                content:
                  replyMode === "aligned"
                    ? "Use NSH today. Second draft works."
                    : replyMode === "markdown"
                      ? "**Use NSH** today. Second _draft_ works."
                      : "Completely different first line.\nUnrelated second.\nExtra third.",
              },
            },
          ],
        },
      }),
    },
  });

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Use NSH today. Second draft works.");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");

  const preview = "id:quick-translate-card-card-1 >> id:quick-translate-result-preview";
  const announcement = "id:quick-translate-sentence-announcement";
  expect(app.shows(preview)).toBe(true);
  expect(app.accessibility(preview)?.label).toBe("Translated result");
  expect(app.accessibility(announcement)?.label ?? "").toBe("");

  // Hovering alone updates highlight without firing screen-reader live announcements.
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:Use NSH today.",
  );
  const resultBg = app.spanStyle(
    "id:quick-translate-card-card-1 >> id:result-seg-0",
  ).backgroundColor;
  expect(resultBg).toBeTruthy();
  expect(app.accessibility(announcement)?.label ?? "").toBe("");
  await app.hover("id:quick-translate-source");
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-0").backgroundColor,
  ).toBeUndefined();

  // Tab from source editor stops on eligible result preview wrapper; ArrowRight highlights first sentence.
  await app.type("id:quick-translate-source", "");
  let reachedPreview = false;
  for (let i = 0; i < 16; i += 1) {
    await app.keyboard.press("tab");
    await app.keyboard.press("arrowright");
    if (app.accessibility(preview)?.value) {
      reachedPreview = true;
      break;
    }
  }
  expect(reachedPreview).toBe(true);
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-0").backgroundColor,
  ).toEqual(resultBg);
  expect(app.spanStyle("id:quick-translate-source >> text:Use NSH today.").backgroundColor).toEqual(
    resultBg,
  );
  expect(app.accessibility(preview)?.value).toBe("Sentence 1 of 2: Use NSH today.");
  expect(app.accessibility(announcement)?.label).toBe("Sentence 1 of 2: Use NSH today.");

  // ArrowRight advances to second sentence; ArrowLeft returns to first.
  await app.keyboard.press("arrowright");
  expect(
    app.spanStyle("id:quick-translate-card-card-1 >> id:result-seg-1").backgroundColor,
  ).toEqual(resultBg);
  expect(
    app.spanStyle("id:quick-translate-source >> text:Second draft works.").backgroundColor,
  ).toEqual(resultBg);
  expect(app.accessibility(preview)?.value).toBe("Sentence 2 of 2: Second draft works.");
  expect(app.accessibility(announcement)?.label).toBe("Sentence 2 of 2: Second draft works.");

  await app.keyboard.press("arrowleft");
  expect(app.spanStyle("id:quick-translate-source >> text:Use NSH today.").backgroundColor).toEqual(
    resultBg,
  );
  expect(app.accessibility(preview)?.value).toBe("Sentence 1 of 2: Use NSH today.");

  // Tabbing away blurs wrapper and clears keyboard preview & value, and ArrowRight no longer activates it.
  await app.keyboard.press("tab");
  expect(
    app.spanStyle("id:quick-translate-source >> text:Use NSH today.").backgroundColor,
  ).toBeUndefined();
  expect(app.accessibility(preview)?.value ?? "").toBe("");
  await app.keyboard.press("arrowright");
  expect(
    app.spanStyle("id:quick-translate-source >> text:Use NSH today.").backgroundColor,
  ).toBeUndefined();

  // Keyboard traversal works in Markdown mode too, and Enter inside source still submits.
  replyMode = "markdown";
  await app.press("id:harness-toggle-markdown");
  await app.type("id:quick-translate-source", "");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:result-seg-1");
  let reachedMarkdownPreview = false;
  for (let i = 0; i < 16; i += 1) {
    await app.keyboard.press("tab");
    await app.keyboard.press("arrowright");
    if (app.accessibility(preview)?.value) {
      reachedMarkdownPreview = true;
      break;
    }
  }
  expect(reachedMarkdownPreview).toBe(true);
  expect(app.spanStyle("id:quick-translate-source >> text:Use NSH today.").backgroundColor).toEqual(
    resultBg,
  );

  // Unmapped results expose no focusable result preview stop.
  replyMode = "unmapped";
  await app.press("id:harness-toggle-markdown");
  await app.clear("id:quick-translate-source");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text", {
    state: "gone",
  });
  await app.type("id:quick-translate-source", "Alpha source 123.");
  await app.keyboard.press("enter");
  await app.waitUntil(
    () =>
      app.shows("id:quick-translate-card-card-1 >> id:quick-translate-result-text") &&
      app.texts().some((line) => line.includes("Completely different first line.")),
  );
  expect(app.shows(preview)).toBe(false);
});

test("sentence highlight keyboard: localizes zh-CN preview label and live sentence announcement", async () => {
  const preview = "id:quick-translate-card-card-1 >> id:quick-translate-result-preview";
  const announcement = "id:quick-translate-sentence-announcement";
  const zhApp = await open(POPUP_HARNESS, {
    ...viewport,
    storage: seedWithPresets([makePreset()], {
      "settings.language": "zh-CN",
    }),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "今天使用 NSH。第二句草稿有效。" } }] },
      },
    },
  });
  await zhApp.waitFor("id:quick-translate-source");
  await zhApp.type("id:quick-translate-source", "First NSH sentence. Second draft.");
  await zhApp.keyboard.press("enter");
  await zhApp.waitFor(preview);
  expect(zhApp.accessibility(preview)?.label).toBe("译文内容");
  for (let i = 0; i < 16; i += 1) {
    await zhApp.keyboard.press("tab");
    await zhApp.keyboard.press("arrowright");
    if (zhApp.accessibility(preview)?.value) break;
  }
  expect(zhApp.accessibility(preview)?.value).toBe("第 1 / 2 句：First NSH sentence.");
  expect(zhApp.accessibility(announcement)?.label).toBe("第 1 / 2 句：First NSH sentence.");
});
