import { expect, open, test } from "nsh/test";

const viewport = { width: 1040, height: 720, platform: "windows" as const };

test("opens Home by default and switches between sidebar destinations", async () => {
  const app = await open("./App.tsx", viewport);
  expect(app.shows("id:home-page")).toBe(true);
  expect(app.texts()).toContain("Translation example");
  expect(app.texts()).not.toContain("Appearance");
  const selected = app.spanStyle("id:nav-home >> text:M").color;

  await app.press("role:button[Settings]");
  expect(app.shows("id:home-page")).toBe(false);
  expect(app.texts()).toContain("Appearance");
  expect(app.spanStyle("id:nav-home >> text:M").color).not.toBe(selected);

  await app.press("role:button[Home]");
  expect(app.shows("id:home-page")).toBe(true);
  expect(app.texts()).not.toContain("Appearance");
  expect(app.spanStyle("id:nav-home >> text:M").color).toBe(selected);

  await app.press("role:button[Home]");
  expect(app.count("id:home-page")).toBe(1);
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
  expect(app.shows("id:home-page")).toBe(true);
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
  expect(app.shows("id:home-page")).toBe(true);
});

test("does not switch sidebar destinations with removed keyboard shortcuts", async () => {
  const app = await open("./App.tsx", viewport);
  for (const shortcut of ["mod+,", "mod+1"]) {
    await app.keyboard.press(shortcut);
    expect(app.shows("id:home-page")).toBe(true);
    expect(app.texts()).not.toContain("Appearance");
  }

  await app.press("id:nav-settings");
  for (const shortcut of ["mod+,", "mod+1"]) {
    await app.keyboard.press(shortcut);
    expect(app.texts()).toContain("Appearance");
    expect(app.shows("id:home-page")).toBe(false);
  }
});

test("switches pages at the minimum window size with reduced motion", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    width: 720,
    height: 520,
    reducedMotion: true,
  });
  expect(app.shows("id:home-page")).toBe(true);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Appearance");
  await app.press("id:nav-home");
  expect(app.texts()).toContain("Translation example");
});

test("opens settings from the sidebar", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Settings");
  expect(app.texts()).toContain("Appearance");
  expect(app.texts()).toContain("Following system · light");
});

test("opens the models page from the sidebar", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-models");
  expect(app.shows("id:models-page")).toBe(true);
  expect(app.shows("id:home-page")).toBe(false);
  expect(app.texts()).toContain("Models");

  await app.press("id:nav-home");
  expect(app.shows("id:home-page")).toBe(true);
  expect(app.shows("id:models-page")).toBe(false);
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
  expect(app.texts()).toContain("Dark theme");
  expect(app.storage()["settings.appearance"]).toBe("dark");
  await app.press("id:nav-home");
  expect(app.shows("id:home-page")).toBe(true);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Dark theme");
  const dark = app.spanStyle("text:Settings").color;

  await app.setColorScheme("light");
  expect(app.spanStyle("text:Settings").color).toBe(dark);

  await app.press("id:theme-light");
  expect(app.texts()).toContain("Light theme");
  expect(app.spanStyle("text:Settings").color).not.toBe(dark);
  expect(app.storage()["settings.appearance"]).toBe("light");

  await app.press("id:theme-system");
  await app.setColorScheme("dark");
  expect(app.texts()).toContain("Following system · dark");
  expect(app.spanStyle("text:Settings").color).toBe(dark);
  await app.setColorScheme("light");
  expect(app.texts()).toContain("Following system · light");
  expect(app.storage()["settings.appearance"]).toBe("system");
});

test("restores the saved appearance before showing settings", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    colorScheme: "light",
    storage: { "settings.appearance": "dark" },
  });
  expect(app.shows("id:home-page")).toBe(true);
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Dark theme");
});

test("uses the system appearance when the saved value is invalid", async () => {
  const app = await open("./App.tsx", {
    ...viewport,
    colorScheme: "dark",
    storage: { "settings.appearance": "invalid" },
  });
  await app.press("id:nav-settings");
  expect(app.texts()).toContain("Following system · dark");
});
