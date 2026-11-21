import { expect, open, test } from "nsh/test";
import { QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY } from "../../features/settings/shortcuts";

// Run with --target windows. Headless NSH does not answer native hotkey registration.
test("Windows records and registers a replacement Quick Translate shortcut", async () => {
  const app = await open("../../App.tsx", {
    width: 1040,
    height: 720,
    platform: "windows",
    storage: {
      "settings.language": "en",
      [QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]: "alt+shift+f8",
    },
  });
  const field = "id:settings-quick-translate-shortcut";
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.waitUntil(() => app.enabled(field));
  const record = "id:settings-quick-translate-shortcut-record";
  const error = "id:settings-quick-translate-shortcut-error";
  const original = app.value(field);

  await app.press(record);
  await app.waitFor("role:button[Cancel]");
  await app.keyboard.press("escape");
  await app.waitFor("role:button[Record Quick Translate shortcut]");
  expect(app.value(field)).toBe(original);

  await app.keyboard.press("enter");
  await app.waitFor("role:button[Cancel]");
  await app.keyboard.press("tab");
  await app.waitFor("role:button[Record Quick Translate shortcut]");

  await app.press(record);
  await app.keyboard.press("ctrl+c");
  await app.waitFor(error);
  expect(app.value(field)).toBe(original);
  await app.keyboard.press("alt+shift+f9");
  await app.waitUntil(() => app.value(field) === "Alt+Shift+F9");
  expect(app.shows(error)).toBe(false);
  expect(app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY]).toBe("alt+shift+f8");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY] === "alt+shift+f9");
  expect(app.shows(error)).toBe(false);
});
