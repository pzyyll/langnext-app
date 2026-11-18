import { expect, open, test } from "nsh/test";
import { SPLIT_RAIL_STORAGE_KEYS } from "../../components/layout/split-rail";

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

test("settings ui: groups language under General and theme under Appearance in a split view", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-page");
  expect(app.shows("id:settings-rail")).toBe(true);
  expect(app.shows("id:settings-detail")).toBe(true);
  expect(app.shows("id:settings-nav-general")).toBe(true);
  expect(app.shows("id:settings-nav-appearance")).toBe(true);

  // General is active by default and displays Language only.
  expect(app.shows("id:settings-general-card")).toBe(true);
  expect(app.shows("id:language-system")).toBe(true);
  expect(app.shows("id:settings-theme-card")).toBe(false);
  expect(app.shows("id:theme-dark")).toBe(false);

  // Switching to Appearance shows Theme and transparency controls without Language.
  await app.press("id:settings-nav-appearance");
  expect(app.shows("id:settings-theme-card")).toBe(true);
  expect(app.shows("id:settings-transparency-card")).toBe(true);
  expect(app.shows("id:theme-dark")).toBe(true);
  expect(app.shows("id:settings-general-card")).toBe(false);
  expect(app.texts()).toContain("Theme");

  // Active category stays selected across sidebar destination switches in the same session.
  await app.press("id:nav-models");
  await app.waitFor("id:models-page");
  await app.press("id:nav-settings");
  await app.waitFor("id:settings-theme-card");
  expect(app.shows("id:theme-dark")).toBe(true);

  // Switching back to General restores Language and verifies zh-CN labels across both categories.
  await app.press("id:settings-nav-general");
  await app.press("id:language-zh-CN");
  expect(app.texts()).toContain("通用");
  expect(app.texts()).toContain("语言");
  await app.press("id:settings-nav-appearance");
  expect(app.texts()).toContain("外观");
  expect(app.texts()).toContain("主题");
  expect(app.texts()).toContain("透明标题栏与侧边栏");
});

test("settings ui: resizes the settings split divider and persists width independently", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [SPLIT_RAIL_STORAGE_KEYS.models]: "210",
      [SPLIT_RAIL_STORAGE_KEYS.presets]: "225",
    },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-rail");
  await app.waitFor("label:Resize settings panel");

  await app.drag("label:Resize settings panel", { x: 80 });
  await app.waitUntil(() => Boolean(app.storage()[SPLIT_RAIL_STORAGE_KEYS.settings]));
  const resized = Number(app.storage()[SPLIT_RAIL_STORAGE_KEYS.settings]);
  expect(resized).toBeGreaterThan(240);
  expect(resized).toBeLessThanOrEqual(360);
  expect(app.storage()[SPLIT_RAIL_STORAGE_KEYS.models]).toBe("210");
  expect(app.storage()[SPLIT_RAIL_STORAGE_KEYS.presets]).toBe("225");

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  await reopened.press("id:nav-settings");
  await reopened.waitFor("id:settings-rail");
  expect(reopened.storage()[SPLIT_RAIL_STORAGE_KEYS.settings]).toBe(String(resized));

  await reopened.setViewport(720, 520);
  expect(reopened.shows("id:settings-rail")).toBe(true);
  expect(reopened.shows("id:settings-detail")).toBe(true);
});

test("settings ui: renders cleanly at the minimum viewport in dark mode with reduced motion", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    width: 720,
    height: 520,
    colorScheme: "dark",
    reducedMotion: true,
    storage: { "settings.language": "zh-CN" },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-general-card");
  expect(app.shows("id:language-zh-CN")).toBe(true);

  await app.press("id:settings-nav-appearance");
  await app.waitFor("id:settings-theme-card");
  expect(app.shows("id:theme-dark")).toBe(true);
  expect(app.shows("id:settings-transparency-card")).toBe(true);
});
