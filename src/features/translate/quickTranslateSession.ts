// ABOUTME: localStorage load/save for quick-translate session chrome (langs, slots, collapse).
// ABOUTME: Does not store source text or translation results; schema stays page-compatible.
import {
  isSelectableLanguageId,
  type SelectableLanguageId,
  type SourceLanguageId,
} from "../../routes/translate/-languages";

export const QUICK_TRANSLATE_SESSION_KEY = "langnext-quick-translate-session";

export type QuickTranslateSlot = {
  /** Stable slot instance id (allows the same profile more than once). */
  id: string;
  profileId: string;
};

export type QuickTranslateSessionState = {
  sourceLang: SourceLanguageId;
  targetLang: SelectableLanguageId;
  slots: QuickTranslateSlot[];
  /** Slot ids that are collapsed; expanded cards are omitted. */
  collapsedSlotIds: string[];
  /** When false, source edits never auto-run; Enter translates, Shift+Enter inserts a newline. */
  autoTranslate: boolean;
};

const DEFAULT_SESSION: QuickTranslateSessionState = {
  sourceLang: "auto",
  targetLang: "zh",
  slots: [],
  collapsedSlotIds: [],
  autoTranslate: true,
};

export function loadQuickTranslateSession(): QuickTranslateSessionState {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SESSION, slots: [], collapsedSlotIds: [] };
  }
  try {
    const raw = localStorage.getItem(QUICK_TRANSLATE_SESSION_KEY);
    if (!raw) {
      return { ...DEFAULT_SESSION, slots: [], collapsedSlotIds: [] };
    }
    const parsed = JSON.parse(raw) as Partial<QuickTranslateSessionState>;
    const sourceLang = isSelectableLanguageId(parsed.sourceLang) ? parsed.sourceLang : DEFAULT_SESSION.sourceLang;
    const targetLang = isSelectableLanguageId(parsed.targetLang) ? parsed.targetLang : DEFAULT_SESSION.targetLang;
    const slots = Array.isArray(parsed.slots)
      ? parsed.slots
          .filter(
            (slot): slot is QuickTranslateSlot =>
              !!slot &&
              typeof slot === "object" &&
              typeof (slot as QuickTranslateSlot).id === "string" &&
              typeof (slot as QuickTranslateSlot).profileId === "string",
          )
          .map((slot) => ({ id: slot.id, profileId: slot.profileId }))
      : [];
    const slotIds = new Set(slots.map((slot) => slot.id));
    const collapsedSlotIds = Array.isArray(parsed.collapsedSlotIds)
      ? parsed.collapsedSlotIds.filter((id): id is string => typeof id === "string" && slotIds.has(id))
      : [];
    const autoTranslate =
      typeof parsed.autoTranslate === "boolean" ? parsed.autoTranslate : DEFAULT_SESSION.autoTranslate;
    return { sourceLang, targetLang, slots, collapsedSlotIds, autoTranslate };
  } catch {
    return { ...DEFAULT_SESSION, slots: [], collapsedSlotIds: [] };
  }
}

export function saveQuickTranslateSession(state: QuickTranslateSessionState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(QUICK_TRANSLATE_SESSION_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota / private-mode failures.
  }
}
