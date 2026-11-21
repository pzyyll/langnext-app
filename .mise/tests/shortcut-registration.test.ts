import { expect, open, test } from "nsh/test";
import { QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY } from "../../features/settings/shortcuts";

// Run with --target windows. Headless NSH does not answer native hotkey registration.
test("Windows registers a replacement Quick Translate shortcut", async () => {
  const app = await open("../../App.tsx", {
    width: 1040,
    height: 720,
    platform: "windows",
    storage: { "settings.language": "en" },
  });
  const field = "id:settings-quick-translate-shortcut";
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.waitUntil(() => app.enabled(field));
  await app.clear(field);
  await app.type(field, "Alt+Shift+F9");
  await app.submit(field);
  await app.waitUntil(() => app.storage()[QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY] === "alt+shift+f9");
  expect(app.shows("id:settings-quick-translate-shortcut-error")).toBe(false);
});
