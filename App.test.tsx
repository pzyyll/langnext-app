import { expect, open, test } from "nsh/test";

const viewport = { width: 1040, height: 720, platform: "windows" as const };
const transparencySwitch = "role:switch[Transparent title bar and sidebar]";
const transparencyKey = "settings.transparency";

test("opens Models by default and switches between sidebar destinations", async () => {
  const app = await open("./App.tsx", viewport);
  expect(app.shows("id:models-page")).toBe(true);
  expect(app.texts()).not.toContain("Appearance");

  await app.press("role:button[Settings]");
  expect(app.shows("id:models-page")).toBe(false);
  expect(app.texts()).toContain("Appearance");

  await app.press("role:button[Models]");
  expect(app.shows("id:models-page")).toBe(true);
  expect(app.texts()).not.toContain("Appearance");

  await app.press("role:button[Models]");
  expect(app.count("id:models-page")).toBe(1);
});

test("opens About from the app menu and closes it with OK", async () => {
  const app = await open("./App.tsx", viewport);
  expect(app.shows("id:about-dialog")).toBe(false);
  expect(app.shows("role:menuitem[About]")).toBe(false);

  await app.press("role:button[App menu]");
  await app.waitFor("role:menuitem[About]");
  await app.press("role:menuitem[About]");
  await app.waitFor("role:dialog[About My Translator]");
  expect(app.shows("role:menuitem[About]")).toBe(false);
  expect(app.texts()).toContain("My Translator");
  expect(app.texts()).toContain("Version 0.1.0");

  await app.press("role:button[OK]");
  await app.waitUntil(() => !app.shows("id:about-dialog"));
  expect(app.shows("id:models-page")).toBe(true);
});

test("dismisses the app menu and can reopen About after Escape", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    width: 720,
    height: 520,
    colorScheme: "dark",
    reducedMotion: true,
  });
  await app.press("role:button[App menu]");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("role:menuitem[About]"));
  expect(app.shows("id:about-dialog")).toBe(false);

  for (let attempt = 0; attempt < 2; attempt++) {
    await app.press("role:button[App menu]");
    await app.press("role:menuitem[About]");
    await app.waitFor("id:about-dialog");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:about-dialog"));
  }
  expect(app.shows("id:models-page")).toBe(true);
});

test("does not switch sidebar destinations with removed keyboard shortcuts", async () => {
  const app = await open("./App.tsx", viewport);
  for (const shortcut of ["mod+,", "mod+1"]) {
    await app.keyboard.press(shortcut);
    expect(app.shows("id:models-page")).toBe(true);
    expect(app.texts()).not.toContain("Appearance");
  }

  await app.press("id:nav-settings");
  for (const shortcut of ["mod+,", "mod+1"]) {
    await app.keyboard.press(shortcut);
    expect(app.texts()).toContain("Appearance");
    expect(app.shows("id:models-page")).toBe(false);
  }
});

test("switches pages at the minimum window size with reduced motion", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    width: 720,
    height: 520,
    reducedMotion: true,
  });
  expect(app.shows("id:models-page")).toBe(true);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Appearance");
  await app.press("id:nav-models");
  expect(app.shows("id:models-page")).toBe(true);
});

test("opens settings from the sidebar", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Settings");
  expect(app.texts()).toContain("Appearance");
});

test("opens the models page from the sidebar", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  expect(app.shows("id:models-page")).toBe(false);

  await app.press("id:nav-models");
  expect(app.shows("id:models-page")).toBe(true);
  expect(app.texts()).toContain("Models");
  expect(app.texts()).not.toContain("Appearance");
});

test("shows the sidebar tooltip on hover", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  await app.hover("id:theme-light");
  await app.hover("id:nav-settings");
  await app.waitFor("id:settings-tooltip");
  expect(app.texts().filter((text) => text === "Settings")).toHaveLength(2);
  expect(app.texts().some((text) => text.includes("Ctrl"))).toBe(false);
  await app.hover("id:theme-light");
  await app.waitUntil(() => !app.shows("id:settings-tooltip"));
});

test("switches themes and keeps the selected preference", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  await app.press("id:theme-dark");
  expect(app.storage()["settings.appearance"]).toBe("dark");
  await app.press("id:nav-models");
  expect(app.shows("id:models-page")).toBe(true);
  await app.press("id:nav-settings");
  expect(app.storage()["settings.appearance"]).toBe("dark");
  const dark = app.spanStyle("text:Settings").color;

  await app.setColorScheme("light");
  expect(app.spanStyle("text:Settings").color).toBe(dark);

  await app.press("id:theme-light");
  expect(app.spanStyle("text:Settings").color).not.toBe(dark);
  expect(app.storage()["settings.appearance"]).toBe("light");

  await app.press("id:theme-system");
  await app.setColorScheme("dark");
  expect(app.spanStyle("text:Settings").color).toBe(dark);
  await app.setColorScheme("light");
  expect(app.spanStyle("text:Settings").color).not.toBe(dark);
  expect(app.storage()["settings.appearance"]).toBe("system");
});

test("restores the saved appearance before showing settings", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    colorScheme: "light",
    storage: { "settings.appearance": "dark" },
  });
  const light = await open("./App.tsx", { ...viewport, colorScheme: "light" });
  await light.press("id:nav-settings");

  expect(app.shows("id:models-page")).toBe(true);
  await app.press("id:nav-settings");
  expect(app.spanStyle("text:Settings").color).not.toBe(light.spanStyle("text:Settings").color);
});

test("toggles transparency and keeps the choice across pages and theme changes", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  expect(app.shows(transparencySwitch)).toBe(true);

  await app.press(transparencySwitch);
  expect(app.storage()[transparencyKey]).toBe("false");
  await app.press("id:theme-dark");
  expect(app.storage()[transparencyKey]).toBe("false");
  await app.press("id:nav-models");
  await app.press("id:nav-settings");

  await app.press(transparencySwitch);
  expect(app.storage()[transparencyKey]).toBe("true");
  expect(app.storage()["settings.appearance"]).toBe("dark");

  const reopened = await open("./App.tsx", { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press(transparencySwitch);
  expect(reopened.storage()[transparencyKey]).toBe("false");
});

test("restores disabled transparency at the minimum size with reduced motion", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    width: 720,
    height: 520,
    reducedMotion: true,
    storage: { [transparencyKey]: "false" },
  });
  await app.press("id:nav-settings");
  await app.press(transparencySwitch);
  expect(app.storage()[transparencyKey]).toBe("true");
  await app.press(transparencySwitch);
  expect(app.storage()[transparencyKey]).toBe("false");
});

test("enables transparency when the saved value is invalid", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    storage: { [transparencyKey]: "invalid" },
  });
  await app.press("id:nav-settings");
  await app.press(transparencySwitch);
  expect(app.storage()[transparencyKey]).toBe("false");
});

test("follows the user's language until one is picked", async () => {
  const app = await open("./App.tsx", { ...viewport, locale: "zh-CN" });
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("设置");
  expect(app.texts()).toContain("外观");
  expect(app.texts()).toContain("语言");
});

test("switches the interface language and keeps the choice", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Settings");

  await app.press("id:language-zh-CN");
  expect(app.storage()["settings.language"]).toBe("zh-CN");
  expect(app.texts()).toContain("设置");
  expect(app.texts()).not.toContain("Settings");

  await app.press("id:nav-models");
  expect(app.texts()).toContain("模型");

  const reopened = await open("./App.tsx", { ...viewport, storage: app.storage() });
  expect(reopened.shows("id:models-page")).toBe(true);
  expect(reopened.texts()).toContain("模型");

  await reopened.press("id:nav-settings");
  expect(reopened.texts()).toContain("语言");

  await reopened.press("id:language-en");
  expect(reopened.storage()["settings.language"]).toBe("en");
  expect(reopened.texts()).toContain("Settings");
  expect(reopened.texts()).not.toContain("设置");
});

test("uses the system appearance when the saved value is invalid", async () => {
  const dark = await open("./App.tsx", { ...viewport, colorScheme: "dark" });
  await dark.press("id:nav-settings");

  const app = await open("./App.tsx", {
    ...viewport,
    colorScheme: "dark",
    storage: { "settings.appearance": "invalid" },
  });
  await app.press("id:nav-settings");
  expect(app.spanStyle("text:Settings").color).toBe(dark.spanStyle("text:Settings").color);
});

test("presets nav: opens the workspace from Models", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  expect(app.shows("id:models-page")).toBe(true);
  expect(app.shows("id:presets-page")).toBe(false);

  await app.press("id:nav-presets");
  await app.waitFor("id:presets-page");
  expect(app.shows("id:models-page")).toBe(false);
  expect(app.count("id:presets-page")).toBe(1);
  expect(app.texts()).toContain("Presets");
  expect(app.shows("id:empty-add-preset-button")).toBe(true);

  await app.press("id:nav-presets");
  expect(app.count("id:presets-page")).toBe(1);
});

test("page surface: keeps work-area background opaque across destination switches", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  const modelsSurface = app.viewStyle("id:models-page");
  expect(modelsSurface?.backgroundColor).toBeDefined();
  expect(modelsSurface?.opacity).toBe(1);
  expect(modelsSurface?.effectiveOpacity).toBe(1);

  await app.press("id:nav-presets");
  await app.waitFor("id:presets-page");
  const presetsSurface = app.viewStyle("id:presets-page");
  expect(presetsSurface?.backgroundColor).toBe(modelsSurface?.backgroundColor);
  expect(presetsSurface?.opacity).toBe(1);
  expect(presetsSurface?.effectiveOpacity).toBe(1);

  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Appearance");

  await app.press("id:nav-models");
  await app.waitFor("id:models-page");
  expect(app.viewStyle("id:models-page")).toEqual(modelsSurface);
});
