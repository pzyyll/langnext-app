import type { WindowRef, WindowState } from "nsh/desktop";
import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";
import { makeChannel, makeModel, makeSeedStorage } from "../features/models/__tests__/fixtures";
import { PRESETS_STORAGE_KEY } from "../features/presets/store";
import type { TranslationPreset } from "../features/presets/types";
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
  await app.keyboard.press("ctrl+shift+t");
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
  expect(app.shows("id:quick-translate-header >> id:quick-translate-add-preset")).toBe(true);
  await app.waitUntil(() => height() > 0 && height() < 220);
  const compactHeight = height();
  const width = state().contentBounds.size.width;

  await app.press("id:quick-translate-header >> id:quick-translate-add-preset");
  await app.press("id:quick-translate-add-preset-option-preset-1");
  await app.waitFor(secondCard);
  await app.waitUntil(() => height() > compactHeight);
  await app.press(`${secondCard} >> id:quick-translate-remove`);
  await app.waitUntil(() => Math.abs(height() - compactHeight) < 1);

  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor(`${firstCard} >> id:quick-translate-result-text`);
  // The test driver's WindowState exposes the display ID; read its work area in the app.
  const work = app.texts().find((value) => value.startsWith("quick-work-area:"))!;
  const [, workTop, workHeight] = work.split(":").map(Number);
  await app.waitUntil(() => Math.abs(state().bounds.size.height - workHeight!) < 1);
  expect(Math.abs(state().bounds.origin.y - workTop!)).toBeLessThan(1);
  expect(state().contentBounds.size.width).toBe(width);

  await app.press(`${firstCard} >> id:quick-translate-collapse`);
  await app.waitUntil(() => Math.abs(height() - compactHeight) < 1);
  await app.press(`${firstCard} >> id:quick-translate-collapse`);
  await app.waitUntil(() => Math.abs(state().bounds.size.height - workHeight!) < 1);
  expect(state().contentBounds.size.width).toBe(width);

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
  await app.waitFor("id:quick-translate-language-menu");
  await app.press("id:quick-translate-language-menu");
  await app.waitFor("id:quick-translate-source-language");
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Hovering a submenu opens language options inside the popup without blur dismissal.
  await app.hover("id:quick-translate-source-language");
  await app.waitFor("id:quick-translate-source-language-en");
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // First Escape closes submenu, second closes menu; window stays open throughout.
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-source-language-en"));
  expect(app.shows("id:quick-translate-source-language")).toBe(true);
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-source-language"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Reopen menu, pick a target language via submenu, and translate by pressing Enter.
  await app.press("id:quick-translate-language-menu");
  await app.waitFor("id:quick-translate-target-language");
  await app.hover("id:quick-translate-target-language");
  await app.waitFor("id:quick-translate-target-language-ja");
  await app.press("id:quick-translate-target-language-ja");
  await app.waitUntil(() => !app.shows("id:quick-translate-target-language"));
  expect(app.shows("label:Languages (English → Japanese)")).toBe(true);

  await app.type("id:quick-translate-source", "Hello");
  await app.keyboard.press("enter");
  await app.waitFor("id:quick-translate-card-card-1 >> id:quick-translate-result-text");
  expect(app.texts()).toContain("こんにちは");

  // Reopen Add preset menu in the title bar and confirm Escape closes it without blur dismissal.
  await app.press("id:quick-translate-header >> id:quick-translate-add-preset");
  await app.waitFor("id:quick-translate-add-preset-option-preset-1");
  expect(app.window("quick-translate").state()?.visible).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-add-preset-option-preset-1"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  // Reopen menu without submenu and confirm Escape dismisses menu, then Escape closes window.
  await app.press("id:quick-translate-language-menu");
  await app.waitFor("id:quick-translate-source-language");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("id:quick-translate-source-language"));
  expect(app.window("quick-translate").state()?.visible).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => app.window("quick-translate").state() === null);
});

test("desktop: quick window remains available while main window is hidden and registers Windows shortcut once across locale changes", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  expect(app.texts().join(" ")).toContain("reg=1|");
  expect(app.texts().join(" ")).toContain("shortcut=ctrl+shift+t|tray=Quick Translate,Exit");

  await app.press("id:nav-settings");
  await app.press("id:language-zh-CN");
  await app.waitUntil(() => app.texts().some((text) => text.includes("tray=快速翻译,退出")));
  expect(app.texts().join(" ")).toContain("reg=1|");

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

test("desktop: quick window unregisters global shortcut on shell disposal", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.waitFor("id:harness-metrics");
  await app.press("id:harness-dispose-shell");
  await app.waitUntil(() => app.texts().some((text) => text.includes("unreg=1|")));
});

test("desktop: quick window warns and keeps tray fallback when global shortcut returns false or rejects, and skips non-Windows", async () => {
  const denied = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [HARNESS_SHORTCUT_MODE_KEY]: "false",
    },
  });
  await denied.waitUntil(() => denied.texts().includes(t("quickTranslate.shortcutUnavailable")));
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
    rejected.texts().includes("全局快捷键 Ctrl+Shift+T 不可用，请通过托盘菜单打开快速翻译。"),
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
  expect(controller.sourceDeliverySeq()).toBe(0);

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
  expect(controller.sourceDeliverySeq()).toBe(1);
  firstPending.resolve("Stale first text");
  await slowFirst;
  expect(controller.sourceText()).toBe("Fresh second text");
  expect(controller.sourceDeliverySeq()).toBe(1);

  // 6. Slow read superseded by manual edit -> preserves manual draft.
  const manualRace = controller.activateDoubleCopy({ hasValidCopy: true });
  expect(readCalls).toBe(5);
  controller.setSourceText("Manual override");
  pendingReads.shift()!.resolve("Late clipboard text");
  await manualRace;
  expect(controller.sourceText()).toBe("Manual override");
  expect(controller.sourceDeliverySeq()).toBe(1);
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
