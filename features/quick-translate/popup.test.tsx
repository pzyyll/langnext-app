import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { initializeAiModules } from "../../app/ai-setup";
import { LANGUAGE_DETECTION_STORAGE_KEY } from "../language-detection/settings";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { credentialStorageKey, MODELS_STORAGE_KEY, PROVIDERS_STORAGE_KEY } from "../models/store";
import { getLanguageLabel, getTargetLanguageLabel } from "../presets/languages";
import { deepLCredentialStorageKey, PRESETS_STORAGE_KEY } from "../presets/store";
import type { TranslationPreset } from "../presets/types";
import { QUICK_TRANSLATE_PREFERENCES_KEY } from "./preferences";
import { GOOGLE_CLOUD_TTS_URL } from "../tts/google-cloud";
import { TTS_STORAGE_KEY, ttsCredentialStorageKey } from "../tts/settings";

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
  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Line 1");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Line 2");
  expect(app.value("id:quick-translate-source")).toBe("Line 1\nLine 2");
  expect(app.requests()).toHaveLength(1);
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

  await app.hover("id:quick-translate-collapse-source");
  await app.waitFor(`text:${t("quickTranslate.editSource")}`);

  // Pressing the preview returns to the editor with the whole draft.
  await app.press("id:quick-translate-source-preview");
  await app.waitFor("id:quick-translate-source");
  expect(app.value("id:quick-translate-source")).toBe("First line\nSecond line");
  expect(app.shows("id:quick-translate-source-preview")).toBe(false);

  // An empty field always shows the editor again.
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source-preview");
  await app.press("id:quick-translate-clear");
  await app.waitFor("id:quick-translate-source");
  expect(app.value("id:quick-translate-source")).toBe("");
  expect(app.shows("id:quick-translate-collapse-source")).toBe(false);
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
  expect(app.value("id:quick-translate-source")).toBe("Hello!\n");
  await app.clock!.runFor(499);
  expect(app.requests()).toHaveLength(1);
  await app.clock!.runFor(1);
  expect(app.requests()).toHaveLength(2);

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

  const app = await open("../../App.tsx", {
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
  const failedApp = await open("../../App.tsx", {
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

  // Manual Add + template selection sends 0 requests.
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
      [LANGUAGE_DETECTION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        mode: "ai",
        modelIds: ["det-1"],
        nativeLanguage: "zh",
        preferredTranslationLanguage: "en",
      }),
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
      [LANGUAGE_DETECTION_STORAGE_KEY]: JSON.stringify({
        version: 1,
        mode: options.detectionMode ?? "ai",
        modelIds: ["det-1"],
        nativeLanguage: "zh",
        preferredTranslationLanguage: "en",
      }),
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

  // 3. Entering OCR recognizing leaves header Detecting intact and shows busy below source.
  await app.press("id:harness-ocr-recognizing");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  expect(app.texts()).toContain(t("quickTranslate.ocrRecognizing"));
  expect(
    app.shows(
      `id:quick-translate-source-language >> text:${t("quickTranslate.detectingLanguage")}`,
    ),
  ).toBe(true);
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    false,
  );

  // 4. Entering OCR error replaces busy inside the source toolbar.
  await app.press("id:harness-ocr-error");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
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
      googleCloud: { enabled, credentialRef: "tts-ref" },
    }),
    [ttsCredentialStorageKey("tts-ref")]: JSON.stringify({ apiKey: "tts-key" }),
  };
}

function ttsVoice(requestBody: string | null): { languageCode: string; name: string } {
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
  expect(unsupported.texts()).toContain(t("quickTranslate.speakUnsupported"));
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

test("quick tts: resolved Auto uses the detected source and the card's stored target", async () => {
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
  await app.press("id:quick-translate-speak-source");
  await app.waitFor("id:quick-translate-speak-source-error");
  expect(app.texts()).toContain(t("quickTranslate.speakTranslateFirst"));
  expect(app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);

  await app.keyboard.press("enter");
  await app.press("id:harness-resolve-language-fr");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  expect(app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toBe(false);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-speak-result");
  await app.waitUntil(() => app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL));
  const resultSpeech = app.requests().find((request) => request.url === GOOGLE_CLOUD_TTS_URL)!;
  expect(JSON.parse(resultSpeech.body ?? "").input.text).toBe("\u8bd1\u6587");
  expect(ttsVoice(resultSpeech.body)).toEqual({
    languageCode: "cmn-CN",
    name: "cmn-CN-Standard-A",
  });

  await app.press("id:quick-translate-speak-source");
  await app.waitUntil(
    () => app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL).length === 2,
  );
  const sourceSpeech = app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL)[1]!;
  expect(JSON.parse(sourceSpeech.body ?? "").input.text).toBe("Bonjour");
  expect(ttsVoice(sourceSpeech.body)).toEqual({ languageCode: "fr-FR", name: "fr-FR-Standard-F" });

  await app.press("id:quick-translate-target-language");
  await app.waitFor(`role:option[${getLanguageLabel("en")}]`);
  await app.press(`role:option[${getLanguageLabel("en")}]`);
  expect(app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL)).toHaveLength(2);
});
