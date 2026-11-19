import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { initializeAiModules } from "../../app/ai-setup";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { PRESETS_STORAGE_KEY } from "../presets/store";
import type { TranslationPreset } from "../presets/types";

initializeAiModules();

const POPUP_HARNESS = "./__tests__/popup-harness.tsx";
const POPUP_HARNESS_MODE_KEY = "__test.qt.popupMode";
const viewport = { width: 520, height: 520, platform: "windows" as const };

function makePreset(overrides: Partial<TranslationPreset> = {}): TranslationPreset {
  return {
    id: "preset-1",
    name: "Default EN to FR",
    enabled: true,
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
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
  expect(app.shows("id:quick-translate-copy")).toBe(false);

  // Whitespace-only Enter shows blank validation error and sends 0 requests.
  await app.type("id:quick-translate-source", "   ");
  await app.keyboard.press("enter");
  expect(app.texts()).toContain(t("quickTranslate.error.blankInput"));
  expect(app.requests()).toHaveLength(0);

  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");

  await app.waitFor("id:quick-translate-copy");
  expect(app.texts()).toContain("Bonjour");
  expect(app.requests()).toHaveLength(1);

  await app.press("id:quick-translate-copy");
  expect(app.clipboard()).toBe("Bonjour");
  expect(app.texts()).toContain(t("quickTranslate.copied"));

  // Shift+Enter inserts a newline without submitting.
  await app.clear("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Line 1");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Line 2");
  expect(app.value("id:quick-translate-source")).toBe("Line 1\nLine 2");
  expect(app.requests()).toHaveLength(1);
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
  expect(disabledOnly.enabled("id:quick-translate-submit")).toBe(false);
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
  await copyErr.press("id:quick-translate-submit");
  await copyErr.waitFor("id:quick-translate-copy");
  await copyErr.press("id:quick-translate-copy");
  await copyErr.waitFor("id:quick-translate-copy-error");
  expect(copyErr.texts()).toContain(t("quickTranslate.error.copyFailed"));
  expect(copyErr.texts()).toContain("Bonjour");
});

test("quick popup: debounces 500ms opt-in auto-translate, keeps preset change manual, and lets Translate bypass timer", async () => {
  const secondPreset = makePreset({
    id: "preset-2",
    name: "Preset Two",
    sourceLanguage: "auto",
    targetLanguage: null,
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

  // In automatic mode, Enter inserts newline and does not submit early.
  await app.keyboard.press("enter");
  expect(app.value("id:quick-translate-source")).toBe("Hello!\n");
  await app.clock!.runFor(499);
  expect(app.requests()).toHaveLength(1);
  await app.clock!.runFor(1);
  expect(app.requests()).toHaveLength(2);

  // Language change re-runs after 500 ms.
  await app.press("id:quick-translate-target-language");
  await app.waitFor("role:option[Japanese]");
  await app.press("role:option[Japanese]");
  expect(app.shows("id:quick-translate-copy")).toBe(false);
  await app.clock!.runFor(499);
  expect(app.requests()).toHaveLength(2);
  await app.clock!.runFor(1);
  expect(app.requests()).toHaveLength(3);

  // Changing preset alone invalidates result and does NOT trigger translation.
  await app.press("id:quick-translate-preset");
  await app.waitFor("role:option[Preset Two]");
  await app.press("role:option[Preset Two]");
  expect(app.shows("id:quick-translate-copy")).toBe(false);
  await app.clock!.runFor(1000);
  expect(app.requests()).toHaveLength(3);

  // Translate button bypasses debounce timer without a duplicate second call.
  await app.type("id:quick-translate-source", " Go");
  await app.press("id:quick-translate-submit");
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
  await outOfOrder.press("id:quick-translate-submit");

  await outOfOrder.type("id:quick-translate-source", " Second");
  await outOfOrder.waitUntil(() =>
    outOfOrder.texts().some((line) => line.includes("aborts=aborted-1")),
  );
  await outOfOrder.press("id:quick-translate-submit");

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
  await lateClose.press("id:quick-translate-submit");
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
  await app.press("id:quick-translate-submit");
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
  expect(app.shows("id:quick-translate-card-card-2 >> text:Copied")).toBe(true);
  expect(app.shows("id:quick-translate-card-card-1 >> text:Copied")).toBe(false);

  // Collapse hides result body and re-expanding restores it without sending another request.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  expect(app.shows("id:quick-translate-card-card-2 >> id:quick-translate-result-text")).toBe(false);
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-result-text");
  expect(app.texts().some((line) => line.includes("calls=2|"))).toBe(true);

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
});

test("preset cards: automatic mode schedules eligible cards on shared input and runs only targeted card on add or template override", async () => {
  const multiTemplatePreset = makePreset({
    id: "preset-1",
    name: "Preset Alpha",
    sourceLanguage: "en",
    targetLanguage: "fr",
    engine: {
      kind: "ai",
      modelIds: ["m-1"],
      temperature: null,
      maxOutputTokens: null,
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
  expect(autoApp.shows("id:quick-translate-source-language >> text:English")).toBe(true);
  expect(autoApp.shows("id:quick-translate-target-language >> text:French")).toBe(true);

  // Change template override ONLY on card 1 -> runs ONLY card 1 (total 3 requests).
  await autoApp.press("id:quick-translate-card-card-1 >> id:quick-translate-template");
  await autoApp.waitFor("role:option[Concise]");
  await autoApp.press("role:option[Concise]");
  await autoApp.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(autoApp.requests()).toHaveLength(3);
});
