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
  const record = "id:settings-quick-translate-shortcut-record";
  const error = "id:settings-quick-translate-shortcut-error";
  const edit = "role:button[Edit Quick Translate shortcut]";
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

  await app.press("role:button[Clear Quick Translate shortcut]");
  await app.waitFor("id:settings-quick-translate-shortcut-unassigned");
  expect(app.shows("role:button[Clear Quick Translate shortcut]")).toBe(false);
  expect(app.shows("role:button[Restore default Quick Translate shortcut]")).toBe(true);
});
