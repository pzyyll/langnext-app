import { cleanup, effect, signal, untracked, type Accessor, type Bounds } from "nsh";
import { t } from "nsh/i18n";
import type { LanguageId } from "../../framework/languages";
import {
  extractContextSentence,
  isSelectionLookupCandidate,
  normalizeLookupTerm,
} from "../dictionary/lexical-query";
import { isDictionaryConfigured } from "../dictionary/lookup";
import { dictionaryChannels } from "../dictionary/store";
import type {
  QuickTranslateSelectionMenu,
  QuickTranslateSelectionRegion,
  TextSelectionEventPayload,
} from "./selection-types";
import type { QuickTranslateSession } from "./session";

const SELECTION_PILL_DEBOUNCE_MS = 180;
const EMPTY_SELECTION_CLEAR_GRACE_MS = 220;

export interface ActiveLookupSelection {
  region: QuickTranslateSelectionRegion | "drawer";
  term: string;
  contextSentence?: string;
  sourceLanguage?: LanguageId | "auto";
  pageBounds: Bounds | null;
}

export interface DictionarySelectionCoordinator {
  activeSelection: Accessor<ActiveLookupSelection | null>;
  pillVisible: Accessor<boolean>;
  pillAnchor: Accessor<Bounds | null>;
  handleSelection: (
    region: QuickTranslateSelectionRegion | "drawer",
    event: TextSelectionEventPayload | null,
    meta: {
      fullText: string;
      start?: number;
      end?: number;
      sourceLanguage?: LanguageId | "auto";
    },
  ) => void;
  selectionMenu: () => QuickTranslateSelectionMenu | undefined;
  beginPillPress: () => void;
  endPillPress: () => void;
  triggerLookup: () => boolean;
  clear: () => void;
  suppressPill: () => void;
}

/** Coordinates debounced selection pill visibility, context extraction, and lookup invocation across surfaces. */
export function createDictionarySelectionCoordinator(options: {
  session: QuickTranslateSession;
  isSuppressed?: Accessor<boolean>;
  isConfigured?: Accessor<boolean>;
  onBeforeLookup?: () => void;
}): DictionarySelectionCoordinator {
  const activeSelection = signal<ActiveLookupSelection | null>(null);
  const pillVisible = signal(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let emptyClearTimer: ReturnType<typeof setTimeout> | null = null;
  let pillPressed = false;

  const configured = () =>
    options.isConfigured ? options.isConfigured() : isDictionaryConfigured(dictionaryChannels);

  const clearTimer = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const clearEmptyTimer = () => {
    if (emptyClearTimer !== null) {
      clearTimeout(emptyClearTimer);
      emptyClearTimer = null;
    }
  };

  const suppressPill = () => {
    clearTimer();
    clearEmptyTimer();
    pillPressed = false;
    if (untracked(pillVisible)) pillVisible.set(false);
  };

  const clear = () => {
    suppressPill();
    if (untracked(activeSelection) !== null) activeSelection.set(null);
  };

  effect(() => {
    options.session.notifyOverlayOpenChange("dictionary-pill", pillVisible());
  });

  cleanup(() => {
    clearTimer();
    clearEmptyTimer();
    options.session.notifyOverlayOpenChange("dictionary-pill", false);
  });

  const scheduleEmptyClear = () => {
    if (emptyClearTimer !== null) return;
    emptyClearTimer = setTimeout(() => {
      emptyClearTimer = null;
      if (!pillPressed) clear();
    }, EMPTY_SELECTION_CLEAR_GRACE_MS);
  };

  const beginPillPress = () => {
    if (!untracked(pillVisible)) return;
    pillPressed = true;
    clearEmptyTimer();
  };

  const endPillPress = () => {
    if (!pillPressed) return;
    pillPressed = false;
    scheduleEmptyClear();
  };

  const handleSelection: DictionarySelectionCoordinator["handleSelection"] = (
    region,
    event,
    meta,
  ) => {
    if (!configured()) {
      clear();
      return;
    }
    if (!event || !event.text) {
      // Desktop pointer-down on the floating pill clears native selection before onPress fires.
      if (!untracked(pillVisible)) {
        clear();
        return;
      }
      if (!pillPressed) scheduleEmptyClear();
      return;
    }
    if (!isSelectionLookupCandidate(event.text) || options.isSuppressed?.()) {
      clear();
      return;
    }

    const term = normalizeLookupTerm(event.text);
    if (!term) {
      clear();
      return;
    }

    const start = meta.start ?? event.start;
    const end = meta.end ?? (start !== undefined ? start + event.text.length : undefined);
    const contextSentence =
      region === "drawer"
        ? undefined
        : extractContextSentence({
            fullText: meta.fullText,
            start,
            end,
            term,
          });
    const pageBounds = event.pageBounds ?? null;

    clearTimer();
    clearEmptyTimer();
    pillPressed = false;
    pillVisible.set(false);
    activeSelection.set({
      region,
      term,
      contextSentence,
      sourceLanguage: meta.sourceLanguage,
      pageBounds,
    });

    if (pageBounds !== null) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (options.isSuppressed?.() || activeSelection() === null) return;
        pillVisible.set(true);
      }, SELECTION_PILL_DEBOUNCE_MS);
    }
  };

  const triggerLookup = () => {
    const selection = activeSelection();
    if (!selection || !configured()) return false;
    options.onBeforeLookup?.();
    clear();
    options.session.handleLookupSelection(
      {
        term: selection.term,
        contextSentence: selection.contextSentence,
        sourceLanguage: selection.sourceLanguage,
        region: selection.region,
      },
      { drillDown: selection.region === "drawer" },
    );
    return true;
  };

  const selectionMenu = () => {
    if (!configured()) return undefined;
    return [
      {
        label: t("dictionary.lookUp"),
        onSelect: () => {
          triggerLookup();
        },
      },
    ];
  };

  return {
    activeSelection: () => activeSelection(),
    pillVisible: () => pillVisible(),
    pillAnchor: () => (pillVisible() ? (activeSelection()?.pageBounds ?? null) : null),
    handleSelection,
    selectionMenu,
    beginPillPress,
    endPillPress,
    triggerLookup,
    clear,
    suppressPill,
  };
}
