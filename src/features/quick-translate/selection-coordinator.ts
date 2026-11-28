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
  triggerLookup: () => boolean;
  clear: () => void;
  suppressPill: () => void;
}

/** Coordinates debounced selection pill visibility, context extraction, and lookup invocation across surfaces. */
export function createDictionarySelectionCoordinator(options: {
  session: QuickTranslateSession;
  isSuppressed?: Accessor<boolean>;
  onBeforeLookup?: () => void;
}): DictionarySelectionCoordinator {
  const activeSelection = signal<ActiveLookupSelection | null>(null);
  const pillVisible = signal(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const suppressPill = () => {
    clearTimer();
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
    options.session.notifyOverlayOpenChange("dictionary-pill", false);
  });

  const handleSelection: DictionarySelectionCoordinator["handleSelection"] = (
    region,
    event,
    meta,
  ) => {
    if (!isDictionaryConfigured(dictionaryChannels)) {
      clear();
      return;
    }
    if (!event || !event.text || !isSelectionLookupCandidate(event.text)) {
      clear();
      return;
    }
    if (options.isSuppressed?.()) {
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
    if (!selection || !isDictionaryConfigured(dictionaryChannels)) return false;
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
    if (!isDictionaryConfigured(dictionaryChannels)) return undefined;
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
    triggerLookup,
    clear,
    suppressPill,
  };
}
