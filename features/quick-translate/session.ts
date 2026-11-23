import { batch, cleanup, Clipboard, effect, signal, type Accessor } from "nsh";
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
  | { status: "success"; text: string; modelId: string | null; targetLanguage: LanguageId }
  | { status: "error"; message: string; text?: string };

export interface CardViewItem {
  id: string;
  presetId: string;
  templateId: string | null;
  collapsed: boolean;
  result: CardResultState;
  copied: boolean;
  copyError: string | null;
}

interface CardQuery {
  result: CardResultState;
  abort: AbortController | null;
  streamFlushTimer: ReturnType<typeof setTimeout> | null;
}

interface CardRuntime {
  context: { preset: TranslationPreset; text: string; languageKey: string } | null;
  queries: Map<string | null, CardQuery>;
  selectedQuery: CardQuery | null;
  copyResetTimer: ReturnType<typeof setTimeout> | null;
}

/** One action's immutable source text and language selections. */
interface ActionLanguages {
  text: string;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId;
  detection: LanguageDetectionSnapshot;
  languageKey: string;
}

export interface QuickTranslateSessionOptions {
  sourceText: Accessor<string>;
  /** The newest text that arrived as a whole (clipboard, selection, or OCR), with its kind. */
  sourceDelivery?: Accessor<SourceDelivery | null>;
  onSourceTextChange: (text: string) => void;
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
  sourceLanguage: Accessor<SourceLanguageId>;
  targetLanguage: Accessor<TargetLanguageId>;
  sourceDetection: Accessor<SourceDetectionState>;
  /** Detects the current source once per input and shares the result with translation. */
  detectSourceLanguage: (signal?: AbortSignal) => Promise<LanguageDetectionResult | null>;
  canSwapLanguages: Accessor<boolean>;
  cards: Accessor<readonly CardViewItem[]>;
  enabledPresets: Accessor<readonly TranslationPreset[]>;
  presetItems: Accessor<SelectItem[]>;
  isAutoTranslate: Accessor<boolean>;
  presetsStatus: Accessor<PresetsStoreStatus>;
  prefsSaveError: Accessor<string | null>;
  canAddPreset: Accessor<boolean>;
  handleSourceChange: (nextText: string) => void;
  handleSourceSubmit: () => void;
  handleClearSource: () => void;
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
  retryLoadPresets: () => void;
  notifyOverlayOpenChange: (menuId: string, open: boolean) => void;
}

function createCardRuntime(): CardRuntime {
  return {
    context: null,
    queries: new Map(),
    selectedQuery: null,
    copyResetTimer: null,
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

  let hasSeededInitialCard = false;
  let hasRestoredLanguages = false;
  let nextCardOrdinal = 1;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledDeliverySeq = 0;
  const cardRuntimes = new Map<string, CardRuntime>();

  const captureActionLanguages = (): ActionLanguages => {
    const source = sourceLanguage();
    const target = targetLanguage();
    const detection = languageDetectionStore.snapshot();
    return {
      text: options.sourceText(),
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

  const cancelRuntime = (runtime: CardRuntime) => {
    clearCopyTimer(runtime);
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

  // Seed or restore valid cards and languages only after presets finish loading cleanly.
  effect(() => {
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
    if (hasSeededInitialCard) {
      return;
    }
    const available = enabledPresets();
    const restored = resolveQuickTranslateCards(saved.cards, status, store.records());
    if (restored === null) {
      return;
    }
    if (available.length === 0 && restored.length === 0) {
      return;
    }

    hasSeededInitialCard = true;
    const firstAvailable = available[0];

    let nextCards: CardViewItem[];
    if (restored.length > 0) {
      let maxOrd = 0;
      for (const entry of restored) {
        const match = /^card-(\d+)$/.exec(entry.id);
        if (match) {
          maxOrd = Math.max(maxOrd, Number(match[1]));
        }
        cardRuntimes.set(entry.id, createCardRuntime());
      }
      nextCardOrdinal = Math.max(nextCardOrdinal, maxOrd + 1);
      nextCards = restored.map((entry) => ({
        id: entry.id,
        presetId: entry.presetId,
        templateId: entry.templateId,
        collapsed: entry.collapsed,
        result: { status: "idle" },
        copied: false,
        copyError: null,
      }));
    } else if (firstAvailable) {
      const id = allocateCardId();
      cardRuntimes.set(id, createCardRuntime());
      nextCards = [
        {
          id,
          presetId: firstAvailable.id,
          templateId: null,
          collapsed: false,
          result: { status: "idle" },
          copied: false,
          copyError: null,
        },
      ];
    } else {
      nextCards = [];
    }

    cards.set(nextCards);
  });

  effect(() => {
    if (!isAutoTranslate()) {
      clearSharedDebounce();
    }
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
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || card.collapsed || !runtime || disposed) {
      return;
    }

    const selectQuery = (query: CardQuery | null, result = query?.result) => {
      runtime.selectedQuery = query;
      clearCopyTimer(runtime);
      updateCard(cardId, (item) => ({
        ...item,
        copied: false,
        copyError: null,
        result: result ?? { status: "idle" },
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
      if (outcome.ok) {
        finishQuery({
          status: "success",
          text: outcome.text,
          modelId: outcome.modelId,
          targetLanguage: pair.targetLanguage,
        });
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
    invalidateAllCards();
    const deliverable =
      !disposed &&
      store.status().kind === "ready" &&
      options.sourceText().trim().length > 0 &&
      hasEligibleExpandedCard();
    if (deliverable) executeAllCards("auto");
  };

  effect(() => {
    const seq = options.sourceDelivery?.()?.seq ?? 0;
    if (seq > lastHandledDeliverySeq) {
      lastHandledDeliverySeq = seq;
      // Delivered text is a translation request, whatever Auto-translate says.
      translateDelivery();
    }
  });

  // A new input belongs to no detection yet, whichever path replaced the draft.
  effect(() => {
    languageDetection.syncText(options.sourceText());
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
    runtime.selectedQuery = null;
    batch(() => {
      updateCard(cardId, (item) => ({
        ...item,
        templateId: nextTemplateId,
        copied: false,
        copyError: null,
        result: { status: "idle" },
      }));
      if (!current.collapsed) void executeCard(cardId, "auto");
    });
    persistPreferencesState();
  };

  const handleToggleCollapse = (cardId: string) => {
    const current = cards().find((item) => item.id === cardId);
    if (!current) return;
    const collapsed = !current.collapsed;

    if (collapsed) {
      const runtime = cardRuntimes.get(cardId);
      if (runtime) {
        clearCopyTimer(runtime);
        for (const [templateId, query] of runtime.queries) {
          if (!query.abort) continue;
          cancelQuery(query);
          runtime.queries.delete(templateId);
          if (runtime.selectedQuery === query) runtime.selectedQuery = null;
        }
      }
      updateCard(cardId, (item) => ({
        ...item,
        collapsed,
        copied: false,
        copyError: null,
        result: runtime?.selectedQuery?.result ?? { status: "idle" },
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
    languageDetection.syncText("");
    options.onSourceTextChange("");
    invalidateAllCards();
  };

  const handleCopyCard = async (cardId: string) => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || !runtime || card.result.status !== "success") return;

    const expectedText = card.result.text;
    updateCard(cardId, (item) => ({ ...item, copyError: null }));
    try {
      await clipboardApi.writeText(expectedText);
      if (disposed || !cardRuntimes.has(cardId)) return;
      const latest = cards().find((item) => item.id === cardId);
      if (!latest || latest.result.status !== "success" || latest.result.text !== expectedText) {
        return;
      }
      if (runtime.copyResetTimer !== null) {
        clearTimeout(runtime.copyResetTimer);
      }
      updateCard(cardId, (item) => ({ ...item, copied: true }));
      runtime.copyResetTimer = setTimeout(() => {
        runtime.copyResetTimer = null;
        if (!disposed && cardRuntimes.has(cardId)) {
          updateCard(cardId, (item) => ({ ...item, copied: false }));
        }
      }, COPY_FEEDBACK_DURATION_MS);
    } catch {
      if (!disposed && cardRuntimes.has(cardId)) {
        updateCard(cardId, (item) => ({
          ...item,
          copied: false,
          copyError: t("quickTranslate.error.copyFailed"),
        }));
      }
    }
  };

  return {
    sourceText: options.sourceText,
    sourceDelivery: options.sourceDelivery ?? (() => null),
    sourceLanguage: () => sourceLanguage(),
    targetLanguage: () => targetLanguage(),
    sourceDetection: () => sourceDetection(),
    detectSourceLanguage: (signal?: AbortSignal) =>
      languageDetection.detect(options.sourceText(), languageDetectionStore.snapshot(), signal),
    canSwapLanguages,
    cards: () => cards(),
    enabledPresets,
    presetItems,
    isAutoTranslate,
    presetsStatus: () => store.status(),
    prefsSaveError: () => prefsStore.saveError(),
    canAddPreset: () => store.status().kind === "ready" && enabledPresets().length > 0,
    handleSourceChange,
    handleSourceSubmit: () => executeAllCards("manual"),
    handleClearSource,
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
    handleCopyCard: (cardId: string) => void handleCopyCard(cardId),
    retryLoadPresets: () => void store.load(),
    notifyOverlayOpenChange: (menuId: string, open: boolean) =>
      options.onOverlayOpenChange?.(menuId, open),
  };
}
