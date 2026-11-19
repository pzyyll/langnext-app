import {
  batch,
  cleanup,
  Clipboard,
  effect,
  signal,
  Text,
  View,
  type Accessor,
  type InputRef,
} from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Select, type SelectItem } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import {
  AUTO_LANGUAGE,
  getLanguageLabel,
  LANGUAGE_IDS,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
import { presetsStore } from "../presets/store";
import type { PresetsStore, TranslationPreset } from "../presets/types";
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

type CardResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; text: string; modelId: string }
  | { status: "error"; message: string };

interface CardViewItem {
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

export interface QuickTranslatePopupProps {
  sourceText: Accessor<string>;
  sourceDeliverySeq?: Accessor<number>;
  onSourceTextChange: (text: string) => void;
  autoTranslate?: Accessor<boolean>;
  onOverlayOpenChange?: (menuId: string, open: boolean) => void;
  onAttachSourceInput?: (input: InputRef | null) => void;
  presetsStore?: Pick<PresetsStore, "load" | "records" | "status">;
  preferences?: QuickTranslatePreferencesStore;
  translate?: (
    input: TranslateWithPresetInput,
    options?: TranslateWithPresetOptions,
  ) => Promise<TranslateWithPresetResult>;
  clipboard?: Pick<typeof Clipboard, "writeText">;
}

function createCardRuntime(): CardRuntime {
  return {
    abort: null,
    copyResetTimer: null,
    requestSeq: 0,
    activeRequestId: 0,
  };
}

function buildSourceLanguageItems(): SelectItem[] {
  return [
    { value: AUTO_LANGUAGE, title: getLanguageLabel(AUTO_LANGUAGE) },
    ...LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) })),
  ];
}

function buildTargetLanguageItems(): SelectItem[] {
  return LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) }));
}

function buildPresetItems(presets: readonly TranslationPreset[]): SelectItem[] {
  return presets.map((preset) => ({ value: preset.id, title: preset.name }));
}

function buildTemplateItems(preset: TranslationPreset | null): SelectItem[] {
  if (!preset) return [];
  return preset.engine.templates.map((tpl) => ({
    value: tpl.id,
    title: tpl.name,
  }));
}

interface PresetCardRowProps {
  card: Accessor<CardViewItem>;
  presets: Accessor<readonly TranslationPreset[]>;
  presetItems: Accessor<SelectItem[]>;
  onOverlayOpenChange?: (menuId: string, open: boolean) => void;
  onSelectPreset: (cardId: string, presetId: string | null) => void;
  onSelectTemplate: (cardId: string, templateId: string | null) => void;
  onToggleCollapse: (cardId: string) => void;
  onRemove: (cardId: string) => void;
  onRetry: (cardId: string) => void;
  onCopy: (cardId: string) => void;
}

function PresetCardRow(props: PresetCardRowProps) {
  const resolvedPreset = () =>
    props.presets().find((item) => item.id === props.card().presetId) ?? null;

  const templateItems = () => buildTemplateItems(resolvedPreset());

  const activeTemplateValue = () => {
    const preset = resolvedPreset();
    if (!preset) return null;
    const resolution = resolvePresetTemplate(preset, props.card().templateId);
    return resolution ? resolution.template.id : null;
  };

  return (
    <Card testID={`quick-translate-card-${props.card().id}`} class="gap-2 p-2.5">
      <View class="flex-row items-center gap-1.5">
        <Select
          testID="quick-translate-preset"
          size="sm"
          class="min-w-0 flex-1"
          items={props.presetItems()}
          value={props.card().presetId}
          placeholder={t("quickTranslate.presetPlaceholder")}
          accessibilityLabel={t("quickTranslate.presetLabel")}
          disabled={props.presetItems().length === 0}
          onOpenChange={(open) =>
            props.onOverlayOpenChange?.(`card-preset-${props.card().id}`, open)
          }
          onChange={(value) => props.onSelectPreset(props.card().id, value)}
        />
        <Select
          testID="quick-translate-template"
          size="sm"
          class="min-w-0 flex-1"
          items={templateItems()}
          value={activeTemplateValue()}
          placeholder={t("quickTranslate.templateLabel")}
          accessibilityLabel={t("quickTranslate.templateLabel")}
          disabled={templateItems().length === 0}
          onOpenChange={(open) =>
            props.onOverlayOpenChange?.(`card-template-${props.card().id}`, open)
          }
          onChange={(value) => props.onSelectTemplate(props.card().id, value)}
        />
        <Button
          testID="quick-translate-collapse"
          variant="ghost"
          size="icon-sm"
          tooltip={
            props.card().collapsed
              ? t("quickTranslate.expandCard")
              : t("quickTranslate.collapseCard")
          }
          accessibilityLabel={
            props.card().collapsed
              ? t("quickTranslate.expandCard")
              : t("quickTranslate.collapseCard")
          }
          onPress={() => props.onToggleCollapse(props.card().id)}
        >
          <Icon
            name={props.card().collapsed ? "chevron-down" : "chevron-up"}
            tone="muted-foreground"
            class="size-3.5"
          />
        </Button>
        <Button
          testID="quick-translate-remove"
          variant="ghost"
          size="icon-sm"
          tooltip={t("quickTranslate.removeCard")}
          accessibilityLabel={t("quickTranslate.removeCard")}
          onPress={() => props.onRemove(props.card().id)}
        >
          <Icon name="close" tone="muted-foreground" class="size-3.5" />
        </Button>
      </View>

      <If when={!props.card().collapsed && props.card().result.status !== "idle"}>
        <View class="gap-2 pt-0.5">
          <If when={props.card().result.status === "loading"}>
            <Text testID="quick-translate-status" class="text-xs text-muted-foreground">
              {t("quickTranslate.translating")}
            </Text>
          </If>

          <If when={props.card().result.status === "error"}>
            <View class="gap-2">
              <Text testID="quick-translate-error" role="alert" class="text-xs text-destructive">
                {(() => {
                  const res = props.card().result;
                  return res.status === "error" ? res.message : "";
                })()}
              </Text>
              <View class="flex-row justify-end">
                <Button
                  testID="quick-translate-retry"
                  size="xs"
                  variant="outline"
                  label={t("common.retry")}
                  onPress={() => props.onRetry(props.card().id)}
                />
              </View>
            </View>
          </If>

          <If when={props.card().result.status === "success"}>
            <View class="gap-2">
              <View selectable>
                <Text
                  testID="quick-translate-result-text"
                  class="text-sm leading-relaxed text-foreground"
                >
                  {(() => {
                    const res = props.card().result;
                    return res.status === "success" ? res.text : "";
                  })()}
                </Text>
              </View>
              <View class="flex-row items-center justify-between gap-2">
                <Button
                  testID="quick-translate-copy"
                  size="xs"
                  variant="outline"
                  accessibilityLabel={
                    props.card().copied ? t("quickTranslate.copied") : t("quickTranslate.copy")
                  }
                  label={
                    props.card().copied ? t("quickTranslate.copied") : t("quickTranslate.copy")
                  }
                  onPress={() => props.onCopy(props.card().id)}
                >
                  <Icon
                    name={props.card().copied ? "check" : "copy"}
                    tone={props.card().copied ? "success" : "muted-foreground"}
                    class="size-3.5"
                  />
                </Button>
                <Button
                  testID="quick-translate-retry"
                  size="xs"
                  variant="ghost"
                  label={t("common.retry")}
                  onPress={() => props.onRetry(props.card().id)}
                />
              </View>
              <If when={props.card().copyError !== null}>
                <Text
                  testID="quick-translate-copy-error"
                  role="alert"
                  class="text-xs text-destructive"
                >
                  {props.card().copyError ?? ""}
                </Text>
              </If>
            </View>
          </If>
        </View>
      </If>
    </Card>
  );
}

/** Compact Quick Translate popup composed inside the floating window or standalone harness. */
export function QuickTranslatePopup(props: QuickTranslatePopupProps) {
  const store = props.presetsStore ?? presetsStore;
  const prefsStore = props.preferences ?? quickTranslatePreferencesStore;
  const runTranslate = props.translate ?? translateWithPreset;
  const clipboardApi = props.clipboard ?? Clipboard;
  const isAutoTranslate = () => props.autoTranslate?.() ?? prefsStore.autoTranslate();

  if (store.status().kind === "idle") {
    void store.load();
  }

  const cards = signal<CardViewItem[]>([]);
  const sourceLanguage = signal<SourceLanguageId>(AUTO_LANGUAGE);
  const targetLanguage = signal<TargetLanguageId>("zh");
  const isComposing = signal(false);
  const addMenuOpen = signal(false);

  const enabledPresets = () => store.records().filter((item) => item.enabled);
  // A collapsed card is out of the working set: it neither translates nor refreshes.
  const expandedCards = () => cards().filter((card) => !card.collapsed);
  const hasEligibleExpandedCard = () =>
    expandedCards().some((card) => enabledPresets().some((preset) => preset.id === card.presetId));
  const presetItems = () => buildPresetItems(enabledPresets());
  const sourceLanguageItems = buildSourceLanguageItems();
  const targetLanguageItems = buildTargetLanguageItems();

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

    const text = props.sourceText();
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
    if (props.sourceText().trim().length === 0) return;

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
      props.sourceText().trim().length > 0 &&
      hasEligibleExpandedCard();
    if (deliverable) executeAllCards("auto");
  };

  effect(() => {
    const seq = props.sourceDeliverySeq?.() ?? 0;
    if (seq > lastHandledDeliverySeq) {
      lastHandledDeliverySeq = seq;
      // Copied text from double Ctrl+C is a translation request, whatever Auto-translate says.
      translateDelivery();
    }
  });

  const handleSourceChange = (nextText: string) => {
    if (nextText === props.sourceText()) return;
    props.onSourceTextChange(nextText);
    scheduleAutoTranslate();
  };

  const handleSourceLanguageChange = (value: string | null) => {
    if (!value || value === sourceLanguage()) return;
    sourceLanguage.set(value as SourceLanguageId);
    persistPreferencesState();
    scheduleAutoTranslate();
  };

  const handleTargetLanguageChange = (value: string | null) => {
    if (!value || value === targetLanguage()) return;
    targetLanguage.set(value as TargetLanguageId);
    persistPreferencesState();
    scheduleAutoTranslate();
  };

  const handleSwapLanguages = () => {
    const src = sourceLanguage();
    if (src === AUTO_LANGUAGE) return;
    const tgt = targetLanguage();
    batch(() => {
      sourceLanguage.set(tgt);
      targetLanguage.set(src);
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
      props.sourceText().trim().length > 0
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
      props.sourceText().trim().length > 0
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
    props.onOverlayOpenChange?.(`card-preset-${cardId}`, false);
    props.onOverlayOpenChange?.(`card-template-${cardId}`, false);
    cards.set(cards().filter((item) => item.id !== cardId));
    persistPreferencesState();
  };

  const handleClearSource = () => {
    props.onSourceTextChange("");
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

  const canTranslate = () =>
    store.status().kind === "ready" && enabledPresets().length > 0 && expandedCards().length > 0;
  const canAddPreset = () => store.status().kind === "ready" && enabledPresets().length > 0;

  return (
    <View class="gap-2 p-2.5">
      <If when={store.status().kind === "idle" || store.status().kind === "loading"}>
        <Card testID="quick-translate-presets-loading" class="gap-1.5 p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.presetsLoading")}</Text>
        </Card>
      </If>

      <If when={store.status().kind === "error"}>
        <Card
          testID="quick-translate-presets-error"
          class="flex-row items-center justify-between gap-2 border-destructive/40 p-3"
        >
          <Text role="alert" class="min-w-0 flex-1 text-xs text-destructive">
            {(() => {
              const s = store.status();
              return s.kind === "error" ? s.message : "";
            })()}
          </Text>
          <Button
            testID="quick-translate-retry-presets"
            size="xs"
            variant="outline"
            label={t("common.retry")}
            onPress={() => void store.load()}
          />
        </Card>
      </If>

      <If when={store.status().kind === "ready" && enabledPresets().length === 0}>
        <Card testID="quick-translate-no-presets" class="p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.noEnabledPresets")}</Text>
        </Card>
      </If>

      <View class="flex-row items-center gap-1.5">
        <Select
          testID="quick-translate-source-language"
          size="sm"
          class="min-w-0 flex-1"
          items={sourceLanguageItems}
          value={sourceLanguage()}
          accessibilityLabel={t("presets.fields.sourceLanguage")}
          onOpenChange={(open) => props.onOverlayOpenChange?.("source-language", open)}
          onChange={handleSourceLanguageChange}
        />
        <Button
          testID="quick-translate-swap-languages"
          variant="ghost"
          size="icon-sm"
          disabled={sourceLanguage() === AUTO_LANGUAGE}
          tooltip={t("quickTranslate.swapLanguages")}
          accessibilityLabel={t("quickTranslate.swapLanguages")}
          onPress={handleSwapLanguages}
        >
          <Icon
            name="switch"
            tone={sourceLanguage() === AUTO_LANGUAGE ? "muted-foreground" : "foreground"}
            class="size-3.5"
          />
        </Button>
        <Select
          testID="quick-translate-target-language"
          size="sm"
          class="min-w-0 flex-1"
          items={targetLanguageItems}
          value={targetLanguage()}
          accessibilityLabel={t("presets.fields.targetLanguage")}
          onOpenChange={(open) => props.onOverlayOpenChange?.("target-language", open)}
          onChange={handleTargetLanguageChange}
        />
        <Button
          testID="quick-translate-submit"
          variant="primary"
          size="sm"
          disabled={!canTranslate()}
          label={t("quickTranslate.translate")}
          onPress={() => executeAllCards("manual")}
        />
      </View>

      <Textarea
        testID="quick-translate-source"
        autoFocus
        submitBehavior={isAutoTranslate() ? "newline" : "submit"}
        value={props.sourceText()}
        placeholder={t("quickTranslate.sourcePlaceholder")}
        accessibilityLabel={t("quickTranslate.sourceLabel")}
        inputClass="min-h-16"
        onChange={handleSourceChange}
        onSubmit={() => {
          if (isComposing() || isAutoTranslate()) return;
          executeAllCards("manual");
        }}
        onCompositionChange={({ composing }) => isComposing.set(composing)}
        ref={(node) => props.onAttachSourceInput?.(node)}
      />

      <View class="flex-row items-center justify-between gap-2">
        <View>
          <If when={props.sourceText().length > 0}>
            <Button
              testID="quick-translate-clear"
              size="xs"
              variant="ghost"
              label={t("common.clearInput")}
              onPress={handleClearSource}
            />
          </If>
        </View>
        <If
          when={canAddPreset()}
          else={
            <Button
              testID="quick-translate-add-preset"
              size="xs"
              variant="outline"
              disabled
              label={t("quickTranslate.addPreset")}
            >
              <Icon name="plus" tone="muted-foreground" class="size-3.5" />
            </Button>
          }
        >
          <Menu
            open={addMenuOpen()}
            onOpenChange={({ open }) => {
              addMenuOpen.set(open);
              props.onOverlayOpenChange?.("add-preset", open);
            }}
            placement="bottom"
            align="end"
            popupClass={`min-w-44 rounded-xl border border-border bg-popover p-1 shadow-lg ${motion.popup}`}
            popupStartingClass={motion.popupHidden}
            popupEndingClass={motion.popupHidden}
            trigger={
              <Button
                testID="quick-translate-add-preset"
                size="xs"
                variant="outline"
                selected={addMenuOpen()}
                label={t("quickTranslate.addPreset")}
              >
                <Icon name="plus" tone="foreground" class="size-3.5" />
              </Button>
            }
          >
            <Each of={enabledPresets()} key={(item) => item.id}>
              {(preset) => (
                <MenuItem
                  testID={`quick-translate-add-preset-option-${preset().id}`}
                  accessibilityLabel={preset().name}
                  onSelect={() => handleAddPresetCard(preset().id)}
                  class={`h-8 justify-center rounded-lg px-3 hover:bg-accent focus:bg-accent active:bg-border ${motion.navigationFeedback}`}
                >
                  <Text class="text-sm text-popover-foreground">{preset().name}</Text>
                </MenuItem>
              )}
            </Each>
          </Menu>
        </If>
      </View>

      <If when={prefsStore.saveError() !== null}>
        <Text
          testID="quick-translate-preferences-error"
          role="alert"
          class="text-xs text-destructive"
        >
          {prefsStore.saveError() ?? ""}
        </Text>
      </If>

      <View class="gap-2">
        <Each of={cards()} key={(card) => card.id}>
          {(card) => (
            <PresetCardRow
              card={card}
              presets={enabledPresets}
              presetItems={presetItems}
              onOverlayOpenChange={props.onOverlayOpenChange}
              onSelectPreset={handleSelectCardPreset}
              onSelectTemplate={handleSelectCardTemplate}
              onToggleCollapse={handleToggleCollapse}
              onRemove={handleRemoveCard}
              onRetry={(id) => void executeCard(id, "manual")}
              onCopy={(id) => void handleCopyCard(id)}
            />
          )}
        </Each>
      </View>
    </View>
  );
}
