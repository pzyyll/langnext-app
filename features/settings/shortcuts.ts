import { signal, Storage, type KeyEvent } from "nsh";
import type { GlobalShortcutModule } from "nsh/desktop";

export const DEFAULT_QUICK_TRANSLATE_SHORTCUT = "ctrl+shift+t";
export const QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY = "settings.shortcuts.quickTranslate";

const MODIFIERS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", win: "Win" } as const;
const MODIFIER_ORDER = Object.keys(MODIFIERS) as (keyof typeof MODIFIERS)[];

export function formatShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => MODIFIERS[part as keyof typeof MODIFIERS] ?? part.toUpperCase())
    .join("+");
}

/** Normalizes a single Windows chord. Ctrl+C belongs to the fixed double-copy trigger. */
export function parseQuickTranslateShortcut(value: string): string | null {
  const parts = value
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const key = parts.pop()!;
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  if (
    !/^(?:[a-z0-9]|f(?:[1-9]|1[01]))$/.test(key) ||
    modifiers.length !== parts.length ||
    !modifiers.some((modifier) => modifier !== "shift")
  ) {
    return null;
  }
  const chord = [...modifiers, key].join("+");
  return chord === "ctrl+c" ? null : chord;
}

/** Ignores modifier-only transitions, navigation keys, and auto-repeat while recording. */
export function recordQuickTranslateShortcut(event: KeyEvent): string | null | undefined {
  const { key, code, modifiers, repeat } = event;
  if (repeat || ["Control", "Alt", "Shift", "Meta", "Tab", "Enter", " "].includes(key)) {
    return undefined;
  }

  // Shift can report a symbol (e.g. "!" for Digit1). Retain the underlying digit.
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  return parseQuickTranslateShortcut(
    [
      modifiers.control && "ctrl",
      modifiers.alt && "alt",
      modifiers.shift && "shift",
      modifiers.platform && "win",
      digit ?? key,
    ]
      .filter(Boolean)
      .join("+"),
  );
}

export type QuickTranslateShortcutBinding = Pick<GlobalShortcutModule, "register" | "unregister">;
type ShortcutSaveError = "invalid" | "unavailable" | "saveError";

/** Owns the chosen chord and its native registration for the lifetime of the app shell. */
export function createQuickTranslateShortcutSetting(
  binding: QuickTranslateShortcutBinding,
  onPress: () => void,
  isMainWindowFocused: () => boolean,
) {
  const shortcut = signal(DEFAULT_QUICK_TRANSLATE_SHORTCUT);
  const busy = signal(true);
  const unavailable = signal(false);
  const recording = signal(false);
  let active: string | null = null;
  let pending: string | null = null;
  let disposed = false;

  function unregister(chord: string | null) {
    if (chord === null) return;
    try {
      binding.unregister(chord);
    } catch {
      // A native window may already be closing. Its stale callback cannot activate the popup.
    }
  }

  async function register(chord: string): Promise<boolean> {
    pending = chord;
    try {
      return await binding.register(chord, () => {
        if (!disposed && active === chord && !isRecordingInForeground()) onPress();
      });
    } catch {
      return false;
    }
  }

  async function start(): Promise<void> {
    try {
      const saved = await Storage.getItem(QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY);
      if (saved && !disposed) {
        shortcut.set(parseQuickTranslateShortcut(saved) ?? DEFAULT_QUICK_TRANSLATE_SHORTCUT);
      }
    } catch {
      // Use the default if storage is not readable at startup.
    }
    if (disposed) return;
    const chord = shortcut();
    const accepted = await register(chord);
    if (disposed) return;
    pending = null;
    if (accepted) active = chord;
    else unregister(chord);
    unavailable.set(!accepted);
    busy.set(false);
  }

  async function save(value: string): Promise<ShortcutSaveError | null> {
    if (busy() || disposed) return null;
    const chord = parseQuickTranslateShortcut(value);
    if (!chord) return "invalid";
    if (chord === active) return null;

    busy.set(true);
    try {
      if (!(await register(chord)) || disposed) return "unavailable";
      if (shortcut() !== chord) {
        try {
          await Storage.setItem(QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY, chord);
        } catch {
          return "saveError";
        }
      }
      if (disposed) return null;

      // Keep the old binding until the new one is accepted and saved.
      const previous = active;
      active = chord;
      pending = null;
      unregister(previous);
      shortcut.set(chord);
      unavailable.set(false);
      return null;
    } finally {
      if (!disposed) {
        unregister(pending);
        pending = null;
        busy.set(false);
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unregister(pending);
    unregister(active);
  }

  function isRecordingInForeground() {
    return recording() && isMainWindowFocused();
  }

  return {
    shortcut,
    busy,
    unavailable,
    start,
    save,
    dispose,
    recording,
    isRecordingInForeground,
    setRecording: (value: boolean) => recording.set(value),
  };
}

export type QuickTranslateShortcutSetting = Pick<
  ReturnType<typeof createQuickTranslateShortcutSetting>,
  "shortcut" | "busy" | "unavailable" | "save" | "recording" | "setRecording"
>;
