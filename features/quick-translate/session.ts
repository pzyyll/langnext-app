import { batch, cleanup, Clipboard, effect, signal, type Accessor } from "nsh";
import { t } from "nsh/i18n";
import type { SelectItem } from "../../components/ui/select";
import { languageResolutionErrorMessage } from "../language-detection/messages";
import type { DetectLanguageOptions } from "../language-detection/detect";
import {
  resolveTranslationLanguages,
  type ResolveTranslationLanguagesInput,
  type ResolveTranslationLanguagesResult,
} from "../language-detection/resolve";
import {
  languageDetectionStore,
  type LanguageDetectionSettings,
} from "../language-detection/settings";
import {
  AUTO_LANGUAGE,
  type LanguageId,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
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

const AUTO_TRANSLATE_DEBOUNCE_MS = 500;
const COPY_FEEDBACK_DURATION_MS = 1500;
/** Coalesces streamed text updates so a fast provider does not re-render each token. */
const STREAM_FLUSH_INTERVAL_MS = 50;

export type SourceDetectionState =
  | { status: "idle" }
  | { status: "detecting" }
  | { status: "detected"; language: LanguageId };

export type CardResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "streaming"; text: string }
  | { status: "success"; text: string; modelId: string | null }
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

interface CardRuntime {
  abort: AbortController | null;
  copyResetTimer: ReturnType<typeof setTimeout> | null;
  streamFlushTimer: ReturnType<typeof setTimeout> | null;
  requestSeq: number;
  activeRequestId: number;
}

/** One lazy language-resolution run shared by every card of a single translation action. */
interface SharedLanguageRun {
  join(cardSignal: AbortSignal): Promise<ResolveTranslationLanguagesResult | null>;
}

interface LanguageSnapshot {
  sourceText: string;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId;
  settings: LanguageDetectionSettings;
}

/**
 * Starts the resolution on the first join, aborts it when the last consumer leaves,
 * and never retains a result: each action gets a new run.
 */
function createSharedLanguageRun(
  snapshot: LanguageSnapshot,
  resolveLanguages: (
    input: ResolveTranslationLanguagesInput,
    options?: DetectLanguageOptions,
  ) => Promise<ResolveTranslationLanguagesResult>,
  onDetectionState?: (state: SourceDetectionState) => void,
): SharedLanguageRun {
  let promise: Promise<ResolveTranslationLanguagesResult> | null = null;
  let controller: AbortController | null = null;
  let consumers = 0;
  let settled = false;

  const notifyDetection = (state: SourceDetectionState) => {
    if (snapshot.sourceLanguage === AUTO_LANGUAGE) {
      onDetectionState?.(state);
    }
  };

  return {
    join: async (cardSignal: AbortSignal) => {
      if (promise === null) {
        notifyDetection({ status: "detecting" });
        const shared = new AbortController();
        controller = shared;
        promise = resolveLanguages(
          {
            sourceText: snapshot.sourceText,
            sourceLanguage: snapshot.sourceLanguage,
            targetLanguage: snapshot.targetLanguage,
            settings: snapshot.settings,
          },
          { signal: shared.signal },
        ).then(
          (result) => {
            settled = true;
            notifyDetection(
              result.ok
                ? { status: "detected", language: result.sourceLanguage }
                : { status: "idle" },
            );
            return result;
          },
          (error) => {
            settled = true;
            notifyDetection({ status: "idle" });
            throw error;
          },
        );
      }
      consumers += 1;
      try {
        return await Promise.race([
          promise,
          new Promise<null>((resolve) => {
            if (cardSignal.aborted) {
              resolve(null);
              return;
            }
            cardSignal.addEventListener("abort", () => resolve(null));
          }),
        ]);
      } finally {
        consumers -= 1;
        if (consumers === 0) {
          controller?.abort();
          if (!settled) {
            settled = true;
            notifyDetection({ status: "idle" });
          }
        }
      }
    },
  };
}

export interface QuickTranslateSessionOptions {
  sourceText: Accessor<string>;
  sourceDeliverySeq?: Accessor<number>;
  onSourceTextChange: (text: string) => void;
  autoTranslate?: Accessor<boolean>;
  onOverlayOpenChange?: (menuId: string, open: boolean) => void;
  presetsStore?: Pick<PresetsStore, "load" | "records" | "status">;
  preferences?: QuickTranslatePreferencesStore;
  translate?: (
    input: TranslateWithPresetInput,
    options?: TranslateWithPresetOptions,
  ) => Promise<TranslateWithPresetResult>;
  resolveLanguages?: (
    input: ResolveTranslationLanguagesInput,
    options?: DetectLanguageOptions,
  ) => Promise<ResolveTranslationLanguagesResult>;
  clipboard?: Pick<typeof Clipboard, "writeText">;
}

export interface QuickTranslateSession {
  sourceText: Accessor<string>;
  sourceLanguage: Accessor<SourceLanguageId>;
  targetLanguage: Accessor<TargetLanguageId>;
  sourceDetection: Accessor<SourceDetectionState>;
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
  handleAddPresetCard: (presetId: string) => void;
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
    abort: null,
    copyResetTimer: null,
    streamFlushTimer: null,
    requestSeq: 0,
    activeRequestId: 0,
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
  const runResolveLanguages = options.resolveLanguages ?? resolveTranslationLanguages;
  const clipboardApi = options.clipboard ?? Clipboard;
  const isAutoTranslate = () => options.autoTranslate?.() ?? prefsStore.autoTranslate();

  if (store.status().kind === "idle") {
    void store.load();
  }

  const cards = signal<CardViewItem[]>([]);
  const sourceLanguage = signal<SourceLanguageId>(AUTO_LANGUAGE);
  const targetLanguage = signal<TargetLanguageId>(AUTO_LANGUAGE);
  const sourceDetection = signal<SourceDetectionState>({ status: "idle" });

  const enabledPresets = () => store.records().filter((item) => item.enabled);
  // A collapsed card is out of the working set: it neither translates nor refreshes.
  const expandedCards = () => cards().filter((card) => !card.collapsed);
  const hasEligibleExpandedCard = () =>
    expandedCards().some((card) => enabledPresets().some((preset) => preset.id === card.presetId));
  const presetItems = () => buildPresetItems(enabledPresets());

  let disposed = false;
  let hasSeededInitialCard = false;
  let hasRestoredLanguages = false;
  let nextCardOrdinal = 1;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledDeliverySeq = 0;
  let detectionRunSeq = 0;
  const cardRuntimes = new Map<string, CardRuntime>();

  const createTrackedLanguageRun = (text: string) => {
    detectionRunSeq += 1;
    const runSeq = detectionRunSeq;
    return createSharedLanguageRun(
      {
        sourceText: text,
        sourceLanguage: sourceLanguage(),
        targetLanguage: targetLanguage(),
        settings: languageDetectionStore.settings(),
      },
      runResolveLanguages,
      (state) => {
        if (!disposed && runSeq === detectionRunSeq) {
          sourceDetection.set(state);
        }
      },
    );
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

  const cancelRuntime = (runtime: CardRuntime) => {
    if (runtime.copyResetTimer !== null) {
      clearTimeout(runtime.copyResetTimer);
      runtime.copyResetTimer = null;
    }
    if (runtime.streamFlushTimer !== null) {
      clearTimeout(runtime.streamFlushTimer);
      runtime.streamFlushTimer = null;
    }
    runtime.requestSeq += 1;
    runtime.activeRequestId = runtime.requestSeq;
    runtime.abort?.abort();
    runtime.abort = null;
  };

  const invalidateCard = (cardId: string, nextResult: CardResultState = { status: "idle" }) => {
    const runtime = cardRuntimes.get(cardId);
    if (runtime) {
      cancelRuntime(runtime);
    }
    updateCard(cardId, (card) => ({
      ...card,
      copied: false,
      copyError: null,
      result: nextResult,
    }));
  };

  const invalidateAllCards = (nextResult: CardResultState = { status: "idle" }) => {
    detectionRunSeq += 1;
    sourceDetection.set({ status: "idle" });
    clearSharedDebounce();
    for (const runtime of cardRuntimes.values()) {
      cancelRuntime(runtime);
    }
    cards.set(
      cards().map((card) => ({
        ...card,
        copied: false,
        copyError: null,
        result: nextResult,
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
    detectionRunSeq += 1;
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
    sharedRun?: SharedLanguageRun,
  ) => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || card.collapsed || !runtime || disposed) {
      return;
    }

    if (runtime.copyResetTimer !== null) {
      clearTimeout(runtime.copyResetTimer);
      runtime.copyResetTimer = null;
    }
    if (runtime.streamFlushTimer !== null) {
      clearTimeout(runtime.streamFlushTimer);
      runtime.streamFlushTimer = null;
    }

    const preset = enabledPresets().find((item) => item.id === card.presetId);
    if (store.status().kind !== "ready" || !preset) {
      if (trigger === "manual") {
        updateCard(cardId, (item) => ({
          ...item,
          copied: false,
          copyError: null,
          result: { status: "error", message: t("quickTranslate.error.noEnabledPresets") },
        }));
      }
      return;
    }

    const text = options.sourceText();
    if (text.trim().length === 0) {
      if (trigger === "manual") {
        updateCard(cardId, (item) => ({
          ...item,
          copied: false,
          copyError: null,
          result: { status: "error", message: t("quickTranslate.error.blankInput") },
        }));
      } else {
        updateCard(cardId, (item) => ({
          ...item,
          copied: false,
          copyError: null,
          result: { status: "idle" },
        }));
      }
      return;
    }

    const templateResolution = resolvePresetTemplate(preset, card.templateId);
    runtime.requestSeq += 1;
    const reqId = runtime.requestSeq;
    runtime.activeRequestId = reqId;
    runtime.abort?.abort();
    const abort = new AbortController();
    runtime.abort = abort;

    updateCard(cardId, (item) => ({
      ...item,
      copied: false,
      copyError: null,
      result: { status: "loading" },
    }));

    // Cards of one action join the same run, so the detector is asked once per action.
    // A standalone request (retry or expand) starts a run of its own.
    const run = sharedRun ?? createTrackedLanguageRun(text);
    const pair = await run.join(abort.signal);
    if (pair === null || abort.signal.aborted) {
      if (runtime.abort === abort) runtime.abort = null;
      return;
    }
    if (disposed || reqId !== runtime.activeRequestId || !cardRuntimes.has(cardId)) {
      return;
    }
    if (!pair.ok) {
      if (runtime.abort === abort) runtime.abort = null;
      if (pair.code !== "cancelled") {
        updateCard(cardId, (item) => ({
          ...item,
          result: { status: "error", message: languageResolutionErrorMessage(pair.code) },
        }));
      }
      return;
    }
    const resolvedPair: { sourceLanguage: LanguageId; targetLanguage: LanguageId } = pair;

    let streamedText = "";
    const canApplyStream = () =>
      !disposed &&
      reqId === runtime.activeRequestId &&
      !abort.signal.aborted &&
      cardRuntimes.has(cardId);
    const clearStreamTimer = () => {
      if (runtime.streamFlushTimer !== null) {
        clearTimeout(runtime.streamFlushTimer);
        runtime.streamFlushTimer = null;
      }
    };
    const flushStreamedText = () => {
      clearStreamTimer();
      if (streamedText.length === 0 || !canApplyStream()) return;
      updateCard(cardId, (item) => ({
        ...item,
        result: { status: "streaming", text: streamedText },
      }));
    };
    const onStreamedText = (text: string) => {
      streamedText = text;
      if (!canApplyStream() || runtime.streamFlushTimer !== null) return;
      runtime.streamFlushTimer = setTimeout(flushStreamedText, STREAM_FLUSH_INTERVAL_MS);
    };

    let outcome: TranslateWithPresetResult;
    try {
      outcome = await runTranslate(
        {
          preset,
          sourceText: text,
          sourceLanguage: resolvedPair.sourceLanguage,
          targetLanguage: resolvedPair.targetLanguage,
          templateId: templateResolution?.template.id ?? card.templateId ?? undefined,
        },
        { signal: abort.signal, onText: onStreamedText },
      );
    } catch (error) {
      clearStreamTimer();
      if (
        disposed ||
        reqId !== runtime.activeRequestId ||
        abort.signal.aborted ||
        !cardRuntimes.has(cardId)
      ) {
        return;
      }
      updateCard(cardId, (item) => ({
        ...item,
        result: {
          status: "error",
          message: error instanceof Error ? error.message : t("protocol.error.networkDefault"),
          ...(streamedText.length > 0 ? { text: streamedText } : {}),
        },
      }));
      return;
    }
    clearStreamTimer();

    if (
      disposed ||
      reqId !== runtime.activeRequestId ||
      abort.signal.aborted ||
      !cardRuntimes.has(cardId)
    ) {
      return;
    }

    if (runtime.abort === abort) {
      runtime.abort = null;
    }

    if (outcome.ok) {
      updateCard(cardId, (item) => ({
        ...item,
        result: {
          status: "success",
          text: outcome.text,
          modelId: outcome.modelId,
        },
      }));
      return;
    }

    if (!outcome.cancelled) {
      updateCard(cardId, (item) => ({
        ...item,
        result: {
          status: "error",
          message: outcome.error,
          ...(streamedText.length > 0 ? { text: streamedText } : {}),
        },
      }));
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

    const text = options.sourceText();
    // One immutable snapshot per action: a saved Settings change applies to the next action.
    let run: SharedLanguageRun | undefined;
    if (text.trim().length === 0) {
      detectionRunSeq += 1;
      sourceDetection.set({ status: "idle" });
    } else {
      run = createTrackedLanguageRun(text);
    }

    for (const card of targets) {
      void executeCard(card.id, trigger, run);
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
    for (const card of cards()) invalidateCard(card.id);
    const deliverable =
      !disposed &&
      store.status().kind === "ready" &&
      options.sourceText().trim().length > 0 &&
      hasEligibleExpandedCard();
    if (deliverable) executeAllCards("auto");
  };

  effect(() => {
    const seq = options.sourceDeliverySeq?.() ?? 0;
    if (seq > lastHandledDeliverySeq) {
      lastHandledDeliverySeq = seq;
      // Copied text from double Ctrl+C is a translation request, whatever Auto-translate says.
      translateDelivery();
    }
  });

  const handleSourceChange = (nextText: string) => {
    if (nextText === options.sourceText()) return;
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

    invalidateCard(cardId);
    updateCard(cardId, (item) => ({
      ...item,
      templateId: nextTemplateId,
    }));
    persistPreferencesState();

    if (
      !current.collapsed &&
      isAutoTranslate() &&
      store.status().kind === "ready" &&
      options.sourceText().trim().length > 0
    ) {
      void executeCard(cardId, "auto");
    }
  };

  const handleToggleCollapse = (cardId: string) => {
    const current = cards().find((item) => item.id === cardId);
    if (!current) return;
    const collapsed = !current.collapsed;

    if (collapsed) {
      // Collapsing stops the card: cancel its request and drop transient state.
      const runtime = cardRuntimes.get(cardId);
      if (runtime) {
        cancelRuntime(runtime);
      }
      updateCard(cardId, (item) => ({
        ...item,
        collapsed,
        copied: false,
        copyError: null,
        result: item.result.status === "loading" ? { status: "idle" } : item.result,
      }));
    } else {
      updateCard(cardId, (item) => ({ ...item, collapsed }));
    }
    persistPreferencesState();

    // Expanding puts the card back to work, unless its result already answers the current input.
    if (!collapsed && current.result.status !== "success") {
      void executeCard(cardId, "auto");
    }
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
    sourceLanguage: () => sourceLanguage(),
    targetLanguage: () => targetLanguage(),
    sourceDetection: () => sourceDetection(),
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
    handleAddPresetCard,
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
