import type { HistoryResult, HistorySnapshot } from "langnext-native";
import { effect, signal } from "nsh";
import type { WindowRef, WindowState } from "nsh/desktop";
import { t } from "nsh/i18n";
import { expect, open, test, type StubRequest, type StubResponse } from "nsh/test";
import { GOOGLE_DETECTION_URL } from "../integrations/detect/vendor/google-free";
import { GOOGLE_CLOUD_TTS_URL } from "../integrations/tts/vendor/google-cloud";
import { DEFAULT_GOOGLE_VOICE_PREFERENCES } from "../integrations/tts/vendor/google-preferences";
import { DICTIONARY_CHANNELS_STORAGE_KEY } from "../features/dictionary/store";
import { LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY } from "../features/language-detection/preferences";
import { DETECT_COLLECTION_STORAGE_KEY } from "../features/language-detection/store";
import { makeChannel, makeModel, makeSeedStorage } from "../features/models/__tests__/fixtures";
import { OCR_CHANNELS_STORAGE_KEY, OCR_CREDENTIAL_NAMESPACE } from "../features/ocr/store";
import { PRESETS_STORAGE_KEY } from "../features/presets/store";
import type { TranslationPreset } from "../features/presets/types";
import { QUICK_TRANSLATE_PREFERENCES_KEY } from "../features/quick-translate/preferences";
import {
  DEFAULT_QUICK_TRANSLATE_SHORTCUT,
  DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT,
  DEFAULT_SELECTION_TRANSLATE_SHORTCUT,
  formatShortcut,
  QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY,
  SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY,
  SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY,
} from "../features/settings/shortcuts";
import {
  createQuickTranslateController,
  POPUP_DEFAULT_SIZE,
  POPUP_MIN_SIZE,
} from "./quick-translate-controller";
import { SELECTION_HINT_STORAGE_KEY } from "../features/settings/selection-hint";
import { SELECTION_HINT_DURATION_MS } from "./selection-hint";

const HARNESS_ENTRY = "./__tests__/quick-translate-harness.tsx";
const HARNESS_SHORTCUT_MODE_KEY = "__test.qt.shortcutMode";
const HARNESS_PLATFORM_OS_KEY = "__test.qt.platformOs";
const viewport = { width: 1040, height: 720, platform: "windows" as const };
const AUTO_TRANSLATE_DEBOUNCE_MS = 500;
const SENTENCE_ALIGNMENT_STORAGE_KEY = "settings.quickTranslate.sentenceAlignment";
const TTS_STORAGE_KEY = "integrations.tts.v1";
const TTS_CREDENTIAL_NAMESPACE = "secret.tts";

function ttsCredentialStorageKey(credentialRef: string): string {
  return `${TTS_CREDENTIAL_NAMESPACE}.${credentialRef}`;
}

function ocrCredentialStorageKey(credentialRef: string): string {
  return `${OCR_CREDENTIAL_NAMESPACE}.${credentialRef}`;
}

/** Popup selections live in the popup's own preferences; presets never supply languages. */
function popupPreferences(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    doubleCopyEnabled: false,
    autoTranslate: false,
    sourceLanguage: "en",
    targetLanguage: "zh",
    cards: [],
    ...overrides,
  });
}

function hasQuickSource(targetApp: Awaited<ReturnType<typeof open>>, expected: string): boolean {
  if (expected.length === 0) {
    return (
      !targetApp.shows("id:quick-translate-collapse-source") &&
      !targetApp.shows("id:quick-translate-source-count")
    );
  }
  const texts = targetApp.texts();
  const lines = expected.split("\n").filter((line) => line.length > 0);
  return (
    targetApp.shows("id:quick-translate-collapse-source") &&
    targetApp.shows("id:quick-translate-source-count") &&
    texts.includes(String(expected.length)) &&
    lines.every((line) => texts.includes(line))
  );
}

const quickPreset: TranslationPreset = {
  id: "preset-1",
  name: "Quick Preset",
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
};

test("desktop: quick window opens from production tray action, reuses existing window, and preserves active source", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  expect(app.window("quick-translate").state()).toBeNull();

  await app.press("id:harness-tray-quick-translate");
  await app.waitUntil(() => app.window("quick-translate").state()?.focused === true);

  const firstState = app.window("quick-translate").state()!;
  expect(firstState.visible).toBe(true);
  expect(firstState.focused).toBe(true);
  expect(Math.abs(firstState.contentBounds.size.width - 420)).toBeLessThan(1);
  expect(firstState.display).toBeDefined();
  expect(firstState.display).toBe(app.window("main").state()?.display);

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello quick window");
  expect(hasQuickSource(app, "Hello quick window")).toBe(true);

  // Re-invoking shortcut while unpinned focuses and preserves existing draft.
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.window("quick-translate").state()?.focused).toBe(true);
  expect(hasQuickSource(app, "Hello quick window")).toBe(true);
});

test("quick history: group multi-card translations and restore with no request or duplicate history", async () => {
  const saved = new Map<string, HistorySnapshot>();
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        autoTranslate: true,
        cards: [
          { id: "card-1", presetId: quickPreset.id },
          { id: "card-2", presetId: quickPreset.id },
        ],
      }),
      "settings.language": "en",
    },
    modules: {
      "langnext-native": {
        "TranslationHistoryNative.record": (
          id: string,
          sourceText: string | null,
          result: HistoryResult,
        ) => {
          if (sourceText !== null) saved.set(id, { id, sourceText, results: [] });
          saved.get(id)?.results.push(result);
        },
        "TranslationHistoryNative.listRecent": () =>
          [...saved.values()]
            .reverse()
            .map(({ id, sourceText }) => ({ id, preview: sourceText.replaceAll("\n", " ") })),
        "TranslationHistoryNative.read": (id: string) => saved.get(id) ?? null,
      },
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Saved translation" } }] },
      },
    },
  });
  const source = "id:quick-translate-source";
  const history = "id:quick-translate-history";
  const original = "Original first line\nOriginal second line";
  const entry = `role:menuitem[${original.replaceAll("\n", " ")}]`;

  await app.press("id:harness-tray-quick-translate");
  await app.press(history);
  await app.waitFor("No translation history");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("No translation history"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  await app.type(source, "Original first line");
  await app.keyboard.press("shift+enter");
  await app.type(source, "Original second line");
  await app.keyboard.press("enter");
  await app.waitUntil(() => [...saved.values()][0]?.results.length === 2);
  expect(saved.size).toBe(1);
  expect(app.requests()).toHaveLength(2);

  await app.type(source, " Draft not sent yet");
  await app.press(history);
  await app.waitFor(entry);
  expect(hasQuickSource(app, original)).toBe(false);
  expect(app.texts().some((text) => text.includes("Draft not sent yet"))).toBe(true);
  await app.keyboard.press("arrowdown");
  await app.keyboard.press("enter");
  await app.waitUntil(() => !app.shows(entry));
  await app.waitFor("id:quick-translate-history-results");
  expect(hasQuickSource(app, original)).toBe(true);
  expect(app.texts().some((text) => text.includes("Draft not sent yet"))).toBe(false);
  expect(app.texts().filter((text) => text === "Saved translation")).toHaveLength(2);
  await app.clock!.runFor(AUTO_TRANSLATE_DEBOUNCE_MS + 200);
  expect(app.requests()).toHaveLength(2);
  expect(saved.size).toBe(1);

  // Once the menu has closed, Return works from the restored editor without another click.
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.requests().length === 4);
  expect(app.shows("id:quick-translate-history-results")).toBe(false);
});

test("quick history: discard a late translation when a saved action replaces the draft", async () => {
  const old: HistorySnapshot = {
    id: "old",
    sourceText: "Stored original",
    results: [
      {
        position: 0,
        presetName: "Removed preset",
        sourceLanguage: "fr",
        targetLanguage: "en",
        text: "Stored result",
      },
    ],
  };
  let writes = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences(),
      "settings.language": "en",
    },
    modules: {
      "langnext-native": {
        "TranslationHistoryNative.record": () => {
          writes += 1;
        },
        "TranslationHistoryNative.listRecent": () => [{ id: old.id, preview: old.sourceText }],
        "TranslationHistoryNative.read": () => old,
      },
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        delay: 2000,
        body: { choices: [{ message: { content: "Late result" } }] },
      },
    },
  });
  const source = "id:quick-translate-source";
  await app.press("id:harness-tray-quick-translate");
  await app.type(source, "Pending original");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.requests().length === 1);
  await app.press("id:quick-translate-history");
  await app.press("role:menuitem[Stored original]");
  await app.waitFor("Stored result");
  expect(hasQuickSource(app, "Stored original")).toBe(true);
  expect(app.texts()).toContain("Removed preset");
  await app.clock!.runFor(2100);
  expect(app.texts()).not.toContain("Late result");
  expect(app.requests()).toHaveLength(1);
  expect(writes).toBe(0);

  await app.press("id:quick-translate-history-copy");
  expect(app.clipboard()).toBe("Stored result");
  await app.type(source, " edited");
  expect(app.shows("id:quick-translate-history-results")).toBe(false);
  expect(app.shows("id:quick-translate-card-card-1")).toBe(true);
});

async function headlessHasAlignmentModel(): Promise<boolean | null> {
  try {
    const { SentenceAlignmentNative } = await import("langnext-native");
    return SentenceAlignmentNative.modelAssets().length > 0;
  } catch {
    // Desktop test runners execute this file outside the app's native registry.
    return null;
  }
}

test("alignment settings: model row downloads, cancels, and retries without enabling alignment", async () => {
  if ((await headlessHasAlignmentModel()) === false) return;
  let attempts = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { "settings.language": "en" },
    network: {
      "GET https://huggingface.co/Xenova/multilingual-e5-small/*": () => ({
        status: 503,
        body: "Unavailable",
        delay: ++attempts === 1 ? 2_500 : 0,
      }),
    },
  });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-quick-translate");
  const toggle = "id:settings-sentence-alignment-switch";
  const modelRow = "id:settings-alignment-model";
  const downloadButton = "id:settings-alignment-download";
  const cancelButton = "id:settings-alignment-download-cancel";
  const progressBar = "id:settings-alignment-download-progress-bar";
  const errorText = "id:settings-alignment-download-error";

  await app.waitFor(toggle);
  await app.waitFor(modelRow);
  await app.waitFor(downloadButton);
  expect(app.texts()).toContain("Multilingual E5 Small");
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(true);
  expect(app.requests()).toHaveLength(0);

  await app.press(downloadButton);
  await app.waitFor(progressBar);
  await app.waitFor(cancelButton);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(false);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();
  expect(app.layout(progressBar)!.y).toBeGreaterThanOrEqual(
    app.layout(modelRow)!.y + app.layout(modelRow)!.height,
  );

  // Returning from another Settings page preserves the active app-wide transfer progress.
  await app.press("id:settings-nav-general");
  await app.waitFor("id:settings-general-card");
  await app.press("id:settings-nav-quick-translate");
  await app.waitFor(progressBar);
  expect(app.enabled(toggle)).toBe(false);

  await app.press(cancelButton);
  await app.waitUntil(() => !app.shows(progressBar));
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(true);
  expect(app.shows(downloadButton)).toBe(true);
  expect(app.shows(errorText)).toBe(false);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();

  // Manual download failure offers Retry without enabling alignment.
  await app.press(downloadButton);
  await app.waitFor(errorText);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(true);
  expect(app.shows("role:button[Retry]")).toBe(true);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();

  // Retry starts a fresh manual transfer and keeps alignment off.
  await app.press("role:button[Retry]");
  await app.waitUntil(() => attempts === 3);
  await app.waitFor(errorText);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();

  // When the verified model is present, show Downloaded and hide transfer controls.
  const installedApp = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    modules: {
      "langnext-native": {
        "SentenceAlignmentNative.modelReady": () => true,
      },
    },
  });
  await installedApp.press("id:nav-settings");
  await installedApp.press("id:settings-nav-quick-translate");
  await installedApp.waitFor("text:Downloaded");
  expect(installedApp.shows(downloadButton)).toBe(false);
  expect(installedApp.shows(cancelButton)).toBe(false);
  expect(installedApp.shows(progressBar)).toBe(false);
  expect(installedApp.shows("role:button[Retry]")).toBe(false);
  expect(installedApp.accessibility(toggle)?.checked).toBe("false");
  expect(installedApp.requests()).toHaveLength(0);
});

test("alignment settings: consent asks before downloading and recovers from cancel or failed transfer", async () => {
  if ((await headlessHasAlignmentModel()) === false) return;
  let attempts = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { "settings.language": "en" },
    network: {
      "GET https://huggingface.co/Xenova/multilingual-e5-small/*": () => ({
        status: 503,
        body: "Unavailable",
        delay: ++attempts === 1 ? 2_500 : 0,
      }),
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(app.shows("id:quick-translate-download-alignment")).toBe(false);
  expect(app.requests()).toHaveLength(0);
  await app.press("id:quick-translate-close");
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-quick-translate");

  const toggle = "id:settings-sentence-alignment-switch";
  const dialog = "id:settings-alignment-download-dialog";
  const dialogCancel = "id:settings-alignment-download-cancel-dialog";
  const dialogConfirm = "id:settings-alignment-download-confirm";
  const pendingEnable = "id:settings-alignment-pending-enable";
  const progressBar = "id:settings-alignment-download-progress-bar";
  const errorText = "id:settings-alignment-download-error";

  await app.waitFor(toggle);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  await app.hover("id:settings-sentence-alignment-info");
  await app.waitFor(t("settings.quickTranslate.alignmentHelp"));
  expect(app.requests()).toHaveLength(0);

  await app.press(toggle);
  await app.waitFor(dialog);
  expect(app.texts()).toContain("Multilingual E5 Small");
  expect(app.texts().some((line) => line.includes("135 MB"))).toBe(true);
  expect(app.shows(dialogCancel)).toBe(true);
  expect(app.shows(dialogConfirm)).toBe(true);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();
  expect(app.requests()).toHaveLength(0);

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows(dialog));
  expect(app.requests()).toHaveLength(0);
  expect(app.accessibility(toggle)?.checked).toBe("false");

  // Focus returns to the switch so Space reopens the confirmation dialog without a pointer.
  await app.keyboard.press("space");
  await app.waitFor(dialog);
  await app.press(dialogCancel);
  await app.waitUntil(() => !app.shows(dialog));
  expect(app.requests()).toHaveLength(0);
  expect(app.accessibility(toggle)?.checked).toBe("false");

  await app.keyboard.press("space");
  await app.waitFor(dialog);
  await app.keyboard.press("tab");
  await app.keyboard.press("space");
  await app.waitUntil(() => !app.shows(dialog));
  await app.waitFor(progressBar);
  await app.waitFor(pendingEnable);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(false);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();
  expect(app.requests().map((request) => request.method)).toEqual(["GET"]);
  expect(app.requests()[0]!.body ?? "").toBe("");

  await app.waitFor(errorText, { timeout: 6_000 });
  expect(app.shows(pendingEnable)).toBe(false);
  expect(app.shows(progressBar)).toBe(false);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(true);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-alignment-download-retry");
  await app.waitUntil(() => attempts === 2);
  await app.waitFor(errorText);
  expect(app.shows(pendingEnable)).toBe(false);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();
});

test("alignment settings: preparation failure preserves verified model and keeps switch off", async () => {
  if ((await headlessHasAlignmentModel()) !== true) return;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
    modules: {
      "langnext-native": {
        "SentenceAlignmentNative.modelReady": () => true,
        "SentenceAlignmentNative.prepareSemanticModel": () => false,
      },
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-quick-translate");
  const toggle = "id:settings-sentence-alignment-switch";
  await app.waitFor("id:settings-alignment-model-downloaded");
  await app.press(toggle);
  await app.waitFor("id:settings-alignment-prepare-error");
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.shows("id:settings-alignment-model-downloaded")).toBe(true);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();
  expect(app.requests()).toHaveLength(0);
});

test("offline alignment model: cancel in the model row aborts the download before a retry starts after cleanup", async () => {
  if (!(await headlessHasAlignmentModel())) return;
  let attempts = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { "settings.language": "en" },
    network: {
      "GET https://huggingface.co/Xenova/multilingual-e5-small/*": () => ({
        status: 503,
        body: "Unavailable",
        delay: ++attempts === 1 ? 2_500 : 0,
      }),
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-quick-translate");
  const toggle = "id:settings-sentence-alignment-switch";
  const progress = "id:settings-alignment-download-progress";
  const progressBar = "id:settings-alignment-download-progress-bar";
  const cancelButton = "id:settings-alignment-download-cancel";
  expect(app.shows(progressBar)).toBe(false);

  await app.press(toggle);
  await app.waitFor("id:settings-alignment-download-dialog");
  await app.press("id:settings-alignment-download-confirm");
  await app.waitFor(progress);
  await app.waitFor(progressBar);
  await app.waitFor(cancelButton);
  expect(app.accessibility(progressBar)?.role).toBe("progressbar");
  await app.waitUntil(() => attempts === 1);

  await app.press(cancelButton);
  await app.waitUntil(() => !app.shows(progressBar));
  expect(app.shows(progress)).toBe(false);
  expect(app.shows("id:settings-alignment-pending-enable")).toBe(false);
  expect(app.shows("id:settings-alignment-download-error")).toBe(false);
  expect(app.accessibility(toggle)?.checked).toBe("false");
  expect(app.enabled(toggle)).toBe(true);
  expect(app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-alignment-download");
  await app.waitUntil(() => attempts === 2, { timeout: 1000 });
  await app.waitFor("id:settings-alignment-download-error");
  expect(app.shows(progressBar)).toBe(false);
  expect(app.shows("id:settings-alignment-pending-enable")).toBe(false);

  await app.press("id:settings-alignment-download-retry");
  await app.waitUntil(() => attempts === 3, { timeout: 1000 });
  await app.waitFor("id:settings-alignment-download-error");
  expect(app.accessibility(toggle)?.checked).toBe("false");
});

test("alignment settings: existing result clears preview and highlight without retranslating", async () => {
  if (!(await headlessHasAlignmentModel())) return;
  const source = "She opened the door. He stepped inside.";
  const target = "她打开了门。他走了进去。";
  const calls: unknown[][] = [];
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      [SENTENCE_ALIGNMENT_STORAGE_KEY]: "true",
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: target } }] },
      },
    },
    modules: {
      "langnext-native": {
        "SentenceAlignmentNative.modelReady": () => true,
        "SentenceAlignmentNative.prepareSemanticModel": () => true,
        "SentenceAlignmentNative.alignSemantic": (input: string, blocks: string[]) => {
          calls.push([input, blocks]);
          return [
            { sourceStart: 21, sourceEnd: 39, targetBlockIndex: 0, targetStart: 6, targetEnd: 12 },
          ];
        },
      },
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", source);
  await app.keyboard.press("enter");
  await app.waitUntil(() => calls.length > 0);
  expect(calls).toEqual([[source, [target]]]);
  await app.waitFor("id:quick-translate-result-preview");
  let reachedPreview = false;
  for (let i = 0; i < 16; i += 1) {
    await app.keyboard.press("tab");
    await app.keyboard.press("arrowright");
    if (app.accessibility("id:quick-translate-result-preview")?.value) {
      reachedPreview = true;
      break;
    }
  }
  expect(reachedPreview).toBe(true);
  await app.hover(
    "id:quick-translate-card-card-1 >> id:quick-translate-result-text >> text:他走了进去。",
  );
  expect(
    app.spanStyle("id:quick-translate-source >> text:He stepped inside.").backgroundColor,
  ).toBeTruthy();
  await app.press("id:quick-translate-copy");
  expect(app.clipboard()).toBe(target);
  expect(app.requests()).toHaveLength(1);

  await app.press("id:quick-translate-pin");
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-quick-translate");
  const toggle = "id:settings-sentence-alignment-switch";
  expect(app.accessibility(toggle)?.checked).toBe("true");
  await app.press(toggle);
  await app.waitUntil(() => app.storage()[SENTENCE_ALIGNMENT_STORAGE_KEY] === "false");
  expect(app.shows("id:quick-translate-result-preview")).toBe(false);
  expect(app.accessibility("id:quick-translate-sentence-announcement")?.label ?? "").toBe("");
  expect(
    app.spanStyle("id:quick-translate-source >> text:He stepped inside.").backgroundColor,
  ).toBeUndefined();
  expect(app.texts()).toContain(target);
  await app.press("id:quick-translate-copy");
  expect(app.clipboard()).toBe(target);
  expect(app.requests()).toHaveLength(1);
});

test("alignment settings: collapse, expand, and Markdown toggle reuse the settled alignment", async () => {
  if (!(await headlessHasAlignmentModel())) return;
  const source = "She opened the door. He stepped inside.";
  const target = "她打开了门。他走了进去。";
  const alignCalls: unknown[][] = [];
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      [SENTENCE_ALIGNMENT_STORAGE_KEY]: "true",
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: target } }] },
      },
    },
    modules: {
      "langnext-native": {
        "SentenceAlignmentNative.modelReady": () => true,
        "SentenceAlignmentNative.prepareSemanticModel": () => true,
        "SentenceAlignmentNative.alignSemantic": (input: string, blocks: string[]) => {
          alignCalls.push([input, blocks]);
          return [
            { sourceStart: 0, sourceEnd: 20, targetBlockIndex: 0, targetStart: 0, targetEnd: 6 },
            { sourceStart: 21, sourceEnd: 39, targetBlockIndex: 0, targetStart: 6, targetEnd: 12 },
          ];
        },
      },
    },
  });

  const card = "id:quick-translate-card-card-1";
  const secondSentence = `${card} >> id:quick-translate-result-text >> text:他走了进去。`;
  const sourceRange = "id:quick-translate-source >> text:He stepped inside.";
  const preview = "id:quick-translate-result-preview";
  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", source);
  await app.keyboard.press("enter");
  await app.waitFor(preview);
  expect(alignCalls).toHaveLength(1);

  // Collapsing and expanding restores the settled alignment without another inference.
  await app.press(`${card} >> id:quick-translate-collapse`);
  await app.waitFor(`${card} >> label:${t("quickTranslate.expandCard")}`);
  await app.press(`${card} >> id:quick-translate-collapse`);
  await app.waitFor(preview);
  await app.hover(secondSentence);
  expect(app.spanStyle(sourceRange).backgroundColor).toBeTruthy();
  expect(alignCalls).toHaveLength(1);

  // Markdown aligns its own block split once; going back reuses the first inference.
  const toggle = "id:quick-translate-header >> id:quick-translate-markdown-toggle";
  await app.press(toggle);
  await app.waitUntil(() => alignCalls.length === 2);
  await app.hover(secondSentence);
  expect(app.spanStyle(sourceRange).backgroundColor).toBeTruthy();
  await app.hover("id:quick-translate-source");
  await app.press(toggle);
  await app.hover(secondSentence);
  expect(app.spanStyle(sourceRange).backgroundColor).toBeTruthy();
  expect(alignCalls).toHaveLength(2);
  expect(app.requests()).toHaveLength(1);
});

test("alignment settings: pending enable download keeps complete translation usable without preview", async () => {
  if (!(await headlessHasAlignmentModel())) return;
  const source = "She opened the door. He stepped inside.";
  const target = "她打开了门。他走了进去。";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
    },
    network: {
      "GET https://huggingface.co/Xenova/multilingual-e5-small/*": {
        status: 503,
        body: "Unavailable",
        delay: 60_000,
      },
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: target } }] },
      },
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-quick-translate");
  await app.press("id:settings-sentence-alignment-switch");
  await app.waitFor("id:settings-alignment-download-dialog");
  await app.press("id:settings-alignment-download-confirm");
  await app.waitFor("id:settings-alignment-download-progress-bar");
  expect(app.shows("id:settings-alignment-pending-enable")).toBe(true);

  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", source);
  await app.keyboard.press("enter");
  await app.waitFor(`text:${target}`);
  expect(app.shows("id:quick-translate-result-preview")).toBe(false);
  expect(app.shows("id:result-seg-0")).toBe(false);
  await app.press("id:quick-translate-copy");
  expect(app.clipboard()).toBe(target);
  expect(app.requests().map((request) => request.method)).toEqual(["GET", "POST"]);
});

test("alignment settings: unaligned semantic result stays visible without rule fallback", async () => {
  if ((await headlessHasAlignmentModel()) !== true) return;
  const source = "Use NSH today. Second draft works.";
  const target = "今天用 NSH。第二句草稿有效。";
  let alignCalls = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      [SENTENCE_ALIGNMENT_STORAGE_KEY]: "true",
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: target } }] },
      },
    },
    modules: {
      "langnext-native": {
        "SentenceAlignmentNative.modelReady": () => true,
        "SentenceAlignmentNative.prepareSemanticModel": () => true,
        "SentenceAlignmentNative.alignSemantic": () => {
          alignCalls += 1;
          return null;
        },
      },
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", source);
  await app.keyboard.press("enter");
  await app.waitUntil(() => alignCalls === 1);
  await app.waitFor(`text:${target}`);
  expect(app.shows("id:quick-translate-result-preview")).toBe(false);
  await app.press("id:quick-translate-copy");
  expect(app.clipboard()).toBe(target);
});

test("quick window: the Markdown toggle reformats all results without retranslating", async () => {
  const heading = "Translation";
  const output = `## ${heading}\n\n**Bonjour**\n\n![Illustration](https://example.com/image.png)`;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [
          { id: "card-1", presetId: quickPreset.id },
          { id: "card-2", presetId: quickPreset.id },
        ],
      }),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: output } }] },
      },
    },
  });
  const toggle = "id:quick-translate-header >> id:quick-translate-markdown-toggle";
  const copiesOf = (text: string) => app.texts().filter((item) => item === text);

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor(toggle);
  expect(app.shows(`role:button[${t("quickTranslate.showMarkdown")}]`)).toBe(true);
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy");
  expect(copiesOf(output)).toHaveLength(2);

  await app.press(toggle);
  expect(app.shows(`role:button[${t("quickTranslate.showPlainText")}]`)).toBe(true);
  expect(copiesOf(heading)).toHaveLength(2);
  expect(copiesOf("Bonjour")).toHaveLength(2);
  expect(app.texts()).toContain("Illustration");
  expect(copiesOf(output)).toHaveLength(0);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-copy");
  expect(app.clipboard()).toBe(output);

  await app.press(toggle);
  expect(copiesOf(output)).toHaveLength(2);
  expect(app.requests()).toHaveLength(2);
});

test("quick window: the Markdown toggle persists across window close and app restart", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  const toggle = "id:quick-translate-markdown-toggle";
  const showMarkdown = `role:button[${t("quickTranslate.showMarkdown")}]`;
  const showPlainText = `role:button[${t("quickTranslate.showPlainText")}]`;
  const savedMode = (storage: Record<string, string>) =>
    JSON.parse(storage[QUICK_TRANSLATE_PREFERENCES_KEY] ?? "{}").markdownEnabled;

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor(showMarkdown);
  await app.press(toggle);
  await app.waitUntil(() => savedMode(app.storage()) === true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state()?.visible !== true);
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor(showPlainText);

  const restarted = await open(HARNESS_ENTRY, { ...viewport, storage: app.storage() });
  await restarted.press("id:harness-tray-quick-translate");
  await restarted.waitFor(showPlainText);
  await restarted.press(toggle);
  await restarted.waitFor(showMarkdown);
  await restarted.waitUntil(() => savedMode(restarted.storage()) === false);
});

test("quick window fits cards and translation content within the display work area", async () => {
  const result = Array.from({ length: 90 }, (_, i) => `Translated line ${i + 1}`).join("\n");
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences(),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: result } }] },
      },
    },
  });
  const window = app.window("quick-translate");
  const state = () => window.state()!;
  const height = () => state()?.contentBounds.size.height ?? 0;
  const firstCard = "id:quick-translate-card-card-1";
  const secondCard = "id:quick-translate-card-card-2";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor(firstCard);
  expect(app.shows("id:quick-translate-footer >> id:quick-translate-add-preset")).toBe(true);
  await app.waitUntil(() => height() > 0 && height() < 220);
  const compactHeight = height();
  const width = state().contentBounds.size.width;

  await app.press("id:quick-translate-footer >> id:quick-translate-add-preset");
  await app.press("id:quick-translate-add-preset-option-preset-1");
  await app.waitFor(secondCard);
  await app.waitUntil(() => height() > compactHeight);
  await app.press(`${secondCard} >> id:quick-translate-remove`);
  await app.waitUntil(() => Math.abs(height() - compactHeight) < 1);

  await app.type("id:quick-translate-source", "Hello");
  await app.waitUntil(() => height() > compactHeight);
  const withSourceHeight = height();
  await app.keyboard.press("enter");
  await app.waitFor(`${firstCard} >> id:quick-translate-result-text`);
  // The test driver's WindowState exposes the display ID; read its work area in the app.
  const work = app.texts().find((value) => value.startsWith("quick-work-area:"))!;
  const [, workTop, workHeight] = work.split(":").map(Number);
  await app.waitUntil(() => Math.abs(state().bounds.size.height - workHeight!) < 1);
  expect(Math.abs(state().bounds.origin.y - workTop!)).toBeLessThan(1);
  expect(state().contentBounds.size.width).toBe(width);

  await app.press(`${firstCard} >> id:quick-translate-collapse`);
  await app.waitUntil(() => Math.abs(height() - withSourceHeight) < 1);
  await app.press(`${firstCard} >> id:quick-translate-collapse`);
  await app.waitUntil(() => Math.abs(state().bounds.size.height - workHeight!) < 1);
  expect(state().contentBounds.size.width).toBe(width);

  await app.press("id:quick-translate-clear");
  await app.press(`${firstCard} >> id:quick-translate-remove`);
  await app.waitUntil(() => height() < compactHeight - 20);
  expect(height()).toBeGreaterThanOrEqual(POPUP_MIN_SIZE.height);
});

test("quick window: closes on unpinned blur, survives blur when pinned, resets pin on close, and closes via button/escape/OS close without quitting app", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  // Unpinned blur closes Quick Translate and does not quit the app.
  await app.press("id:harness-tray-quick-translate");
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);
  await app.press("id:nav-settings");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.shows("id:settings-page")).toBe(true);
  expect(app.window("main").state()?.visible).toBe(true);

  // Pinning keeps it open across blur, while close button closes it and resets pin.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "Unfinished draft");
  await app.press("id:quick-translate-pin");
  await app.press("id:nav-models");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.shows("id:models-page")).toBe(true);

  await app.press("id:quick-translate-close");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);

  // Reopen restores the draft but not the pin.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(hasQuickSource(app, "Unfinished draft")).toBe(true);
  await app.press("id:nav-settings");
  await app.waitUntil(() => app.window("quick-translate").state() === null);

  // Escape closes even when pinned.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.press("id:quick-translate-pin");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);

  // OS close closes even when pinned without quitting the app.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.press("id:quick-translate-pin");
  await app.window("quick-translate").pressClose();
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);
});

test("desktop: quick window pins, survives focus switch, resets pin on close, and closes via Escape and close button without quitting app", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.press("id:quick-translate-pin");
  await app.press("id:nav-models");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.shows("id:models-page")).toBe(true);

  await app.press("id:quick-translate-close");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.press("id:quick-translate-pin");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);
});

test("desktop: quick window Language menu overlay does not trigger blur dismissal and Escape dismisses menu before closing window", async () => {
  const seeded = makeSeedStorage({
    channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
    models: [makeModel({ enabled: true })],
    credentials: { "ch-1": "sk-test" },
  });
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...seeded,
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences(),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "こんにちは" } }] },
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source-language");
  await app.press("id:quick-translate-source-language");
  await app.waitFor("role:option[English]");
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Escape closes the language Select dropdown without closing the window.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("role:option[English]"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Pick a target language from the header bar and translate by pressing Enter.
  await app.press("id:quick-translate-target-language");
  await app.waitFor("role:option[German]");
  await app.press("role:option[German]");
  await app.waitUntil(() => !app.shows("role:option[German]"));
  expect(app.shows("id:quick-translate-source-language >> text:English")).toBe(true);
  expect(app.shows("id:quick-translate-target-language >> text:German")).toBe(true);

  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(app.texts()).toContain("こんにちは");

  // Reopen Add preset menu in the footer and confirm Escape closes it without blur dismissal.
  await app.press("id:quick-translate-footer >> id:quick-translate-add-preset");
  await app.waitFor("id:quick-translate-add-preset-option-preset-1");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-add-preset-option-preset-1"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Reopen language Select and confirm Escape dismisses dropdown, then Escape closes window.
  await app.press("id:quick-translate-source-language");
  await app.waitFor("role:option[English]");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("role:option[English]"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
});

test("desktop: quick window remains available while main window is hidden and registers the Windows shortcuts once across locale changes", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.waitUntil(() =>
    app
      .texts()
      .some((text) =>
        text.includes(
          `shortcuts=${DEFAULT_QUICK_TRANSLATE_SHORTCUT},${DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT},${DEFAULT_SELECTION_TRANSLATE_SHORTCUT}|tray=Quick Translate,Screenshot Translate,Exit`,
        ),
      ),
  );
  expect(app.texts().join(" ")).toContain("|reg=3|");

  await app.press("id:nav-settings");
  await app.press("id:language-zh-CN");
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes("tray=快速翻译,截图翻译,退出")),
  );
  expect(app.texts().join(" ")).toContain("|reg=3|");

  await app.press("id:harness-hide-main-tray-flow");
  await app.waitUntil(
    () =>
      app.window("main").state()?.visible === false &&
      app.window("quick-translate").state()?.visible === true,
  );

  await app.wait(40);
  await app.press("id:quick-translate-close");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  await app.waitUntil(() => app.window("main").state()?.visible === true);

  await app.window("main").pressClose();
  await app.waitUntil(() => app.window("main").state()?.visible === false);
});

const SHORTCUT_RECORD = "id:settings-quick-translate-shortcut-record";
const SHORTCUT_CLEAR = "id:settings-quick-translate-shortcut-clear";
const SHORTCUT_RESET = "id:settings-quick-translate-shortcut-reset";
const SHORTCUT_ERROR = "id:settings-quick-translate-shortcut-error";
const UNASSIGNED = "id:settings-quick-translate-shortcut-unassigned";
const CUSTOM_SHORTCUT = "ctrl+shift+y";

test("shortcut settings: restores custom bindings, persists removal, and resets to the default", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en", [QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]: CUSTOM_SHORTCUT },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.waitUntil(() => app.enabled(SHORTCUT_CLEAR));
  expect(app.texts()).toContain("Ctrl+Shift+Y");
  expect(app.shows(SHORTCUT_RESET)).toBe(true);

  await app.keyboard.press(CUSTOM_SHORTCUT);
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.window("quick-translate").state());

  await app.press(SHORTCUT_CLEAR);
  await app.waitFor(UNASSIGNED);
  expect(app.shows(SHORTCUT_CLEAR)).toBe(false);
  expect(app.shows(SHORTCUT_RESET)).toBe(true);
  expect(app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("");
  await app.keyboard.press(CUSTOM_SHORTCUT);
  expect(app.window("quick-translate").state()).toBeNull();

  const reopened = await open(HARNESS_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-shortcuts");
  await reopened.waitFor(UNASSIGNED);
  await reopened.waitUntil(() =>
    reopened
      .texts()
      .some((text) =>
        text.includes(
          `shortcuts=${DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT},${DEFAULT_SELECTION_TRANSLATE_SHORTCUT}|`,
        ),
      ),
  );
  expect(reopened.texts().join(" ")).toContain("|reg=2|");
  await reopened.press(SHORTCUT_RESET);
  await reopened.waitUntil(() => reopened.texts().includes("Alt+Shift+D"));
  expect(reopened.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe(
    DEFAULT_QUICK_TRANSLATE_SHORTCUT,
  );
  expect(reopened.shows(SHORTCUT_RESET)).toBe(false);
  await reopened.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await reopened.waitUntil(() => reopened.window("quick-translate").state()?.visible === true);
});

test("shortcut settings: keeps the old binding if reset cannot register or removal cannot save", async () => {
  for (const conflict of [true, false]) {
    const app = await open(HARNESS_ENTRY, {
      ...viewport,
      storage: {
        "settings.language": "en",
        [HARNESS_SHORTCUT_MODE_KEY]: conflict ? "conflict" : "ok",
        [QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]: CUSTOM_SHORTCUT,
      },
      modules: conflict
        ? undefined
        : {
            nsh: {
              "Storage.setItem": async (key: string) => {
                if (key === QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY) throw new Error("Write failed");
              },
            },
          },
    });
    await app.press("id:nav-settings");
    await app.press("id:settings-nav-shortcuts");
    await app.waitUntil(() => app.enabled(SHORTCUT_RECORD));
    await app.press(conflict ? SHORTCUT_RESET : SHORTCUT_CLEAR);
    await app.waitFor(SHORTCUT_ERROR);
    expect(app.texts()).toContain(
      conflict
        ? "This shortcut is unavailable. Try another combination."
        : "Could not save the shortcut. Check storage and try again.",
    );
    expect(app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe(CUSTOM_SHORTCUT);
    expect(app.texts()).toContain("Ctrl+Shift+Y");
    await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
    expect(app.window("quick-translate").state()).toBeNull();
    await app.keyboard.press(CUSTOM_SHORTCUT);
    await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);
  }
});

test("shortcut settings: the new screenshot default does not take over an existing binding", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]: DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT,
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  const screenshot = "id:settings-screenshot-translate-shortcut";
  await app.waitFor(`${screenshot}-error`);
  expect(app.texts().join(" ")).toContain("|reg=2|unreg=0|");

  await app.press(`${screenshot}-clear`);
  await app.waitFor(`${screenshot}-unassigned`);
  await app.press(`${screenshot}-reset`);
  await app.waitFor(`${screenshot}-error`);
  expect(app.storage()[SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("");
  await app.keyboard.press(DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT);
  await app.waitFor("id:quick-translate-source");
  expect(app.texts().join(" ")).toContain("ocrCap=0|");
});

test("selection shortcut: an existing action keeps Alt+D and the selection row stays inactive", async () => {
  const owners = [
    {
      key: QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY,
      effect: "source",
    },
    {
      key: SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY,
      effect: "ocr",
    },
  ] as const;
  for (const owner of owners) {
    const app = await open(HARNESS_ENTRY, {
      ...viewport,
      storage: {
        "settings.language": "en",
        [owner.key]: DEFAULT_SELECTION_TRANSLATE_SHORTCUT,
      },
    });
    await app.press("id:nav-settings");
    await app.press("id:settings-nav-shortcuts");
    await app.waitFor("id:settings-selection-translate-shortcut-error");
    expect(app.texts()).toContain("This shortcut is inactive. Record another combination.");
    expect(app.texts()).toContain("Alt+D");
    expect(app.shows("id:settings-selection-translate-shortcut-error")).toBe(true);

    await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
    if (owner.effect === "source") {
      await app.waitFor("id:quick-translate-source");
    } else {
      await app.waitFor("id:quick-translate-ocr-status");
    }
    expect(app.texts().join(" ")).toContain("selReads=0|");
  }
});

test("selection shortcut: a refused replacement keeps the previous binding", async () => {
  const previous = DEFAULT_SELECTION_TRANSLATE_SHORTCUT;
  // Headless Windows does not deliver a raw key to the focused recorder. Linux does,
  // while the harness still registers the Windows shortcuts.
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    platform: "linux",
    storage: {
      "settings.language": "en",
      [HARNESS_PLATFORM_OS_KEY]: "windows",
      [HARNESS_SHORTCUT_MODE_KEY]: "conflict",
      [SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY]: previous,
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  const selection = "id:settings-selection-translate-shortcut";
  await app.waitUntil(() => app.enabled(`${selection}-record`));
  await app.press(`${selection}-record`);
  await app.keyboard.press(CUSTOM_SHORTCUT);
  await app.waitFor(`${selection}-error`);
  expect(app.texts()).toContain("This shortcut is unavailable. Try another combination.");
  expect(app.storage()[SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe(previous);
  expect(app.texts()).toContain("Alt+D");

  await app.keyboard.press(previous);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  expect(app.window("quick-translate").state()).toBeNull();
});

test("desktop: quick window unregisters the global shortcuts on shell disposal", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.waitUntil(() => app.texts().some((text) => text.includes("|reg=3|")));
  await app.press("id:harness-dispose-shell");
  await app.waitUntil(() => app.texts().some((text) => text.includes("|unreg=3|")));
});

test("desktop: quick window warns and keeps tray fallback when global shortcut returns false or rejects, and skips non-Windows", async () => {
  const denied = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [HARNESS_SHORTCUT_MODE_KEY]: "false",
    },
  });
  await denied.waitUntil(() =>
    denied.texts().includes(
      t("quickTranslate.shortcutUnavailable", {
        shortcut: formatShortcut(DEFAULT_QUICK_TRANSLATE_SHORTCUT),
      }),
    ),
  );
  await denied.press("id:harness-tray-quick-translate");
  await denied.waitUntil(() => denied.window("quick-translate").state()?.visible === true);

  const rejected = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "zh-CN",
      [HARNESS_SHORTCUT_MODE_KEY]: "reject",
    },
  });
  await rejected.waitUntil(() =>
    rejected.texts().includes("全局快捷键 Alt+Shift+D 不可用，请通过托盘菜单打开快速翻译。"),
  );
  await rejected.press("id:harness-tray-quick-translate");
  await rejected.waitUntil(() => rejected.window("quick-translate").state()?.visible === true);

  const nonWindows = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [HARNESS_PLATFORM_OS_KEY]: "macos",
    },
  });
  await nonWindows.waitFor("id:harness-metrics");
  expect(nonWindows.texts().join(" ")).toContain("reg=0|");
  // Screen selection is Windows-only, so the tray offers no Screenshot Translate item.
  expect(nonWindows.texts().join(" ")).toContain("tray=Quick Translate,Exit");
});

test("quick placement: window controller corrects shifted initial bounds once and never moves after user drag", async () => {
  const setBoundsCalls: Array<{
    origin?: { x?: number; y?: number };
    size?: { width?: number; height?: number };
  }> = [];
  const fakeWindow: Pick<WindowRef, "focus" | "setBounds" | "state"> = {
    focus: () => {},
    setBounds: (bounds) => {
      setBoundsCalls.push(bounds);
    },
    state: () => null,
  };

  const controller = createQuickTranslateController({
    readCursorAnchor: () => ({ displayId: "disp-1", offsetX: 600, offsetY: 400 }),
    getDisplays: () => [
      {
        id: "disp-1",
        bounds: { origin: { x: 0, y: 0 }, size: { width: 1280, height: 800 } },
        visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 1280, height: 760 } },
        primary: true,
        name: "Primary",
        scaleFactor: 1,
        cutouts: [],
      },
    ],
  });

  controller.open();
  expect(controller.openingDisplay()).toBe("disp-1");
  expect(controller.openingPosition()).toEqual({ x: 590, y: 390 });
  expect(controller.openingSize()).toEqual({ width: 420, height: 360 });
  controller.attachWindow(fakeWindow as WindowRef);

  const shiftedState: WindowState = {
    mode: "normal",
    minimized: false,
    visible: true,
    focused: true,
    bounds: { origin: { x: 100, y: 100 }, size: { width: 420, height: 360 } },
    contentBounds: { origin: { x: 100, y: 100 }, size: { width: 420, height: 360 } },
    placement: { bounds: { origin: { x: 100, y: 100 }, size: { width: 420, height: 360 } } },
    display: null,
    scaleFactor: 1,
  };
  controller.verifyInitialBounds(shiftedState);
  expect(setBoundsCalls).toEqual([{ origin: { x: 590, y: 390 } }]);

  // Echo from our own setBounds clears expectation, and a subsequent user move disables repositioning.
  controller.handleBoundsChange({ origin: { x: 590, y: 390 }, size: { width: 420, height: 360 } });
  controller.handleBoundsChange({ origin: { x: 510, y: 220 }, size: { width: 420, height: 360 } });
  controller.open();
  controller.verifyInitialBounds(shiftedState);
  expect(setBoundsCalls).toHaveLength(1);
});

test("quick height fit: retries once when a drag move overwrites the pending height fit", () => {
  const display = {
    id: "disp-1",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1392 } },
    primary: true,
    name: "Primary",
    scaleFactor: 1.5,
    cutouts: [],
  };
  const setBoundsCalls: Array<{
    origin?: { x?: number; y?: number };
    size?: { width?: number; height?: number };
  }> = [];
  const makeState = (x: number, y: number, width: number, height: number): WindowState => ({
    mode: "normal",
    minimized: false,
    visible: true,
    focused: true,
    bounds: { origin: { x, y }, size: { width, height } },
    contentBounds: { origin: { x, y }, size: { width, height } },
    placement: { bounds: { origin: { x, y }, size: { width, height } } },
    display,
    scaleFactor: 1.5,
  });
  let currentState = makeState(1007.33, 799.33, 420, 346);
  const fakeWindow: Pick<WindowRef, "focus" | "setBounds" | "state"> = {
    focus: () => {},
    setBounds: (bounds) => {
      setBoundsCalls.push(bounds);
    },
    state: () => currentState,
  };

  const controller = createQuickTranslateController({
    readCursorAnchor: () => ({ displayId: "disp-1", offsetX: 1600, offsetY: 1200 }),
    getDisplays: () => [display],
  });
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);

  controller.fitContentHeight(fakeWindow as WindowRef, 494, 2);
  expect(setBoundsCalls).toEqual([{ size: { height: 494 } }]);

  // Drag finishes with new origin and clobbered pre-fit height -> triggers retry.
  currentState = makeState(988.67, 748, 420, 346);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toEqual([{ size: { height: 494 } }, { size: { height: 494 } }]);

  // Retry lands -> clears pending fit; subsequent user drag does not re-fit.
  currentState = makeState(988.67, 748, 420, 494);
  controller.handleBoundsChange(currentState.bounds);
  currentState = makeState(1484.67, 828.67, 420, 494);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toHaveLength(2);
});

test("quick height fit: retry clamps y into work area after dragging near bottom", () => {
  const display = {
    id: "disp-1",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1392 } },
    primary: true,
    name: "Primary",
    scaleFactor: 1.5,
    cutouts: [],
  };
  const setBoundsCalls: Array<{
    origin?: { x?: number; y?: number };
    size?: { width?: number; height?: number };
  }> = [];
  const makeState = (x: number, y: number, width: number, height: number): WindowState => ({
    mode: "normal",
    minimized: false,
    visible: true,
    focused: true,
    bounds: { origin: { x, y }, size: { width, height } },
    contentBounds: { origin: { x, y }, size: { width, height } },
    placement: { bounds: { origin: { x, y }, size: { width, height } } },
    display,
    scaleFactor: 1.5,
  });
  let currentState = makeState(1007.33, 799.33, 420, 346);
  const fakeWindow: Pick<WindowRef, "focus" | "setBounds" | "state"> = {
    focus: () => {},
    setBounds: (bounds) => {
      setBoundsCalls.push(bounds);
    },
    state: () => currentState,
  };

  const controller = createQuickTranslateController({
    getDisplays: () => [display],
  });
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);

  controller.fitContentHeight(fakeWindow as WindowRef, 494, 2);
  expect(setBoundsCalls).toEqual([{ size: { height: 494 } }]);

  currentState = makeState(988.67, 1000, 420, 346);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toEqual([
    { size: { height: 494 } },
    { size: { height: 494 }, origin: { y: 898 } },
  ]);
});

test("quick height fit: manual user resize does not trigger retry", () => {
  const display = {
    id: "disp-1",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1392 } },
    primary: true,
    name: "Primary",
    scaleFactor: 1.5,
    cutouts: [],
  };
  const setBoundsCalls: Array<{
    origin?: { x?: number; y?: number };
    size?: { width?: number; height?: number };
  }> = [];
  const makeState = (x: number, y: number, width: number, height: number): WindowState => ({
    mode: "normal",
    minimized: false,
    visible: true,
    focused: true,
    bounds: { origin: { x, y }, size: { width, height } },
    contentBounds: { origin: { x, y }, size: { width, height } },
    placement: { bounds: { origin: { x, y }, size: { width, height } } },
    display,
    scaleFactor: 1.5,
  });
  let currentState = makeState(1007.33, 799.33, 420, 346);
  const fakeWindow: Pick<WindowRef, "focus" | "setBounds" | "state"> = {
    focus: () => {},
    setBounds: (bounds) => {
      setBoundsCalls.push(bounds);
    },
    state: () => currentState,
  };

  const controller = createQuickTranslateController({
    getDisplays: () => [display],
  });

  // Case 1: user manually resized height.
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);
  controller.fitContentHeight(fakeWindow as WindowRef, 494, 2);
  currentState = makeState(1007.33, 799.33, 420, 380);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toHaveLength(1);

  // Case 2: user manually resized width.
  controller.close();
  currentState = makeState(1007.33, 799.33, 420, 346);
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);
  controller.fitContentHeight(fakeWindow as WindowRef, 494, 3);
  currentState = makeState(988.67, 748, 460, 346);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toHaveLength(2);
});

test("quick height fit: caps retries and clears pending fit on close", () => {
  const display = {
    id: "disp-1",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 2560, height: 1392 } },
    primary: true,
    name: "Primary",
    scaleFactor: 1.5,
    cutouts: [],
  };
  const setBoundsCalls: Array<{
    origin?: { x?: number; y?: number };
    size?: { width?: number; height?: number };
  }> = [];
  const makeState = (x: number, y: number, width: number, height: number): WindowState => ({
    mode: "normal",
    minimized: false,
    visible: true,
    focused: true,
    bounds: { origin: { x, y }, size: { width, height } },
    contentBounds: { origin: { x, y }, size: { width, height } },
    placement: { bounds: { origin: { x, y }, size: { width, height } } },
    display,
    scaleFactor: 1.5,
  });
  let currentState = makeState(1007.33, 799.33, 420, 346);
  const fakeWindow: Pick<WindowRef, "focus" | "setBounds" | "state"> = {
    focus: () => {},
    setBounds: (bounds) => {
      setBoundsCalls.push(bounds);
    },
    state: () => currentState,
  };

  const controller = createQuickTranslateController({
    getDisplays: () => [display],
  });

  // Repeated move-only bounds changes stop retrying after MAX_HEIGHT_FIT_RETRIES (2).
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);
  controller.fitContentHeight(fakeWindow as WindowRef, 494, 2);
  currentState = makeState(988.67, 748, 420, 346);
  controller.handleBoundsChange(currentState.bounds);
  currentState = makeState(1020, 760, 420, 346);
  controller.handleBoundsChange(currentState.bounds);
  currentState = makeState(1050, 780, 420, 346);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toHaveLength(3);

  // Close clears pending fit so a late bounds change does not retry.
  currentState = makeState(1007.33, 799.33, 420, 346);
  controller.close();
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);
  controller.fitContentHeight(fakeWindow as WindowRef, 494, 3);
  expect(setBoundsCalls).toHaveLength(4);
  controller.close();
  currentState = makeState(988.67, 748, 420, 346);
  controller.handleBoundsChange(currentState.bounds);
  expect(setBoundsCalls).toHaveLength(4);
});

test("quick overlays: reporting a popover change does not subscribe to the overlay registry", () => {
  const controller = createQuickTranslateController();
  const popoverOpen = signal(false);
  const reports: boolean[] = [];
  effect(() => {
    const open = popoverOpen();
    reports.push(open);
    controller.setMenuOpen("sentence-popover", open);
  });

  popoverOpen.set(true);
  expect(controller.hasOpenOverlay()).toBe(true);
  controller.setMenuOpen("history", true);
  popoverOpen.set(false);
  expect(controller.hasOpenOverlay()).toBe(true);
  controller.setMenuOpen("history", false);
  expect(controller.hasOpenOverlay()).toBe(false);
  expect(reports).toEqual([false, true, false]);
});

test("quick press: an outside pointer press closes the unpinned popup, while inside presses, other displays and pinned popups keep it", async () => {
  const display = {
    id: "disp-1",
    bounds: { origin: { x: 0, y: 0 }, size: { width: 1280, height: 800 } },
    visibleBounds: { origin: { x: 0, y: 0 }, size: { width: 1280, height: 760 } },
    primary: true,
    name: "Primary",
    scaleFactor: 2,
    cutouts: [],
  };
  // The popup sits at (400, 300) pt, 420 x 360 pt, on a 2x display.
  const popupBounds = { origin: { x: 400, y: 300 }, size: { width: 420, height: 360 } };
  const popupState: WindowState = {
    mode: "normal",
    minimized: false,
    visible: true,
    focused: false,
    bounds: popupBounds,
    contentBounds: popupBounds,
    placement: { bounds: popupBounds },
    display,
    scaleFactor: 2,
  };
  const fakeWindow: Pick<WindowRef, "focus" | "setBounds" | "state"> = {
    focus: () => {},
    setBounds: () => {},
    state: () => popupState,
  };

  let pressListener:
    | ((press: { displayId: string; offsetX: number; offsetY: number }) => void)
    | null = null;
  let monitorStarts = 0;
  let monitorStops = 0;
  const controller = createQuickTranslateController({
    getDisplays: () => [display],
    onPointerPress: (listener) => {
      monitorStarts += 1;
      pressListener = listener;
      return () => {
        monitorStops += 1;
        if (pressListener === listener) {
          pressListener = null;
        }
      };
    },
  });

  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);
  // Opening twice keeps one monitor.
  controller.open();
  expect(monitorStarts).toBe(1);

  // Inside the popup: 500 pt of 2x display = 1000 px.
  pressListener!({ displayId: "disp-1", offsetX: 1000, offsetY: 800 });
  expect(controller.isOpen()).toBe(true);
  // A press the displays cannot locate is ignored.
  pressListener!({ displayId: "missing", offsetX: 200, offsetY: 200 });
  expect(controller.isOpen()).toBe(true);
  // Above and left of the popup closes it, and the monitor goes with it.
  pressListener!({ displayId: "disp-1", offsetX: 200, offsetY: 200 });
  expect(controller.isOpen()).toBe(false);
  expect(monitorStops).toBe(1);
  expect(pressListener).toBeNull();

  // A pinned popup ignores outside presses until it closes.
  controller.open();
  controller.attachWindow(fakeWindow as WindowRef);
  controller.togglePinned();
  expect(monitorStarts).toBe(2);
  pressListener!({ displayId: "disp-1", offsetX: 200, offsetY: 200 });
  expect(controller.isOpen()).toBe(true);
  controller.close();
  expect(monitorStops).toBe(2);
});

test("desktop: quick window monitors global presses only while it is open", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  const metrics = () => app.texts().join(" ");

  await app.waitFor("id:harness-metrics");
  expect(metrics()).toContain("ppReg=0|ppStop=0|");

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.waitUntil(() => metrics().includes("ppReg=1|"));

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  await app.waitUntil(() => metrics().includes("ppStop=1|"));
});

test("double copy: controller reads clipboard once, skips when disabled or empty, and drops slow reads superseded by close, newer activation, or manual edit", async () => {
  let doubleCopyActive = false;
  let readCalls = 0;
  const pendingReads: Array<{ resolve: (text: string) => void; reject: (err: Error) => void }> = [];

  const controller = createQuickTranslateController({
    isDoubleCopyActive: () => doubleCopyActive,
    readClipboardText: () => {
      readCalls += 1;
      return new Promise<string>((resolve, reject) => {
        pendingReads.push({ resolve, reject });
      });
    },
  });

  // 1. Disabled -> ignores activation completely with zero clipboard reads.
  await controller.activateDoubleCopy({ hasValidCopy: true });
  expect(controller.isOpen()).toBe(false);
  expect(readCalls).toBe(0);

  // 2. Enabled + hasValidCopy: false -> opens popup, keeps existing draft, performs zero reads.
  doubleCopyActive = true;
  controller.open();
  controller.setSourceText("Keep draft");
  await controller.activateDoubleCopy({ hasValidCopy: false });
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("Keep draft");
  expect(readCalls).toBe(0);

  // 3. Enabled + hasValidCopy: true -> performs one read and keeps empty/whitespace from overwriting draft.
  const emptyPromise = controller.activateDoubleCopy({ hasValidCopy: true });
  expect(readCalls).toBe(1);
  pendingReads.shift()!.resolve("   ");
  await emptyPromise;
  expect(controller.sourceText()).toBe("Keep draft");
  expect(controller.sourceDelivery()).toBeNull();

  // 4. Slow read superseded by close -> never reopens or replaces source.
  const closedPromise = controller.activateDoubleCopy({ hasValidCopy: true });
  expect(readCalls).toBe(2);
  controller.close();
  expect(controller.isOpen()).toBe(false);
  pendingReads.shift()!.resolve("Stale closed text");
  await closedPromise;
  expect(controller.isOpen()).toBe(false);
  expect(controller.sourceText()).toBe("Keep draft");

  // 5. Slow read superseded by newer activation -> older read never overwrites newer delivery.
  const slowFirst = controller.activateDoubleCopy({ hasValidCopy: true });
  expect(controller.isOpen()).toBe(true);
  const fastSecond = controller.activateDoubleCopy({ hasValidCopy: true });
  expect(readCalls).toBe(4);
  const firstPending = pendingReads.shift()!;
  const secondPending = pendingReads.shift()!;
  secondPending.resolve("Fresh second text");
  await fastSecond;
  expect(controller.sourceText()).toBe("Fresh second text");
  expect(controller.sourceDelivery()?.seq).toBe(1);
  expect(controller.sourceDelivery()?.kind).toBe("clipboard");
  firstPending.resolve("Stale first text");
  await slowFirst;
  expect(controller.sourceText()).toBe("Fresh second text");
  expect(controller.sourceDelivery()?.seq).toBe(1);
  expect(controller.sourceDelivery()?.kind).toBe("clipboard");

  // 6. Slow read superseded by manual edit -> preserves manual draft.
  const manualRace = controller.activateDoubleCopy({ hasValidCopy: true });
  expect(readCalls).toBe(5);
  controller.setSourceText("Manual override");
  pendingReads.shift()!.resolve("Late clipboard text");
  await manualRace;
  expect(controller.sourceText()).toBe("Manual override");
  expect(controller.sourceDelivery()?.seq).toBe(1);
  expect(controller.sourceDelivery()?.kind).toBe("clipboard");
});

test("selection controller: close while reading does not reopen a closed popup", async () => {
  const pendingReads: Array<{
    resolve: (result: { status: "selected"; text: string }) => void;
  }> = [];
  const controller = createQuickTranslateController({
    selectionText: {
      snapshot: () => "target-1",
      isCurrent: () => true,
      read: () =>
        new Promise((resolve) => {
          pendingReads.push({ resolve });
        }),
    },
  });

  const activation = controller.activateSelectionTranslate();
  expect(pendingReads).toHaveLength(1);
  expect(controller.isOpen()).toBe(false);
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();

  controller.close();
  pendingReads[0]!.resolve({ status: "selected", text: "Late selection" });
  await activation;

  expect(controller.isOpen()).toBe(false);
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();
});

test("selection controller: a changed draft or target drops the delayed read", async () => {
  const pendingReads: Array<{
    resolve: (result: { status: "selected"; text: string }) => void;
  }> = [];
  let currentTarget = "target-1";
  let clipboard = "Copied phrase";
  const controller = createQuickTranslateController({
    isDoubleCopyActive: () => true,
    readClipboardText: async () => clipboard,
    selectionText: {
      snapshot: () => currentTarget,
      isCurrent: (target) => target === currentTarget,
      read: () =>
        new Promise((resolve) => {
          pendingReads.push({ resolve });
        }),
    },
  });

  const edited = controller.activateSelectionTranslate();
  controller.setSourceText("Manual edit");
  pendingReads.shift()!.resolve({ status: "selected", text: "Late selection" });
  await edited;
  expect(controller.isOpen()).toBe(false);
  expect(controller.sourceText()).toBe("Manual edit");
  expect(controller.sourceDelivery()).toBeNull();

  controller.open();
  const cleared = controller.activateSelectionTranslate();
  controller.setSourceText("");
  pendingReads.shift()!.resolve({ status: "selected", text: "After clear" });
  await cleared;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();

  const replaced = controller.activateSelectionTranslate();
  await controller.activateDoubleCopy({ hasValidCopy: true });
  pendingReads.shift()!.resolve({ status: "selected", text: "After copy" });
  await replaced;
  expect(controller.sourceText()).toBe("Copied phrase");
  expect(controller.sourceDelivery()?.kind).toBe("clipboard");
  expect(controller.sourceDelivery()?.seq).toBe(1);

  currentTarget = "target-2";
  const stale = controller.activateSelectionTranslate();
  currentTarget = "target-3";
  pendingReads.shift()!.resolve({ status: "selected", text: "Stale target" });
  await stale;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("Copied phrase");
  expect(controller.sourceDelivery()?.seq).toBe(1);
});

test("selection controller: a native stale result never opens or focuses the popup", async () => {
  let focuses = 0;
  const controller = createQuickTranslateController({
    selectionText: {
      snapshot: () => "same-window-and-control",
      isCurrent: () => true,
      // The focused UI Automation element changed inside the same native control.
      read: async () => ({ status: "stale" }),
    },
  });
  controller.setSourceText("Keep draft");

  await controller.activateSelectionTranslate();
  const openedWhileClosed = controller.isOpen();

  if (!openedWhileClosed) controller.open();
  controller.attachWindow({
    focus() {
      focuses += 1;
    },
  } as WindowRef);
  await controller.activateSelectionTranslate();

  expect({ openedWhileClosed, focuses }).toEqual({ openedWhileClosed: false, focuses: 0 });
  expect(controller.sourceText()).toBe("Keep draft");
  expect(controller.sourceDelivery()).toBeNull();
});

test("selection controller: only the latest current read delivers", async () => {
  const pendingSelections: Array<{
    target: string;
    resolve: (result: { status: "selected"; text: string }) => void;
  }> = [];
  const pendingCopies: Array<{ resolve: (text: string) => void }> = [];
  let currentTarget = "idle";
  const controller = createQuickTranslateController({
    isDoubleCopyActive: () => true,
    readClipboardText: () =>
      new Promise((resolve) => {
        pendingCopies.push({ resolve });
      }),
    selectionText: {
      snapshot: () => currentTarget,
      isCurrent: (target) => target === currentTarget,
      read: (target) =>
        new Promise((resolve) => {
          pendingSelections.push({ target, resolve });
        }),
    },
  });

  currentTarget = "t1";
  const first = controller.activateSelectionTranslate();
  currentTarget = "t2";
  const second = controller.activateSelectionTranslate();
  currentTarget = "t3";
  const third = controller.activateSelectionTranslate();
  expect(pendingSelections.map((read) => read.target)).toEqual(["t1"]);

  await second;
  expect(controller.sourceDelivery()).toBeNull();
  pendingSelections.shift()!.resolve({ status: "selected", text: "First" });
  await first;
  expect(pendingSelections.map((read) => read.target)).toEqual(["t3"]);
  expect(controller.sourceText()).toBe("");

  pendingSelections.shift()!.resolve({ status: "selected", text: "Third" });
  await third;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("Third");
  expect(controller.sourceDelivery()?.kind).toBe("selection");
  expect(controller.sourceDelivery()?.seq).toBe(1);

  currentTarget = "q1";
  const running = controller.activateSelectionTranslate();
  currentTarget = "q2";
  const queued = controller.activateSelectionTranslate();
  currentTarget = "q3";
  pendingSelections.shift()!.resolve({ status: "selected", text: "Queued gone" });
  await running;
  await queued;
  expect(pendingSelections).toHaveLength(0);
  expect(controller.sourceText()).toBe("Third");
  expect(controller.sourceDelivery()?.seq).toBe(1);

  currentTarget = "c1";
  const closing = controller.activateSelectionTranslate();
  currentTarget = "c2";
  const cancelled = controller.activateSelectionTranslate();
  controller.close();
  pendingSelections.shift()!.resolve({ status: "selected", text: "Closed" });
  await closing;
  await cancelled;
  expect(pendingSelections).toHaveLength(0);
  expect(controller.isOpen()).toBe(false);
  expect(controller.sourceText()).toBe("Third");
  expect(controller.sourceDelivery()).toBeNull();

  currentTarget = "s1";
  const oldSelection = controller.activateSelectionTranslate();
  const newerCopy = controller.activateDoubleCopy({ hasValidCopy: true });
  pendingSelections.shift()!.resolve({ status: "selected", text: "Old selection" });
  await oldSelection;
  pendingCopies.shift()!.resolve("Newer copy");
  await newerCopy;
  expect(controller.sourceText()).toBe("Newer copy");
  expect(controller.sourceDelivery()?.kind).toBe("clipboard");

  const oldCopy = controller.activateDoubleCopy({ hasValidCopy: true });
  currentTarget = "s2";
  const newerSelection = controller.activateSelectionTranslate();
  pendingSelections.shift()!.resolve({ status: "selected", text: "Newer selection" });
  await newerSelection;
  pendingCopies.shift()!.resolve("Old copy");
  await oldCopy;
  expect(controller.sourceText()).toBe("Newer selection");
  expect(controller.sourceDelivery()?.kind).toBe("selection");
  expect(controller.sourceDelivery()?.seq).toBe(3);
});

test("selection controller: an empty or failed read opens without changing the draft", async () => {
  const pendingReads: Array<{
    resolve: (
      result:
        | { status: "selected"; text: string }
        | { status: "noSelection" }
        | { status: "unavailable" },
    ) => void;
  }> = [];
  let rejectRead = false;
  let currentTarget = "target";
  let focuses = 0;
  const controller = createQuickTranslateController({
    selectionText: {
      snapshot: () => currentTarget,
      isCurrent: (target) => target === currentTarget,
      read: () => {
        if (rejectRead) return Promise.reject(new Error("port down"));
        return new Promise((resolve) => {
          pendingReads.push({ resolve });
        });
      },
    },
  });

  const closed = controller.activateSelectionTranslate();
  pendingReads.shift()!.resolve({ status: "noSelection" });
  await closed;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();

  controller.close();
  const unavailable = controller.activateSelectionTranslate();
  pendingReads.shift()!.resolve({ status: "unavailable" });
  await unavailable;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();

  controller.close();
  const blank = controller.activateSelectionTranslate();
  pendingReads.shift()!.resolve({ status: "selected", text: "  \n" });
  await blank;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();

  controller.close();
  rejectRead = true;
  await controller.activateSelectionTranslate();
  rejectRead = false;
  expect(controller.isOpen()).toBe(true);
  expect(controller.sourceDelivery()).toBeNull();

  const delivered = controller.activateSelectionTranslate();
  pendingReads.shift()!.resolve({ status: "selected", text: "Keep draft" });
  await delivered;
  controller.setPinned(true);
  controller.attachWindow({
    focus() {
      focuses += 1;
    },
  } as WindowRef);
  const failed = controller.activateSelectionTranslate();
  pendingReads.shift()!.resolve({ status: "noSelection" });
  await failed;
  expect(controller.isOpen()).toBe(true);
  expect(controller.isPinned()).toBe(true);
  expect(controller.sourceText()).toBe("Keep draft");
  expect(controller.sourceDelivery()?.seq).toBe(1);
  expect(focuses).toBe(1);

  controller.close();
  currentTarget = "gone";
  const stale = controller.activateSelectionTranslate();
  currentTarget = "elsewhere";
  pendingReads.shift()!.resolve({ status: "noSelection" });
  await stale;
  expect(controller.isOpen()).toBe(false);
  expect(controller.sourceText()).toBe("Keep draft");
  expect(controller.sourceDelivery()).toBeNull();
});

test("selection controller: OCR overlay ignores a shortcut and drops a pending read", async () => {
  const pendingReads: Array<{
    resolve: (result: { status: "selected"; text: string }) => void;
  }> = [];
  const selectionText = {
    snapshot: () => "target-1",
    isCurrent: () => true,
    read: () =>
      new Promise((resolve: (result: { status: "selected"; text: string }) => void) => {
        pendingReads.push({ resolve });
      }),
  };

  const overlay = createQuickTranslateController({
    captureRegion: () => new Promise(() => {}),
    selectionText,
  });
  const ocr = overlay.startOcr();
  expect(overlay.ocrState().phase).toBe("selecting");
  const ignored = overlay.activateSelectionTranslate();
  expect(pendingReads).toHaveLength(0);
  await ignored;
  await ocr;

  pendingReads.length = 0;
  const controller = createQuickTranslateController({
    captureRegion: () => new Promise(() => {}),
    selectionText,
  });
  const pending = controller.activateSelectionTranslate();
  expect(pendingReads).toHaveLength(1);
  const started = controller.startOcr();
  pendingReads[0]!.resolve({ status: "selected", text: "Late selection" });
  await pending;
  expect(controller.sourceText()).toBe("");
  expect(controller.sourceDelivery()).toBeNull();
  await started;
});

test("double copy: shell seam delivers copied text to a newly mounted popup, translates with Auto-translate off, keeps typing opt-in, and handles worker failure", async () => {
  const seeded = makeSeedStorage({
    channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
    models: [makeModel({ enabled: true })],
    credentials: { "ch-1": "sk-test" },
  });

  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: {
      ...seeded,
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({ doubleCopyEnabled: true }),
      "__test.qt.doubleCopyClipboard": "Clipboard manual text",
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Translated ok" } }] },
      },
    },
  });

  await app.press("id:harness-trigger-double-copy-valid");
  // A copied draft arrives collapsed: the popup shows the source and results without taking edits.
  await app.waitFor("id:quick-translate-source-preview");
  await app.waitUntil(() => app.window("quick-translate").state()?.focused === true);
  expect(app.window("main").state()?.focused).toBe(false);
  expect(app.shows("id:quick-translate-source")).toBe(false);
  expect(app.texts()).toContain("Clipboard manual text");
  // Double Ctrl+C is an explicit translation request, even with Auto-translate off.
  await app.waitFor("id:quick-translate-result-text");
  expect(app.texts()).toContain("Translated ok");
  expect(app.requests()).toHaveLength(1);

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await app.waitFor("id:quick-translate-source-preview");
  await app.waitFor("id:quick-translate-result-text");
  expect(app.texts()).toContain("Clipboard manual text");
  expect(app.texts()).toContain("Translated ok");
  expect(app.requests()).toHaveLength(1);

  // Pin before triggering harness controls on the main window so blur does not close the popup.
  await app.press("id:quick-translate-pin");

  // Empty clipboard leaves the sent draft and its result untouched, with no request.
  await app.press("id:harness-set-clipboard-empty");
  await app.press("id:harness-trigger-double-copy-valid");
  expect(app.shows("id:quick-translate-source-preview")).toBe(true);
  expect(app.texts()).toContain("Clipboard manual text");
  expect(app.texts()).toContain("Translated ok");
  expect(app.requests()).toHaveLength(1);

  // Typing still follows the Auto-translate toggle and its 500 ms debounce. A due translate runs
  // with the next step, the clock's frames included, which is where the window starts.
  await app.press("id:quick-translate-auto-toggle");
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source");
  expect(hasQuickSource(app, "Clipboard manual text")).toBe(true);
  await app.type("id:quick-translate-source", "!");
  expect(hasQuickSource(app, "Clipboard manual text!")).toBe(true);
  await app.clock!.runFor(AUTO_TRANSLATE_DEBOUNCE_MS);
  await app.waitFor("id:quick-translate-result-text");
  expect(app.requests()).toHaveLength(2);

  // A second copied text translates at once and replaces the result instead of clearing it.
  await app.press("id:harness-set-clipboard-second");
  await app.press("id:harness-trigger-double-copy-valid");
  // A new delivery collapses the preview again, replacing the edited draft.
  await app.waitUntil(() => app.texts().includes("Second copied phrase"));
  await app.waitFor("id:quick-translate-source-preview");
  expect(app.shows("id:quick-translate-source")).toBe(false);
  await app.press("id:quick-translate-collapse-source");
  await app.waitFor("id:quick-translate-source");
  expect(hasQuickSource(app, "Second copied phrase")).toBe(true);
  await app.waitFor("id:quick-translate-result-text");
  expect(app.texts()).toContain("Translated ok");
  expect(app.requests()).toHaveLength(3);

  await app.press("id:quick-translate-clear");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await app.waitFor("id:quick-translate-source");
  expect(hasQuickSource(app, "")).toBe(true);
  expect(app.shows("id:quick-translate-result-text")).toBe(false);
  expect(app.requests()).toHaveLength(3);

  // Failed worker initialization keeps listener inactive with zero clipboard reads.
  const failed = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      "quickTranslate.preferences.v1": JSON.stringify({ version: 1, doubleCopyEnabled: true }),
      "__test.qt.doubleCopyMode": "throw",
      "__test.qt.doubleCopyClipboard": "Should not be read",
    },
  });
  await failed.waitUntil(() => failed.texts().includes(t("settings.doubleCopy.enableError")));
  await failed.press("id:harness-trigger-double-copy-valid");
  expect(failed.window("quick-translate").state()).toBeNull();
  expect(failed.texts().join(" ")).toContain("dcReads=0|");
});

test("quick window: reopening restores the draft and completed translation without sending a request", async () => {
  const draft = "Keep this source";
  const translation = "Completed translation";
  const responseDelay = 1000;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences(),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        delay: responseDelay,
        body: { choices: [{ message: { content: translation } }] },
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", draft);
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.requests().length === 1);
  expect(app.shows("id:quick-translate-status")).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await app.waitFor("id:quick-translate-source");
  await app.clock!.runFor(responseDelay);

  expect(hasQuickSource(app, draft)).toBe(true);
  expect(app.shows("id:quick-translate-status")).toBe(false);
  expect(app.shows("id:quick-translate-result-text")).toBe(false);
  expect(app.requests()).toHaveLength(1);

  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-result-text");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await app.waitFor("id:quick-translate-result-text");

  expect(hasQuickSource(app, draft)).toBe(true);
  expect(app.texts()).toContain(translation);
  expect(app.requests()).toHaveLength(2);
});

test("quick window fits a short copied translation after closing a taller result", async () => {
  const shortResult = "Short replacement";
  const tallResult = Array.from({ length: 90 }, (_, i) => `Translated line ${i + 1}`).join("\n");
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({ doubleCopyEnabled: true }),
      "settings.language": "en",
      "__test.qt.doubleCopyClipboard": "First copied phrase",
      "__test.qt.openNearWorkAreaBottom": "true",
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": (request) => ({
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: request.body?.includes("Second copied phrase") ? shortResult : tallResult,
              },
            },
          ],
        },
      }),
    },
  });
  const window = app.window("quick-translate");
  const height = () => window.state()?.contentBounds.size.height ?? 0;
  const copy = "id:harness-trigger-double-copy-valid";

  await app.press(copy);
  await app.waitFor("id:quick-translate-result-text");
  const [, workTop, workHeight] = app
    .texts()
    .find((line) => line.startsWith("quick-work-area:"))!
    .split(":")
    .map(Number);
  // The first result reaches the work-area limit and pushes the window up.
  await app.waitUntil(() => Math.abs(height() - workHeight!) < 1);
  await app.press("id:quick-translate-close");
  await app.waitUntil(() => window.state() === null);

  await app.press("id:harness-set-clipboard-second");
  await app.press(copy);
  await app.waitFor(`text:${shortResult}`);
  await app.waitUntil(() => height() > 0 && height() < POPUP_DEFAULT_SIZE.height);
  // The new result fits at the opening position; the old fit must not push it up.
  const openingY = workTop! + workHeight! - POPUP_DEFAULT_SIZE.height;
  expect(Math.abs(window.state()!.bounds.origin.y - openingY)).toBeLessThan(1);
});

const HARNESS_OCR_CAPTURE_KEY = "__test.qt.ocrCapture";
const OCR_TEXT = "Screen line one\n第二行";
const OCR_CAPTION = "Drag to select · Tab switches display · Space and Enter confirm · Esc cancels";
const OCR_BUTTON = "id:quick-translate-header >> id:quick-translate-ocr";

/** Vision recognition runs on its own route, so each request kind stays countable. */
function ocrAnswers(text: string, delay?: number): unknown {
  return {
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    ...(delay === undefined ? {} : {}),
  };
}

function ocrSeed(extra: Record<string, string> = {}) {
  return {
    ...makeSeedStorage({
      channels: [
        makeChannel({ id: "ch-1", adapterId: "openai-compatible", enabled: true }),
        makeChannel({
          id: "ch-vision",
          presetId: "openai",
          adapterId: "openai-responses",
          baseUrl: "https://vision.example.com/v1",
          sortOrder: 1,
          enabled: true,
        }),
      ],
      models: [
        makeModel({ id: "m-1", providerId: "ch-1", enabled: true }),
        makeModel({ id: "m-vision", providerId: "ch-vision", modelKey: "gpt-4.1", enabled: true }),
      ],
      credentials: { "ch-1": "sk-test", "ch-vision": "sk-vision" },
    }),
    [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
    "settings.language": "en",
    "quickTranslate.preferences.v1": popupPreferences({
      cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
    }),
    [OCR_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["ai", "baidu"],
      channels: {
        ai: {
          enabled: true,
          configured: true,
          config: { modelId: "m-vision" },
          credentialRef: null,
        },
        baidu: {
          enabled: false,
          configured: false,
          config: { operation: "accurate" },
          credentialRef: null,
        },
      },
    }),
    ...extra,
  };
}

const ocrRoutes = (answer: string, delay?: number) => ({
  "POST https://vision.example.com/v1/responses": {
    status: 200,
    body: ocrAnswers(answer),
    ...(delay === undefined ? {} : { delay }),
  },
  "POST https://api.openai.com/v1/chat/completions": {
    status: 200,
    body: { choices: [{ message: { content: "翻译结果" } }] },
  },
});

test("selection translate: waits for the selection, then translates once with Auto-translate off", async () => {
  const selected = "Selected line one\nSelected line two";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
      }),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Translated selection" } }] },
      },
    },
  });

  await app.keyboard.press("alt+d");
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  expect(app.window("quick-translate").state()).toBeNull();
  expect(app.requests()).toHaveLength(0);

  await app.press("id:harness-finish-selection");
  await app.waitFor("id:quick-translate-source-preview");
  await app.waitUntil(() => app.window("quick-translate").state()?.focused === true);
  expect(app.window("main").state()?.focused).toBe(false);
  expect(app.texts()).toContain("Selected line one");
  expect(app.shows("id:quick-translate-source")).toBe(false);
  await app.waitUntil(() => app.requests().length === 1);
  expect(JSON.parse(app.requests()[0]!.body!).messages[1].content).toBe(selected);
  expect(app.texts().join(" ")).toContain("dcReads=0|");
});

test("selection feedback: an empty selection shows why and keeps the draft, results, and pin", async () => {
  const seeded = makeSeedStorage({
    channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
    models: [makeModel({ enabled: true })],
    credentials: { "ch-1": "sk-test" },
  });
  const popupStorage = popupPreferences({
    cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
  });
  const routes = {
    "POST https://api.openai.com/v1/chat/completions": {
      status: 200,
      body: { choices: [{ message: { content: "Kept translation" } }] },
    },
  };

  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...seeded,
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupStorage,
      "settings.language": "en",
    },
    network: routes,
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Kept draft");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-result-text");
  await app.press("id:quick-translate-pin");

  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-empty");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-selection-status");

  expect(app.texts()).toContain("No text is selected.");
  expect(hasQuickSource(app, "Kept draft")).toBe(true);
  expect(app.texts()).toContain("Kept translation");
  expect(app.requests()).toHaveLength(1);

  // The pin is unchanged: a press outside the popup does not close it.
  await app.press("id:nav-models");
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  const chinese = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...seeded,
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupStorage,
      "settings.language": "zh-CN",
    },
    network: routes,
  });
  // An empty source still shows the status row, localized.
  await chinese.press("id:harness-tray-quick-translate");
  await chinese.waitFor("id:quick-translate-pin");
  await chinese.press("id:quick-translate-pin");
  await chinese.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await chinese.waitUntil(() => chinese.texts().some((text) => text.includes("selReads=1|")));
  await chinese.press("id:harness-finish-selection-empty");
  await chinese.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-selection-status");
  expect(chinese.texts()).toContain("未选中文本。");
  expect(hasQuickSource(chinese, "")).toBe(true);
  expect(chinese.requests()).toHaveLength(0);
});

test("selection feedback: an unreadable selection replaces an idle OCR message and never interrupts recognition", async () => {
  const app = await open(HARNESS_ENTRY, { ...viewport, storage: { "settings.language": "en" } });

  // Missing OCR setup leaves an idle message in the source toolbar.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Kept draft");
  await app.press("id:quick-translate-pin");
  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
  expect(app.texts()).toContain(
    "Configure OCR in Settings, or choose another way to get the text.",
  );

  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-unavailable");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-selection-status");
  expect(app.texts()).toContain("Could not read the selection.");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status")).toBe(
    false,
  );
  expect(hasQuickSource(app, "Kept draft")).toBe(true);
  expect(app.requests()).toHaveLength(0);

  // Recognition keeps the status slot: the failed read does not replace it.
  const recognizing = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "wait" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 2000),
  });
  await recognizing.press("id:harness-tray-quick-translate");
  await recognizing.waitFor("id:quick-translate-source");
  await recognizing.press(OCR_BUTTON);
  await recognizing.waitUntil(() => recognizing.texts().some((text) => text.includes("ocrCap=1|")));
  await recognizing.press("id:harness-finish-capture");
  await recognizing.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");

  await recognizing.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await recognizing.waitUntil(() =>
    recognizing.texts().some((text) => text.includes("selReads=1|")),
  );
  await recognizing.press("id:harness-finish-selection-unavailable");
  await recognizing.wait(50);
  expect(
    recognizing.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy"),
  ).toBe(true);
  expect(recognizing.shows("id:quick-translate-selection-status")).toBe(false);
  expect(recognizing.texts()).not.toContain("Could not read the selection.");
  await recognizing.waitUntil(() => hasQuickSource(recognizing, OCR_TEXT));
  expect(
    recognizing.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy"),
  ).toBe(false);
});

test("selection feedback: clears on a new attempt, edit, restore, delivery, OCR start, or close, and stale reads stay silent", async () => {
  const pending: Array<{
    resolve: (result: { status: "noSelection" } | { status: "unavailable" }) => void;
  }> = [];
  let currentTarget: string | null = "t1";
  const controller = createQuickTranslateController({
    isDoubleCopyActive: () => true,
    readClipboardText: async () => "Copied phrase",
    captureRegion: () => new Promise(() => {}),
    selectionText: {
      snapshot: () => currentTarget,
      isCurrent: (target) => target === currentTarget,
      read: () =>
        new Promise((resolve) => {
          pending.push({ resolve });
        }),
    },
  });

  controller.open();
  controller.setSourceText("Kept draft");

  const unreadable = controller.activateSelectionTranslate();
  pending.shift()!.resolve({ status: "unavailable" });
  await unreadable;
  expect(controller.selectionFeedback()).toBe("unavailable");
  expect(controller.sourceText()).toBe("Kept draft");

  // A new attempt clears the old message before its read ends.
  currentTarget = "t2";
  const stale = controller.activateSelectionTranslate();
  expect(controller.selectionFeedback()).toBeNull();
  currentTarget = "t3";
  pending.shift()!.resolve({ status: "noSelection" });
  await stale;
  expect(controller.selectionFeedback()).toBeNull();

  // No foreground target: no read, no new feedback.
  currentTarget = null;
  await controller.activateSelectionTranslate();
  expect(pending).toHaveLength(0);
  expect(controller.selectionFeedback()).toBeNull();

  // A draft edit clears it.
  currentTarget = "t4";
  const editedRead = controller.activateSelectionTranslate();
  pending.shift()!.resolve({ status: "unavailable" });
  await editedRead;
  expect(controller.selectionFeedback()).toBe("unavailable");
  controller.setSourceText("Edited draft");
  expect(controller.selectionFeedback()).toBeNull();

  // A restored draft clears it.
  currentTarget = "t5";
  const restoredRead = controller.activateSelectionTranslate();
  pending.shift()!.resolve({ status: "noSelection" });
  await restoredRead;
  expect(controller.selectionFeedback()).toBe("noSelection");
  controller.restoreSourceText("Restored draft");
  expect(controller.selectionFeedback()).toBeNull();

  // A new delivery clears it.
  currentTarget = "t6";
  const deliveryRead = controller.activateSelectionTranslate();
  pending.shift()!.resolve({ status: "unavailable" });
  await deliveryRead;
  expect(controller.selectionFeedback()).toBe("unavailable");
  await controller.activateDoubleCopy({ hasValidCopy: true });
  expect(controller.selectionFeedback()).toBeNull();
  expect(controller.sourceDelivery()?.kind).toBe("clipboard");

  // Starting OCR clears it and owns the status slot from then on.
  currentTarget = "t7";
  const ocrRead = controller.activateSelectionTranslate();
  pending.shift()!.resolve({ status: "unavailable" });
  await ocrRead;
  expect(controller.selectionFeedback()).toBe("unavailable");
  await controller.startOcr();
  expect(controller.selectionFeedback()).toBeNull();
  expect(controller.ocrState().message).not.toBeNull();

  // A failed read replaces that idle OCR message.
  currentTarget = "t8";
  const replacedRead = controller.activateSelectionTranslate();
  pending.shift()!.resolve({ status: "unavailable" });
  await replacedRead;
  expect(controller.selectionFeedback()).toBe("unavailable");
  expect(controller.ocrState().message).toBeNull();
  expect(controller.sourceDelivery()?.seq).toBe(1);

  // Closing clears it.
  controller.close();
  expect(controller.selectionFeedback()).toBeNull();
});

test("selection screenshot recovery: an unreadable selection offers capture and a cancelled region keeps the draft", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "cancel" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });
  const recovery = "id:quick-translate-source-toolbar >> id:quick-translate-selection-screenshot";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Kept draft");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-result-text");
  await app.press("id:quick-translate-pin");

  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-unavailable");
  await app.waitFor(recovery);
  expect(app.texts()).toContain("Could not read the selection.");
  expect(app.texts().some((text) => text.includes("ocrCap=0|"))).toBe(true);
  expect(app.requests()).toHaveLength(1);

  await app.press(recovery);
  await app.waitUntil(() => app.texts().some((text) => text.includes("ocrCap=1|")));
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);

  expect(hasQuickSource(app, "Kept draft")).toBe(true);
  expect(app.texts()).toContain("翻译结果");
  expect(app.shows(recovery)).toBe(false);
  expect(app.requests()).toHaveLength(1);
});

test("selection screenshot recovery: a confirmed crop translates the recognized text once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "wait" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });
  const recovery = "id:quick-translate-source-toolbar >> id:quick-translate-selection-screenshot";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-unavailable");
  await app.waitFor(recovery);

  await app.press(recovery);
  await app.waitUntil(() => app.texts().some((text) => text.includes("ocrCap=1|")));
  await app.press("id:harness-finish-capture");
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.waitFor("翻译结果");

  expect(app.requests().map((request) => request.url)).toEqual([
    "https://vision.example.com/v1/responses",
    "https://api.openai.com/v1/chat/completions",
  ]);
  expect(app.shows(recovery)).toBe(false);
});

test("selection screenshot recovery: only an unreadable selection offers capture", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "cancel" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });
  const recovery = "id:quick-translate-source-toolbar >> id:quick-translate-selection-screenshot";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-pin");
  await app.press("id:quick-translate-pin");
  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-empty");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-selection-status");

  expect(app.texts()).toContain("No text is selected.");
  expect(app.shows(recovery)).toBe(false);
  expect(app.texts().some((text) => text.includes("ocrCap=0|"))).toBe(true);
});

test("selection screenshot recovery: missing OCR setup shows its own feedback without capture", async () => {
  const seed: Record<string, string> = { ...ocrSeed() };
  delete seed[OCR_CHANNELS_STORAGE_KEY];
  const app = await open(HARNESS_ENTRY, { ...viewport, storage: seed });
  const recovery = "id:quick-translate-source-toolbar >> id:quick-translate-selection-screenshot";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-unavailable");
  await app.waitFor(recovery);

  await app.press(recovery);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
  expect(app.texts()).toContain(
    "Configure OCR in Settings, or choose another way to get the text.",
  );
  expect(app.texts().some((text) => text.includes("ocrCap=0|"))).toBe(true);
  expect(app.requests()).toHaveLength(0);
  expect(app.shows(recovery)).toBe(false);
});

test("selection screenshot recovery: the unreadable row renders in dark mode with reduced motion in Chinese", async () => {
  const seed: Record<string, string> = { ...ocrSeed() };
  delete seed[OCR_CHANNELS_STORAGE_KEY];
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    colorScheme: "dark",
    reducedMotion: true,
    storage: { ...seed, "settings.language": "zh-CN" },
  });
  const recovery = "id:quick-translate-source-toolbar >> id:quick-translate-selection-screenshot";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.keyboard.press(DEFAULT_SELECTION_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection-unavailable");
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-selection-status");

  expect(app.texts()).toContain("无法读取选中文本。");
  expect(app.texts()).toContain("截图翻译");
  expect(app.shows(recovery)).toBe(true);
  expect(app.shows("id:quick-translate-footer")).toBe(true);
  expect(app.window("quick-translate").state()?.visible).toBe(true);
});

test("selection hint activation: a drag release shows one button and only a click reads and translates", async () => {
  const selected = "Selected line one\nSelected line two";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
      }),
      [SELECTION_HINT_STORAGE_KEY]: "true",
      "settings.language": "en",
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Translated selection" } }] },
      },
    },
  });

  await app.waitUntil(() => app.texts().some((text) => text.includes("sgReg=1|")));
  expect(app.window("selection-hint").state()).toBeNull();

  await app.press("id:harness-selection-hint-candidate");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  // The button alone reads nothing: no target read, clipboard call, capture, or request.
  expect(app.texts().join(" ")).toContain("selReads=0|");
  expect(app.texts().join(" ")).toContain("dcReads=0|");
  expect(app.texts().join(" ")).toContain("ocrCap=0|");
  expect(app.requests()).toHaveLength(0);
  expect(app.window("quick-translate").state()).toBeNull();
  const placed = app.window("selection-hint").state()!;
  expect(placed.display).toBe(app.window("main").state()?.display);
  // Opening it takes no focus: the window that had it keeps it.
  expect(placed.focused).toBe(false);
  expect(app.window("main").state()?.focused).toBe(true);

  await app.press("id:selection-hint-translate");
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  expect(app.texts().join(" ")).toContain("selUia=1|");
  await app.press("id:harness-finish-selection");
  await app.waitUntil(() => app.requests().length === 1);

  expect(JSON.parse(app.requests()[0]!.body!).messages[1].content).toBe(selected);
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.window("selection-hint").state()?.visible).not.toBe(true);
});

test("selection hint activation: a stale, expired, outside-pressed, or edge hint opens nothing unwanted", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { "settings.language": "en", [SELECTION_HINT_STORAGE_KEY]: "true" },
  });

  // A target that is no longer current opens nothing and reads nothing.
  await app.press("id:harness-selection-hint-candidate");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  await app.press("id:harness-selection-hint-target-gone");
  await app.press("id:selection-hint-translate");
  await app.wait(50);
  expect(app.texts().join(" ")).toContain("selReads=0|");
  expect(app.window("quick-translate").state()).toBeNull();
  expect(app.window("selection-hint").state()?.visible).not.toBe(true);

  // A press outside dismisses it before any read.
  await app.press("id:harness-selection-hint-candidate");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  await app.press("id:harness-selection-hint-press");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible !== true);
  expect(app.texts().join(" ")).toContain("selReads=0|");

  // Three seconds without a click dismiss it too.
  await app.press("id:harness-selection-hint-candidate");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  await app.clock!.runFor(SELECTION_HINT_DURATION_MS + 100);
  await app.waitUntil(() => app.window("selection-hint").state()?.visible !== true);
  expect(app.texts().join(" ")).toContain("selReads=0|");
  expect(app.requests()).toHaveLength(0);

  // Near the work-area edge the hint flips and clamps, and stays fully inside the display.
  await app.press("id:harness-selection-hint-candidate-edge");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  const edge = app.window("selection-hint").state()!;
  const displayMetrics = app.texts().find((text) => text.startsWith("display:"))!;
  const [workX, workY, workWidth, workHeight] = displayMetrics
    .slice("display:".length)
    .split(":")
    .map(Number);
  expect(edge.bounds.origin.x).toBeGreaterThanOrEqual(workX - 1);
  expect(edge.bounds.origin.y).toBeGreaterThanOrEqual(workY - 1);
  expect(edge.bounds.origin.x + edge.bounds.size.width).toBeLessThanOrEqual(workX + workWidth + 1);
  expect(edge.bounds.origin.y + edge.bounds.size.height).toBeLessThanOrEqual(
    workY + workHeight + 1,
  );
  // The release was 8 pt inside the corner, so a below-right placement could not fit.
  expect(edge.bounds.origin.x + edge.bounds.size.width).toBeLessThanOrEqual(
    workX + workWidth - 8 + 1,
  );
  expect(edge.bounds.origin.y + edge.bounds.size.height).toBeLessThanOrEqual(
    workY + workHeight - 8 + 1,
  );
  expect(app.texts().join(" ")).toContain("selReads=0|");
});

test("selection hint lifetime: a pointer resting on it holds it open, and leaving it starts the countdown again", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { "settings.language": "en", [SELECTION_HINT_STORAGE_KEY]: "true" },
  });

  await app.press("id:harness-selection-hint-candidate");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  // The icon alone shows the action; its accessible name carries the words.
  expect(app.accessibility("id:selection-hint-translate")?.label).toBe(
    t("settings.shortcuts.selectionTranslate"),
  );
  expect(app.texts()).not.toContain(t("settings.shortcuts.selectionTranslate"));
  expect(app.texts()).not.toContain(formatShortcut(DEFAULT_SELECTION_TRANSLATE_SHORTCUT));

  // A pointer resting on the hint pauses the countdown, so it stays past its three seconds.
  await app.hover("id:selection-hint-translate");
  await app.clock!.runFor(SELECTION_HINT_DURATION_MS + 100);
  expect(app.window("selection-hint").state()?.visible).toBe(true);

  // A pointer that leaves starts the countdown again, and the hint goes without reading.
  await app.hover("id:harness-selection-hint-press");
  await app.clock!.runFor(SELECTION_HINT_DURATION_MS + 100);
  await app.waitUntil(() => app.window("selection-hint").state()?.visible !== true);
  expect(app.texts().join(" ")).toContain("selReads=0|");
});

test("selection hint setting: starts one listener only for the saved preference and stops it on disable", async () => {
  const switchId = "id:settings-selection-hint-switch";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { "settings.language": "en" },
  });

  // Nothing saved: the listener never starts.
  await app.waitUntil(() => app.texts().some((text) => text.includes("sgReg=0|")));
  expect(app.window("selection-hint").state()).toBeNull();
  expect(app.storage()[SELECTION_HINT_STORAGE_KEY]).toBeUndefined();

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.waitFor(switchId);
  expect(app.texts()).toContain("Show Translate Button After Dragging Text");
  expect(app.shows("id:settings-selection-hint-error")).toBe(false);

  await app.press(switchId);
  await app.waitUntil(() => app.texts().some((text) => text.includes("sgReg=1|")));
  await app.waitUntil(() => app.storage()[SELECTION_HINT_STORAGE_KEY] === "true");

  // The enabled listener reports a candidate; the hint shows without reading anything.
  await app.press("id:harness-selection-hint-candidate-edge");
  await app.waitUntil(() => app.window("selection-hint").state()?.visible === true);
  expect(app.texts().join(" ")).toContain("selReads=0|");

  // Disabling stops the one listener and dismisses the hint it left behind.
  await app.press(switchId);
  await app.waitUntil(() => app.texts().some((text) => text.includes("sgStop=1|")));
  await app.waitUntil(() => app.window("selection-hint").state()?.visible !== true);
  await app.waitUntil(() => app.storage()[SELECTION_HINT_STORAGE_KEY] === "false");
  expect(app.texts().join(" ")).toContain("sgReg=1|");

  // The saved preference starts exactly one listener on the next launch.
  const reopened = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    storage: { ...app.storage(), [SELECTION_HINT_STORAGE_KEY]: "true" },
  });
  await reopened.waitUntil(() => reopened.texts().some((text) => text.includes("sgReg=1|")));
  await reopened.press("id:harness-selection-hint-candidate");
  await reopened.waitUntil(() => reopened.window("selection-hint").state()?.visible === true);
  await reopened.press("id:selection-hint-translate");
  await reopened.waitUntil(() => reopened.texts().some((text) => text.includes("selReads=1|")));
  expect(reopened.texts().join(" ")).toContain("selUia=1|");
  await reopened.press("id:harness-finish-selection");
  await reopened.waitUntil(() => reopened.window("quick-translate").state()?.visible === true);
});

test("selection hint setting: a refused start or a failed write keeps the feature off and the shortcuts", async () => {
  const refused = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [SELECTION_HINT_STORAGE_KEY]: "true",
      "__test.qt.selectionHintMode": "throw",
    },
  });

  // The failure is reported to the user, and the shortcuts keep working.
  await refused.waitUntil(() => refused.texts().includes(t("settings.selectionHint.enableError")));
  expect(refused.texts().join(" ")).toContain("sgReg=1|");
  expect(refused.texts().join(" ")).toContain("sgStop=0|");
  // A refused listener never takes the shortcuts with it.
  expect(refused.texts().join(" ")).toContain("shortcuts=alt+shift+d,alt+s,alt+d|");
  expect(refused.window("selection-hint").state()).toBeNull();
  await refused.press("id:nav-settings");
  await refused.press("id:settings-nav-shortcuts");
  await refused.waitFor("id:settings-selection-hint-error");

  // A failed write keeps the previous value and runtime state. Only a headless run can
  // substitute the app's storage; a desktop target rejects the option and skips this part.
  let failWrites = true;
  const saved: Record<string, string> = { "settings.language": "en" };
  let failing: Awaited<ReturnType<typeof open>> | null = null;
  try {
    failing = await open(HARNESS_ENTRY, {
      ...viewport,
      modules: {
        nsh: {
          "Storage.getItem": async (key: string) => saved[key] ?? null,
          "Storage.setItem": async (key: string, value: string) => {
            if (key === SELECTION_HINT_STORAGE_KEY && failWrites) {
              throw new Error("Storage unavailable");
            }
            saved[key] = value;
          },
        },
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_NSH_TEST_UNSUPPORTED") throw error;
  }
  if (failing === null) return;
  await failing.press("id:nav-settings");
  await failing.press("id:settings-nav-shortcuts");
  await failing.press("id:settings-selection-hint-switch");
  await failing.waitFor("id:settings-selection-hint-error");
  expect(saved[SELECTION_HINT_STORAGE_KEY]).toBeUndefined();
  await failing.waitUntil(() => failing.texts().some((text) => text.includes("sgStop=1|")));

  failWrites = false;
  await failing.press("id:settings-selection-hint-switch");
  await failing.waitUntil(() => saved[SELECTION_HINT_STORAGE_KEY] === "true");
  await failing.waitUntil(() => failing.shows("id:settings-selection-hint-error") === false);
  expect(failing.texts().join(" ")).toContain("sgReg=2|");
});

test("selection hint setting: outside Windows the switch is hidden and no listener starts", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    platform: "macos",
    clock: {},
    storage: { "settings.language": "en", [SELECTION_HINT_STORAGE_KEY]: "true" },
  });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  // A desktop target runs its own platform; only a headless run can substitute macOS.
  if (app.shows("id:settings-copy-card")) return;
  await app.waitFor("id:settings-shortcuts-windows-only");
  expect(app.shows("id:settings-selection-hint-switch")).toBe(false);
  expect(app.texts().join(" ")).toContain("sgReg=0|");
  expect(app.window("selection-hint").state()).toBeNull();
});

test("selection controller: recognition keeps the first delivery", async () => {
  const selected = "Selected line one\nSelected line two";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 10_000),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  await app.keyboard.press("alt+d");
  await app.waitUntil(() => app.texts().some((text) => text.includes("selReads=1|")));
  await app.press("id:harness-finish-selection");
  await app.waitFor("id:quick-translate-source-preview");
  expect(app.texts()).toContain("Selected line one");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy")).toBe(false);
  expect(app.texts().join("\n")).not.toContain(OCR_TEXT);
  await app.waitUntil(
    () => app.requests().filter((request) => request.url.includes("api.openai.com")).length === 1,
  );
  const delivered = app.requests().filter((request) => request.url.includes("api.openai.com"))[0]!;
  expect(JSON.parse(delivered.body!).messages[1].content).toBe(selected);

  const lateSelection = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 300),
  });
  await lateSelection.press("id:harness-tray-quick-translate");
  await lateSelection.waitFor("id:quick-translate-source");
  await lateSelection.press("id:quick-translate-pin");
  await lateSelection.press(OCR_BUTTON);
  await lateSelection.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  await lateSelection.keyboard.press("alt+d");
  await lateSelection.waitUntil(() =>
    lateSelection.texts().some((text) => text.includes("selReads=1|")),
  );
  await lateSelection.waitUntil(() =>
    lateSelection.texts().some((text) => text.includes("Screen line one")),
  );
  await lateSelection.press("id:harness-finish-selection");
  await lateSelection.wait(50);
  expect(hasQuickSource(lateSelection, OCR_TEXT)).toBe(true);
  expect(lateSelection.texts().join("\n")).not.toContain(selected);

  const emptySelection = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 400),
  });
  await emptySelection.press("id:harness-tray-quick-translate");
  await emptySelection.waitFor("id:quick-translate-source");
  await emptySelection.press("id:quick-translate-pin");
  await emptySelection.press(OCR_BUTTON);
  await emptySelection.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  await emptySelection.keyboard.press("alt+d");
  await emptySelection.waitUntil(() =>
    emptySelection.texts().some((text) => text.includes("selReads=1|")),
  );
  await emptySelection.press("id:harness-finish-selection-empty");
  expect(
    emptySelection.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy"),
  ).toBe(true);
  await emptySelection.waitUntil(() =>
    emptySelection.texts().some((text) => text.includes(OCR_TEXT)),
  );
  expect(hasQuickSource(emptySelection, OCR_TEXT)).toBe(true);
});

test("screenshot shortcut: selects first, then opens Quick Translate and translates once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "wait" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 500),
  });
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes(`,${DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT},`)),
  );
  await app.keyboard.press(DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("ocrCap=1|")));
  expect(app.window("quick-translate").state()).toBeNull();
  expect(app.requests()).toHaveLength(0);
  await app.keyboard.press(DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT);
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  expect(app.window("quick-translate").state()).toBeNull();
  expect(app.texts().some((text) => text.includes("ocrCap=1|"))).toBe(true);

  await app.press("id:harness-finish-capture");
  await app.waitFor("id:quick-translate-ocr-busy");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.waitFor("翻译结果");
  const requests = app.requests();
  expect(requests.map((request) => request.url)).toEqual([
    "https://vision.example.com/v1/responses",
    "https://api.openai.com/v1/chat/completions",
  ]);
  expect(JSON.parse(requests[1]!.body!).messages[1].content).toBe(OCR_TEXT);
});

test("screenshot shortcut: cancellation without a popup stays on the desktop", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "cancel" }),
  });
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes(`,${DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT},`)),
  );
  await app.keyboard.press(DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.texts().some((text) => text.includes("ocrCap=1|")));
  expect(app.window("quick-translate").state()).toBeNull();
  expect(app.requests()).toHaveLength(0);
});

test("screenshot shortcut: missing OCR setup shows recovery without capturing", async () => {
  const app = await open(HARNESS_ENTRY, { ...viewport, storage: { "settings.language": "en" } });
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes(`,${DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT},`)),
  );
  await app.keyboard.press(DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT);
  await app.waitFor("id:quick-translate-ocr-status");
  expect(app.texts()).toContain(
    "Configure OCR in Settings, or choose another way to get the text.",
  );
  expect(app.texts().some((text) => text.includes("ocrCap=0|"))).toBe(true);
  expect(app.requests()).toHaveLength(0);
});

test("tray: Screenshot Translate starts the region selection and opens Quick Translate after the crop", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "wait" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 500),
  });
  await app.waitUntil(() =>
    app.texts().some((text) => text.includes("tray=Quick Translate,Screenshot Translate,Exit")),
  );

  await app.press("id:harness-tray-screenshot-translate");
  await app.waitUntil(() => app.texts().some((text) => text.includes("ocrCap=1|")));
  expect(app.window("quick-translate").state()).toBeNull();
  expect(app.requests()).toHaveLength(0);

  await app.press("id:harness-finish-capture");
  await app.waitFor("id:quick-translate-ocr-busy");
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.waitFor("翻译结果");
});

test("quick ocr: replaces the draft with the recognized text and translates once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "old draft");
  expect(app.shows(OCR_BUTTON)).toBe(true);

  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));

  const vision = app.requests().filter((request) => request.url.includes("vision.example.com"));
  expect(vision).toHaveLength(1);
  const sent = JSON.parse(vision[0]!.body!);
  expect(sent.model).toBe("gpt-4.1");
  expect(sent.input[0].content[1].type).toBe("input_image");
  expect(app.texts().some((line) => line.includes(`ocrCaption=${OCR_CAPTION}`))).toBe(true);

  await app.waitUntil(() =>
    app.requests().some((request) => request.url.includes("api.openai.com")),
  );
  const translations = app.requests().filter((request) => request.url.includes("api.openai.com"));
  expect(translations).toHaveLength(1);
  expect(JSON.parse(translations[0]!.body!).messages[1].content).toBe(OCR_TEXT);

  // The same window returns with the editor open, its line breaks kept, and the pin state intact.
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.shows("id:quick-translate-source")).toBe(true);
  expect(app.shows("id:quick-translate-pin")).toBe(true);
  expect(app.texts()).toContain("翻译结果");
  expect(app.texts().some((line) => line.includes("ocrCap=1"))).toBe(true);
});

const PASTED_PNG = "src/app/__tests__/fixtures/clipboard-16.png";

test("quick translate: a pasted image is recognized without a screen capture", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 400),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "old draft");

  await app.paste("id:quick-translate-source", { files: [PASTED_PNG] });
  await app.waitFor("id:quick-translate-ocr-busy");
  expect(hasQuickSource(app, "old draft")).toBe(true);
  expect(app.texts().some((line) => line.includes("ocrCap=0|"))).toBe(true);

  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.waitFor("翻译结果");
  const vision = app.requests().filter((request) => request.url.includes("vision.example.com"));
  expect(vision).toHaveLength(1);
  const sent = JSON.parse(vision[0]!.body!);
  expect(sent.input[0].content[1].type).toBe("input_image");
  const translation = app.requests().find((request) => request.url.includes("api.openai.com"));
  expect(JSON.parse(translation!.body!).messages[1].content).toBe(OCR_TEXT);
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.shows("id:quick-translate-source")).toBe(true);
});

test("quick translate: pasted text stays text and does not call OCR", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.paste("id:quick-translate-source", { text: "Pasted sentence" });

  expect(hasQuickSource(app, "Pasted sentence")).toBe(true);
  expect(app.requests().some((request) => request.url.includes("vision.example.com"))).toBe(false);
  expect(app.shows("id:quick-translate-ocr-busy")).toBe(false);
});

test("quick translate: a pasted image without OCR keeps the draft and shows setup", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "kept draft");
  await app.paste("id:quick-translate-source", { files: [PASTED_PNG] });
  await app.waitFor("id:quick-translate-ocr-status");

  expect(app.texts()).toContain(
    "Configure OCR in Settings, or choose another way to get the text.",
  );
  expect(hasQuickSource(app, "kept draft")).toBe(true);
  expect(app.requests()).toHaveLength(0);
});

test("quick ocr: cancelling keeps the draft and restores the popup", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "cancel" }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "kept draft");

  await app.press(OCR_BUTTON);
  await app.waitUntil(() => app.texts().some((line) => line.includes("ocrCap=1")));
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);

  expect(hasQuickSource(app, "kept draft")).toBe(true);
  expect(app.requests()).toHaveLength(0);
  expect(app.shows("id:quick-translate-ocr-status")).toBe(false);
});

test("quick ocr: a blank answer keeps the draft, shows an alert, and sends no translation", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: "" })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "kept draft");

  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");

  expect(app.texts()).toContain("No text was found in the selected area.");
  expect(hasQuickSource(app, "kept draft")).toBe(true);
  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: a provider failure keeps the draft and never imports partial text", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: {
      "POST https://vision.example.com/v1/responses": { status: 500, body: { error: "busy" } },
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "翻译结果" } }] },
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "kept draft");

  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");

  expect(hasQuickSource(app, "kept draft")).toBe(true);
  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: the source waits for the answer, and the answer replaces the draft", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 1_200),
  });
  const source = "id:quick-translate-source";

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor(source);
  await app.type(source, "kept draft");

  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");

  // One OCR session at a time: neither the action nor the source takes input until the answer.
  expect(app.enabled(OCR_BUTTON)).toBe(false);
  expect(app.enabled(source)).toBe(false);
  await app.type(source, "typed instead");
  expect(app.texts().some((text) => text.includes("typed instead"))).toBe(false);
  expect(hasQuickSource(app, "kept draft")).toBe(true);

  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  expect(app.enabled(source)).toBe(true);
  expect(app.enabled(OCR_BUTTON)).toBe(true);
  const translations = app.requests().filter((request) => request.url.includes("api.openai.com"));
  expect(translations).toHaveLength(1);
  expect(JSON.parse(translations[0]!.body!).messages[1].content).toBe(OCR_TEXT);
});

test("quick ocr: a valid double copy ends recognition and translates the copied text", async () => {
  const copied = "copied while recognizing";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({
      "quickTranslate.preferences.v1": popupPreferences({
        doubleCopyEnabled: true,
        cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
      }),
      "__test.qt.doubleCopyClipboard": copied,
    }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 10_000),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  await app.waitUntil(() =>
    app.requests().some((request) => request.url.includes("vision.example.com")),
  );

  await app.press("id:harness-trigger-double-copy-invalid");
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy")).toBe(true);
  await app.press("id:harness-trigger-double-copy-valid");
  await app.waitFor("id:quick-translate-source-preview");
  expect(app.texts()).toContain(copied);
  expect(app.shows("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy")).toBe(false);
  expect(app.enabled(OCR_BUTTON)).toBe(true);
  await app.waitFor("id:quick-translate-result-text");
  const translations = app.requests().filter((request) => request.url.includes("api.openai.com"));
  expect(translations).toHaveLength(1);
  expect(JSON.parse(translations[0]!.body!).messages).toContainEqual({
    role: "user",
    content: copied,
  });
});

test("quick ocr: closing and reopening before the old result keeps the new draft", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 250),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press(OCR_BUTTON);
  await app.waitUntil(() => app.texts().some((line) => line.includes("ocrCap=1")));

  await app.window("quick-translate").pressClose();
  await app.waitUntil(() => app.window("quick-translate").state()?.visible !== true);
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);
  await app.waitFor("id:quick-translate-source");
  expect(hasQuickSource(app, "")).toBe(true);

  await app.wait(400);
  expect(hasQuickSource(app, "")).toBe(true);
  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: a queued auto-translate debounce never repeats the delivered text", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({
      "quickTranslate.preferences.v1": popupPreferences({
        autoTranslate: true,
        cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: false }],
      }),
    }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "hello");
  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.wait(700);

  const translations = app
    .requests()
    .filter(
      (request) =>
        request.url.includes("api.openai.com") && (request.body ?? "").includes("Screen line one"),
    );
  expect(translations).toHaveLength(1);
});

test("quick ocr: no eligible card replaces the text without a translation", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed({
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [{ id: "card-1", presetId: "preset-1", templateId: null, collapsed: true }],
      }),
    }),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));

  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: an unsaved service shows recovery and never captures", async () => {
  const seed: Record<string, string> = { ...ocrSeed() };
  delete seed[OCR_CHANNELS_STORAGE_KEY];
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: seed,
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "kept draft");

  await app.press(OCR_BUTTON);
  await app.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");

  expect(app.texts()).toContain(
    "Configure OCR in Settings, or choose another way to get the text.",
  );
  expect(app.texts().some((line) => line.includes("ocrCap=0"))).toBe(true);
  expect(hasQuickSource(app, "kept draft")).toBe(true);
  expect(app.requests()).toHaveLength(0);
});

test("quick ocr: no OCR action outside Windows", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    platform: "macos",
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(app.shows(OCR_BUTTON)).toBe(false);
});

const BAIDU_REF = "qt-baidu-ref";
const BAIDU_TOKEN = "POST https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_OCR_URL =
  "POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token";

function baiduOcrSeed(extra: Record<string, string> = {}) {
  return ocrSeed({
    [OCR_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["baidu", "ai"],
      channels: {
        baidu: {
          enabled: true,
          configured: true,
          config: { operation: "accurate" },
          credentialRef: BAIDU_REF,
        },
        ai: { enabled: false, configured: false, config: { modelId: "" }, credentialRef: null },
      },
    }),
    [ocrCredentialStorageKey(BAIDU_REF)]: JSON.stringify({
      apiKey: "synthetic-api-key",
      secretKey: "synthetic-secret-key",
    }),
    ...extra,
  });
}

function baiduOcrRoutes(options: { words?: string[]; delay?: number; quota?: boolean } = {}) {
  const words = options.words ?? ["Screen line one", "第二行"];
  return {
    [BAIDU_TOKEN]: {
      status: 200,
      body: { access_token: "fixture-token" },
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    },
    [BAIDU_OCR_URL]: options.quota
      ? { status: 200, body: { error_code: 17, error_msg: "SENTINEL-SECRET" } }
      : {
          status: 200,
          body: { words_result: words.map((words) => ({ words })), words_result_num: words.length },
        },
    "POST https://api.openai.com/v1/chat/completions": {
      status: 200,
      body: { choices: [{ message: { content: "翻译结果" } }] },
    },
  };
}

test("quick ocr: Baidu replaces the draft and translates the text once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed(),
    network: baiduOcrRoutes(),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "old draft");

  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));

  const token = app.requests().filter((request) => request.url.includes("/oauth/2.0/token"));
  const uploads = app.requests().filter((request) => request.url.includes("/ocr/v1/accurate"));
  expect(token).toHaveLength(1);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.body ?? "").not.toContain("synthetic-api-key");
  expect(uploads[0]!.body ?? "").not.toContain("synthetic-secret-key");

  await app.waitUntil(() =>
    app.requests().some((request) => request.url.includes("api.openai.com")),
  );
  const translations = app.requests().filter((request) => request.url.includes("api.openai.com"));
  expect(translations).toHaveLength(1);
  const translation = translations[0]!.body ?? "";
  expect(JSON.parse(translation).messages[1].content).toBe(OCR_TEXT);
  expect(translation.includes("synthetic-api-key")).toBe(false);
  expect(translation.includes("fixture-token")).toBe(false);
  expect(translation.includes("iVBORw0KGgo")).toBe(false);
  expect(app.texts()).toContain("翻译结果");
});

test("quick ocr: Baidu cancellation, a late result, and a quota error keep the draft", async () => {
  const cancelled = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "cancel" }),
    network: baiduOcrRoutes(),
  });
  await cancelled.press("id:harness-tray-quick-translate");
  await cancelled.waitFor("id:quick-translate-source");
  await cancelled.type("id:quick-translate-source", "kept draft");
  await cancelled.press(OCR_BUTTON);
  await cancelled.waitUntil(() => cancelled.texts().some((line) => line.includes("ocrCap=1")));
  await cancelled.waitUntil(() => cancelled.window("quick-translate").state()?.visible === true);
  expect(hasQuickSource(cancelled, "kept draft")).toBe(true);
  expect(cancelled.requests()).toHaveLength(0);

  const late = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed(),
    network: baiduOcrRoutes({ delay: 1_200 }),
  });
  await late.press("id:harness-tray-quick-translate");
  await late.waitFor("id:quick-translate-source");
  await late.press(OCR_BUTTON);
  await late.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-busy");
  expect(late.enabled("id:quick-translate-source")).toBe(false);
  await late.waitUntil(() => hasQuickSource(late, OCR_TEXT));
  expect(late.enabled("id:quick-translate-source")).toBe(true);
  await late.waitUntil(() =>
    late.requests().some((request) => request.url.includes("api.openai.com")),
  );
  const lateTranslations = late
    .requests()
    .filter((request) => request.url.includes("api.openai.com"));
  expect(lateTranslations).toHaveLength(1);
  expect(JSON.parse(lateTranslations[0]!.body!).messages[1].content).toBe(OCR_TEXT);

  const quota = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed(),
    network: baiduOcrRoutes({ quota: true }),
  });
  await quota.press("id:harness-tray-quick-translate");
  await quota.waitFor("id:quick-translate-source");
  await quota.type("id:quick-translate-source", "kept draft");
  await quota.press(OCR_BUTTON);
  await quota.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
  expect(quota.texts()).toContain(t("ocr.failure.baiduQuota"));
  expect(quota.texts().some((line) => line.includes("SENTINEL-SECRET"))).toBe(false);
  expect(hasQuickSource(quota, "kept draft")).toBe(true);
  expect(quota.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: falls back from primary Baidu quota failure to backup AI and translates once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed({
      [OCR_CHANNELS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        order: ["baidu", "ai"],
        channels: {
          baidu: {
            enabled: true,
            configured: true,
            config: { operation: "accurate" },
            credentialRef: BAIDU_REF,
          },
          ai: {
            enabled: true,
            configured: true,
            config: { modelId: "m-vision" },
            credentialRef: null,
          },
        },
      }),
    }),
    network: {
      ...baiduOcrRoutes({ quota: true }),
      ...ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "old draft");

  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.waitUntil(() =>
    app.requests().some((request) => request.url.includes("api.openai.com")),
  );

  expect(app.requests().map((request) => request.url)).toEqual([
    "https://aip.baidubce.com/oauth/2.0/token",
    "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token",
    "https://vision.example.com/v1/responses",
    "https://api.openai.com/v1/chat/completions",
  ]);
  expect(app.texts()).toContain("翻译结果");
});

const GOOGLE_REF = "qt-google-ref";
const GOOGLE_KEY = "synthetic-vision-key";
const GOOGLE_ANNOTATE = "https://vision.googleapis.com/v1/images:annotate";

function googleOcrSeed(extra: Record<string, string> = {}) {
  return ocrSeed({
    [OCR_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["google-cloud"],
      channels: {
        "google-cloud": {
          enabled: true,
          configured: true,
          config: {},
          credentialRef: GOOGLE_REF,
        },
      },
    }),
    [ocrCredentialStorageKey(GOOGLE_REF)]: JSON.stringify({ apiKey: GOOGLE_KEY }),
    ...extra,
  });
}

function googleOcrRoutes(options: { text?: string; delay?: number; fail?: boolean } = {}) {
  const body = options.fail
    ? { error: { code: 500, message: "SENTINEL-SECRET" } }
    : { responses: [{ fullTextAnnotation: { text: options.text ?? OCR_TEXT } }] };
  return {
    ["POST " + GOOGLE_ANNOTATE]: {
      status: options.fail ? 500 : 200,
      body,
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    },
    "POST https://api.openai.com/v1/chat/completions": {
      status: 200,
      body: { choices: [{ message: { content: "翻译结果" } }] },
    },
  };
}

test("quick ocr: Vision replaces the draft and translates the text once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: googleOcrSeed(),
    network: googleOcrRoutes(),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "old draft");

  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT));
  await app.waitUntil(() =>
    app.requests().some((request) => request.url.includes("api.openai.com")),
  );

  const uploads = app.requests().filter((request) => request.url === GOOGLE_ANNOTATE);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.url).not.toContain(GOOGLE_KEY);
  expect(uploads[0]!.headers?.["x-goog-api-key"]).toBe(GOOGLE_KEY);
  expect(JSON.parse(uploads[0]!.body!).requests[0].features).toEqual([
    { type: "DOCUMENT_TEXT_DETECTION" },
  ]);
  const translations = app.requests().filter((request) => request.url.includes("api.openai.com"));
  expect(translations).toHaveLength(1);
  const translation = translations[0]!.body ?? "";
  expect(JSON.parse(translation).messages[1].content).toBe(OCR_TEXT);
  expect(translation.includes(GOOGLE_KEY)).toBe(false);
  expect(app.texts().join(" ").includes(GOOGLE_KEY)).toBe(false);
  expect(app.texts()).toContain("翻译结果");
});

test("quick ocr: Vision cancellation, a late result, and a service failure keep the draft", async () => {
  const cancelled = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: googleOcrSeed({ [HARNESS_OCR_CAPTURE_KEY]: "cancel" }),
    network: googleOcrRoutes(),
  });
  await cancelled.press("id:harness-tray-quick-translate");
  await cancelled.waitFor("id:quick-translate-source");
  await cancelled.type("id:quick-translate-source", "kept draft");
  await cancelled.press(OCR_BUTTON);
  await cancelled.waitUntil(() => cancelled.texts().some((line) => line.includes("ocrCap=1")));
  await cancelled.waitUntil(() => cancelled.window("quick-translate").state()?.visible === true);
  expect(hasQuickSource(cancelled, "kept draft")).toBe(true);
  expect(cancelled.requests()).toHaveLength(0);

  const late = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: googleOcrSeed(),
    network: googleOcrRoutes({ delay: 400 }),
  });
  await late.press("id:harness-tray-quick-translate");
  await late.waitFor("id:quick-translate-source");
  await late.press(OCR_BUTTON);
  await late.waitUntil(() => late.requests().some((request) => request.url === GOOGLE_ANNOTATE));
  expect(late.enabled("id:quick-translate-source")).toBe(false);
  await late.window("quick-translate").pressClose();
  await late.waitUntil(() => late.window("quick-translate").state()?.visible !== true);
  await late.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  await late.waitFor("id:quick-translate-source");
  await late.wait(500);
  expect(hasQuickSource(late, "")).toBe(true);
  expect(late.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
  expect(late.texts().join("\n")).not.toContain(OCR_TEXT);

  const failed = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: googleOcrSeed(),
    network: googleOcrRoutes({ fail: true }),
  });
  await failed.press("id:harness-tray-quick-translate");
  await failed.waitFor("id:quick-translate-source");
  await failed.type("id:quick-translate-source", "kept draft");
  await failed.press(OCR_BUTTON);
  await failed.waitFor("id:quick-translate-source-toolbar >> id:quick-translate-ocr-status");
  expect(failed.texts()).toContain(t("ocr.failure.googleFailed"));
  expect(failed.texts().some((line) => line.includes("SENTINEL-SECRET"))).toBe(false);
  expect(hasQuickSource(failed, "kept draft")).toBe(true);
  expect(
    failed.requests().filter((request) => request.url.includes("api.openai.com")),
  ).toHaveLength(0);
});

const QUICK_TTS_URL = "POST " + GOOGLE_CLOUD_TTS_URL;
const QUICK_TTS_AUDIO = {
  audioContent: Buffer.from(Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00])).toString("base64"),
};

function ttsWindowStorage(extra: Record<string, string> = {}) {
  return ocrSeed({
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["google-cloud"],
      channels: {
        "google-cloud": {
          enabled: true,
          configured: true,
          config: { preferences: DEFAULT_GOOGLE_VOICE_PREFERENCES },
          credentialRef: "tts-ref",
        },
      },
    }),
    [ttsCredentialStorageKey("tts-ref")]: JSON.stringify({ apiKey: "tts-key" }),
    ...extra,
  });
}

test("quick tts: closing the window drops a loading request and reopening stays silent", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ttsWindowStorage(),
    network: {
      [QUICK_TTS_URL]: { status: 200, delay: 500, body: QUICK_TTS_AUDIO },
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.press("id:quick-translate-speak-source");
  await app.waitFor("role:button[Cancel]");
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state()?.visible !== true);
  await app.wait(600);
  expect(app.audio().some((call) => call.command === "open")).toBe(false);
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(app.audio().some((call) => call.command === "open")).toBe(false);
  expect(app.texts()).not.toContain("Stop");
});

test("quick tts: hiding the window for screenshot selection stops playback and does not resume", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ttsWindowStorage({ [HARNESS_OCR_CAPTURE_KEY]: "wait" }),
    network: {
      ...ocrRoutes(OCR_TEXT),
      [QUICK_TTS_URL]: { status: 200, body: QUICK_TTS_AUDIO },
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "Hello");
  await app.press("id:quick-translate-speak-source");
  await app.waitFor("role:button[Stop]");
  expect(app.audio().filter((call) => call.command === "open")).toHaveLength(1);
  await app.press(OCR_BUTTON);
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === false);
  expect(app.audio().some((call) => call.command === "close")).toBe(true);
  await app.press("id:harness-finish-capture");
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);
  expect(app.audio().filter((call) => call.command === "open")).toHaveLength(1);
  expect(app.texts()).not.toContain("Stop");
});

test("quick window: back-translation respects Markdown toggle without retranslating", async () => {
  const forwardMarkdown = "## Forward Heading\n\n**Bonjour**";
  const reverseMarkdown = "## Reverse Heading\n\n**Hello**";
  let aiCalls = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        aiCalls += 1;
        return {
          status: 200,
          body: {
            choices: [{ message: { content: aiCalls === 1 ? forwardMarkdown : reverseMarkdown } }],
          },
        };
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");

  expect(app.texts()).toContain(forwardMarkdown);
  expect(app.texts()).toContain(reverseMarkdown);

  await app.press("id:quick-translate-header >> id:quick-translate-markdown-toggle");
  await app.waitFor("id:quick-translate-card-card-1 >> text:Reverse Heading");
  expect(app.texts()).toContain("Forward Heading");
  expect(app.texts()).toContain("Reverse Heading");
  expect(app.texts()).not.toContain(reverseMarkdown);
  expect(app.requests()).toHaveLength(2);
});

test("quick window: back-translation adds no height when closed, fits open content within display work area, and preserves collapse/remove/retry", async () => {
  const mediumReverse = Array.from({ length: 10 }, (_, i) => `Back-translation line ${i + 1}`).join(
    "\n",
  );
  const longReverse = Array.from({ length: 60 }, (_, i) => `Overflow back line ${i + 1}`).join(
    "\n",
  );
  let aiCalls = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [
          { id: "card-1", presetId: quickPreset.id },
          { id: "card-2", presetId: quickPreset.id },
        ],
      }),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": (req) => {
        aiCalls += 1;
        const body = JSON.parse(req.body ?? "{}") as { messages?: Array<{ content: string }> };
        if (body.messages?.[1]?.content === "Hello") {
          return { status: 200, body: { choices: [{ message: { content: "Bonjour" } }] } };
        }
        return {
          status: 200,
          body: {
            choices: [{ message: { content: aiCalls === 3 ? mediumReverse : longReverse } }],
          },
        };
      },
    },
  });

  const window = app.window("quick-translate");
  const height = () => window.state()?.contentBounds.size.height ?? 0;

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await app.waitUntil(() => height() > 200);
  const closedHeight = height();

  // Opening a normal-height back-translation grows the window cleanly and closing restores closedHeight.
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-copy-back-translation");
  const work = app.texts().find((value) => value.startsWith("quick-work-area:"))!;
  const [, , workHeight] = work.split(":").map(Number);
  await app.waitUntil(() => height() > closedHeight + 40);
  const mediumHeight = height();
  expect(mediumHeight).toBeGreaterThan(closedHeight);
  expect(window.state()!.bounds.size.height).toBeLessThanOrEqual(workHeight! + 1);

  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-close-back-translation");
  await app.waitUntil(() => Math.abs(height() - closedHeight) < 1);

  // An overflowing 60-line back-translation clamps within the display work area while top controls remain interactive.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-back-translate");
  await app.waitFor("id:quick-translate-card-card-2 >> id:quick-translate-copy-back-translation");
  await app.waitUntil(() => Math.abs(window.state()!.bounds.size.height - workHeight!) < 1);
  expect(window.state()!.bounds.size.height).toBeLessThanOrEqual(workHeight! + 1);

  // Existing collapse, retry, and remove controls continue operating normally.
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.waitUntil(() => height() < closedHeight);
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-collapse");
  await app.waitUntil(() => Math.abs(height() - closedHeight) < 1);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-retry");
  await app.waitUntil(() => aiCalls >= 5);
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-remove");
  expect(app.shows("id:quick-translate-card-card-2")).toBe(false);
});

const ANKI_URL = "http://127.0.0.1:8765/api/v1";

test("quick anki: adds only the pressed card and blocks a second write", async () => {
  let translationCount = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [
          { id: "card-1", presetId: quickPreset.id },
          { id: "card-2", presetId: quickPreset.id },
        ],
      }),
      "settings.wordbook.anki.v1": JSON.stringify({
        version: 1,
        enabled: true,
        profile: "User 1",
        deckId: "1550000000000",
        deckName: "Vocabulary",
        noteTypeId: "1550000000003",
        noteTypeName: "Basic",
        sourceField: "Front",
        translationField: "Back",
      }),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": () => {
        translationCount += 1;
        const text = translationCount === 1 ? "Alpha" : "Beta";
        return { body: { choices: [{ message: { content: text } }] } };
      },
      ["POST " + ANKI_URL]: (request): StubResponse => {
        const body = JSON.parse(request.body ?? "{}") as { id?: unknown; method?: string };
        const id = body.id;
        if (body.method === "collection.get") {
          return {
            body: {
              jsonrpc: "2.0",
              id,
              result: { profile: "User 1", session: "sess-9", scheduler: "fsrs" },
            },
          };
        }
        if (body.method === "decks.get") {
          return {
            body: {
              jsonrpc: "2.0",
              id,
              result: { id: "1550000000000", name: "Vocabulary", kind: "normal" },
            },
          };
        }
        if (body.method === "noteTypes.get") {
          return {
            body: {
              jsonrpc: "2.0",
              id,
              result: {
                id: "1550000000003",
                name: "Basic",
                kind: "normal",
                fields: [{ name: "Front" }, { name: "Back" }],
                templates: [
                  { name: "Card 1", questionHtml: "{{Front}}", answerHtml: "{{Back}}", deck: null },
                ],
              },
            },
          };
        }
        if (body.method === "notes.create") {
          return {
            delay: 1500,
            body: {
              jsonrpc: "2.0",
              id,
              result: { noteId: "1550000000009", cardIds: ["1550000000010"] },
            },
          };
        }
        return {
          status: 500,
          body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } },
        };
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("text:Beta");
  expect(app.requests().filter((request) => request.url.includes("8765"))).toEqual([]);
  await app.press("id:quick-translate-card-card-2 >> id:quick-translate-add-anki");
  await app.waitFor("id:quick-translate-card-card-2 >> text:Adding…");
  expect(app.shows("id:quick-translate-card-card-1 >> text:Adding…")).toBe(false);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-add-anki");
  await app.waitFor("id:quick-translate-card-card-2 >> text:Added to Anki");
  expect(app.shows("id:quick-translate-card-card-1 >> text:Added to Anki")).toBe(false);
  const creates = app.requests().filter((request) => (request.body ?? "").includes("notes.create"));
  expect(creates).toHaveLength(1);
  const created = JSON.parse(creates[0]!.body ?? "") as {
    params: { fields: Record<string, string> };
  };
  expect(created.params.fields.Front).toBe("Hello");
  expect(created.params.fields.Back).toBe("Beta");
});

function wordbookBinding(enabled: boolean): string {
  return JSON.stringify({
    version: 1,
    enabled,
    profile: "User 1",
    deckId: "1550000000000",
    deckName: "Vocabulary",
    noteTypeId: "1550000000003",
    noteTypeName: "Basic",
    sourceField: "Front",
    translationField: "Back",
  });
}

function ankiReadNetwork(create: {
  body: unknown;
  delay?: number;
}): (request: StubRequest) => StubResponse {
  return (request): StubResponse => {
    const body = JSON.parse(request.body ?? "{}") as { id?: unknown; method?: string };
    const id = body.id;
    if (body.method === "collection.get") {
      return {
        body: {
          jsonrpc: "2.0",
          id,
          result: { profile: "User 1", session: "sess-9", scheduler: "fsrs" },
        },
      };
    }
    if (body.method === "decks.get") {
      return {
        body: {
          jsonrpc: "2.0",
          id,
          result: { id: "1550000000000", name: "Vocabulary", kind: "normal" },
        },
      };
    }
    if (body.method === "noteTypes.get") {
      return {
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            id: "1550000000003",
            name: "Basic",
            kind: "normal",
            fields: [{ name: "Front" }, { name: "Back" }],
            templates: [{ name: "Card 1", deck: null }],
          },
        },
      };
    }
    if (body.method === "notes.create") {
      const payload =
        typeof create.body === "object" && create.body !== null
          ? { ...create.body, id }
          : create.body;
      return { delay: create.delay, body: payload };
    }
    return {
      status: 500,
      body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } },
    };
  };
}

test("quick anki: stays hidden when Wordbook is disabled", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      "settings.wordbook.anki.v1": wordbookBinding(false),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        body: { choices: [{ message: { content: "Alpha" } }] },
      },
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("text:Alpha");
  expect(app.shows("id:quick-translate-add-anki")).toBe(false);
  expect(app.requests().filter((request) => request.url.includes("8765"))).toEqual([]);
});

test("quick anki: a duplicate write is not marked added", async () => {
  const duplicate = {
    jsonrpc: "2.0",
    id: 4,
    error: {
      code: -32602,
      message: "Validation failed.",
      data: { type: "validationFailed", details: { issues: [{ type: "duplicate" }] } },
    },
  };
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      "quickTranslate.preferences.v1": popupPreferences({
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      "settings.wordbook.anki.v1": wordbookBinding(true),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        body: { choices: [{ message: { content: "Alpha" } }] },
      },
      ["POST " + ANKI_URL]: ankiReadNetwork({ body: duplicate }),
    },
  });
  await app.press("id:harness-tray-quick-translate");
  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("text:Alpha");
  await app.press("id:quick-translate-add-anki");
  await app.waitFor("text:This source already exists. Its translation was not changed.");
  expect(app.shows("text:Added to Anki")).toBe(false);
  expect(app.texts()).toContain("Alpha");
});

/** Baidu first with a readable saved pair, AI Vision second and eligible, for the desktop fallback case. */
function failingBaiduOcrSeed(): Record<string, string> {
  return baiduOcrSeed({
    [OCR_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["baidu", "ai"],
      channels: {
        baidu: {
          enabled: true,
          configured: true,
          config: { operation: "accurate" },
          credentialRef: BAIDU_REF,
        },
        ai: {
          enabled: true,
          configured: true,
          config: { modelId: "m-vision" },
          credentialRef: null,
        },
      },
    }),
  });
}

/** The Baidu upload rejects an expired token; the AI route answers with the same screen text. */
function failingBaiduOcrRoutes(): Record<string, StubResponse> {
  return {
    ...baiduOcrRoutes(),
    [BAIDU_OCR_URL]: { status: 401, body: { error: "invalid_access_token" } },
    ...ocrRoutes(JSON.stringify({ text: OCR_TEXT })),
  };
}

test("capability desktop: a failed Baidu OCR falls back to AI Vision and delivers the text", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: failingBaiduOcrSeed(),
    network: failingBaiduOcrRoutes(),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.press("id:quick-translate-pin");
  await app.type("id:quick-translate-source", "old draft");
  await app.press(OCR_BUTTON);
  await app.waitUntil(() => hasQuickSource(app, OCR_TEXT), { timeout: 20_000 });
  await app.waitUntil(
    () => app.requests().some((request) => request.url.includes("api.openai.com")),
    { timeout: 20_000 },
  );

  const used = app
    .requests()
    .filter(
      (request) =>
        request.url.includes("aip.baidubce.com") ||
        request.url.includes("vision.example.com") ||
        request.url.includes("api.openai.com"),
    );
  expect(used.map((request) => request.url)).toEqual([
    "https://aip.baidubce.com/oauth/2.0/token",
    "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate?access_token=fixture-token",
    "https://vision.example.com/v1/responses",
    "https://api.openai.com/v1/chat/completions",
  ]);
  const upload = used[1]!.body ?? "";
  expect(upload.includes("synthetic-api-key")).toBe(false);
  expect(upload.includes("synthetic-secret-key")).toBe(false);
  const translation = used[3]!.body ?? "";
  expect(JSON.parse(translation).messages[1].content).toBe(OCR_TEXT);
  expect(translation.includes("synthetic-api-key")).toBe(false);
  await app.waitFor("text:翻译结果", { timeout: 20_000 });
}, 90_000);

const DESKTOP_DETECTION_SAMPLE = "Bonjour le monde";
const DESKTOP_DETECTION_URL = "POST " + GOOGLE_DETECTION_URL;
const DESKTOP_TRANSLATED_TEXT = "Bonjour le monde, traduit";

test("capability desktop: Automatic language detection uses the saved detector and delivers the translation", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        sourceLanguage: "auto",
        targetLanguage: "auto",
        cards: [{ id: "card-1", presetId: quickPreset.id, templateId: null, collapsed: false }],
      }),
    },
    network: {
      [DESKTOP_DETECTION_URL]: { status: 200, body: [[DESKTOP_DETECTION_SAMPLE, "fr"]] },
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: DESKTOP_TRANSLATED_TEXT } }] },
      },
    },
  });

  // The app-level harness does not load the detection stores, so add the free Google detector
  // and save the Automatic-target preferences through Settings before opening the popup.
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-add");
  await app.press("id:settings-detection-add");
  await app.waitFor("id:settings-detection-option-google");
  await app.press("id:settings-detection-option-google");
  await app.waitFor("id:settings-detection-row-google");
  await app.press("id:settings-detection-native-language");
  await app.waitFor(`role:option[${t("presets.languages.zh")}]`);
  await app.press(`role:option[${t("presets.languages.zh")}]`);
  await app.press("id:settings-detection-preferred-language");
  await app.waitFor(`role:option[${t("presets.languages.en")}]`);
  await app.press(`role:option[${t("presets.languages.en")}]`);
  await app.waitUntil(() => {
    const record = app.storage()[DETECT_COLLECTION_STORAGE_KEY];
    if (record === undefined) return false;
    const saved = JSON.parse(record) as {
      order: string[];
      channels: Record<string, { enabled: boolean }>;
    };
    return saved.order[0] === "google" && saved.channels.google?.enabled === true;
  });
  await app.waitUntil(() => {
    const saved = JSON.parse(app.storage()[LANGUAGE_DETECTION_PREFERENCES_STORAGE_KEY] ?? "{}");
    return saved.nativeLanguage === "zh" && saved.preferredTranslationLanguage === "en";
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", DESKTOP_DETECTION_SAMPLE);
  await app.keyboard.press("enter");

  await app.waitUntil(
    () => app.requests().some((request) => request.url === GOOGLE_DETECTION_URL),
    { timeout: 20_000 },
  );
  const detection = app.requests().filter((request) => request.url === GOOGLE_DETECTION_URL);
  expect(detection).toHaveLength(1);
  expect(detection[0]!.method).toBe("POST");
  expect(detection[0]!.body).toBe(`q=${encodeURIComponent(DESKTOP_DETECTION_SAMPLE)}`);

  const detectedLabel = t("quickTranslate.autoDetectDetected", {
    language: t("presets.languages.fr"),
  });
  await app.waitFor(`id:quick-translate-source-language >> text:${detectedLabel}`, {
    timeout: 20_000,
  });

  const translations = app
    .requests()
    .filter((request) => request.url === "https://api.openai.com/v1/chat/completions");
  expect(translations).toHaveLength(1);
  const prompt = JSON.parse(translations[0]!.body!);
  expect(prompt.messages[0].content).toBe(
    `Translate from ${t("presets.languages.fr")} to ${t("presets.languages.zh")}.`,
  );
  expect(prompt.messages[1].content).toBe(DESKTOP_DETECTION_SAMPLE);
  await app.waitFor(`text:${DESKTOP_TRANSLATED_TEXT}`, { timeout: 20_000 });
}, 90_000);

test("capability desktop: Quick TTS holds the request until the window closes from its controls", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ttsWindowStorage(),
    network: {
      [QUICK_TTS_URL]: { status: 200, delay: 60_000, body: {} },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello");
  await app.press("id:quick-translate-speak-source");

  await app.waitUntil(
    () => app.requests().some((request) => request.url === GOOGLE_CLOUD_TTS_URL),
    { timeout: 20_000 },
  );
  const speech = app.requests().filter((request) => request.url === GOOGLE_CLOUD_TTS_URL);
  expect(speech).toHaveLength(1);
  expect(speech[0]!.method).toBe("POST");
  expect(speech[0]!.headers?.["x-goog-api-key"]).toBe("tts-key");
  expect(JSON.parse(speech[0]!.body!)).toEqual({
    input: { text: "Hello" },
    voice: { languageCode: "en-US", name: "en-US-Standard-C" },
    audioConfig: { audioEncoding: "MP3" },
  });

  // While the route holds the response, the source speak control offers Cancel.
  await app.waitUntil(
    () => app.accessibility("id:quick-translate-speak-source")?.label === t("common.cancel"),
    { timeout: 20_000 },
  );
  expect(app.texts()).not.toContain(t("settings.tts.stop"));

  // Close the popup with its own Escape handling, never the frameless window close button.
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state()?.visible !== true, {
    timeout: 20_000,
  });
  expect(app.texts()).not.toContain(t("settings.tts.stop"));

  // Reopening sends no new synthesis and starts no playback.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(app.texts()).not.toContain(t("settings.tts.stop"));
  expect(app.requests()).toHaveLength(1);
}, 90_000);

test("alignment window: collapsed Markdown preview opens a sentence popover that handles Escape before the window", async () => {
  if (!(await headlessHasAlignmentModel())) return;
  const source = "She opened the door. He stepped inside.";
  const target = "她打开了门。**他走了进去。**";
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      ...makeSeedStorage({
        channels: [makeChannel({ adapterId: "openai-compatible", enabled: true })],
        models: [makeModel({ enabled: true })],
        credentials: { "ch-1": "sk-test" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      "settings.language": "en",
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        doubleCopyEnabled: true,
        markdownEnabled: true,
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      [SENTENCE_ALIGNMENT_STORAGE_KEY]: "true",
      "__test.qt.doubleCopyClipboard": source,
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: target } }] },
      },
    },
    modules: {
      "langnext-native": {
        "SentenceAlignmentNative.modelReady": () => true,
        "SentenceAlignmentNative.prepareSemanticModel": () => true,
        "SentenceAlignmentNative.alignSemantic": () => [
          { sourceStart: 0, sourceEnd: 20, targetBlockIndex: 0, targetStart: 0, targetEnd: 6 },
          { sourceStart: 21, sourceEnd: 39, targetBlockIndex: 0, targetStart: 6, targetEnd: 12 },
        ],
      },
    },
  });

  await app.press("id:harness-trigger-double-copy-valid");
  await app.waitFor("id:quick-translate-source-preview");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-preview");
  expect(app.shows("id:quick-translate-source")).toBe(false);

  const seg1 = "id:quick-translate-card-card-1 >> id:result-seg-1";
  const popover = "id:quick-translate-sentence-popover";
  await app.hover(seg1);
  expect(app.viewStyle(seg1)?.backgroundColor).toBeTruthy();

  await app.press(seg1);
  await app.waitFor(popover);
  expect(app.shows(`${popover} >> text:He stepped inside.`)).toBe(true);

  // First Escape closes only the source popover; Quick Translate window stays open.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows(popover));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Second Escape closes the Quick Translate window.
  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
});

test("dictionary window: docks drawer between scroll and footer, supports history selection, and layers Escape", async () => {
  const dictBaseUrl = "https://dict.test/v1";
  const dictUrl = `POST ${dictBaseUrl}/chat/completions`;
  const saved = new Map<string, HistorySnapshot>();
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    clock: {},
    modules: {
      "langnext-native": {
        "TranslationHistoryNative.record": (
          id: string,
          sourceText: string | null,
          result: HistoryResult,
        ) => {
          if (sourceText !== null) saved.set(id, { id, sourceText, results: [] });
          saved.get(id)?.results.push(result);
        },
        "TranslationHistoryNative.listRecent": () =>
          [...saved.values()]
            .reverse()
            .map(({ id, sourceText }) => ({ id, preview: sourceText.replaceAll("\n", " ") })),
        "TranslationHistoryNative.read": (id: string) => saved.get(id) ?? null,
      },
    },
    storage: {
      ...makeSeedStorage({
        channels: [
          makeChannel({
            id: "ch-1",
            presetId: "openai",
            adapterId: "openai-compatible",
            enabled: true,
          }),
          makeChannel({
            id: "ch-dict",
            displayName: "Dict AI",
            adapterId: "openai-compatible",
            baseUrl: dictBaseUrl,
            enabled: true,
          }),
        ],
        models: [
          makeModel({
            id: "m-1",
            providerId: "ch-1",
            modelKey: "gpt-4o",
            sourceAdapterId: "openai-compatible",
            enabled: true,
          }),
          makeModel({
            id: "m-dict",
            providerId: "ch-dict",
            modelKey: "gpt-4.1-mini",
            sourceAdapterId: "openai-compatible",
            enabled: true,
          }),
        ],
        credentials: { "ch-1": "sk-test", "ch-dict": "sk-dict" },
      }),
      [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
      [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
        autoTranslate: false,
        sourceLanguage: "en",
        targetLanguage: "zh",
        cards: [{ id: "card-1", presetId: quickPreset.id }],
      }),
      [DICTIONARY_CHANNELS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        order: ["ai"],
        channels: {
          ai: {
            enabled: true,
            configured: true,
            config: { modelId: "m-dict" },
            credentialRef: null,
          },
        },
      }),
    },
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        status: 200,
        body: { choices: [{ message: { content: "Fleeting spring glory fades away today" } }] },
      },
      [dictUrl]: {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  found: true,
                  term: "ephemeral",
                  phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
                  senses: [{ partOfSpeech: "adj.", glosses: ["短暂的"] }],
                  contextSenseSummary: "此处意为“转瞬即逝”。",
                }),
              },
            },
          ],
        },
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Fame and beauty feel ephemeral right now");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Next sentence here.");
  await app.keyboard.press("enter");
  await app.waitFor(
    "id:quick-translate-card-card-1 >> text:Fleeting spring glory fades away today",
  );
  await app.waitUntil(() => [...saved.values()][0]?.results.length === 1);

  // Restore via history and select inside restored history result to open pill + drawer.
  const historyEntry =
    "role:menuitem[Fame and beauty feel ephemeral right now Next sentence here.]";
  await app.press("id:quick-translate-history");
  await app.waitFor(historyEntry);
  await app.keyboard.press("arrowdown");
  await app.keyboard.press("enter");
  await app.waitUntil(() => !app.shows(historyEntry));
  await app.waitFor("id:quick-translate-history-result-text");

  await app.drag("id:quick-translate-history-result-text", { x: -80, y: 0 });
  await app.clock!.runFor(200);
  await app.waitFor("id:quick-translate-dictionary-pill");

  // First Escape closes pill alone; drawer stays closed and window stays open.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-dictionary-pill"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Open pill again -> press pill -> opens docked drawer outside scroll above footer.
  await app.drag(
    "id:quick-translate-source >> text:Fame and beauty feel ephemeral right now >> nth=0",
    { x: -80, y: 0 },
  );
  await app.clock!.runFor(200);
  await app.waitFor("id:quick-translate-dictionary-pill");
  await app.press("id:quick-translate-dictionary-pill");
  await app.waitFor("id:quick-translate-dictionary-drawer");

  const surfaceLayout = app.layout("id:quick-translate-surface");
  const drawerLayout = app.layout("id:quick-translate-dictionary-drawer");
  const scrollLayout = app.layout("id:quick-translate-scroll");
  expect(surfaceLayout).toBeTruthy();
  expect(drawerLayout).toBeTruthy();
  if (scrollLayout && drawerLayout) {
    expect(drawerLayout.y).toBeGreaterThanOrEqual(scrollLayout.y + scrollLayout.height - 1);
  }
  const winState = app.window("quick-translate").state()!;
  expect(winState.contentBounds.size.height).toBeLessThanOrEqual(760);

  // Layered Escape: closes drawer first while window remains visible, then next Escape closes window.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-dictionary-drawer"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
});

function dictionaryAnkiStorage(wordbookEnabled: boolean, dictBaseUrl: string) {
  return {
    ...makeSeedStorage({
      channels: [
        makeChannel({
          id: "ch-1",
          presetId: "openai",
          adapterId: "openai-compatible",
          enabled: true,
        }),
        makeChannel({
          id: "ch-dict",
          displayName: "Dict AI",
          adapterId: "openai-compatible",
          baseUrl: dictBaseUrl,
          enabled: true,
        }),
      ],
      models: [
        makeModel({
          id: "m-1",
          providerId: "ch-1",
          modelKey: "gpt-4o",
          sourceAdapterId: "openai-compatible",
          enabled: true,
        }),
        makeModel({
          id: "m-dict",
          providerId: "ch-dict",
          modelKey: "gpt-4.1-mini",
          sourceAdapterId: "openai-compatible",
          enabled: true,
        }),
      ],
      credentials: { "ch-1": "sk-test", "ch-dict": "sk-dict" },
    }),
    [PRESETS_STORAGE_KEY]: JSON.stringify({ version: 1, items: [quickPreset] }),
    [QUICK_TRANSLATE_PREFERENCES_KEY]: popupPreferences({
      autoTranslate: false,
      sourceLanguage: "en",
      targetLanguage: "zh",
      cards: [{ id: "card-1", presetId: quickPreset.id }],
    }),
    [DICTIONARY_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["ai"],
      channels: {
        ai: { enabled: true, configured: true, config: { modelId: "m-dict" }, credentialRef: null },
      },
    }),
    "settings.language": "en",
    "settings.wordbook.anki.v1": wordbookBinding(wordbookEnabled),
  };
}

test("quick anki dictionary: adds source dictionary entry via unified drawer, blocks concurrent card write, and preserves format", async () => {
  const dictBaseUrl = "https://dict.test/v1";
  const dictUrl = `POST ${dictBaseUrl}/chat/completions`;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: dictionaryAnkiStorage(true, dictBaseUrl),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        body: { choices: [{ message: { content: "短暂的" } }] },
      },
      [dictUrl]: {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  found: true,
                  term: "ephemeral",
                  phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
                  senses: [
                    {
                      partOfSpeech: "adj.",
                      glosses: ["短暂的", "转瞬即逝的"],
                      example: "Fashion is by nature ephemeral.",
                      exampleTranslation: "时尚本质上是转瞬即逝的。",
                    },
                  ],
                }),
              },
            },
          ],
        },
      },
      ["POST " + ANKI_URL]: ankiReadNetwork({
        delay: 1500,
        body: { jsonrpc: "2.0", result: { noteId: "1550000000021", cardIds: ["1550000000022"] } },
      }),
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "ephemeral");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-source-toolbar >> text:/ɪˈfɛmərəl/");
  await app.waitFor("id:quick-translate-card-card-1 >> text:短暂的");

  await app.press("id:quick-translate-dictionary-open");
  await app.waitFor("id:quick-translate-dictionary-drawer >> text:US /ɪˈfɛmərəl/");

  await app.press("id:quick-translate-dictionary-drawer-add-anki");
  await app.waitUntil(
    () => app.accessibility("id:quick-translate-dictionary-drawer-add-anki")?.label === "Adding…",
  );
  expect(app.shows("id:quick-translate-dictionary-drawer >> text:Adding…")).toBe(false);
  await app.press("id:quick-translate-card-card-1 >> id:quick-translate-add-anki");
  expect(app.shows("id:quick-translate-card-card-1 >> text:Adding…")).toBe(false);

  await app.waitUntil(
    () =>
      app.accessibility("id:quick-translate-dictionary-drawer-add-anki")?.label === "Added to Anki",
  );
  expect(app.shows("id:quick-translate-dictionary-drawer >> text:Added to Anki")).toBe(false);
  expect(app.shows("id:quick-translate-card-card-1 >> text:Added to Anki")).toBe(false);
  const creates = app.requests().filter((request) => (request.body ?? "").includes("notes.create"));
  expect(creates).toHaveLength(1);
  const created = JSON.parse(creates[0]!.body ?? "") as {
    params: { fields: Record<string, string> };
  };
  expect(created.params.fields.Front).toBe("ephemeral");
  expect(created.params.fields.Back).toBe(
    "US /ɪˈfɛmərəl/<br>adj. 短暂的; 转瞬即逝的<br>Fashion is by nature ephemeral.<br>时尚本质上是转瞬即逝的。",
  );
});

test("quick anki dictionary: adds drawer entry with context sentence, hides when disabled, and handles duplicate errors", async () => {
  const dictBaseUrl = "https://dict.test/v1";
  const dictUrl = `POST ${dictBaseUrl}/chat/completions`;
  const disabledApp = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: dictionaryAnkiStorage(false, dictBaseUrl),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        body: { choices: [{ message: { content: "短暂的" } }] },
      },
      [dictUrl]: {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  found: true,
                  term: "ephemeral",
                  phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
                  senses: [{ partOfSpeech: "adj.", glosses: ["短暂的"] }],
                }),
              },
            },
          ],
        },
      },
    },
  });

  await disabledApp.press("id:harness-tray-quick-translate");
  await disabledApp.waitFor("id:quick-translate-source");
  await disabledApp.type("id:quick-translate-source", "ephemeral");
  await disabledApp.keyboard.press("enter");
  await disabledApp.waitFor("id:quick-translate-source-toolbar >> text:/ɪˈfɛmərəl/");
  await disabledApp.press("id:quick-translate-dictionary-open");
  await disabledApp.waitFor("id:quick-translate-dictionary-drawer >> text:US /ɪˈfɛmərəl/");
  expect(disabledApp.shows("id:quick-translate-dictionary-drawer-add-anki")).toBe(false);

  let createCalls = 0;
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: dictionaryAnkiStorage(true, dictBaseUrl),
    network: {
      "POST https://api.openai.com/v1/chat/completions": {
        body: { choices: [{ message: { content: "美丽转瞬即逝。" } }] },
      },
      [dictUrl]: {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  found: true,
                  term: "ephemeral",
                  phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
                  senses: [{ partOfSpeech: "adj.", glosses: ["短暂的"] }],
                  contextSenseSummary: "此处意为“短暂的”。",
                }),
              },
            },
          ],
        },
      },
      ["POST " + ANKI_URL]: (request): StubResponse => {
        const body = JSON.parse(request.body ?? "{}") as { id?: unknown; method?: string };
        if (body.method !== "notes.create") {
          return ankiReadNetwork({ body: {} })(request);
        }
        createCalls += 1;
        if (createCalls === 1) {
          return {
            body: {
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: -32602,
                message: "Validation failed.",
                data: { type: "validationFailed", details: { issues: [{ type: "duplicate" }] } },
              },
            },
          };
        }
        return {
          body: {
            jsonrpc: "2.0",
            id: body.id,
            result: { noteId: "1550000000031", cardIds: ["1550000000032"] },
          },
        };
      },
    },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Fame and beauty feel ephemeral right now");
  await app.keyboard.press("shift+enter");
  await app.type("id:quick-translate-source", "Next sentence here.");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> text:美丽转瞬即逝。");

  await app.drag(
    "id:quick-translate-source >> text:Fame and beauty feel ephemeral right now >> nth=0",
    { x: -80, y: 0 },
  );
  await app.waitFor("id:quick-translate-dictionary-pill");
  await app.press("id:quick-translate-dictionary-pill");
  await app.waitFor("id:quick-translate-dictionary-drawer >> text:US /ɪˈfɛmərəl/");

  await app.press("id:quick-translate-dictionary-drawer-add-anki");
  await app.waitFor(
    "id:quick-translate-dictionary-drawer >> text:This source already exists. Its translation was not changed.",
  );
  expect(app.shows("id:quick-translate-dictionary-drawer >> text:Added to Anki")).toBe(false);

  await app.press("id:quick-translate-dictionary-drawer-add-anki");
  await app.waitUntil(
    () =>
      app.accessibility("id:quick-translate-dictionary-drawer-add-anki")?.label === "Added to Anki",
  );
  expect(app.shows("id:quick-translate-dictionary-drawer >> text:Added to Anki")).toBe(false);
  const creates = app.requests().filter((request) => (request.body ?? "").includes("notes.create"));
  expect(creates).toHaveLength(2);
  const created = JSON.parse(creates[1]!.body ?? "") as {
    params: { fields: Record<string, string> };
  };
  expect(created.params.fields.Front).toBe("ephemeral");
  expect(created.params.fields.Back).toBe(
    "US /ɪˈfɛmərəl/<br>adj. 短暂的<br>Fame and beauty feel ephemeral right now",
  );
});
