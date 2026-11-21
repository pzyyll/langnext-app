import type { KeyEvent } from "nsh";
import { expect, test } from "nsh/test";
import { recordQuickTranslateShortcut } from "./shortcuts";

function keyEvent(key: string, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    key,
    code: "",
    modifiers: { control: true, alt: false, shift: true, platform: false },
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  };
}

test("shortcut recorder: preserves the underlying digit and ignores held or modifier-only keys", () => {
  expect(recordQuickTranslateShortcut(keyEvent("!", { code: "Digit1" }))).toBe("ctrl+shift+1");
  expect(recordQuickTranslateShortcut(keyEvent("Shift"))).toBeUndefined();
  expect(recordQuickTranslateShortcut(keyEvent("Y", { repeat: true }))).toBeUndefined();
});
