import { t } from "nsh/i18n";
import { expect, open, test } from "nsh/test";

const HARNESS_ENTRY = "./__tests__/quick-translate-harness.tsx";
const HARNESS_SHORTCUT_MODE_KEY = "__test.qt.shortcutMode";
const HARNESS_PLATFORM_OS_KEY = "__test.qt.platformOs";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

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
  expect(firstState.contentBounds.size).toEqual({ width: 420, height: 360 });
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

test("desktop: quick window pins, survives focus switch, resets pin on close, and closes via Escape and OS close without quitting app", async () => {
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

  await app.window("quick-translate").pressClose();
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

test("desktop: quick window Select overlay does not trigger blur dismissal and Escape dismisses menu before closing window", async () => {
  const app = await open(HARNESS_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:harness-tray-quick-translate");
  await app.waitFor("id:quick-translate-source-language");
  await app.press("id:quick-translate-source-language");
  await app.waitFor("role:option[English]");

  expect(app.window("quick-translate").state()?.visible).toBe(true);

  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("role:option[English]"));
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
  await app.window("quick-translate").pressClose();
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
