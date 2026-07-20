// ABOUTME: Helpers for global-shortcut binding capture and display formatting.
// ABOUTME: Maps KeyboardEvent codes into the global-hotkey parse format used by the backend.

/** Modifier-only codes that do not complete a binding. */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/**
 * Convert a KeyboardEvent into a binding string (e.g. `Ctrl+Shift+T`).
 * Returns null while only modifiers are held, or when no modifier is present.
 */
export function keyboardEventToBinding(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.metaKey) {
    parts.push("Super");
  }

  // Global shortcuts without a modifier are easy to hijack; require at least one.
  if (parts.length === 0) {
    return null;
  }

  const keyToken = codeToKeyToken(event.code);
  if (!keyToken) {
    return null;
  }

  parts.push(keyToken);
  return parts.join("+");
}

/** Map `KeyboardEvent.code` to a global-hotkey key token. */
export function codeToKeyToken(code: string): string | null {
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3);
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  // F1–F24, ArrowUp, Space, Escape, etc. match global-hotkey parse tokens.
  if (
    code.startsWith("F") ||
    code.startsWith("Arrow") ||
    code === "Space" ||
    code === "Tab" ||
    code === "Enter" ||
    code === "Backspace" ||
    code === "Delete" ||
    code === "Home" ||
    code === "End" ||
    code === "PageUp" ||
    code === "PageDown" ||
    code === "Insert" ||
    code === "Minus" ||
    code === "Equal" ||
    code === "BracketLeft" ||
    code === "BracketRight" ||
    code === "Backslash" ||
    code === "Semicolon" ||
    code === "Quote" ||
    code === "Comma" ||
    code === "Period" ||
    code === "Slash" ||
    code === "Backquote"
  ) {
    return code;
  }
  return null;
}

/** Pretty-print a stored binding for UI chips (keeps `+` separators). */
export function formatShortcutBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" + ");
}
