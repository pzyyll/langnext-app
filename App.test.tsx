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

test("switches sidebar destinations with keyboard shortcuts", async () => {
  const app = await open("./App.tsx", viewport);
  await app.keyboard.press("mod+,");
  expect(app.texts()).toContain("Appearance");
  expect(app.shows("id:home-page")).toBe(false);
  await app.keyboard.press("mod+1");
  expect(app.shows("id:home-page")).toBe(true);
  expect(app.texts()).not.toContain("Appearance");
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

test("shows the sidebar tooltip on hover", async () => {
  const app = await open("./App.tsx", viewport);
  await app.press("id:nav-settings");
  await app.hover("id:theme-light");
  await app.hover("id:nav-settings");
  await app.waitFor("id:settings-tooltip");
  expect(app.texts().filter((text) => text === "Settings")).toHaveLength(2);
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
