import type { HistoryResult, HistorySnapshot } from "langnext/native";
import { batch, cleanup, Clipboard, effect, signal, untracked, type Accessor } from "nsh";
import { t } from "nsh/i18n";
import type { SelectItem } from "../../components/ui/select";
import type { LanguageDetectionResult } from "../language-detection/detect";
import { languageResolutionErrorMessage } from "../language-detection/messages";
import {
  resolveTargetLanguage,
  type ResolveTranslationLanguagesResult,
} from "../language-detection/resolve";
import {
  languageDetectionStore,
  type LanguageDetectionSnapshot,
} from "../language-detection/settings";
import {
  AUTO_LANGUAGE,
  type LanguageId,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
import {
  createSourceLanguageDetection,
  type DetectSourceLanguage,
  type SourceDetectionState,
} from "./source-detection";
import { presetsStore } from "../presets/store";
import type { PresetsStore, PresetsStoreStatus, TranslationPreset } from "../presets/types";
import {
  quickTranslatePreferencesStore,
  resolveQuickTranslateCards,
  type QuickTranslatePreferencesStore,
  type SavedQuickTranslateCard,
} from "./preferences";
import {
  resolvePresetTemplate,
  translateWithPreset,
  type TranslateWithPresetInput,
  type TranslateWithPresetOptions,
  type TranslateWithPresetResult,
} from "./translate";

export type { SourceDetectionState } from "./source-detection";

const AUTO_TRANSLATE_DEBOUNCE_MS = 500;
const COPY_FEEDBACK_DURATION_MS = 1500;
/** Coalesces streamed text updates so a fast provider does not re-render each token. */
const STREAM_FLUSH_INTERVAL_MS = 50;

export type SourceDeliveryKind = "clipboard" | "ocr" | "selection";

/** Text that replaced the draft as a whole, with one increasing sequence per delivery. */
export interface SourceDelivery {
  kind: SourceDeliveryKind;
  seq: number;
}

export type CardResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "streaming"; text: string }
  | {
      status: "success";
      text: string;
      modelId: string | null;
      sourceLanguage: LanguageId;
      targetLanguage: LanguageId;
    }
  | { status: "error"; message: string; text?: string };

export type BackTranslationState =
  | { status: "closed" }
  | { status: "loading" }
  | { status: "success"; text: string; copied: boolean; copyError: string | null }
  | { status: "error"; message: string };

export interface CardViewItem {
  id: string;
  presetId: string;
  templateId: string | null;
  collapsed: boolean;
  result: CardResultState;
  copied: boolean;
  copyError: string | null;
  backTranslation: BackTranslationState;
}

interface CardQuery {
  result: CardResultState;
  abort: AbortController | null;
  streamFlushTimer: ReturnType<typeof setTimeout> | null;
}

interface BackTranslationRuntime {
  forwardQuery: CardQuery;
  open: boolean;
  state:
    | { status: "loading"; abort: AbortController }
    | { status: "success"; text: string }
    | { status: "error"; message: string };
  copyResetTimer: ReturnType<typeof setTimeout> | null;
  copied: boolean;
  copyError: string | null;
  copyEpoch: number;
}

interface CardRuntime {
  context: { preset: TranslationPreset; text: string; languageKey: string } | null;
  queries: Map<string | null, CardQuery>;
  selectedQuery: CardQuery | null;
  copyResetTimer: ReturnType<typeof setTimeout> | null;
  backTranslation: BackTranslationRuntime | null;
}

/** One action's immutable source text and language selections. */
interface ActionLanguages {
  text: string;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId;
  detection: LanguageDetectionSnapshot;
  languageKey: string;
  recordHistory?: (result: HistoryResult) => void;
}

export interface QuickTranslateSessionOptions {
  /** When provided, the session outlives the window but stops pending work on close. */
  windowOpen?: Accessor<boolean>;
  sourceText: Accessor<string>;
  /** The newest text that arrived as a whole (clipboard, selection, or OCR), with its kind. */
  sourceDelivery?: Accessor<SourceDelivery | null>;
  onSourceTextChange: (text: string) => void;
  onRestoreSourceText?: (text: string) => void;
  beginHistoryAction?: (sourceText: string) => (result: HistoryResult) => void;
  autoTranslate?: Accessor<boolean>;
  onOverlayOpenChange?: (menuId: string, open: boolean) => void;
  presetsStore?: Pick<PresetsStore, "load" | "records" | "status">;
  preferences?: QuickTranslatePreferencesStore;
  translate?: (
    input: TranslateWithPresetInput,
    options?: TranslateWithPresetOptions,
  ) => Promise<TranslateWithPresetResult>;
  /** Source language detection; tests replace it to control timing and answers. */
  detectSource?: DetectSourceLanguage;
  clipboard?: Pick<typeof Clipboard, "writeText">;
}

export interface QuickTranslateSession {
  sourceText: Accessor<string>;
  /** The newest delivered text, or `null` when the draft was typed. */
  sourceDelivery: Accessor<SourceDelivery | null>;
  sourceCollapsed: Accessor<boolean>;
  setSourceCollapsed: (collapsed: boolean) => void;
  sourceLanguage: Accessor<SourceLanguageId>;
  targetLanguage: Accessor<TargetLanguageId>;
  sourceDetection: Accessor<SourceDetectionState>;
  /** Detects the current source once per input and shares the result with translation. */
  detectSourceLanguage: (signal?: AbortSignal) => Promise<LanguageDetectionResult | null>;
  canSwapLanguages: Accessor<boolean>;
  cards: Accessor<readonly CardViewItem[]>;
  historySnapshot: Accessor<HistorySnapshot | null>;
  enabledPresets: Accessor<readonly TranslationPreset[]>;
  presetItems: Accessor<SelectItem[]>;
  isAutoTranslate: Accessor<boolean>;
  presetsStatus: Accessor<PresetsStoreStatus>;
  prefsSaveError: Accessor<string | null>;
  canAddPreset: Accessor<boolean>;
  handleSourceChange: (nextText: string) => void;
  handleSourceSubmit: () => void;
  handleClearSource: () => void;
  handleRestoreHistory: (snapshot: HistorySnapshot) => void;
  handleSourceLanguageChange: (language: SourceLanguageId) => void;
  handleTargetLanguageChange: (language: TargetLanguageId) => void;
  handleSwapLanguages: () => void;
  handleAddPresetCard: (presetId: string) => void;
  handleMoveCard: (cardId: string, targetIndex: number) => void;
  handleSelectCardPreset: (cardId: string, presetId: string | null) => void;
  handleSelectCardTemplate: (cardId: string, templateId: string | null) => void;
  handleToggleCollapse: (cardId: string) => void;
  handleRemoveCard: (cardId: string) => void;
  handleRetryCard: (cardId: string) => void;
  handleCopyCard: (cardId: string) => void;
  handleBackTranslate: (cardId: string) => void;
  handleCloseBackTranslation: (cardId: string) => void;
  handleRetryBackTranslation: (cardId: string) => void;
  handleCopyBackTranslation: (cardId: string) => void;
  retryLoadPresets: () => void;
  notifyOverlayOpenChange: (menuId: string, open: boolean) => void;
}

function createCardRuntime(): CardRuntime {
  return {
    context: null,
    queries: new Map(),
    selectedQuery: null,
    copyResetTimer: null,
    backTranslation: null,
  };
}

function toBackTranslationViewState(bt: BackTranslationRuntime | null): BackTranslationState {
  if (!bt || !bt.open) return { status: "closed" };
  if (bt.state.status === "loading") return { status: "loading" };
  if (bt.state.status === "error") return { status: "error", message: bt.state.message };
  return {
    status: "success",
    text: bt.state.text,
    copied: bt.copied,
    copyError: bt.copyError,
  };
}

function buildPresetItems(presets: readonly TranslationPreset[]): SelectItem[] {
  return presets.map((preset) => ({ value: preset.id, title: preset.name }));
}

/** Owns Quick Translate language selection, preset cards, request cancellation, and auto-translate timers. */
export function createQuickTranslateSession(
  options: QuickTranslateSessionOptions,
): QuickTranslateSession {
  const store = options.presetsStore ?? presetsStore;
  const prefsStore = options.preferences ?? quickTranslatePreferencesStore;
  const runTranslate = options.translate ?? translateWithPreset;
  const clipboardApi = options.clipboard ?? Clipboard;
  const isAutoTranslate = () => options.autoTranslate?.() ?? prefsStore.autoTranslate();

  if (store.status().kind === "idle") {
    void store.load();
  }

  const cards = signal<CardViewItem[]>([]);
  const historySnapshot = signal<HistorySnapshot | null>(null);
  const sourceCollapsed = signal(false);
  const sourceLanguage = signal<SourceLanguageId>(AUTO_LANGUAGE);
  const targetLanguage = signal<TargetLanguageId>(AUTO_LANGUAGE);
  const sourceDetection = signal<SourceDetectionState>({ status: "idle" });

  let disposed = false;
  const languageDetection = createSourceLanguageDetection({
    detect: options.detectSource,
    onStateChange: (state) => {
      if (!disposed) sourceDetection.set(state);
    },
  });
  languageDetection.syncText(options.sourceText());

  const enabledPresets = () => store.records().filter((item) => item.enabled);
  // A collapsed card is out of the working set: it neither translates nor refreshes.
  const expandedCards = () => cards().filter((card) => !card.collapsed);
  const hasEligibleExpandedCard = () =>
    expandedCards().some((card) => enabledPresets().some((preset) => preset.id === card.presetId));
  const presetItems = () => buildPresetItems(enabledPresets());

  let needsCardRestore = true;
  let hasRestoredCards = false;
  let hasRestoredLanguages = false;
  let windowEpoch = 0;
  let nextCardOrdinal = 1;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledDeliverySeq = 0;
  const cardRuntimes = new Map<string, CardRuntime>();

  const captureActionLanguages = (): ActionLanguages => {
    const source = sourceLanguage();
    const target = targetLanguage();
    const detection = languageDetectionStore.snapshot();
    const text = options.sourceText();
    return {
      text,
      recordHistory: options.beginHistoryAction?.(text),
      sourceLanguage: source,
      targetLanguage: target,
      detection,
      languageKey: JSON.stringify([
        source,
        target,
        source === AUTO_LANGUAGE ? detection.detectors : null,
        target === AUTO_LANGUAGE ? detection.nativeLanguage : null,
        target === AUTO_LANGUAGE ? detection.preferredTranslationLanguage : null,
      ]),
    };
  };

  // An automatic target cannot resolve without a native language, so fail before any detector request.
  const resolveActionLanguages = async (
    action: ActionLanguages,
    signal: AbortSignal,
  ): Promise<ResolveTranslationLanguagesResult | null> => {
    if (action.targetLanguage === AUTO_LANGUAGE && action.detection.nativeLanguage === null) {
      return { ok: false, code: "missing_native_language" };
    }

    let source: LanguageId;
    if (action.sourceLanguage === AUTO_LANGUAGE) {
      const detected = await languageDetection.detect(action.text, action.detection, signal);
      if (detected === null) return null;
      if (!detected.ok) return detected;
      source = detected.language;
    } else {
      source = action.sourceLanguage;
    }

    return resolveTargetLanguage({
      sourceLanguage: source,
      targetLanguage: action.targetLanguage,
      detection: action.detection,
    });
  };

  const allocateCardId = () => `card-${nextCardOrdinal++}`;

  const updateCard = (cardId: string, transform: (card: CardViewItem) => CardViewItem) => {
    cards.set(cards().map((item) => (item.id === cardId ? transform(item) : item)));
  };

  const clearSharedDebounce = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const clearCopyTimer = (runtime: CardRuntime) => {
    if (runtime.copyResetTimer !== null) {
      clearTimeout(runtime.copyResetTimer);
      runtime.copyResetTimer = null;
    }
  };

  const clearBackTranslationCopyTimer = (bt: BackTranslationRuntime) => {
    if (bt.copyResetTimer !== null) {
      clearTimeout(bt.copyResetTimer);
      bt.copyResetTimer = null;
    }
  };

  const clearBackTranslation = (runtime: CardRuntime) => {
    const bt = runtime.backTranslation;
    if (!bt) return;
    bt.copyEpoch += 1;
    clearBackTranslationCopyTimer(bt);
    if (bt.state.status === "loading") {
      bt.state.abort.abort();
    }
    runtime.backTranslation = null;
  };

  const clearStreamTimer = (query: CardQuery) => {
    if (query.streamFlushTimer !== null) {
      clearTimeout(query.streamFlushTimer);
      query.streamFlushTimer = null;
    }
  };

  const cancelQuery = (query: CardQuery) => {
    clearStreamTimer(query);
    query.abort?.abort();
    query.abort = null;
  };

  const cancelPendingQueries = (runtime: CardRuntime) => {
    for (const [templateId, query] of runtime.queries) {
      if (!query.abort) continue;
      cancelQuery(query);
      runtime.queries.delete(templateId);
      if (runtime.selectedQuery === query) runtime.selectedQuery = null;
    }
  };

  const cancelRuntime = (runtime: CardRuntime) => {
    clearCopyTimer(runtime);
    clearBackTranslation(runtime);
    for (const query of runtime.queries.values()) cancelQuery(query);
    runtime.queries.clear();
    runtime.selectedQuery = null;
    runtime.context = null;
  };

  const invalidateAllCards = () => {
    clearSharedDebounce();
    for (const runtime of cardRuntimes.values()) {
      cancelRuntime(runtime);
    }
    cards.set(
      cards().map((card) => ({
        ...card,
        copied: false,
        copyError: null,
        result: { status: "idle" },
        backTranslation: { status: "closed" },
      })),
    );
  };

  const toSavedCards = (items: readonly CardViewItem[]): SavedQuickTranslateCard[] =>
    items.map(({ id, presetId, templateId, collapsed }) => ({
      id,
      presetId,
      templateId,
      collapsed,
    }));

  const persistPreferencesState = () => {
    void prefsStore.savePopupState({
      sourceLanguage: sourceLanguage(),
      targetLanguage: targetLanguage(),
      cards: toSavedCards(cards()),
    });
  };

  // Restore the card layout on open, keeping results for cards that are still valid.
  effect(() => {
    if (options.windowOpen?.() === false) {
      needsCardRestore = true;
      return;
    }
    const status = store.status();
    if (status.kind !== "ready") {
      return;
    }
    const saved = prefsStore.preferences();
    // The popup owns its language pair: presets never supply or change it.
    if (!hasRestoredLanguages) {
      hasRestoredLanguages = true;
      batch(() => {
        sourceLanguage.set(saved.sourceLanguage ?? AUTO_LANGUAGE);
        targetLanguage.set(saved.targetLanguage ?? AUTO_LANGUAGE);
      });
    }
    if (!needsCardRestore) return;

    const currentCards = untracked(cards);
    const restored = resolveQuickTranslateCards(
      hasRestoredCards ? currentCards : saved.cards,
      status,
      store.records(),
    );
    if (restored === null) return;

    const firstAvailable = enabledPresets()[0];
    for (const current of currentCards) {
      const entry = restored.find((card) => card.id === current.id);
      if (entry?.presetId === current.presetId && entry.templateId === current.templateId) continue;
      const runtime = cardRuntimes.get(current.id);
      if (runtime) cancelRuntime(runtime);
      cardRuntimes.delete(current.id);
    }
    if (restored.length === 0 && firstAvailable) {
      restored.push({
        id: allocateCardId(),
        presetId: firstAvailable.id,
        templateId: null,
        collapsed: false,
      });
    }

    needsCardRestore = restored.length === 0;
    hasRestoredCards ||= restored.length > 0;
    cards.set(
      restored.map((entry) => {
        if (cardRuntimes.has(entry.id)) {
          return currentCards.find((card) => card.id === entry.id)!;
        }
        const match = /^card-(\d+)$/.exec(entry.id);
        if (match) nextCardOrdinal = Math.max(nextCardOrdinal, Number(match[1]) + 1);
        cardRuntimes.set(entry.id, createCardRuntime());
        return {
          ...entry,
          result: { status: "idle" },
          copied: false,
          copyError: null,
          backTranslation: { status: "closed" },
        };
      }),
    );
  });

  effect(() => {
    if (!isAutoTranslate()) {
      clearSharedDebounce();
    }
  });

  effect(() => {
    if (options.windowOpen?.() !== false) return;
    windowEpoch += 1;
    clearSharedDebounce();
    languageDetection.cancelPending();
    prefsStore.clearSaveError();
    cards.set(
      untracked(cards).map((card) => {
        const runtime = cardRuntimes.get(card.id)!;
        clearCopyTimer(runtime);
        cancelPendingQueries(runtime);
        const bt = runtime.backTranslation;
        if (bt?.state.status === "success") {
          bt.copyEpoch += 1;
          clearBackTranslationCopyTimer(bt);
          bt.copied = false;
          bt.copyError = null;
        } else {
          clearBackTranslation(runtime);
        }
        return {
          ...card,
          copied: false,
          copyError: null,
          result:
            card.result.status === "loading" || card.result.status === "streaming"
              ? { status: "idle" }
              : card.result,
          backTranslation: toBackTranslationViewState(runtime.backTranslation),
        };
      }),
    );
  });

  cleanup(() => {
    disposed = true;
    languageDetection.dispose();
    clearSharedDebounce();
    for (const runtime of cardRuntimes.values()) {
      cancelRuntime(runtime);
    }
    cardRuntimes.clear();
    prefsStore.clearSaveError();
  });

  const executeCard = async (
    cardId: string,
    trigger: "manual" | "auto",
    action?: ActionLanguages,
  ) => {
    const currentCards = cards();
    const position = currentCards.findIndex((item) => item.id === cardId);
    const card = currentCards[position];
    const runtime = cardRuntimes.get(cardId);
    if (!card || card.collapsed || !runtime || disposed) {
      return;
    }

    const selectQuery = (query: CardQuery | null, result = query?.result) => {
      runtime.selectedQuery = query;
      clearCopyTimer(runtime);
      if (runtime.backTranslation && runtime.backTranslation.forwardQuery !== query) {
        clearBackTranslation(runtime);
      }
      updateCard(cardId, (item) => ({
        ...item,
        copied: false,
        copyError: null,
        result: result ?? { status: "idle" },
        backTranslation:
          runtime.backTranslation && runtime.backTranslation.forwardQuery === query
            ? toBackTranslationViewState(runtime.backTranslation)
            : { status: "closed" },
      }));
    };

    const preset = enabledPresets().find((item) => item.id === card.presetId);
    if (store.status().kind !== "ready" || !preset) {
      if (trigger === "manual") {
        cancelRuntime(runtime);
        selectQuery(null, { status: "error", message: t("quickTranslate.error.noEnabledPresets") });
      }
      return;
    }

    const languages = action ?? captureActionLanguages();
    if (languages.text.trim().length === 0) {
      cancelRuntime(runtime);
      const result =
        trigger === "manual"
          ? { status: "error" as const, message: t("quickTranslate.error.blankInput") }
          : undefined;
      selectQuery(null, result);
      return;
    }

    const context = runtime.context;
    if (
      context?.preset !== preset ||
      context.text !== languages.text ||
      context.languageKey !== languages.languageKey
    ) {
      cancelRuntime(runtime);
      runtime.context = { preset, text: languages.text, languageKey: languages.languageKey };
    }

    const templateId =
      resolvePresetTemplate(preset, card.templateId)?.template.id ?? card.templateId;
    const previous = runtime.queries.get(templateId);
    if (previous) {
      if (trigger === "auto") {
        if (runtime.selectedQuery !== previous) selectQuery(previous);
        return;
      }
      cancelQuery(previous);
    }

    const abort = new AbortController();
    const query: CardQuery = { result: { status: "loading" }, abort, streamFlushTimer: null };
    runtime.queries.set(templateId, query);
    selectQuery(query);

    const publishResult = (result: CardResultState) => {
      query.result = result;
      if (runtime.selectedQuery === query) {
        updateCard(cardId, (item) => ({ ...item, result }));
      }
    };
    const isPending = () => query.abort === abort && !abort.signal.aborted;
    const finishQuery = (result?: CardResultState) => {
      if (!isPending()) return;
      query.abort = null;
      clearStreamTimer(query);
      if (!result) {
        runtime.queries.delete(templateId);
        if (runtime.selectedQuery === query) selectQuery(null);
      } else {
        publishResult(result);
      }
    };

    const pair = await resolveActionLanguages(languages, abort.signal);
    if (!isPending()) return;
    if (pair === null || (!pair.ok && pair.code === "cancelled")) {
      finishQuery();
      return;
    }
    if (!pair.ok) {
      finishQuery({ status: "error", message: languageResolutionErrorMessage(pair.code) });
      return;
    }

    let streamedText = "";
    const onStreamedText = (text: string) => {
      if (!isPending()) return;
      streamedText = text;
      if (query.streamFlushTimer !== null) return;
      query.streamFlushTimer = setTimeout(() => {
        clearStreamTimer(query);
        if (isPending() && streamedText.length > 0) {
          publishResult({ status: "streaming", text: streamedText });
        }
      }, STREAM_FLUSH_INTERVAL_MS);
    };
    const failQuery = (message: string) =>
      finishQuery({
        status: "error",
        message,
        ...(streamedText.length > 0 ? { text: streamedText } : {}),
      });

    try {
      const outcome = await runTranslate(
        {
          preset,
          sourceText: languages.text,
          sourceLanguage: pair.sourceLanguage,
          targetLanguage: pair.targetLanguage,
          templateId: templateId ?? undefined,
        },
        { signal: abort.signal, onText: onStreamedText },
      );
      if (!isPending()) return;
      if (outcome.ok) {
        finishQuery({
          status: "success",
          text: outcome.text,
          modelId: outcome.modelId,
          sourceLanguage: pair.sourceLanguage,
          targetLanguage: pair.targetLanguage,
        });
        if (outcome.text.trim().length > 0) {
          languages.recordHistory?.({
            position,
            presetName: preset.name,
            sourceLanguage: pair.sourceLanguage,
            targetLanguage: pair.targetLanguage,
            text: outcome.text,
          });
        }
      } else if (outcome.cancelled) {
        finishQuery();
      } else {
        failQuery(outcome.error);
      }
    } catch (error) {
      failQuery(error instanceof Error ? error.message : t("protocol.error.networkDefault"));
    }
  };

  const executeAllCards = (trigger: "manual" | "auto") => {
    clearSharedDebounce();
    const targets =
      trigger === "manual"
        ? expandedCards()
        : expandedCards().filter((card) =>
            enabledPresets().some((item) => item.id === card.presetId),
          );
    if (targets.length === 0) return;

    // One immutable snapshot per action: a saved Settings change applies to the next action.
    const action = captureActionLanguages();
    for (const card of targets) {
      void executeCard(card.id, trigger, action);
    }
  };

  const scheduleAutoTranslate = () => {
    historySnapshot.set(null);
    invalidateAllCards();
    if (!isAutoTranslate()) return;
    if (store.status().kind !== "ready" || enabledPresets().length === 0) return;
    if (options.sourceText().trim().length === 0) return;

    if (!hasEligibleExpandedCard()) return;

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      executeAllCards("auto");
    }, AUTO_TRANSLATE_DEBOUNCE_MS);
  };

  const translateDelivery = () => {
    // A delivery replaces a pending typing run, so only one action follows it.
    historySnapshot.set(null);
    invalidateAllCards();
    const deliverable =
      !disposed &&
      store.status().kind === "ready" &&
      options.sourceText().trim().length > 0 &&
      hasEligibleExpandedCard();
    if (deliverable) executeAllCards("auto");
  };

  effect(() => {
    const delivery = options.sourceDelivery?.();
    if (delivery && delivery.seq > lastHandledDeliverySeq) {
      lastHandledDeliverySeq = delivery.seq;
      sourceCollapsed.set(delivery.kind === "clipboard" || delivery.kind === "selection");
      // Delivered text is a translation request, whatever Auto-translate says.
      translateDelivery();
    }
  });

  effect(() => {
    const text = options.sourceText();
    if (text.length === 0) sourceCollapsed.set(false);
    languageDetection.syncText(text);
  });

  const handleSourceChange = (nextText: string) => {
    if (nextText === options.sourceText()) return;
    languageDetection.syncText(nextText);
    options.onSourceTextChange(nextText);
    scheduleAutoTranslate();
  };

  const handleSourceLanguageChange = (language: SourceLanguageId) => {
    if (language === sourceLanguage()) return;
    sourceLanguage.set(language);
    persistPreferencesState();
    scheduleAutoTranslate();
  };

  const handleTargetLanguageChange = (language: TargetLanguageId) => {
    if (language === targetLanguage()) return;
    targetLanguage.set(language);
    persistPreferencesState();
    scheduleAutoTranslate();
  };

  const resolveEffectiveSourceLanguage = (): LanguageId | null => {
    const src = sourceLanguage();
    if (src !== AUTO_LANGUAGE) return src;
    const detected = sourceDetection();
    return detected.status === "detected" ? detected.language : null;
  };

  const canSwapLanguages = () => {
    const effective = resolveEffectiveSourceLanguage();
    return effective !== null && effective !== targetLanguage();
  };

  const handleSwapLanguages = () => {
    const effective = resolveEffectiveSourceLanguage();
    const nextSource = targetLanguage();
    if (effective === null || effective === nextSource) return;
    batch(() => {
      sourceLanguage.set(nextSource);
      targetLanguage.set(effective);
    });
    persistPreferencesState();
    scheduleAutoTranslate();
  };

  const handleAddPresetCard = (presetId: string) => {
    const preset = enabledPresets().find((item) => item.id === presetId);
    if (!preset) return;
    historySnapshot.set(null);
    const id = allocateCardId();
    cardRuntimes.set(id, createCardRuntime());
    cards.set([
      ...cards(),
      {
        id,
        presetId: preset.id,
        templateId: null,
        collapsed: false,
        result: { status: "idle" },
        copied: false,
        copyError: null,
        backTranslation: { status: "closed" },
      },
    ]);
    persistPreferencesState();
    if (
      isAutoTranslate() &&
      store.status().kind === "ready" &&
      options.sourceText().trim().length > 0
    ) {
      void executeCard(id, "auto");
    }
  };

  // The card keeps its queries and result: reordering changes neither.
  const handleMoveCard = (cardId: string, targetIndex: number) => {
    const list = cards();
    const index = list.findIndex((item) => item.id === cardId);
    if (index === -1) return;
    const target = Math.max(0, Math.min(targetIndex, list.length - 1));
    if (target === index) return;
    const next = [...list];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    cards.set(next);
    persistPreferencesState();
  };

  const handleSelectCardPreset = (cardId: string, value: string | null) => {
    if (!value) return;
    const current = cards().find((item) => item.id === cardId);
    if (!current || current.presetId === value) return;
    if (!enabledPresets().some((item) => item.id === value)) return;

    const runtime = cardRuntimes.get(cardId);
    if (runtime) {
      cancelRuntime(runtime);
    }
    updateCard(cardId, (item) => ({
      ...item,
      presetId: value,
      templateId: null,
      copied: false,
      copyError: null,
      result: { status: "idle" },
      backTranslation: { status: "closed" },
    }));
    persistPreferencesState();
  };

  const handleSelectCardTemplate = (cardId: string, value: string | null) => {
    if (!value) return;
    const current = cards().find((item) => item.id === cardId);
    if (!current) return;
    const preset = enabledPresets().find((item) => item.id === current.presetId);
    if (!preset || preset.engine.kind !== "ai") return;
    const chosen = preset.engine.templates.find((tpl) => tpl.id === value);
    if (!chosen) return;

    const nextTemplateId = chosen.id === preset.engine.defaultTemplateId ? null : chosen.id;
    const currentEffective =
      resolvePresetTemplate(preset, current.templateId)?.template.id ??
      preset.engine.defaultTemplateId;
    if (chosen.id === currentEffective) {
      return;
    }

    const runtime = cardRuntimes.get(cardId);
    if (!runtime) return;
    clearCopyTimer(runtime);
    clearBackTranslation(runtime);
    runtime.selectedQuery = null;
    batch(() => {
      updateCard(cardId, (item) => ({
        ...item,
        templateId: nextTemplateId,
        copied: false,
        copyError: null,
        result: { status: "idle" },
        backTranslation: { status: "closed" },
      }));
      if (!current.collapsed) void executeCard(cardId, "auto");
    });
    persistPreferencesState();
  };

  const closeBackTranslationRuntime = (runtime: CardRuntime) => {
    const bt = runtime.backTranslation;
    if (!bt) return;
    bt.copyEpoch += 1;
    clearBackTranslationCopyTimer(bt);
    bt.copied = false;
    bt.copyError = null;
    if (bt.state.status === "loading") {
      bt.state.abort.abort();
      runtime.backTranslation = null;
      return;
    }
    if (bt.state.status === "error") {
      runtime.backTranslation = null;
      return;
    }
    bt.open = false;
  };

  const handleToggleCollapse = (cardId: string) => {
    const current = cards().find((item) => item.id === cardId);
    if (!current) return;
    const collapsed = !current.collapsed;

    if (collapsed) {
      const runtime = cardRuntimes.get(cardId);
      if (runtime) {
        clearCopyTimer(runtime);
        closeBackTranslationRuntime(runtime);
        cancelPendingQueries(runtime);
        if (
          runtime.backTranslation &&
          runtime.backTranslation.forwardQuery !== runtime.selectedQuery
        ) {
          clearBackTranslation(runtime);
        }
      }
      updateCard(cardId, (item) => ({
        ...item,
        collapsed,
        copied: false,
        copyError: null,
        result: runtime?.selectedQuery?.result ?? { status: "idle" },
        backTranslation: { status: "closed" },
      }));
    } else {
      batch(() => {
        updateCard(cardId, (item) => ({ ...item, collapsed }));
        void executeCard(cardId, "auto");
      });
    }
    persistPreferencesState();
  };

  const handleRemoveCard = (cardId: string) => {
    const runtime = cardRuntimes.get(cardId);
    if (runtime) {
      cancelRuntime(runtime);
      cardRuntimes.delete(cardId);
    }
    options.onOverlayOpenChange?.(`card-preset-${cardId}`, false);
    options.onOverlayOpenChange?.(`card-template-${cardId}`, false);
    cards.set(cards().filter((item) => item.id !== cardId));
    persistPreferencesState();
  };

  const handleClearSource = () => {
    historySnapshot.set(null);
    languageDetection.syncText("");
    options.onSourceTextChange("");
    invalidateAllCards();
  };

  const handleRestoreHistory = (snapshot: HistorySnapshot) => {
    batch(() => {
      invalidateAllCards();
      languageDetection.cancelPending();
      languageDetection.syncText(snapshot.sourceText);
      (options.onRestoreSourceText ?? options.onSourceTextChange)(snapshot.sourceText);
      sourceCollapsed.set(false);
      historySnapshot.set(snapshot);
    });
  };

  const runCopyWithFeedback = async (params: {
    text: string;
    isValid: () => boolean;
    setFeedback: (patch: { copied?: boolean; copyError?: string | null }) => void;
    clearTimer: () => void;
    setTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
    errorKey: string;
  }) => {
    params.setFeedback({ copyError: null });
    try {
      await clipboardApi.writeText(params.text);
      if (!params.isValid()) return;
      params.clearTimer();
      params.setFeedback({ copied: true, copyError: null });
      params.setTimer(
        setTimeout(() => {
          params.setTimer(null);
          if (params.isValid()) {
            params.setFeedback({ copied: false });
          }
        }, COPY_FEEDBACK_DURATION_MS),
      );
    } catch {
      if (params.isValid()) {
        params.setFeedback({ copied: false, copyError: t(params.errorKey) });
      }
    }
  };

  const handleCopyCard = (cardId: string) => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || !runtime || card.result.status !== "success") return;

    const expectedText = card.result.text;
    const expectedQuery = runtime.selectedQuery;
    const expectedEpoch = windowEpoch;
    void runCopyWithFeedback({
      text: expectedText,
      isValid: () => {
        if (disposed || windowEpoch !== expectedEpoch || cardRuntimes.get(cardId) !== runtime) {
          return false;
        }
        const latest = cards().find((item) => item.id === cardId);
        return (
          latest !== undefined &&
          runtime.selectedQuery === expectedQuery &&
          latest.result.status === "success" &&
          latest.result.text === expectedText
        );
      },
      setFeedback: (patch) => updateCard(cardId, (item) => ({ ...item, ...patch })),
      clearTimer: () => clearCopyTimer(runtime),
      setTimer: (timer) => {
        runtime.copyResetTimer = timer;
      },
      errorKey: "quickTranslate.error.copyFailed",
    });
  };

  const handleCopyBackTranslation = (cardId: string) => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    const bt = runtime?.backTranslation;
    if (
      !card ||
      card.collapsed ||
      !runtime ||
      !bt ||
      !bt.open ||
      bt.forwardQuery !== runtime.selectedQuery ||
      bt.state.status !== "success" ||
      bt.state.text.trim().length === 0
    ) {
      return;
    }

    const expectedQuery = bt.forwardQuery;
    const expectedText = bt.state.text;
    const expectedEpoch = bt.copyEpoch;
    void runCopyWithFeedback({
      text: expectedText,
      isValid: () =>
        !disposed &&
        cardRuntimes.get(cardId) === runtime &&
        runtime.backTranslation === bt &&
        bt.open &&
        bt.copyEpoch === expectedEpoch &&
        bt.forwardQuery === runtime.selectedQuery &&
        bt.forwardQuery === expectedQuery &&
        bt.state.status === "success" &&
        bt.state.text === expectedText,
      setFeedback: (patch) => {
        if (patch.copied !== undefined) bt.copied = patch.copied;
        if (patch.copyError !== undefined) bt.copyError = patch.copyError;
        updateCard(cardId, (item) => ({
          ...item,
          backTranslation: toBackTranslationViewState(bt),
        }));
      },
      clearTimer: () => clearBackTranslationCopyTimer(bt),
      setTimer: (timer) => {
        bt.copyResetTimer = timer;
      },
      errorKey: "quickTranslate.error.copyBackTranslationFailed",
    });
  };

  const startBackTranslation = async (
    cardId: string,
    runtime: CardRuntime,
    forwardQuery: CardQuery,
    forwardResult: Extract<CardResultState, { status: "success" }>,
    preset: TranslationPreset,
  ) => {
    clearBackTranslation(runtime);
    const abort = new AbortController();
    const bt: BackTranslationRuntime = {
      forwardQuery,
      open: true,
      state: { status: "loading", abort },
      copyResetTimer: null,
      copied: false,
      copyError: null,
      copyEpoch: 0,
    };
    runtime.backTranslation = bt;
    updateCard(cardId, (item) => ({
      ...item,
      backTranslation: { status: "loading" },
    }));

    const isStillCurrent = () =>
      !disposed &&
      cardRuntimes.get(cardId) === runtime &&
      runtime.backTranslation === bt &&
      runtime.selectedQuery === forwardQuery &&
      bt.state.status === "loading" &&
      bt.state.abort === abort &&
      !abort.signal.aborted;

    const failReverse = (message: string) => {
      if (!isStillCurrent()) return;
      bt.state = { status: "error", message };
      updateCard(cardId, (item) => ({
        ...item,
        backTranslation: toBackTranslationViewState(bt),
      }));
    };

    try {
      const outcome = await runTranslate(
        {
          preset,
          sourceText: forwardResult.text,
          sourceLanguage: forwardResult.targetLanguage,
          targetLanguage: forwardResult.sourceLanguage,
          purpose: "back-translation",
        },
        { signal: abort.signal },
      );
      if (!isStillCurrent()) return;
      if (outcome.ok) {
        if (outcome.text.trim().length === 0) {
          failReverse(t("quickTranslate.error.emptyBackTranslation"));
          return;
        }
        bt.state = { status: "success", text: outcome.text };
        updateCard(cardId, (item) => ({
          ...item,
          backTranslation: toBackTranslationViewState(bt),
        }));
      } else if (outcome.cancelled) {
        clearBackTranslation(runtime);
        updateCard(cardId, (item) => ({ ...item, backTranslation: { status: "closed" } }));
      } else {
        failReverse(outcome.error);
      }
    } catch (error) {
      failReverse(error instanceof Error ? error.message : t("protocol.error.networkDefault"));
    }
  };

  const handleBackTranslate = (cardId: string) => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || card.collapsed || !runtime || disposed) return;
    const forwardQuery = runtime.selectedQuery;
    if (!forwardQuery || card.result.status !== "success") return;
    if (
      card.result.text.trim().length === 0 ||
      card.result.sourceLanguage === card.result.targetLanguage
    ) {
      return;
    }

    if (runtime.backTranslation && runtime.backTranslation.forwardQuery !== forwardQuery) {
      clearBackTranslation(runtime);
    }
    const existing = runtime.backTranslation;
    if (existing && existing.forwardQuery === forwardQuery) {
      if (existing.open) {
        closeBackTranslationRuntime(runtime);
        updateCard(cardId, (item) => ({
          ...item,
          backTranslation: { status: "closed" },
        }));
        return;
      }
      if (existing.state.status === "success") {
        existing.open = true;
        updateCard(cardId, (item) => ({
          ...item,
          backTranslation: toBackTranslationViewState(existing),
        }));
        return;
      }
    }

    const preset =
      store.records().find((item) => item.id === card.presetId) ?? runtime.context?.preset;
    if (!preset) {
      const bt: BackTranslationRuntime = {
        forwardQuery,
        open: true,
        state: { status: "error", message: t("quickTranslate.error.noEnabledPresets") },
        copyResetTimer: null,
        copied: false,
        copyError: null,
        copyEpoch: 0,
      };
      runtime.backTranslation = bt;
      updateCard(cardId, (item) => ({
        ...item,
        backTranslation: toBackTranslationViewState(bt),
      }));
      return;
    }

    void startBackTranslation(cardId, runtime, forwardQuery, card.result, preset);
  };

  const handleCloseBackTranslation = (cardId: string) => {
    const runtime = cardRuntimes.get(cardId);
    if (!runtime || disposed) return;
    closeBackTranslationRuntime(runtime);
    updateCard(cardId, (item) => ({
      ...item,
      backTranslation: { status: "closed" },
    }));
  };

  const handleRetryBackTranslation = (cardId: string) => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || card.collapsed || !runtime || disposed) return;
    const forwardQuery = runtime.selectedQuery;
    const bt = runtime.backTranslation;
    if (
      !forwardQuery ||
      card.result.status !== "success" ||
      !bt ||
      !bt.open ||
      (bt.state.status !== "error" && bt.state.status !== "success") ||
      bt.forwardQuery !== forwardQuery
    ) {
      return;
    }
    if (
      card.result.text.trim().length === 0 ||
      card.result.sourceLanguage === card.result.targetLanguage
    ) {
      return;
    }

    const preset =
      store.records().find((item) => item.id === card.presetId) ?? runtime.context?.preset;
    if (!preset) {
      clearBackTranslationCopyTimer(bt);
      bt.copied = false;
      bt.copyError = null;
      bt.copyEpoch += 1;
      bt.state = { status: "error", message: t("quickTranslate.error.noEnabledPresets") };
      updateCard(cardId, (item) => ({
        ...item,
        backTranslation: toBackTranslationViewState(bt),
      }));
      return;
    }

    void startBackTranslation(cardId, runtime, forwardQuery, card.result, preset);
  };

  return {
    sourceText: options.sourceText,
    sourceDelivery: options.sourceDelivery ?? (() => null),
    sourceCollapsed,
    setSourceCollapsed: (collapsed) => sourceCollapsed.set(collapsed),
    sourceLanguage: () => sourceLanguage(),
    targetLanguage: () => targetLanguage(),
    sourceDetection: () => sourceDetection(),
    detectSourceLanguage: (signal?: AbortSignal) =>
      languageDetection.detect(options.sourceText(), languageDetectionStore.snapshot(), signal),
    canSwapLanguages,
    cards: () => cards(),
    historySnapshot,
    enabledPresets,
    presetItems,
    isAutoTranslate,
    presetsStatus: () => store.status(),
    prefsSaveError: () => prefsStore.saveError(),
    canAddPreset: () => store.status().kind === "ready" && enabledPresets().length > 0,
    handleSourceChange,
    handleSourceSubmit: () => {
      historySnapshot.set(null);
      executeAllCards("manual");
    },
    handleClearSource,
    handleRestoreHistory,
    handleSourceLanguageChange,
    handleTargetLanguageChange,
    handleSwapLanguages,
    handleAddPresetCard,
    handleMoveCard,
    handleSelectCardPreset,
    handleSelectCardTemplate,
    handleToggleCollapse,
    handleRemoveCard,
    handleRetryCard: (cardId: string) => void executeCard(cardId, "manual"),
    handleCopyCard,
    handleBackTranslate,
    handleCloseBackTranslation,
    handleRetryBackTranslation,
    handleCopyBackTranslation,
    retryLoadPresets: () => void store.load(),
    notifyOverlayOpenChange: (menuId: string, open: boolean) =>
      options.onOverlayOpenChange?.(menuId, open),
  };
}
