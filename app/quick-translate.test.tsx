import type { WindowRef, WindowState } from "nsh/desktop";
import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { makeChannel, makeModel, makeSeedStorage } from "../features/models/__tests__/fixtures";
import { baiduCredentialStorageKey } from "../features/ocr/settings";
import { PRESETS_STORAGE_KEY } from "../features/presets/store";
import type { TranslationPreset } from "../features/presets/types";
import {
  DEFAULT_QUICK_TRANSLATE_SHORTCUT,
  DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT,
  DEFAULT_SELECTION_TRANSLATE_SHORTCUT,
  formatShortcut,
  QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY,
  SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY,
  SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY,
} from "../features/settings/shortcuts";
import { createQuickTranslateController, POPUP_MIN_SIZE } from "./quick-translate-controller";

const HARNESS_ENTRY = "./__tests__/quick-translate-harness.tsx";
const HARNESS_SHORTCUT_MODE_KEY = "__test.qt.shortcutMode";
const HARNESS_PLATFORM_OS_KEY = "__test.qt.platformOs";
const viewport = { width: 1040, height: 720, platform: "windows" as const };
const AUTO_TRANSLATE_DEBOUNCE_MS = 500;

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
  await app.waitUntil(() => app.window("quick-translate").state()?.visible === true);

  const firstState = app.window("quick-translate").state()!;
  expect(firstState.visible).toBe(true);
  expect(firstState.focused).toBe(true);
  expect(Math.abs(firstState.contentBounds.size.width - 420)).toBeLessThan(1);
  expect(firstState.display).toBeDefined();
  expect(firstState.display).toBe(app.window("main").state()?.display);

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "Hello quick window");
  expect(app.value("id:quick-translate-source")).toBe("Hello quick window");

  // Re-invoking shortcut while unpinned focuses and preserves existing draft.
  await app.keyboard.press(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.window("quick-translate").state()?.focused).toBe(true);
  expect(app.value("id:quick-translate-source")).toBe("Hello quick window");
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
  await app.type("id:quick-translate-source", "Draft to clear on close");
  await app.press("id:quick-translate-pin");
  await app.press("id:nav-models");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.shows("id:models-page")).toBe(true);

  await app.press("id:quick-translate-close");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);

  // Reopen confirms pin reset and empty draft.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(app.value("id:quick-translate-source")).toBe("");
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
  await app.type("id:quick-translate-source", "Draft to clear on close");
  await app.press("id:quick-translate-pin");
  await app.press("id:nav-models");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  expect(app.shows("id:models-page")).toBe(true);

  await app.press("id:quick-translate-close");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
  expect(app.window("main").state()?.visible).toBe(true);

  // Reopen confirms pin reset (pressing Pin again selects it fresh) and cleared source.
  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");
  expect(app.value("id:quick-translate-source")).toBe("");
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
          `shortcuts=${DEFAULT_QUICK_TRANSLATE_SHORTCUT},${DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT},${DEFAULT_SELECTION_TRANSLATE_SHORTCUT}|tray=Quick Translate,Exit`,
        ),
      ),
  );
  expect(app.texts().join(" ")).toContain("|reg=3|");

  await app.press("id:nav-settings");
  await app.press("id:language-zh-CN");
  await app.waitUntil(() => app.texts().some((text) => text.includes("tray=快速翻译,退出")));
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
  expect(controller.sourceText()).toBe("");

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
  expect(controller.sourceText()).toBe("");
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
  expect(controller.sourceText()).toBe("");
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
  expect(app.shows("id:quick-translate-source")).toBe(false);
  expect(app.texts()).toContain("Clipboard manual text");
  // Double Ctrl+C is an explicit translation request, even with Auto-translate off.
  await app.waitFor("id:quick-translate-result-text");
  expect(app.texts()).toContain("Translated ok");
  expect(app.requests()).toHaveLength(1);

  // Pin before triggering harness controls on main window so blur does not close & clear draft.
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
  expect(app.value("id:quick-translate-source")).toBe("Clipboard manual text");
  await app.type("id:quick-translate-source", "!");
  expect(app.value("id:quick-translate-source")).toBe("Clipboard manual text!");
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
  expect(app.value("id:quick-translate-source")).toBe("Second copied phrase");
  await app.waitFor("id:quick-translate-result-text");
  expect(app.texts()).toContain("Translated ok");
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

const HARNESS_OCR_CAPTURE_KEY = "__test.qt.ocrCapture";
const OCR_STORAGE_KEY = "settings.ocr.v3";
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
    [OCR_STORAGE_KEY]: JSON.stringify({
      version: 3,
      order: ["ai", "baidu"],
      enabled: { ai: true, baidu: false },
      ai: { modelId: "m-vision" },
      baidu: null,
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
  expect(app.texts()).toContain("Selected line one");
  expect(app.shows("id:quick-translate-source")).toBe(false);
  await app.waitUntil(() => app.requests().length === 1);
  expect(JSON.parse(app.requests()[0]!.body!).messages[1].content).toBe(selected);
  expect(app.texts().join(" ")).toContain("dcReads=0|");
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
  expect(lateSelection.value("id:quick-translate-source")).toBe(OCR_TEXT);
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
  expect(emptySelection.value("id:quick-translate-source")).toBe(OCR_TEXT);
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
  await app.waitUntil(() => app.value("id:quick-translate-source") === OCR_TEXT);
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
  await app.waitUntil(() => app.value("id:quick-translate-source") === OCR_TEXT);

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

  expect(app.value("id:quick-translate-source")).toBe("kept draft");
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
  expect(app.value("id:quick-translate-source")).toBe("kept draft");
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

  expect(app.value("id:quick-translate-source")).toBe("kept draft");
  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: typing during recognition wins over the late answer, and repeat presses wait", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: ocrSeed(),
    network: ocrRoutes(JSON.stringify({ text: OCR_TEXT }), 1_200),
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source");

  await app.press(OCR_BUTTON);
  await app.waitUntil(() => app.texts().some((line) => line.includes("ocrCap=1")));

  // While the model reads the crop, the action is disabled: one session at a time.
  await app.waitFor(OCR_BUTTON);
  expect(app.enabled(OCR_BUTTON)).toBe(false);

  await app.waitFor("id:quick-translate-source");
  await app.type("id:quick-translate-source", "typed instead");
  await app.wait(1_400);

  expect(app.value("id:quick-translate-source")).toBe("typed instead");
  expect(app.texts().some((line) => line.includes("ocrCap=1"))).toBe(true);
  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
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
  expect(app.value("id:quick-translate-source")).toBe("");

  await app.wait(400);
  expect(app.value("id:quick-translate-source")).toBe("");
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
  await app.waitUntil(() => app.value("id:quick-translate-source") === OCR_TEXT);
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
  await app.waitUntil(() => app.value("id:quick-translate-source") === OCR_TEXT);

  expect(app.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: an unsaved service shows recovery and never captures", async () => {
  const seed: Record<string, string> = { ...ocrSeed() };
  delete seed[OCR_STORAGE_KEY];
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
  expect(app.value("id:quick-translate-source")).toBe("kept draft");
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
    [OCR_STORAGE_KEY]: JSON.stringify({
      version: 3,
      order: ["baidu", "ai"],
      enabled: { ai: false, baidu: true },
      ai: null,
      baidu: { operation: "accurate", credentialRef: BAIDU_REF },
    }),
    [baiduCredentialStorageKey(BAIDU_REF)]: JSON.stringify({
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
  await app.waitUntil(() => app.value("id:quick-translate-source") === OCR_TEXT);

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
  expect(cancelled.value("id:quick-translate-source")).toBe("kept draft");
  expect(cancelled.requests()).toHaveLength(0);

  const late = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed(),
    network: baiduOcrRoutes({ delay: 1_200 }),
  });
  await late.press("id:harness-tray-quick-translate");
  await late.waitFor("id:quick-translate-source");
  await late.press(OCR_BUTTON);
  await late.waitUntil(() => late.texts().some((line) => line.includes("ocrCap=1")));
  await late.waitFor("id:quick-translate-source");
  await late.type("id:quick-translate-source", "typed instead");
  await late.wait(1_400);
  expect(late.value("id:quick-translate-source")).toBe("typed instead");
  expect(late.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );

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
  expect(quota.value("id:quick-translate-source")).toBe("kept draft");
  expect(quota.requests().filter((request) => request.url.includes("api.openai.com"))).toHaveLength(
    0,
  );
});

test("quick ocr: falls back from primary Baidu quota failure to backup AI and translates once", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: baiduOcrSeed({
      [OCR_STORAGE_KEY]: JSON.stringify({
        version: 3,
        order: ["baidu", "ai"],
        enabled: { ai: true, baidu: true },
        ai: { modelId: "m-vision" },
        baidu: { operation: "accurate", credentialRef: BAIDU_REF },
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
  await app.waitUntil(() => app.value("id:quick-translate-source") === OCR_TEXT);
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
