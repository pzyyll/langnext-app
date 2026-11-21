import { signal, Storage, type KeyEvent } from "nsh";
import type { GlobalShortcutModule } from "nsh/desktop";

export const DEFAULT_QUICK_TRANSLATE_SHORTCUT = "ctrl+shift+t";
export const QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY = "settings.shortcuts.quickTranslate";
export const DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT = "alt+shift+s";
export const SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY = "settings.shortcuts.screenshotTranslate";
const UNASSIGNED_SHORTCUT = "";

export const TRANSLATION_SHORTCUTS = {
  "quick-translate": {
    defaultChord: DEFAULT_QUICK_TRANSLATE_SHORTCUT,
    storageKey: QUICK_TRANSLATE_SHORTCUT_STORAGE_KEY,
    labelKey: "settings.shortcuts.quickTranslate",
  },
  "screenshot-translate": {
    defaultChord: DEFAULT_SCREENSHOT_TRANSLATE_SHORTCUT,
    storageKey: SCREENSHOT_TRANSLATE_SHORTCUT_STORAGE_KEY,
    labelKey: "settings.shortcuts.screenshotTranslate",
  },
} as const;

export type TranslationShortcutId = keyof typeof TRANSLATION_SHORTCUTS;

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

export type TranslationShortcutBinding = Pick<GlobalShortcutModule, "register" | "unregister">;
type ShortcutSaveError = "invalid" | "unavailable" | "saveError";

/** Owns the chosen chord and its native registration for one action. */
export function createTranslationShortcutSetting(
  id: TranslationShortcutId,
  binding: TranslationShortcutBinding,
  onPress: () => void,
  shouldSuppress: () => boolean,
  claimed: Set<string>,
) {
  const { defaultChord, storageKey } = TRANSLATION_SHORTCUTS[id];
  const shortcut = signal<string | null>(defaultChord);
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
    } finally {
      claimed.delete(chord);
    }
  }

  async function register(chord: string): Promise<boolean> {
    // NSH replaces the callback if this application registers the same chord twice.
    if (claimed.has(chord)) return false;
    claimed.add(chord);
    pending = chord;
    try {
      return await binding.register(chord, () => {
        if (!disposed && active === chord && !shouldSuppress()) onPress();
      });
    } catch {
      return false;
    }
  }

  async function load(): Promise<void> {
    try {
      const saved = await Storage.getItem(storageKey);
      if (!disposed && saved !== null) {
        shortcut.set(
          saved === UNASSIGNED_SHORTCUT
            ? null
            : (parseQuickTranslateShortcut(saved) ?? defaultChord),
        );
      }
    } catch {
      // Use the default if storage is not readable at startup.
    }
  }

  async function start(): Promise<void> {
    if (disposed) return;
    const chord = shortcut();
    if (chord === null) {
      busy.set(false);
      return;
    }
    const accepted = await register(chord);
    if (disposed) return;
    if (accepted) active = chord;
    else unregister(pending);
    pending = null;
    unavailable.set(!accepted);
    busy.set(false);
  }

  async function save(value: string | null): Promise<ShortcutSaveError | null> {
    if (busy() || disposed) return null;
    const chord = value === null ? null : parseQuickTranslateShortcut(value);
    if (value !== null && chord === null) return "invalid";
    if (chord === shortcut() && chord === active) return null;

    busy.set(true);
    try {
      if (chord !== null && !(await register(chord))) return "unavailable";
      if (disposed) return null;
      if (shortcut() !== chord) {
        try {
          await Storage.setItem(storageKey, chord ?? UNASSIGNED_SHORTCUT);
        } catch {
          return "saveError";
        }
      }
      if (disposed) return null;

      // Do not give back the old binding until the setting is saved.
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

  return {
    shortcut,
    busy,
    unavailable,
    load,
    start,
    save,
    dispose,
    recording,
    setRecording: (value: boolean) => recording.set(value),
  };
}

export type TranslationShortcutSetting = Pick<
  ReturnType<typeof createTranslationShortcutSetting>,
  "shortcut" | "busy" | "unavailable" | "save" | "recording" | "setRecording"
>;
