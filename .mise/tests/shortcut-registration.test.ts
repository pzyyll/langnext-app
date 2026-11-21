import { expect, open, test } from "nsh/test";
import {
  QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY,
  SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY,
  SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY,
} from "../../features/settings/shortcuts";

// Run with --target windows. Headless NSH does not answer native hotkey registration.
test("Windows records and registers independent translation shortcuts", async () => {
  const app = await open("../../App.tsx", {
    width: 1040,
    height: 720,
    platform: "windows",
    storage: {
      "settings.language": "en",
      [QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]: "alt+shift+f8",
    },
  });
  const record = "id:settings-quick-translate-shortcut-record";
  const error = "id:settings-quick-translate-shortcut-error";
  const edit = "role:button[Edit shortcut for Open Quick Translate]";
  const listening = "role:button[Press a shortcut]";
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.waitUntil(() => app.enabled(record));
  expect(app.texts()).toContain("Alt+Shift+F8");

  await app.press(record);
  await app.waitFor(listening);
  await app.keyboard.press("escape");
  await app.waitFor(edit);
  expect(app.texts()).toContain("Alt+Shift+F8");

  await app.keyboard.press("enter");
  await app.waitFor(listening);
  await app.press("role:button[Cancel]");
  await app.waitFor(edit);
  expect(app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("alt+shift+f8");

  await app.press(record);
  await app.waitFor(listening);
  await app.keyboard.press("tab");
  await app.waitFor(edit);

  await app.press(record);
  await app.keyboard.press("ctrl+c");
  await app.waitFor(error);
  expect(app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("alt+shift+f8");
  await app.keyboard.press("alt+shift+f9");
  await app.waitUntil(() => app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY] === "alt+shift+f9");
  expect(app.texts()).toContain("Alt+Shift+F9");
  expect(app.shows(error)).toBe(false);
  expect(app.shows("role:button[Save]")).toBe(false);

  const clear = "role:button[Clear shortcut for Open Quick Translate]";
  await app.press(clear);
  await app.waitFor("id:settings-quick-translate-shortcut-unassigned");
  expect(app.shows(clear)).toBe(false);
  expect(app.shows("role:button[Restore default shortcut for Open Quick Translate]")).toBe(true);
  expect(
    app.shows(
      "id:settings-translation-shortcuts-card >> id:settings-screenshot-translate-shortcut-row",
    ),
  ).toBe(true);
  expect(app.texts()).toContain("Alt+Shift+S");

  const screenshot = "id:settings-screenshot-translate-shortcut";
  await app.waitUntil(() => app.enabled(`${screenshot}-record`));
  await app.press(`${screenshot}-record`);
  await app.waitFor(listening);
  await app.keyboard.press("alt+shift+f6");
  await app.waitUntil(
    () => app.storage()[SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY] === "alt+shift+f6",
  );
  expect(app.shows(`${screenshot}-error`)).toBe(false);
  expect(app.shows(`${screenshot}-reset`)).toBe(true);
  expect(app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("");

  const selection = "id:settings-selection-translate-shortcut";
  expect(app.shows(`${selection}-row`)).toBe(true);
  expect(app.texts()).toContain("Alt+D");
  await app.waitUntil(() => app.enabled(`${selection}-record`));
  await app.press(`${selection}-record`);
  await app.waitFor(listening);
  await app.keyboard.press("alt+shift+f7");
  await app.waitUntil(
    () => app.storage()[SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY] === "alt+shift+f7",
  );
  expect(app.shows(`${selection}-error`)).toBe(false);
  expect(app.storage()[SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("alt+shift+f6");

  await app.press(`${selection}-clear`);
  await app.waitFor(`${selection}-unassigned`);
  expect(app.storage()[SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("");

  await app.press(`${selection}-reset`);
  await app.waitUntil(
    () =>
      app.storage()[SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY] === "alt+d" ||
      app.shows(`${selection}-error`),
  );
  if (app.shows(`${selection}-error`)) {
    expect(app.texts()).toContain("This shortcut is unavailable. Try another combination.");
    expect(app.storage()[SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("");
  } else {
    expect(app.storage()[SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("alt+d");
  }
});
