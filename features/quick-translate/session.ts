import { batch, cleanup, Clipboard, effect, signal, type Accessor } from "nsh";
import { t } from "nsh/i18n";
import type { SelectItem } from "../../components/ui/select";
import { AUTO_LANGUAGE, type SourceLanguageId, type TargetLanguageId } from "../presets/languages";
import { presetsStore } from "../presets/store";
import type { PresetsStore, PresetsStoreStatus, TranslationPreset } from "../presets/types";
import {
  quickTranslatePreferencesStore,
  resolveQuickTranslateCards,
  type QuickTranslatePreferencesStore,
  type SavedQuickTranslateCard,
} from "./preferences";
import {
  resolveInitialPresetLanguages,
  resolvePresetTemplate,
  translateWithPreset,
  type TranslateWithPresetInput,
  type TranslateWithPresetOptions,
  type TranslateWithPresetResult,
} from "./translate";

const AUTO_TRANSLATE_DEBOUNCE_MS = 500;
const COPY_FEEDBACK_DURATION_MS = 1500;

export type CardResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; text: string; modelId: string }
  | { status: "error"; message: string };

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
  requestSeq: number;
  activeRequestId: number;
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
  clipboard?: Pick<typeof Clipboard, "writeText">;
}

export interface QuickTranslateSession {
  sourceText: Accessor<string>;
  sourceLanguage: Accessor<SourceLanguageId>;
  targetLanguage: Accessor<TargetLanguageId>;
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
  const clipboardApi = options.clipboard ?? Clipboard;
  const isAutoTranslate = () => options.autoTranslate?.() ?? prefsStore.autoTranslate();

  if (store.status().kind === "idle") {
    void store.load();
  }

  const cards = signal<CardViewItem[]>([]);
  const sourceLanguage = signal<SourceLanguageId>(AUTO_LANGUAGE);
  const targetLanguage = signal<TargetLanguageId>("zh");

  const enabledPresets = () => store.records().filter((item) => item.enabled);
  // A collapsed card is out of the working set: it neither translates nor refreshes.
  const expandedCards = () => cards().filter((card) => !card.collapsed);
  const hasEligibleExpandedCard = () =>
    expandedCards().some((card) => enabledPresets().some((preset) => preset.id === card.presetId));
  const presetItems = () => buildPresetItems(enabledPresets());

  let disposed = false;
  let hasSeededInitialCard = false;
  let nextCardOrdinal = 1;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledDeliverySeq = 0;
  const cardRuntimes = new Map<string, CardRuntime>();

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
    if (hasSeededInitialCard) {
      return;
    }
    const available = enabledPresets();
    const saved = prefsStore.preferences();
    const restored = resolveQuickTranslateCards(saved.cards, status, store.records());
    if (restored === null) {
      return;
    }
    if (available.length === 0 && restored.length === 0) {
      return;
    }

    hasSeededInitialCard = true;
    const firstAvailable = available[0];
    const seedPreset =
      (restored[0] ? available.find((item) => item.id === restored[0]!.presetId) : undefined) ??
      firstAvailable;

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

    const fallbackLanguages = seedPreset
      ? resolveInitialPresetLanguages(seedPreset)
      : { sourceLanguage: AUTO_LANGUAGE, targetLanguage: "zh" as TargetLanguageId };

    batch(() => {
      sourceLanguage.set(saved.sourceLanguage ?? fallbackLanguages.sourceLanguage);
      targetLanguage.set(saved.targetLanguage ?? fallbackLanguages.targetLanguage);
      cards.set(nextCards);
    });
  });

  effect(() => {
    if (!isAutoTranslate()) {
      clearSharedDebounce();
    }
  });

  cleanup(() => {
    disposed = true;
    clearSharedDebounce();
    for (const runtime of cardRuntimes.values()) {
      cancelRuntime(runtime);
    }
    cardRuntimes.clear();
    prefsStore.clearSaveError();
  });

  const executeCard = async (cardId: string, trigger: "manual" | "auto") => {
    const card = cards().find((item) => item.id === cardId);
    const runtime = cardRuntimes.get(cardId);
    if (!card || card.collapsed || !runtime || disposed) {
      return;
    }

    if (runtime.copyResetTimer !== null) {
      clearTimeout(runtime.copyResetTimer);
      runtime.copyResetTimer = null;
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

    let outcome: TranslateWithPresetResult;
    try {
      outcome = await runTranslate(
        {
          preset,
          sourceText: text,
          sourceLanguage: sourceLanguage(),
          targetLanguage: targetLanguage(),
          templateId: templateResolution?.template.id ?? card.templateId ?? undefined,
        },
        { signal: abort.signal },
      );
    } catch (error) {
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
        },
      }));
      return;
    }

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
        result: { status: "error", message: outcome.error },
      }));
    }
  };

  const executeAllCards = (trigger: "manual" | "auto") => {
    clearSharedDebounce();
    for (const card of expandedCards()) {
      if (trigger === "auto") {
        const eligible = enabledPresets().some((item) => item.id === card.presetId);
        if (!eligible) continue;
      }
      void executeCard(card.id, trigger);
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
    if (!preset) return;
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
