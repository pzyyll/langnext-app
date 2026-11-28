import {
  cleanup,
  createAnimatedValue,
  effect,
  Image,
  keymap as appKeymap,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type Accessor,
  type Align,
  type AnimatedValue,
  type Bounds,
  type PanEvent,
  type Placement,
  type Point,
  type PressEvent,
  type Signal,
  type ViewRef,
} from "nsh";
import { SentenceAlignmentNative, type SentenceAlignmentPair } from "langnext-native";
import type { TextViewDocument } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Button, KeyboardButton } from "../../components/ui/button";
import { LARGEST_FONT_STEP } from "../../components/ui/font-step";
import { Icon, type IconName } from "../../components/ui/icon";
import { Kbd } from "../../components/ui/kbd";
import { Menu, MenuItem } from "../../components/ui/menu";
import { AnchoredPopover } from "../../components/ui/popover";
import { Select, type SelectItem } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import {
  TranslationOutput,
  type TranslationOutputSize,
} from "../../components/ui/translation-output";
import googleCloudIcon from "../../../assets/icons/google-cloud.svg";
import googleIcon from "../../../assets/icons/google.svg";
import { ProviderMark } from "../../modules/ai/ui/provider-mark";
import { createLogger } from "../../services/log";
import { languageResolutionErrorMessage } from "../language-detection/messages";
import { AUTO_LANGUAGE, type LanguageId, type SourceLanguageId } from "../../framework/languages";
import { presetChannelMark } from "../presets/model-choices";
import type { TranslationPreset } from "../presets/types";
import { synthesizeSpeech } from "../tts/channels";
import { playMp3Bytes } from "../tts/playback";
import { prepareQuickSpeech, quickSpeechFailureMessage } from "../tts/quick-speech";
import { ttsChannels } from "../tts/store";
import { AlignedTranslation, type SentenceSegment } from "./aligned-translation";
import {
  finalizeMarkdownAlignment,
  prepareMarkdownAlignment,
  prepareMarkdownComparisonSource,
  projectMarkdownComparison,
  type MarkdownComparisonSource,
} from "./alignment-document";
import { QuickTranslateHistoryResults } from "./history-results";
import {
  createSentencePopoverTrace,
  type SentencePopoverDismissal,
} from "./sentence-popover-trace";
import type { CardResultState, CardViewItem, QuickTranslateSession } from "./session";
import { InlineDictionaryBand, type DictionarySpeakControlState } from "./dictionary-band";
import {
  QuickTranslateSourceEditor,
  type SourceHighlightRange,
  type SourceInputHandle,
} from "./source-editor";
import { resolvePresetTemplate } from "./translate";

const sentencePopoverLog = createLogger("quick-translate/sentence-popover");

/** What the OCR action reports while it runs, and after it stops. */
export interface QuickTranslateOcrStatus {
  phase: "idle" | "selecting" | "recognizing";
  message: string | null;
}

/** Why a valid selection read delivered no text. */
export type QuickTranslateSelectionFeedback = "noSelection" | "unavailable";

export interface QuickTranslatePopupProps {
  session: QuickTranslateSession;
  markdownEnabled?: boolean;
  /** OCR progress and alerts; the window entry point passes the controller's state. */
  ocrState?: Accessor<QuickTranslateOcrStatus>;
  /** Why the last valid selection read delivered no text; omitted without a selection port. */
  selectionFeedback?: Accessor<QuickTranslateSelectionFeedback | null>;
  /** Starts the existing Screenshot Translate command; omitted where screen capture is unavailable. */
  onScreenshotTranslate?: () => void;
  /** Recognizes an image pasted into the source field. */
  onPasteImage?: (png: Uint8Array) => void;
  /** False while the native window is hidden. Omitted in a harness with no window. */
  playbackAllowed?: Accessor<boolean>;
  /** False while the containing popup or window is hidden. */
  windowVisible?: Accessor<boolean>;
  /** Increments when the outer scroll container moves. */
  scrollRevision?: Accessor<number>;
  /** Whether to show sentence alignment for completed results. */
  sentenceAlignmentEnabled?: Accessor<boolean>;
  /** True after the user has installed the offline model. */
  semanticModelReady?: Accessor<boolean>;
  onAttachSourceInput?: (input: SourceInputHandle | null) => void;
}

function buildTemplateItems(preset: TranslationPreset | null): SelectItem[] {
  if (!preset || preset.engine.kind !== "ai") return [];
  return preset.engine.templates.map((tpl) => ({
    value: tpl.id,
    title: tpl.name,
  }));
}

/** Shared icon-only retry trigger used across card failures, result actions, and preset reload. */
function RetryIconButton(props: { testID: string; label?: string; onPress: () => void }) {
  const label = () => props.label ?? t("common.retry");
  return (
    <Button
      testID={props.testID}
      size="icon-xs"
      variant="ghost"
      tooltip={label()}
      accessibilityLabel={label()}
      onPress={() => props.onPress()}
    >
      <Icon name="mdi:refresh" tone="muted-foreground" class="size-3.5" />
    </Button>
  );
}

function SpeakerButton(props: {
  testID: string;
  disabled: boolean;
  tooltip?: string;
  label: string;
  icon: IconName;
  onPress: () => void;
}) {
  return (
    <Button
      testID={props.testID}
      size="icon-xs"
      variant="ghost"
      disabled={props.disabled}
      tooltip={props.tooltip}
      accessibilityLabel={props.label}
      onPress={() => props.onPress()}
    >
      <Icon name={props.icon} tone="muted-foreground" class="size-3.5" />
    </Button>
  );
}

export interface QuickTranslateAddPresetMenuProps {
  session: QuickTranslateSession;
  placement?: Placement;
  align?: Align;
}

/** Renders the labeled add-preset trigger so Menu receives the Button element directly. */
function renderAddPresetButton(options: { disabled?: boolean; selected?: boolean }) {
  return (
    <Button
      testID="quick-translate-add-preset"
      size="xs"
      variant="ghost"
      disabled={options.disabled}
      selected={options.selected}
      accessibilityLabel={t("quickTranslate.addPreset")}
      class="gap-1 px-1.5"
    >
      <Icon
        name="mdi:plus"
        tone={options.selected ? "foreground" : "muted-foreground"}
        class="size-3"
      />
      <Text
        class={
          options.selected
            ? "text-xs font-medium text-foreground"
            : "text-xs font-medium text-muted-foreground"
        }
      >
        {t("quickTranslate.addPreset")}
      </Text>
    </Button>
  );
}

/** Footer-ready trigger menu for appending an enabled preset card to the Quick Translate popup. */
export function QuickTranslateAddPresetMenu(props: QuickTranslateAddPresetMenuProps) {
  const addMenuOpen = signal(false);

  return (
    <If when={props.session.canAddPreset()} else={renderAddPresetButton({ disabled: true })}>
      <Menu
        open={addMenuOpen()}
        onOpenChange={(open) => {
          addMenuOpen.set(open);
          props.session.notifyOverlayOpenChange("add-preset", open);
        }}
        placement={props.placement ?? "top"}
        align={props.align ?? "start"}
        popupClass="min-w-44 max-h-60"
        trigger={renderAddPresetButton({ selected: addMenuOpen() })}
      >
        <Each of={props.session.enabledPresets()} key={(item) => item.id}>
          {(preset) => (
            <MenuItem
              testID={`quick-translate-add-preset-option-${preset().id}`}
              accessibilityLabel={preset().name}
              label={preset().name}
              leading={
                <PresetLeadingMark
                  preset={preset()}
                  testID={`quick-translate-add-preset-option-mark-${preset().id}`}
                />
              }
              onSelect={() => props.session.handleAddPresetCard(preset().id)}
            />
          )}
        </Each>
      </Menu>
    </If>
  );
}

/** Persistent Quick Translate footer with the Add preset menu and keyboard shortcut hints. */
export function QuickTranslateFooter(props: { session: QuickTranslateSession }) {
  return (
    <View
      testID="quick-translate-footer"
      class="shrink-0 flex-row items-center justify-between gap-2 border-t border-border/70 bg-background px-4 py-2"
    >
      {/* Align the + icon glyph with the px-4 body spine while preserving the button hit inset. */}
      <View class="-ml-1.5">
        <QuickTranslateAddPresetMenu session={props.session} placement="top" align="start" />
      </View>
      <View class="shrink-0 flex-row items-center gap-3">
        <View class="flex-row items-center gap-1">
          <Kbd>↵</Kbd>
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.shortcutTranslate")}</Text>
        </View>
        <View class="flex-row items-center gap-1">
          <Kbd>Esc</Kbd>
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.shortcutHide")}</Text>
        </View>
      </View>
    </View>
  );
}

/** Visual engine indicator on the preset chip, its option rows, and the add-preset menu: DeepL mark, known AI provider mark, or brand dot. */
function PresetLeadingMark(props: { preset: TranslationPreset | null; testID?: string }) {
  const providerMark = () => {
    if (!props.preset) return null;
    const mark = presetChannelMark(props.preset);
    if (mark?.kind !== "provider" || mark.presentation.providerTypeId === "custom") {
      return null;
    }
    return mark.presentation;
  };

  return (
    <View testID={props.testID} class="size-3 shrink-0 items-center justify-center">
      <If
        when={props.preset?.engine.kind === "deepl" || props.preset?.engine.kind === "deeplx"}
        else={
          <If
            when={props.preset?.engine.kind === "google-cloud"}
            else={
              <If
                when={props.preset?.engine.kind === "google-web"}
                else={
                  <If
                    when={providerMark()}
                    else={<View class="size-1.5 shrink-0 rounded-full bg-brand" />}
                  >
                    {(presentation) => (
                      <ProviderMark presentation={presentation()} class="size-3 shrink-0" />
                    )}
                  </If>
                }
              >
                <Image
                  testID="quick-translate-preset-mark-google-web"
                  src={googleIcon}
                  accessibilityElementsHidden={true}
                  class="size-3 shrink-0 overflow-hidden"
                />
              </If>
            }
          >
            <Image
              testID="quick-translate-preset-mark-google"
              src={googleCloudIcon}
              accessibilityElementsHidden={true}
              class="size-3 shrink-0 overflow-hidden"
            />
          </If>
        }
      >
        <Icon name="deepl" tone="foreground" class="size-3 shrink-0" />
      </If>
    </View>
  );
}

/** Time a reordered card takes to settle into its new slot. */
const CARD_REORDER_SETTLE_MS = 180;

/** Drag and keyboard reordering for one preset card. */
interface CardReorderControls {
  /** Whether the list has enough cards to reorder. */
  canReorder: Accessor<boolean>;
  /** Whether this card accepts a drag now: the list can reorder and nothing is settling. */
  canDrag: Accessor<boolean>;
  dragging: Accessor<boolean>;
  offset: AnimatedValue;
  onStart: () => void;
  onEnd: (event: PanEvent) => void;
  onMoveBy: (delta: number, refocus: boolean) => void;
  onGripRef: (node: ViewRef) => void;
}

type AlignmentRenderMode = "plain" | "markdown";

const ALIGNMENT_TARGETS = ["result", "back-translation"] as const;
type AlignmentTarget = (typeof ALIGNMENT_TARGETS)[number];
type AlignmentPreviewOrigin = "pointer" | "keyboard" | "accessibility";
type KeyboardPreviewOrigin = Exclude<AlignmentPreviewOrigin, "pointer">;

interface CardAlignmentInput {
  cardId: string;
  resultId: number;
  target: AlignmentTarget;
  renderMode: AlignmentRenderMode;
  sourceText: string;
  text: string;
}

interface CardAlignmentEntry extends CardAlignmentInput {
  comparisonSource: MarkdownComparisonSource | null;
  pairs: readonly SentenceAlignmentPair[];
  document: TextViewDocument | null;
  segments: readonly SentenceSegment[];
  sourceRanges: Readonly<Record<string, SourceHighlightRange>>;
}

interface SemanticPairEntry extends CardAlignmentInput {
  pairs?: SentenceAlignmentPair[] | null;
}

interface ResultComparison {
  document?: TextViewDocument;
  segments: readonly SentenceSegment[];
  activeSegmentId: Accessor<string | null>;
}

interface CardSentenceAlignment {
  document: TextViewDocument | null;
  segments: readonly SentenceSegment[];
  activeSegmentId: Accessor<string | null>;
  keyboardValue: Accessor<string | undefined>;
  onHoverEnterSegment: (segmentId: string) => void;
  onHoverLeaveSegment: (segmentId: string) => void;
  onPressSegment: (segmentId: string, event: PressEvent, node: ViewRef | null) => void;
  onShowSourcePopover: (node: ViewRef | null) => void;
  onKeyboardStep: (delta: -1 | 1) => void;
  onKeyboardFocus: (node: ViewRef | null) => void;
  onKeyboardBlur: () => void;
}

const MAX_ALIGNMENT_CACHE_ENTRIES = 64;
const MAX_SEMANTIC_PAIR_ENTRIES = 64;
/** Half of the 20pt line anchor band centered on click y so the popover clears the clicked line. */
const LINE_ANCHOR_HALF_HEIGHT = 10;
/** Radius and window to treat press-down outside dismiss + press-up on the same sentence as a toggle-close. */
const OUTSIDE_DISMISS_TOGGLE_RADIUS = 12;
const OUTSIDE_DISMISS_TOGGLE_MS = 500;

function trimCache<T>(cache: Map<string, T>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function SentenceAlignedOutput(props: {
  testID: string;
  previewTestID: string;
  label: string;
  text: string;
  markdownEnabled: boolean;
  streaming: boolean;
  size?: TranslationOutputSize;
  alignment: CardSentenceAlignment | null;
  comparison?: ResultComparison | null;
  comparesTranslation?: boolean;
}) {
  let previewNode: ViewRef | null = null;
  const keyboardValue = () => props.alignment?.keyboardValue();

  return (
    <If
      when={props.alignment !== null || props.comparison != null}
      else={
        <TranslationOutput
          testID={props.testID}
          text={props.text}
          markdownEnabled={props.markdownEnabled}
          streaming={props.streaming}
          size={props.size}
        />
      }
    >
      <View
        testID={props.previewTestID}
        ref={(node) => {
          previewNode = node;
        }}
        role={props.alignment ? "region" : undefined}
        focusable={Boolean(props.alignment)}
        accessibilityLabel={props.alignment ? props.label : undefined}
        accessibilityHint={
          props.alignment
            ? t(
                props.comparesTranslation
                  ? "quickTranslate.backTranslationPreviewHint"
                  : "quickTranslate.resultPreviewHint",
              )
            : undefined
        }
        accessibilityValue={keyboardValue() ? { text: keyboardValue() } : undefined}
        accessibilityActions={
          props.alignment
            ? [
                { name: "previous", label: t("quickTranslate.previousSentence") },
                { name: "next", label: t("quickTranslate.nextSentence") },
                {
                  name: "showSource",
                  label: t(
                    props.comparesTranslation
                      ? "quickTranslate.showTranslationSentence"
                      : "quickTranslate.showSourceSentence",
                  ),
                },
              ]
            : undefined
        }
        onAccessibilityAction={(event) => {
          if (event.actionName === "previous") {
            props.alignment?.onKeyboardStep(-1);
          } else if (event.actionName === "next") {
            props.alignment?.onKeyboardStep(1);
          } else if (event.actionName === "showSource") {
            props.alignment?.onShowSourcePopover(previewNode);
          }
        }}
        onFocus={() => props.alignment?.onKeyboardFocus(previewNode)}
        onBlur={() => props.alignment?.onKeyboardBlur()}
        class="min-w-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
      >
        <AlignedTranslation
          testID={props.testID}
          text={props.text}
          size={props.size}
          document={props.comparison?.document ?? props.alignment?.document ?? null}
          segments={props.alignment?.segments ?? []}
          activeSegmentId={props.alignment?.activeSegmentId() ?? null}
          comparisonSegments={props.comparison?.segments}
          activeComparisonId={props.comparison?.activeSegmentId() ?? null}
          onHoverEnterSegment={(segmentId) => props.alignment?.onHoverEnterSegment(segmentId)}
          onHoverLeaveSegment={(segmentId) => props.alignment?.onHoverLeaveSegment(segmentId)}
          onPressSegment={(segmentId, event) =>
            props.alignment?.onPressSegment(segmentId, event, previewNode)
          }
        />
      </View>
    </If>
  );
}

interface PresetCardRowProps {
  card: Accessor<CardViewItem>;
  reorder: CardReorderControls;
  markdownEnabled: boolean;
  sentenceAlignment: (target: AlignmentTarget) => CardSentenceAlignment | null;
  resultComparison: Accessor<ResultComparison | null>;
  presets: Accessor<readonly TranslationPreset[]>;
  presetItems: Accessor<SelectItem[]>;
  onOverlayOpenChange: (menuId: string, open: boolean) => void;
  onSelectPreset: (cardId: string, presetId: string | null) => void;
  onSelectTemplate: (cardId: string, templateId: string | null) => void;
  onToggleCollapse: (cardId: string) => void;
  onRemove: (cardId: string) => void;
  onRetry: (cardId: string) => void;
  onCopy: (cardId: string) => void;
  ankiEnabled: Accessor<boolean>;
  onAddToAnki: (cardId: string) => void;
  onBackTranslate: (cardId: string) => void;
  onCloseBackTranslation: (cardId: string) => void;
  onRetryBackTranslation: (cardId: string) => void;
  onCopyBackTranslation: (cardId: string) => void;
  speakState: Accessor<{
    disabled: boolean;
    tooltip?: string;
    label: string;
    icon: IconName;
  }>;
  speakError: Accessor<string | null>;
  onSpeak: () => void;
  backTranslationSpeakState: Accessor<{
    disabled: boolean;
    tooltip?: string;
    label: string;
    icon: IconName;
  }>;
  backTranslationSpeakError: Accessor<string | null>;
  onSpeakBackTranslation: () => void;
}

function PresetCardRow(props: PresetCardRowProps) {
  let gripNode: ViewRef | null = null;
  let backTranslateNode: ViewRef | null = null;
  const presetById = (presetId: string) =>
    props.presets().find((item) => item.id === presetId) ?? null;

  const resolvedPreset = () => presetById(props.card().presetId);

  const templateItems = () => buildTemplateItems(resolvedPreset());

  const hasTemplates = () => resolvedPreset()?.engine.kind === "ai";

  const activeTemplateValue = () => {
    const preset = resolvedPreset();
    if (!preset) return null;
    const resolution = resolvePresetTemplate(preset, props.card().templateId);
    return resolution ? resolution.template.id : null;
  };

  const result = () => props.card().result;
  const streaming = () => result().status === "streaming";
  const failed = () => result().status === "error";
  const outputText = () => {
    const current = result();
    return "text" in current ? (current.text ?? "") : "";
  };
  const hasOutput = () => streaming() || result().status === "success" || outputText().length > 0;
  const hasBody = () => !props.card().collapsed && result().status !== "idle";
  const canBackTranslate = () => {
    const res = result();
    return (
      res.status === "success" &&
      res.text.trim().length > 0 &&
      res.sourceLanguage !== res.targetLanguage
    );
  };
  const backTranslation = () => props.card().backTranslation;
  const isBackTranslationOpen = () => backTranslation().status !== "closed";

  const presetName = () => resolvedPreset()?.name ?? t("quickTranslate.presetPlaceholder");
  const isCollapsed = () => props.card().collapsed;
  const presetVariant = () => (isCollapsed() ? "ghost-chip" : "pill-muted");
  // Pull collapsed borderless triggers left 6pt so the engine mark sits on the px-4 spine.
  const presetClass = () => (isCollapsed() ? "-ml-1.5 min-w-0 shrink" : "min-w-0 shrink");

  return (
    <View
      testID={`quick-translate-card-${props.card().id}`}
      class={`group/row ${motion.navigationFeedback} ${
        props.reorder.dragging() ? "bg-card" : "hover:bg-brand-soft/45 dark:hover:bg-brand-soft/35"
      }`}
    >
      <View
        testID={`quick-translate-card-header-${props.card().id}`}
        pan={props.reorder.canDrag() ? { y: props.reorder.offset } : undefined}
        onPanStart={() => props.reorder.onStart()}
        onPanEnd={(event) => props.reorder.onEnd(event)}
        onPress={() => props.onToggleCollapse(props.card().id)}
        class={`flex-row items-center justify-between gap-2 px-4 ${hasBody() ? "pt-3.5 pb-1.5" : "py-2.5"}`}
      >
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Select
            testID="quick-translate-preset"
            variant={presetVariant()}
            class={presetClass()}
            labelClass={isCollapsed() ? "font-semibold text-muted-foreground" : "font-semibold"}
            leading={<PresetLeadingMark preset={resolvedPreset()} />}
            itemLeading={(value) => (
              <PresetLeadingMark
                preset={presetById(value)}
                testID={`quick-translate-preset-option-mark-${value}`}
              />
            )}
            items={props.presetItems()}
            value={props.card().presetId}
            placeholder={t("quickTranslate.presetPlaceholder")}
            accessibilityLabel={t("quickTranslate.presetLabel")}
            disabled={props.presetItems().length === 0}
            onOpenChange={(open) =>
              props.onOverlayOpenChange(`card-preset-${props.card().id}`, open)
            }
            onChange={(value) => props.onSelectPreset(props.card().id, value)}
          />
          <If when={hasTemplates()}>
            <Select
              testID="quick-translate-template"
              variant="pill-muted"
              class="min-w-0 shrink"
              labelClass="font-medium text-muted-foreground"
              items={templateItems()}
              value={activeTemplateValue()}
              placeholder={t("quickTranslate.templateLabel")}
              accessibilityLabel={t("quickTranslate.templateLabel")}
              disabled={templateItems().length === 0}
              onOpenChange={(open) =>
                props.onOverlayOpenChange(`card-template-${props.card().id}`, open)
              }
              onChange={(value) => props.onSelectTemplate(props.card().id, value)}
            />
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-0.5">
          <If when={props.reorder.canReorder()}>
            <KeyboardButton
              testID={`quick-translate-card-grip-${props.card().id}`}
              variant="ghost"
              size="icon-xs"
              focusable={true}
              tooltip={t("quickTranslate.reorderCard", { name: presetName() })}
              accessibilityLabel={t("quickTranslate.reorderCard", { name: presetName() })}
              accessibilityHint={t("quickTranslate.reorderCardHint")}
              accessibilityActions={[
                {
                  name: "moveUp",
                  label: t("quickTranslate.moveCardUp", { name: presetName() }),
                },
                {
                  name: "moveDown",
                  label: t("quickTranslate.moveCardDown", { name: presetName() }),
                },
              ]}
              onAccessibilityAction={(event) => {
                if (event.actionName === "moveUp") props.reorder.onMoveBy(-1, false);
                else if (event.actionName === "moveDown") props.reorder.onMoveBy(1, false);
              }}
              captureKeys={["arrowup", "arrowdown"]}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") props.reorder.onMoveBy(-1, true);
                else if (event.key === "ArrowDown") props.reorder.onMoveBy(1, true);
              }}
              onPress={() => gripNode?.focus()}
              ref={(node) => {
                gripNode = node;
                props.reorder.onGripRef(node);
              }}
              class={`shrink-0 cursor-grab ${motion.tooltip} ${
                props.reorder.dragging()
                  ? "opacity-100"
                  : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              }`}
            >
              <Icon name="grip-vertical" tone="muted-foreground" class="size-3.5" />
            </KeyboardButton>
          </If>
          <Button
            testID="quick-translate-remove"
            variant="ghost"
            size="icon-xs"
            tooltip={t("quickTranslate.removeCard")}
            accessibilityLabel={t("quickTranslate.removeCard")}
            onPress={() => props.onRemove(props.card().id)}
            class={`shrink-0 ${motion.tooltip} opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100`}
          >
            <Icon name="mdi:delete-outline" tone="muted-foreground" class="size-3.5" />
          </Button>
          <Button
            testID="quick-translate-collapse"
            variant="ghost"
            size="icon-xs"
            tooltip={
              isCollapsed() ? t("quickTranslate.expandCard") : t("quickTranslate.collapseCard")
            }
            accessibilityLabel={
              isCollapsed() ? t("quickTranslate.expandCard") : t("quickTranslate.collapseCard")
            }
            onPress={() => props.onToggleCollapse(props.card().id)}
          >
            <Icon
              name="mdi:plus"
              tone="muted-foreground"
              class={`size-3.5 ${motion.disclosureIcon} ${isCollapsed() ? "" : "rotate-45"}`}
            />
          </Button>
        </View>
      </View>

      <If when={hasBody()}>
        <If when={props.card().result.status === "loading"}>
          <View class="px-4 pt-1 pb-3">
            <Text testID="quick-translate-status" class="text-xs text-muted-foreground">
              {t("quickTranslate.translating")}
            </Text>
          </View>
        </If>

        <If when={hasOutput() || failed()}>
          <View class={`min-w-0 gap-1.5 px-4 pt-1 ${streaming() ? "pb-3" : "pb-2"}`}>
            <If when={hasOutput()}>
              <SentenceAlignedOutput
                testID={failed() ? "quick-translate-partial-text" : "quick-translate-result-text"}
                previewTestID="quick-translate-result-preview"
                label={t("quickTranslate.resultPreviewLabel")}
                text={outputText()}
                markdownEnabled={props.markdownEnabled}
                streaming={streaming()}
                alignment={props.sentenceAlignment("result")}
                comparison={props.resultComparison()}
              />
            </If>
            <If when={failed()}>
              <Text testID="quick-translate-error" role="alert" class="text-xs text-destructive">
                {(() => {
                  const res = result();
                  return res.status === "error" ? res.message : "";
                })()}
              </Text>
            </If>
          </View>
        </If>

        <If when={failed()}>
          <View class="flex-row items-center justify-end px-4 pt-0.5 pb-2.5">
            <RetryIconButton
              testID="quick-translate-retry"
              onPress={() => props.onRetry(props.card().id)}
            />
          </View>
        </If>

        <If when={result().status === "success"}>
          <View>
            <If when={isBackTranslationOpen()}>
              <View
                testID="quick-translate-back-translation"
                class={`mx-4 mt-1 mb-1.5 gap-1 rounded-r-lg border-l-2 border-brand/40 bg-brand-soft/45 px-3 pt-1.5 pb-2.5 ${motion.navigationFeedback} hover:border-brand/70 hover:bg-brand/10 dark:bg-brand-soft/30 dark:hover:bg-brand/15`}
              >
                <View class="flex-row items-center justify-between gap-2">
                  <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                    <Icon name="mdi:arrow-right-bottom" tone="brand" class="size-3.5 shrink-0" />
                    <Text
                      testID="quick-translate-back-translation-title"
                      class="truncate text-xs font-semibold text-brand"
                    >
                      {t("quickTranslate.backTranslationTitle")}
                    </Text>
                  </View>
                  <View class="-mr-1.5 shrink-0 flex-row items-center gap-0.5">
                    <If
                      when={(() => {
                        const bt = backTranslation();
                        return bt.status === "success" && bt.text.trim().length > 0;
                      })()}
                    >
                      <SpeakerButton
                        testID="quick-translate-speak-back-translation"
                        disabled={props.backTranslationSpeakState().disabled}
                        tooltip={props.backTranslationSpeakState().tooltip}
                        label={props.backTranslationSpeakState().label}
                        icon={props.backTranslationSpeakState().icon}
                        onPress={() => props.onSpeakBackTranslation()}
                      />
                      <Button
                        testID="quick-translate-copy-back-translation"
                        size="icon-xs"
                        variant="ghost"
                        tooltip={(() => {
                          const bt = backTranslation();
                          return bt.status === "success" && bt.copied
                            ? t("quickTranslate.backTranslationCopied")
                            : t("quickTranslate.copyBackTranslation");
                        })()}
                        accessibilityLabel={(() => {
                          const bt = backTranslation();
                          return bt.status === "success" && bt.copied
                            ? t("quickTranslate.backTranslationCopied")
                            : t("quickTranslate.copyBackTranslation");
                        })()}
                        onPress={() => props.onCopyBackTranslation(props.card().id)}
                      >
                        <Icon
                          name={(() => {
                            const bt = backTranslation();
                            return bt.status === "success" && bt.copied
                              ? "mdi:check"
                              : "mdi:content-copy";
                          })()}
                          tone={(() => {
                            const bt = backTranslation();
                            return bt.status === "success" && bt.copied
                              ? "success"
                              : "muted-foreground";
                          })()}
                          class="size-3.5"
                        />
                      </Button>
                    </If>
                    <If
                      when={
                        backTranslation().status === "error" ||
                        backTranslation().status === "success"
                      }
                    >
                      <RetryIconButton
                        testID="quick-translate-retry-back-translation"
                        label={t("quickTranslate.retryBackTranslation")}
                        onPress={() => props.onRetryBackTranslation(props.card().id)}
                      />
                    </If>
                    <Button
                      testID="quick-translate-close-back-translation"
                      size="icon-xs"
                      variant="ghost"
                      tooltip={t("quickTranslate.closeBackTranslation")}
                      accessibilityLabel={t("quickTranslate.closeBackTranslation")}
                      onPress={() => {
                        props.onCloseBackTranslation(props.card().id);
                        queueMicrotask(() => backTranslateNode?.focus());
                      }}
                    >
                      <Icon name="mdi:close" tone="muted-foreground" class="size-3.5" />
                    </Button>
                  </View>
                </View>
                <View class="min-w-0 gap-1">
                  <If when={backTranslation().status === "loading"}>
                    <Text
                      testID="quick-translate-back-translation-status"
                      class="text-xs text-muted-foreground"
                    >
                      {t("quickTranslate.backTranslating")}
                    </Text>
                  </If>
                  <If when={backTranslation().status === "success"}>
                    <SentenceAlignedOutput
                      testID="quick-translate-back-translation-text"
                      previewTestID="quick-translate-back-translation-preview"
                      label={t("quickTranslate.backTranslationTitle")}
                      comparesTranslation
                      size="sm"
                      alignment={props.sentenceAlignment("back-translation")}
                      text={(() => {
                        const bt = backTranslation();
                        return bt.status === "success" ? bt.text : "";
                      })()}
                      markdownEnabled={props.markdownEnabled}
                      streaming={false}
                    />
                  </If>
                  <If when={backTranslation().status === "error"}>
                    <Text
                      testID="quick-translate-back-translation-error"
                      role="alert"
                      class="text-xs text-destructive"
                    >
                      {(() => {
                        const bt = backTranslation();
                        return bt.status === "error" ? bt.message : "";
                      })()}
                    </Text>
                  </If>
                  <If when={props.backTranslationSpeakError() !== null}>
                    <Text
                      testID="quick-translate-speak-back-translation-error"
                      role="alert"
                      class="text-xs text-destructive"
                    >
                      {props.backTranslationSpeakError() ?? ""}
                    </Text>
                  </If>
                  <If
                    when={(() => {
                      const bt = backTranslation();
                      return bt.status === "success" && bt.copyError !== null;
                    })()}
                  >
                    <Text
                      testID="quick-translate-copy-back-translation-error"
                      role="alert"
                      class="text-xs text-destructive"
                    >
                      {(() => {
                        const bt = backTranslation();
                        return bt.status === "success" ? (bt.copyError ?? "") : "";
                      })()}
                    </Text>
                  </If>
                </View>
              </View>
            </If>
            <View class="flex-row items-center justify-between gap-2 px-4 pt-1 pb-2.5">
              {/* Pull the 24pt speaker left 4pt so its glyph aligns with the px-4 spine. */}
              <View class="-ml-1 shrink-0">
                <If
                  when={(() => {
                    const res = props.card().result;
                    return res.status === "success" && res.text.trim().length > 0;
                  })()}
                >
                  <SpeakerButton
                    testID="quick-translate-speak-result"
                    disabled={props.speakState().disabled}
                    tooltip={props.speakState().tooltip}
                    label={props.speakState().label}
                    icon={props.speakState().icon}
                    onPress={() => props.onSpeak()}
                  />
                </If>
              </View>
              <View class="shrink-0 flex-row items-center gap-0.5">
                <If
                  when={(() => {
                    const res = props.card().result;
                    return (
                      props.ankiEnabled() && res.status === "success" && res.text.trim().length > 0
                    );
                  })()}
                >
                  <Button
                    testID="quick-translate-add-anki"
                    size="icon-xs"
                    variant="ghost"
                    tooltip={
                      props.card().anki.status === "added"
                        ? t("quickTranslate.ankiAdded")
                        : props.card().anki.status === "adding"
                          ? t("quickTranslate.ankiAdding")
                          : t("quickTranslate.ankiAdd")
                    }
                    accessibilityLabel={t("quickTranslate.ankiAdd")}
                    onPress={() => props.onAddToAnki(props.card().id)}
                  >
                    <Icon
                      name={
                        props.card().anki.status === "added"
                          ? "mdi:check"
                          : "mdi:share-variant-outline"
                      }
                      tone={props.card().anki.status === "added" ? "success" : "muted-foreground"}
                      class="size-3.5"
                    />
                  </Button>
                </If>
                <Button
                  testID="quick-translate-copy"
                  size="icon-xs"
                  variant="ghost"
                  tooltip={
                    props.card().copied ? t("quickTranslate.copied") : t("quickTranslate.copy")
                  }
                  accessibilityLabel={
                    props.card().copied ? t("quickTranslate.copied") : t("quickTranslate.copy")
                  }
                  onPress={() => props.onCopy(props.card().id)}
                >
                  <Icon
                    name={props.card().copied ? "mdi:check" : "mdi:content-copy"}
                    tone={props.card().copied ? "success" : "muted-foreground"}
                    class="size-3.5"
                  />
                </Button>
                <If when={canBackTranslate()}>
                  <Button
                    testID="quick-translate-back-translate"
                    ref={(node) => {
                      backTranslateNode = node;
                    }}
                    size="icon-xs"
                    variant="brand-ghost"
                    selected={isBackTranslationOpen()}
                    tooltip={
                      isBackTranslationOpen()
                        ? t("quickTranslate.closeBackTranslation")
                        : t("quickTranslate.backTranslate")
                    }
                    accessibilityLabel={t("quickTranslate.backTranslate")}
                    onPress={() => props.onBackTranslate(props.card().id)}
                  >
                    <Icon
                      name="mdi:arrow-u-left-top"
                      tone={isBackTranslationOpen() ? "brand" : "muted-foreground"}
                      class="size-3.5"
                    />
                  </Button>
                </If>
                <RetryIconButton
                  testID="quick-translate-retry"
                  onPress={() => props.onRetry(props.card().id)}
                />
              </View>
            </View>
            <If when={props.speakError() !== null}>
              <View class="px-4 pb-2.5">
                <Text
                  testID="quick-translate-speak-result-error"
                  role="alert"
                  class="text-xs text-destructive"
                >
                  {props.speakError() ?? ""}
                </Text>
              </View>
            </If>
            <If when={props.card().anki.status !== "idle"}>
              <View class="px-4 pb-2.5">
                <Text
                  testID="quick-translate-anki-status"
                  role={props.card().anki.status === "error" ? "alert" : undefined}
                  class={
                    props.card().anki.status === "error"
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {(() => {
                    const anki = props.card().anki;
                    if (anki.status === "adding") return t("quickTranslate.ankiAdding");
                    if (anki.status === "added") return t("quickTranslate.ankiAdded");
                    if (anki.status === "error") return anki.message;
                    return "";
                  })()}
                </Text>
              </View>
            </If>
            <If when={props.card().copyError !== null}>
              <View class="px-4 pb-2.5">
                <Text
                  testID="quick-translate-copy-error"
                  role="alert"
                  class="text-xs text-destructive"
                >
                  {props.card().copyError ?? ""}
                </Text>
              </View>
            </If>
          </View>
        </If>
      </If>
    </View>
  );
}

/** Compact Quick Translate popup body composed inside the floating window or standalone harness. */
export function QuickTranslatePopup(props: QuickTranslatePopupProps) {
  const isComposing = signal(false);
  const sourceText = () => props.session.sourceText();
  const hasSourceText = () => sourceText().length > 0;
  const hasSpeakableSource = () => sourceText().trim().length > 0;
  const delivery = () => props.session.sourceDelivery();
  const isSourceCollapsed = () => props.session.sourceCollapsed() && hasSourceText();
  const showingHistory = () => props.session.historySnapshot() !== null;
  const sourceFirstLine = () => sourceText().split(/\r?\n/, 1)[0] ?? "";
  const sourceHasMultipleLines = () => /\r?\n/.test(sourceText());
  const sourceCharacterCount = () => Array.from(sourceText()).length;
  const sourceInputRef = signal<SourceInputHandle | null>(null);
  // Survives the editor unmounting into the one-line preview, so expand does not flash the largest step.
  const sourceFontStep = signal(LARGEST_FONT_STEP);
  const focusSourceAfterExpand = signal(false);
  // A fresh native field after an edit empties it, so the next text starts from the initial line box.
  const editorAlive = signal(true);
  let lastDeliverySeq = delivery()?.seq ?? 0;
  let popupAlive = true;

  interface ActiveMatchKey {
    entry: CardAlignmentEntry;
    segmentId: string;
  }
  interface ActiveSentenceMatch extends ActiveMatchKey {
    origin: AlignmentPreviewOrigin;
    sourceRange: SourceHighlightRange;
  }
  interface ActiveSentencePopover extends ActiveMatchKey {
    origin: AlignmentPreviewOrigin;
    sourceRange: SourceHighlightRange;
    sourceText: string;
    anchor: Bounds | ViewRef;
    maxWidth?: number;
  }

  const activeMatch = signal<ActiveSentenceMatch | null>(null);
  const sentencePopover = signal<ActiveSentencePopover | null>(null);
  const popoverTrace = createSentencePopoverTrace((failure) =>
    untracked(() => sentencePopoverLog.error("Sentence popover update failed", failure)),
  );
  const readPopoverForOverlay = () => {
    popoverTrace.record("overlay-render");
    return sentencePopover();
  };
  const keyboardAnnouncement = signal("");
  const focusedPreview = signal<{ entry: CardAlignmentEntry; node: ViewRef | null } | null>(null);
  const alignmentCache = new Map<string, CardAlignmentEntry>();
  const comparisonCache = new WeakMap<
    CardAlignmentEntry,
    { forward: CardAlignmentEntry | null; comparison: ResultComparison }
  >();
  const semanticPairs = new Map<string, SemanticPairEntry>();
  const semanticRevision = signal(0);
  let semanticWork = Promise.resolve();
  let pendingClearToken = 0;
  let pendingClearMatch: ActiveMatchKey | null = null;
  let pendingClearRaf: number | null = null;
  let popoverMeasureToken = 0;
  let lastOutsideDismiss: { key: ActiveMatchKey; pagePosition: Point; timestamp: number } | null =
    null;

  const isSameMatchKey = (left: ActiveMatchKey, right: ActiveMatchKey) =>
    left.entry === right.entry && left.segmentId === right.segmentId;

  const cancelPendingClear = () => {
    pendingClearMatch = null;
    pendingClearToken += 1;
    if (pendingClearRaf !== null) {
      cancelAnimationFrame(pendingClearRaf);
      pendingClearRaf = null;
    }
  };

  const closeSentencePopover = (reason: SentencePopoverDismissal) => {
    popoverMeasureToken += 1;
    if (sentencePopover() !== null) {
      popoverTrace.record(`dismiss:${reason}`);
      sentencePopover.set(null);
    }
  };

  const handlePopoverPressOutside = (pagePosition: Point) => {
    const current = sentencePopover();
    if (!current) return;
    lastOutsideDismiss = {
      key: {
        entry: current.entry,
        segmentId: current.segmentId,
      },
      pagePosition,
      timestamp: Date.now(),
    };
    closeSentencePopover("outside-press");
  };

  const clearActiveMatch = () => {
    cancelPendingClear();
    if (activeMatch() !== null) {
      activeMatch.set(null);
    }
    if (keyboardAnnouncement() !== "") {
      keyboardAnnouncement.set("");
    }
  };

  cleanup(() => {
    popoverTrace.record("popup-cleanup");
    popupAlive = false;
    cancelPendingClear();
    popoverMeasureToken += 1;
    props.session.notifyOverlayOpenChange("sentence-popover", false);
  });

  effect(() => {
    const open = sentencePopover() !== null;
    popoverTrace.record(open ? "notify-open" : "notify-closed");
    props.session.notifyOverlayOpenChange("sentence-popover", open);
    popoverTrace.record("notify-return");
  });

  const effectiveHighlightMatch = () => sentencePopover() ?? activeMatch();

  const currentRenderMode = (): AlignmentRenderMode =>
    props.markdownEnabled ? "markdown" : "plain";
  const isPreviewWindowVisible = () => props.windowVisible?.() ?? true;
  const requiresSemanticModel = props.semanticModelReady !== undefined;
  const semanticEnabled = () =>
    (props.sentenceAlignmentEnabled?.() ?? true) && (props.semanticModelReady?.() ?? false);
  const alignmentEnabled = () =>
    requiresSemanticModel ? semanticEnabled() : (props.sentenceAlignmentEnabled?.() ?? true);
  const alignmentKey = (input: CardAlignmentInput) =>
    `${input.cardId}:${input.resultId}:${input.target}:${input.renderMode}`;

  const alignmentText = (card: CardViewItem, target: AlignmentTarget): string | null => {
    if (card.result.status !== "success") return null;
    if (target === "result") return card.result.text;
    return card.backTranslation.status === "success" ? card.backTranslation.text : null;
  };

  const alignmentSource = (
    result: Extract<CardResultState, { status: "success" }>,
    target: AlignmentTarget,
  ) => (target === "result" ? result.sourceText : result.text);

  const isAlignmentForCard = (entry: CardAlignmentInput, card: CardViewItem | undefined) =>
    card?.result.status === "success" &&
    card.result.resultId === entry.resultId &&
    alignmentSource(card.result, entry.target) === entry.sourceText &&
    alignmentText(card, entry.target) === entry.text;

  /** Drops alignments whose output left the session, keeping collapsed and hidden cards. */
  const retainAlignmentEntries = (cards: readonly CardViewItem[]) => {
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const [key, entry] of semanticPairs) {
      if (!isAlignmentForCard(entry, byId.get(entry.cardId))) semanticPairs.delete(key);
    }
    for (const [key, entry] of alignmentCache) {
      if (!isAlignmentForCard(entry, byId.get(entry.cardId))) alignmentCache.delete(key);
    }
  };

  const isCardEligibleForAlignment = (
    card: CardViewItem,
  ): card is CardViewItem & {
    result: Extract<CardResultState, { status: "success" }>;
  } => {
    if (platform.os !== "windows" || !alignmentEnabled()) return false;
    if (showingHistory() || isComposing() || !isPreviewWindowVisible()) {
      return false;
    }
    if (card.collapsed || card.result.status !== "success") return false;
    return card.result.sourceText === sourceText();
  };

  const isPreviewCurrent = (entry: CardAlignmentEntry, cards = props.session.cards()) => {
    const card = cards.find((item) => item.id === entry.cardId);
    return (
      currentRenderMode() === entry.renderMode &&
      card !== undefined &&
      isCardEligibleForAlignment(card) &&
      isAlignmentForCard(entry, card)
    );
  };

  const cardAlignmentInput = (
    card: CardViewItem,
    target: AlignmentTarget,
    renderMode: AlignmentRenderMode,
  ): CardAlignmentInput | null => {
    if (!isCardEligibleForAlignment(card)) return null;
    const text = alignmentText(card, target);
    if (!text) return null;
    return {
      cardId: card.id,
      resultId: card.result.resultId,
      target,
      renderMode,
      sourceText: alignmentSource(card.result, target),
      text,
    };
  };

  const markdownComparisonSource = (input: CardAlignmentInput): MarkdownComparisonSource | null =>
    input.target === "back-translation" && input.renderMode === "markdown"
      ? prepareMarkdownComparisonSource(input.sourceText)
      : null;

  effect(() => {
    if (!alignmentEnabled()) {
      semanticPairs.clear();
      alignmentCache.clear();
      return;
    }
    if (!semanticEnabled()) return;
    const mode = currentRenderMode();
    for (const card of props.session.cards()) {
      for (const target of ALIGNMENT_TARGETS) {
        const input = cardAlignmentInput(card, target, mode);
        if (!input) continue;
        const key = alignmentKey(input);
        const cached = semanticPairs.get(key);
        if (cached?.sourceText === input.sourceText && cached.text === input.text) continue;
        const entry: SemanticPairEntry = input;
        semanticPairs.set(key, entry);
        trimCache(semanticPairs, MAX_SEMANTIC_PAIR_ENTRIES);
        const isCurrent = () => popupAlive && semanticPairs.get(key) === entry;
        semanticWork = semanticWork.then(async () => {
          if (!isCurrent()) return;
          let pairs: SentenceAlignmentPair[] | null;
          try {
            const blocks =
              mode === "markdown"
                ? (prepareMarkdownAlignment(entry.text)?.targetBlocks ?? [])
                : [entry.text];
            const source = markdownComparisonSource(entry)?.text ?? entry.sourceText;
            pairs = await SentenceAlignmentNative.alignSemantic(source, blocks);
          } catch {
            pairs = null;
          }
          if (!isCurrent()) return;
          entry.pairs = pairs;
          semanticRevision.update((revision) => revision + 1);
        });
      }
    }
  });

  const resolveCardAlignment = (
    card: CardViewItem,
    target: AlignmentTarget,
  ): CardAlignmentEntry | null => {
    const input = cardAlignmentInput(card, target, currentRenderMode());
    if (!input) return null;
    const key = alignmentKey(input);
    let matches: SentenceAlignmentPair[] | null = null;
    if (semanticEnabled()) {
      semanticRevision();
      const cached = semanticPairs.get(key);
      if (!cached?.pairs || cached.sourceText !== input.sourceText || cached.text !== input.text) {
        return null;
      }
      matches = cached.pairs;
    } else if (requiresSemanticModel) {
      return null;
    }
    const existing = alignmentCache.get(key);
    if (existing?.sourceText === input.sourceText && existing.text === input.text) {
      return existing;
    }

    const comparisonSource = markdownComparisonSource(input);
    const alignmentSourceText = comparisonSource?.text ?? input.sourceText;
    const prepared = input.renderMode === "markdown" ? prepareMarkdownAlignment(input.text) : null;
    const blocks = input.renderMode === "markdown" ? (prepared?.targetBlocks ?? []) : [input.text];
    const pairs = matches ?? SentenceAlignmentNative.align(alignmentSourceText, blocks);
    let document: TextViewDocument | null = null;
    const segments: SentenceSegment[] = [];
    const sourceRanges: Record<string, SourceHighlightRange> = {};

    if (prepared) {
      const built = finalizeMarkdownAlignment(alignmentSourceText, prepared, pairs);
      if (built) {
        document = built.document;
        for (const seg of built.segments) {
          segments.push({ id: seg.id, testID: seg.testID, start: 0, end: 0 });
          sourceRanges[seg.id] = { start: seg.sourceStart, end: seg.sourceEnd };
        }
      }
    } else if (input.renderMode === "plain") {
      for (const pair of pairs) {
        if (pair.targetBlockIndex !== 0) continue;
        if (
          pair.targetStart < 0 ||
          pair.targetEnd <= pair.targetStart ||
          pair.targetEnd > input.text.length
        ) {
          continue;
        }
        if (
          pair.sourceStart < 0 ||
          pair.sourceEnd <= pair.sourceStart ||
          pair.sourceEnd > alignmentSourceText.length
        ) {
          continue;
        }
        const id = `seg-${segments.length}`;
        segments.push({
          id,
          testID: `result-seg-${segments.length}`,
          start: pair.targetStart,
          end: pair.targetEnd,
        });
        sourceRanges[id] = { start: pair.sourceStart, end: pair.sourceEnd };
      }
    }

    const entry: CardAlignmentEntry = {
      ...input,
      comparisonSource,
      pairs,
      document,
      segments,
      sourceRanges,
    };
    alignmentCache.set(key, entry);
    trimCache(alignmentCache, MAX_ALIGNMENT_CACHE_ENTRIES);
    return entry;
  };

  const activateMatch = (next: ActiveSentenceMatch) => {
    cancelPendingClear();
    const current = activeMatch();
    if (current && isSameMatchKey(current, next) && current.origin === next.origin) {
      return;
    }
    if (next.origin === "pointer" && keyboardAnnouncement() !== "") {
      keyboardAnnouncement.set("");
    }
    if (next.origin === "pointer") popoverTrace.record("hover-match");
    activeMatch.set(next);
  };

  const scheduleClearMatch = (leaving: ActiveMatchKey) => {
    const current = activeMatch();
    if (!current || current.origin !== "pointer" || !isSameMatchKey(current, leaving)) return;
    const token = ++pendingClearToken;
    pendingClearMatch = leaving;
    if (pendingClearRaf !== null) {
      cancelAnimationFrame(pendingClearRaf);
    }
    pendingClearRaf = requestAnimationFrame(() => {
      pendingClearRaf = null;
      if (!popupAlive || pendingClearToken !== token || !pendingClearMatch) return;
      const latest = activeMatch();
      if (latest && latest.origin === "pointer" && isSameMatchKey(latest, pendingClearMatch)) {
        activeMatch.set(null);
      }
      pendingClearMatch = null;
    });
  };

  let lastScrollRevision = props.scrollRevision?.() ?? 0;
  let lastSemanticState = semanticEnabled();
  let lastSourceCollapsed = isSourceCollapsed();
  effect(() => {
    popoverTrace.record("alignment-validation");
    const cards = props.session.cards();
    retainAlignmentEntries(cards);

    const scrollRev = props.scrollRevision?.() ?? 0;
    const scrolled = scrollRev !== lastScrollRevision;
    lastScrollRevision = scrollRev;

    const collapsed = isSourceCollapsed();
    const sourceCollapsedChanged = collapsed !== lastSourceCollapsed;
    lastSourceCollapsed = collapsed;
    const visible = isPreviewWindowVisible();
    const semanticState = semanticEnabled();
    const alignmentChanged = semanticState !== lastSemanticState;
    lastSemanticState = semanticState;
    if (alignmentChanged || !alignmentEnabled()) {
      if (focusedPreview() !== null) focusedPreview.set(null);
      clearActiveMatch();
      closeSentencePopover("alignment-changed");
    }

    const focused = focusedPreview();
    if (focused && !isPreviewCurrent(focused.entry, cards)) {
      focusedPreview.set(null);
    }

    const currentPopover = sentencePopover();
    if (
      currentPopover &&
      (sourceCollapsedChanged || scrolled || !isPreviewCurrent(currentPopover.entry, cards))
    ) {
      closeSentencePopover(scrolled ? "scroll" : !visible ? "window-hidden" : "invalidated");
    }

    const current = activeMatch();
    if (
      current &&
      (sourceCollapsedChanged || scrolled || !isPreviewCurrent(current.entry, cards))
    ) {
      clearActiveMatch();
    }
  });

  const activeSourceHighlight = (): SourceHighlightRange | null => {
    popoverTrace.record("source-highlight");
    const current = effectiveHighlightMatch();
    if (
      current?.entry.target !== "result" ||
      isSourceCollapsed() ||
      !isPreviewCurrent(current.entry)
    ) {
      return null;
    }
    return current.sourceRange;
  };

  const matchedSentence = (entry: CardAlignmentEntry, range: SourceHighlightRange) =>
    (entry.comparisonSource?.text ?? entry.sourceText).slice(range.start, range.end).trim();

  const stepCardPreview = (
    entry: CardAlignmentEntry,
    delta: -1 | 1,
    origin: KeyboardPreviewOrigin,
  ) => {
    if (!isPreviewCurrent(entry)) return;

    const current = effectiveHighlightMatch();
    const currentIndex =
      current?.entry === entry
        ? entry.segments.findIndex((seg) => seg.id === current.segmentId)
        : -1;
    const nextIndex =
      currentIndex >= 0
        ? Math.max(0, Math.min(entry.segments.length - 1, currentIndex + delta))
        : delta > 0
          ? 0
          : entry.segments.length - 1;
    const seg = entry.segments[nextIndex];
    if (!seg) return;
    const sourceRange = entry.sourceRanges[seg.id];
    if (!sourceRange) return;

    const matchedSource = matchedSentence(entry, sourceRange);
    keyboardAnnouncement.set(
      t("quickTranslate.sentencePreviewValue", {
        current: nextIndex + 1,
        total: entry.segments.length,
        text: matchedSource,
      }),
    );
    activateMatch({ entry, segmentId: seg.id, origin, sourceRange });
    const openPopover = sentencePopover();
    if (openPopover?.entry === entry) {
      if (matchedSource.length > 0) {
        sentencePopover.set({
          ...openPopover,
          segmentId: seg.id,
          sourceRange,
          sourceText: matchedSource,
        });
      } else {
        closeSentencePopover("unmatched");
      }
    }
  };

  const handlePressSegment = (
    entry: CardAlignmentEntry,
    segmentId: string,
    event: PressEvent,
    previewNode: ViewRef | null,
  ) => {
    if (
      event.clickCount > 1 ||
      event.modifiers.shift ||
      event.modifiers.control ||
      event.modifiers.alt ||
      event.modifiers.platform
    ) {
      return;
    }
    if (!isPreviewCurrent(entry)) return;
    const sourceRange = entry.sourceRanges[segmentId];
    if (!sourceRange) return;
    const matchedSource = matchedSentence(entry, sourceRange);
    if (!matchedSource) return;

    const key: ActiveMatchKey = { entry, segmentId };
    const current = sentencePopover();
    if (current && isSameMatchKey(current, key)) {
      lastOutsideDismiss = null;
      closeSentencePopover("toggle");
      return;
    }
    if (
      lastOutsideDismiss &&
      isSameMatchKey(lastOutsideDismiss.key, key) &&
      Date.now() - lastOutsideDismiss.timestamp < OUTSIDE_DISMISS_TOGGLE_MS &&
      Math.hypot(
        event.pagePosition.x - lastOutsideDismiss.pagePosition.x,
        event.pagePosition.y - lastOutsideDismiss.pagePosition.y,
      ) <= OUTSIDE_DISMISS_TOGGLE_RADIUS
    ) {
      lastOutsideDismiss = null;
      return;
    }
    lastOutsideDismiss = null;
    if (keyboardAnnouncement() !== "") {
      keyboardAnnouncement.set("");
    }
    const lineY = event.pagePosition.y - LINE_ANCHOR_HALF_HEIGHT;
    const initialAnchor: Bounds = {
      origin: { x: event.pagePosition.x, y: lineY },
      size: { width: 1, height: LINE_ANCHOR_HALF_HEIGHT * 2 },
    };
    const token = ++popoverMeasureToken;
    // The setter flushes its reactive dependants before returning.
    popoverTrace.run(
      untracked(() => ({
        markdown: entry.renderMode === "markdown",
        sourceCollapsed: isSourceCollapsed(),
        replacingPopover: current !== null,
        resultId: entry.resultId,
        segmentId,
        segmentCount: entry.segments.length,
        resultLength: entry.text.length,
        scrollRevision: props.scrollRevision?.() ?? 0,
      })),
      () =>
        sentencePopover.set({
          ...key,
          origin: "pointer",
          sourceRange,
          sourceText: matchedSource,
          anchor: initialAnchor,
        }),
    );
    void previewNode?.measure().then((measured) => {
      if (!popupAlive || popoverMeasureToken !== token || !measured) return;
      const latestPopover = sentencePopover();
      if (!latestPopover || !isSameMatchKey(latestPopover, key)) return;
      sentencePopover.set({
        ...latestPopover,
        anchor: {
          origin: { x: measured.pagePosition.x, y: lineY },
          size: { width: measured.bounds.size.width, height: LINE_ANCHOR_HALF_HEIGHT * 2 },
        },
        maxWidth: measured.bounds.size.width,
      });
    });
  };

  const toggleKeyboardPopover = (
    entry: CardAlignmentEntry,
    previewNode: ViewRef | null,
    origin: KeyboardPreviewOrigin,
  ) => {
    if (!previewNode || !isPreviewCurrent(entry)) return;

    const currentHighlight = effectiveHighlightMatch();
    let segmentId = currentHighlight?.entry === entry ? currentHighlight.segmentId : undefined;
    if (!segmentId) {
      stepCardPreview(entry, 1, origin);
      const nextMatch = activeMatch();
      if (nextMatch?.entry !== entry) return;
      segmentId = nextMatch.segmentId;
    }

    const key: ActiveMatchKey = { entry, segmentId };
    const currentPopover = sentencePopover();
    if (currentPopover && isSameMatchKey(currentPopover, key)) {
      lastOutsideDismiss = null;
      closeSentencePopover("toggle");
      return;
    }

    const sourceRange = entry.sourceRanges[segmentId];
    if (!sourceRange) return;
    const matchedSource = matchedSentence(entry, sourceRange);
    if (!matchedSource) return;

    lastOutsideDismiss = null;
    const token = ++popoverMeasureToken;
    sentencePopover.set({
      ...key,
      origin,
      sourceRange,
      sourceText: matchedSource,
      anchor: previewNode,
    });
    void previewNode.measure().then((measured) => {
      if (!popupAlive || popoverMeasureToken !== token || !measured) return;
      const latestPopover = sentencePopover();
      if (!latestPopover || !isSameMatchKey(latestPopover, key)) return;
      sentencePopover.set({
        ...latestPopover,
        maxWidth: measured.bounds.size.width,
      });
    });
  };

  effect(() => {
    const focused = focusedPreview();
    if (!focused) return;
    const unbind = appKeymap.bind(
      {
        left: () => stepCardPreview(focused.entry, -1, "keyboard"),
        right: () => stepCardPreview(focused.entry, 1, "keyboard"),
        enter: () => toggleKeyboardPopover(focused.entry, focused.node, "keyboard"),
        space: () => toggleKeyboardPopover(focused.entry, focused.node, "keyboard"),
      },
      { when: "always", forFocus: true },
    );
    cleanup(unbind);
  });

  const buildResultComparison = (card: CardViewItem): ResultComparison | null => {
    const back = resolveCardAlignment(card, "back-translation");
    if (!back || back.segments.length === 0) return null;
    const forward = back.comparisonSource ? resolveCardAlignment(card, "result") : null;
    const cached = comparisonCache.get(back);
    if (cached?.forward === forward) return cached.comparison;

    const segments = Object.entries(back.sourceRanges).map(([id, range]) => ({ id, ...range }));
    let document: TextViewDocument | undefined;
    if (back.comparisonSource) {
      const prepared = prepareMarkdownAlignment(back.sourceText);
      if (prepared) {
        document = finalizeMarkdownAlignment(
          forward?.sourceText ?? "",
          prepared,
          forward?.pairs ?? [],
          projectMarkdownComparison(back.comparisonSource, segments),
        )?.document;
      }
    }
    const comparison: ResultComparison = {
      document,
      segments,
      activeSegmentId: () => {
        const current = effectiveHighlightMatch();
        return current?.entry === back ? current.segmentId : null;
      },
    };
    comparisonCache.set(back, { forward, comparison });
    return comparison;
  };

  const buildCardSentenceAlignment = (
    card: CardViewItem,
    target: AlignmentTarget,
  ): CardSentenceAlignment | null => {
    const entry = resolveCardAlignment(card, target);
    if (!entry || entry.segments.length === 0) return null;
    return {
      document: entry.document,
      segments: entry.segments,
      activeSegmentId: () => {
        popoverTrace.record("target-highlight");
        const current = effectiveHighlightMatch();
        return current?.entry === entry ? current.segmentId : null;
      },
      keyboardValue: () => {
        const current = effectiveHighlightMatch();
        if (current?.entry !== entry || current.origin === "pointer") return undefined;
        return keyboardAnnouncement() || undefined;
      },
      onHoverEnterSegment: (segmentId) => {
        if (!isPreviewCurrent(entry)) return;
        const sourceRange = entry.sourceRanges[segmentId];
        if (!sourceRange) return;
        activateMatch({ entry, segmentId, origin: "pointer", sourceRange });
      },
      onHoverLeaveSegment: (segmentId) => scheduleClearMatch({ entry, segmentId }),
      onPressSegment: (segmentId, event, node) => handlePressSegment(entry, segmentId, event, node),
      onShowSourcePopover: (node) => toggleKeyboardPopover(entry, node, "accessibility"),
      onKeyboardStep: (delta) => stepCardPreview(entry, delta, "accessibility"),
      onKeyboardFocus: (node) => focusedPreview.set({ entry, node }),
      onKeyboardBlur: () => {
        if (focusedPreview()?.entry === entry) focusedPreview.set(null);
        const currentPopover = sentencePopover();
        if (currentPopover?.entry === entry && currentPopover.origin !== "pointer") {
          closeSentencePopover("preview-blur");
        }
        const current = activeMatch();
        if (current?.entry === entry && current.origin !== "pointer") clearActiveMatch();
      },
    };
  };

  effect(() => {
    const current = delivery();
    const seq = current?.seq ?? 0;
    if (seq === lastDeliverySeq) return;
    lastDeliverySeq = seq;
    if (current?.kind === "ocr") focusSourceAfterExpand.set(true);
  });

  // Any edit that empties the field (Select All and Delete included) must drop the previous
  // line box. Rebuild the native field between two frames: blur first, then replace it, so
  // nothing is disposed while the control still owns the keyboard. An input method composes
  // the first character of a replacement with the field already empty, so the rebuild waits
  // until it commits or gives up: dropping the field there loses the composition.
  let pendingEmptyRebuild = false;
  const rebuildEmptyField = () => {
    requestAnimationFrame(() => {
      if (!popupAlive) return;
      if (isComposing()) {
        pendingEmptyRebuild = true;
        return;
      }
      if (isSourceCollapsed() || hasSourceText()) return;
      sourceInputRef()?.blur();
      editorAlive.set(false);
      requestAnimationFrame(() => {
        if (!popupAlive) return;
        editorAlive.set(true);
        requestAnimationFrame(() => {
          if (!popupAlive) return;
          if (isComposing()) {
            pendingEmptyRebuild = true;
            return;
          }
          if (isSourceCollapsed() || hasSourceText()) return;
          const input = sourceInputRef();
          input?.focus();
          input?.setSelection(0, 0);
        });
      });
    });
  };

  let hadSourceText = hasSourceText();
  effect(() => {
    const has = hasSourceText();
    if (has) {
      pendingEmptyRebuild = false;
    } else if (hadSourceText) {
      sourceFontStep.set(LARGEST_FONT_STEP);
      if (isComposing()) pendingEmptyRebuild = true;
      else rebuildEmptyField();
    }
    hadSourceText = has;
  });

  effect(() => {
    if (!pendingEmptyRebuild || isComposing() || hasSourceText()) return;
    pendingEmptyRebuild = false;
    rebuildEmptyField();
  });

  const expandSource = () => {
    focusSourceAfterExpand.set(true);
    props.session.setSourceCollapsed(false);
  };

  // The editor remounts on expand: focus it with the caret past the last character.
  effect(() => {
    const input = sourceInputRef();
    if (!focusSourceAfterExpand() || isSourceCollapsed() || input === null) return;
    focusSourceAfterExpand.set(false);
    input.focus();
    const end = sourceText().length;
    input.setSelection(end, end);
  });

  type SpeechOwner =
    | { kind: "source"; text: string; selection: SourceLanguageId }
    | { kind: "dictionary"; slot: "inline"; term: string }
    | { kind: "result"; cardId: string; text: string; language: string }
    | { kind: "back-translation"; cardId: string; text: string; language: string };

  const sourceSpeechError = signal<string | null>(null);
  const inlineDictionarySpeechError = signal<string | null>(null);
  const resultSpeechErrors = signal<Readonly<Record<string, string>>>({});
  const backTranslationSpeechErrors = signal<Readonly<Record<string, string>>>({});
  const speechPhase = signal<"idle" | "loading" | "playing">("idle");
  const speechOwner = signal<SpeechOwner | null>(null);
  let speechToken = 0;
  let speechAbort: AbortController | null = null;
  let stopSpeech: (() => void) | null = null;
  let activeCredential = "";
  const activeSpeech = () => ttsChannels.activeChannel();
  const speakEnabled = () => activeSpeech() !== null;
  const credentialSignature = () => {
    const active = activeSpeech();
    if (active === null) return "";
    const signature = ttsChannels.definition(active.id)?.signature?.(active.binding) ?? "";
    return `${active.id}\0${active.binding.credentialRef ?? ""}\0${signature}`;
  };

  const cancelSpeech = () => {
    speechToken += 1;
    speechAbort?.abort();
    speechAbort = null;
    stopSpeech?.();
    stopSpeech = null;
    speechPhase.set("idle");
    speechOwner.set(null);
  };

  cleanup(cancelSpeech);

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "source" || speechPhase() === "idle") return;
    if (owner.text !== sourceText() || owner.selection !== props.session.sourceLanguage()) {
      cancelSpeech();
    }
  });

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "dictionary" || speechPhase() === "idle") return;
    const inline = props.session.inlineDictionary();
    const currentTerm = inline.status === "entry" ? inline.entry.term : "";
    if (currentTerm !== owner.term) cancelSpeech();
  });

  effect(() => {
    const inline = props.session.inlineDictionary();
    if (inline.status !== "entry") inlineDictionarySpeechError.set(null);
  });

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "result" || speechPhase() === "idle") return;
    const card = props.session.cards().find((item) => item.id === owner.cardId);
    const result = card?.result;
    const current =
      card !== undefined && !card.collapsed && result?.status === "success"
        ? `${result.text}\0${result.targetLanguage}`
        : "";
    if (current !== `${owner.text}\0${owner.language}`) cancelSpeech();
  });

  effect(() => {
    const owner = speechOwner();
    if (owner?.kind !== "back-translation" || speechPhase() === "idle") return;
    const card = props.session.cards().find((item) => item.id === owner.cardId);
    const current =
      card !== undefined &&
      !card.collapsed &&
      card.result.status === "success" &&
      card.backTranslation.status === "success"
        ? `${card.backTranslation.text}\0${card.result.sourceLanguage}`
        : "";
    if (current !== `${owner.text}\0${owner.language}`) cancelSpeech();
  });

  effect(() => {
    const cards = props.session.cards();
    const errors = backTranslationSpeechErrors();
    const keys = Object.keys(errors);
    if (keys.length === 0) return;
    const byId = new Map(cards.map((card) => [card.id, card]));
    let changed = false;
    const next: Record<string, string> = {};
    for (const cardId of keys) {
      const card = byId.get(cardId);
      if (card !== undefined && !card.collapsed && card.backTranslation.status === "success") {
        next[cardId] = errors[cardId]!;
      } else {
        changed = true;
      }
    }
    if (changed) backTranslationSpeechErrors.set(next);
  });

  effect(() => {
    if (speechPhase() !== "idle" && credentialSignature() !== activeCredential) cancelSpeech();
  });

  effect(() => {
    if (props.playbackAllowed && !props.playbackAllowed() && speechPhase() !== "idle") {
      cancelSpeech();
    }
  });

  const setCardSpeechError = (
    store: Signal<Readonly<Record<string, string>>>,
    cardId: string,
    message: string | null,
  ) => {
    const next = { ...store() };
    if (message === null) delete next[cardId];
    else next[cardId] = message;
    store.set(next);
  };

  const mountedSpeech = (token: number) => token === speechToken;

  const finishSpeech = (token: number) => {
    if (!mountedSpeech(token)) return;
    stopSpeech = null;
    speechPhase.set("idle");
    speechOwner.set(null);
  };

  const runSpeech = async (input: {
    owner: SpeechOwner;
    text: string;
    /** Null asks for an Automatic source detection before synthesis. */
    language: LanguageId | null;
    report: (message: string | null) => void;
  }) => {
    const token = ++speechToken;
    speechAbort?.abort();
    stopSpeech?.();
    stopSpeech = null;
    const controller = new AbortController();
    speechAbort = controller;
    activeCredential = credentialSignature();
    speechOwner.set(input.owner);
    speechPhase.set("loading");
    input.report(null);
    if (!speakEnabled()) {
      finishSpeech(token);
      input.report(t("quickTranslate.speakOff"));
      return;
    }
    let language = input.language;
    if (language === null) {
      const detected = await props.session.detectSourceLanguage(controller.signal);
      if (!mountedSpeech(token)) return;
      if (controller.signal.aborted || detected === null) {
        finishSpeech(token);
        return;
      }
      if (!detected.ok) {
        finishSpeech(token);
        if (detected.code !== "cancelled") {
          input.report(
            detected.code === "unconfigured"
              ? t("quickTranslate.speakChooseSource")
              : languageResolutionErrorMessage(detected.code),
          );
        }
        return;
      }
      language = detected.language;
    }
    const prepared = await prepareQuickSpeech({ text: input.text, language });
    if (!mountedSpeech(token)) return;
    if (!prepared.ok) {
      finishSpeech(token);
      input.report(prepared.message);
      return;
    }
    const speech = prepared.speech;
    if (!mountedSpeech(token) || credentialSignature() !== activeCredential) {
      finishSpeech(token);
      return;
    }
    const synthesized = await synthesizeSpeech(speech, { signal: controller.signal });
    if (!mountedSpeech(token)) return;
    if (controller.signal.aborted || synthesized.status === "cancelled") {
      finishSpeech(token);
      return;
    }
    if (credentialSignature() !== activeCredential) {
      finishSpeech(token);
      return;
    }
    if (synthesized.status === "failed") {
      finishSpeech(token);
      input.report(quickSpeechFailureMessage(synthesized.failure, speech.channel));
      return;
    }
    const playback = playMp3Bytes(synthesized.audio, {
      onPlaying: () => {
        if (!mountedSpeech(token)) {
          playback.stop();
          return;
        }
        speechPhase.set("playing");
      },
    });
    stopSpeech = () => playback.stop();
    const played = await playback.result;
    if (!mountedSpeech(token)) return;
    finishSpeech(token);
    if (played.status === "failed") input.report(t("quickTranslate.speakPlayback"));
  };

  const speakSource = () => {
    const selected = props.session.sourceLanguage();
    void runSpeech({
      owner: { kind: "source", text: sourceText(), selection: selected },
      text: sourceText(),
      language: selected === AUTO_LANGUAGE ? null : selected,
      report: (message) => sourceSpeechError.set(message),
    });
  };

  const speakInlineDictionary = () => {
    const inline = props.session.inlineDictionary();
    if (inline.status !== "entry") return;
    const selected = props.session.sourceLanguage();
    void runSpeech({
      owner: { kind: "dictionary", slot: "inline", term: inline.entry.term },
      text: inline.entry.term,
      language: selected === AUTO_LANGUAGE ? null : selected,
      report: (message) => inlineDictionarySpeechError.set(message),
    });
  };

  const speakResult = (cardId: string) => {
    const card = props.session.cards().find((item) => item.id === cardId);
    if (card === undefined || card.result.status !== "success") return;
    void runSpeech({
      owner: {
        kind: "result",
        cardId,
        text: card.result.text,
        language: card.result.targetLanguage,
      },
      text: card.result.text,
      language: card.result.targetLanguage,
      report: (message) => setCardSpeechError(resultSpeechErrors, cardId, message),
    });
  };

  const speakBackTranslation = (cardId: string) => {
    const card = props.session.cards().find((item) => item.id === cardId);
    if (
      card === undefined ||
      card.collapsed ||
      card.result.status !== "success" ||
      card.backTranslation.status !== "success" ||
      card.backTranslation.text.trim().length === 0
    ) {
      return;
    }
    void runSpeech({
      owner: {
        kind: "back-translation",
        cardId,
        text: card.backTranslation.text,
        language: card.result.sourceLanguage,
      },
      text: card.backTranslation.text,
      language: card.result.sourceLanguage,
      report: (message) => setCardSpeechError(backTranslationSpeechErrors, cardId, message),
    });
  };

  const speechControl = (
    target:
      | "source"
      | "inline-dictionary"
      | { kind: "result" | "back-translation"; cardId: string },
  ): DictionarySpeakControlState => {
    const owner = speechOwner();
    const mine =
      owner !== null &&
      (target === "source"
        ? owner.kind === "source"
        : target === "inline-dictionary"
          ? owner.kind === "dictionary" && owner.slot === "inline"
          : owner.kind === target.kind && owner.cardId === target.cardId);
    const phase = mine ? speechPhase() : "idle";
    if (phase === "loading") {
      return {
        disabled: false,
        tooltip: t("common.cancel"),
        label: t("common.cancel"),
        icon: "mdi:close-circle" as const,
        busy: true,
      };
    }
    if (phase === "playing") {
      return {
        disabled: false,
        tooltip: t("settings.tts.stop"),
        label: t("settings.tts.stop"),
        icon: "mdi:stop-circle-outline" as const,
        busy: true,
      };
    }
    const readyLabel =
      typeof target !== "string" && target.kind === "back-translation"
        ? t("quickTranslate.speakBackTranslation")
        : t("quickTranslate.speak");
    return {
      disabled: !speakEnabled(),
      tooltip: speakEnabled() ? undefined : t("quickTranslate.speakOff"),
      label: speakEnabled() ? readyLabel : t("quickTranslate.speakOff"),
      icon: "mdi:volume-high" as const,
      busy: false,
    };
  };

  const draggingCardId = signal<string | null>(null);
  const settlingCards = signal(false);
  const cardOffsets = new Map<string, AnimatedValue>();
  const cardSlots = new Map<string, { top: number; height: number }>();
  const cardGripNodes = new Map<string, ViewRef>();
  const cardOrder = () => props.session.cards().map((card) => card.id);
  const canReorderCards = () => props.session.cards().length > 1;

  const cardOffset = (cardId: string): AnimatedValue => {
    const existing = cardOffsets.get(cardId);
    if (existing !== undefined) return existing;
    const created = createAnimatedValue(0);
    cardOffsets.set(cardId, created);
    return created;
  };

  const animateCardOffset = (cardId: string, to: number): Promise<unknown> => {
    if (reduceMotion()) {
      cardOffset(cardId).set(to);
      return Promise.resolve();
    }
    return cardOffset(cardId).timing(to, { duration: CARD_REORDER_SETTLE_MS, easing: "easeOut" });
  };

  const resetCardOffsets = () => {
    for (const offset of cardOffsets.values()) offset.set(0);
  };

  const handleCardDragStart = (cardId: string) => {
    if (!canReorderCards() || settlingCards() || draggingCardId() !== null) return;
    draggingCardId.set(cardId);
  };

  /** The card whose measured slot center is nearest the dragged card's center. */
  const nearestCardSlot = (cardId: string, offsetY: number): number | null => {
    const slot = cardSlots.get(cardId);
    if (slot === undefined) return null;
    const center = slot.top + slot.height / 2 + offsetY;
    let target: number | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    cardOrder().forEach((other, position) => {
      const otherSlot = cardSlots.get(other);
      if (otherSlot === undefined) return;
      const distance = Math.abs(otherSlot.top + otherSlot.height / 2 - center);
      if (distance < nearest) {
        nearest = distance;
        target = position;
      }
    });
    return target;
  };

  /** Slides every card into the slot the reordered list gives it. */
  const settleCardsIntoSlots = async (cardId: string, target: number) => {
    const list = cardOrder();
    const nextOrder = [...list];
    nextOrder.splice(list.indexOf(cardId), 1);
    nextOrder.splice(target, 0, cardId);
    const moves: Promise<unknown>[] = [];
    nextOrder.forEach((row, position) => {
      const from = cardSlots.get(row);
      const to = cardSlots.get(list[position]!);
      if (from === undefined || to === undefined || from.top === to.top) return;
      moves.push(animateCardOffset(row, to.top - from.top));
    });
    await Promise.all(moves);
  };

  const handleCardDragEnd = async (cardId: string, event: PanEvent) => {
    if (draggingCardId() !== cardId) {
      await animateCardOffset(cardId, 0);
      return;
    }
    settlingCards.set(true);
    try {
      const index = cardOrder().indexOf(cardId);
      const target = nearestCardSlot(cardId, event.value?.y ?? event.translation.y);
      if (event.cancelled || index === -1 || target === null || target === index) {
        await animateCardOffset(cardId, 0);
        return;
      }
      await settleCardsIntoSlots(cardId, target);
      props.session.handleMoveCard(cardId, target);
      resetCardOffsets();
    } finally {
      draggingCardId.set(null);
      settlingCards.set(false);
    }
  };

  const moveCardBy = (cardId: string, delta: number, refocus: boolean) => {
    if (!canReorderCards() || settlingCards() || draggingCardId() !== null) return;
    const list = cardOrder();
    const index = list.indexOf(cardId);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return;
    props.session.handleMoveCard(cardId, target);
    if (refocus) queueMicrotask(() => cardGripNodes.get(cardId)?.focus());
  };

  const ocrMessage = () => (props.ocrState ? props.ocrState().message : null);
  const ocrRecognizing = () => (props.ocrState ? props.ocrState().phase === "recognizing" : false);
  // One bottom-left status slot serves OCR errors and active recognition by priority.
  const showOcrError = () => ocrMessage() !== null;
  const showOcrBusy = () => !showOcrError() && ocrRecognizing();
  const showOcrEmptyPlaceholder = () => showOcrBusy() && !hasSourceText() && !isSourceCollapsed();
  const ocrStatusOpacity = createAnimatedValue(motion.statusPulse.reducedOpacity);
  effect(() => {
    if (!showOcrBusy() || reduceMotion()) {
      ocrStatusOpacity.set(motion.statusPulse.reducedOpacity);
      return;
    }
    void ocrStatusOpacity.keyframes(
      [motion.statusPulse.minOpacity, motion.statusPulse.maxOpacity, motion.statusPulse.minOpacity],
      {
        duration: motion.statusPulse.duration,
        easing: motion.statusPulse.easing,
        iterations: "infinite",
      },
    );
    cleanup(() => {
      void ocrStatusOpacity.stop();
    });
  });
  const selectionFeedback = () => (props.selectionFeedback ? props.selectionFeedback() : null);
  const selectionMessage = () => {
    const feedback = selectionFeedback();
    if (feedback === "unavailable") return t("quickTranslate.selectionUnavailable");
    if (feedback === "noSelection") return t("quickTranslate.selectionNoSelection");
    return null;
  };
  const hasToolbarStatus = () => showOcrError() || showOcrBusy() || selectionMessage() !== null;
  const hasSourceToolbar = () => hasSourceText() || hasToolbarStatus();

  const renderSourceActions = (extraClass = "") => (
    <If when={hasSourceText()}>
      <View
        testID="quick-translate-source-actions"
        class={`shrink-0 flex-row items-center gap-0.5 ${extraClass}`}
      >
        <Button
          testID="quick-translate-clear"
          size="icon-xs"
          variant="ghost"
          tooltip={t("common.clearInput")}
          accessibilityLabel={t("common.clearInput")}
          onPress={() => {
            props.session.handleClearSource();
            // Return the caret to the empty field's start so the next keystroke starts clean.
            queueMicrotask(() => {
              const input = sourceInputRef();
              input?.focus();
              input?.setSelection(0, 0);
            });
          }}
        >
          <Icon name="mdi:close-circle" tone="muted-foreground" class="size-3.5" />
        </Button>
      </View>
    </If>
  );

  const renderSourceStatus = () => (
    <If when={hasSourceToolbar()}>
      <View testID="quick-translate-source-toolbar" class="mt-2 flex-row items-center gap-1.5">
        <If when={hasSpeakableSource()}>
          {/* Pull the 24pt button left 4pt so the speaker glyph aligns with the px-4 spine. */}
          <View class="-ml-1 shrink-0">
            <SpeakerButton
              testID="quick-translate-speak-source"
              disabled={speechControl("source").disabled}
              tooltip={speechControl("source").tooltip}
              label={speechControl("source").label}
              icon={speechControl("source").icon}
              onPress={() => {
                if (speechControl("source").busy) cancelSpeech();
                else speakSource();
              }}
            />
          </View>
          <If when={sourceSpeechError() !== null}>
            <Text
              testID="quick-translate-speak-source-error"
              role="alert"
              class="min-w-0 flex-1 text-xs text-destructive"
            >
              {sourceSpeechError() ?? ""}
            </Text>
          </If>
        </If>
        <If when={showOcrError()}>
          <Text
            testID="quick-translate-ocr-status"
            role="alert"
            class="min-w-0 flex-1 text-xs text-destructive"
          >
            {ocrMessage() ?? ""}
          </Text>
        </If>
        <If when={showOcrBusy()}>
          <View
            testID="quick-translate-ocr-busy"
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: true }}
            class="min-w-0 flex-1 flex-row items-center gap-1.5"
          >
            {/* Runtime style drives native UI-thread pulse on the recognition mark. */}
            <View style={{ opacity: ocrStatusOpacity }} class="shrink-0">
              <Icon name="mdi:text-recognition" tone="brand" class="size-3.5" />
            </View>
            <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {t("quickTranslate.ocrRecognizing")}
            </Text>
          </View>
        </If>
        <If when={!showOcrError() && !showOcrBusy() && selectionMessage() !== null}>
          <Text
            testID="quick-translate-selection-status"
            role={selectionFeedback() === "unavailable" ? "alert" : undefined}
            class={`min-w-0 flex-1 text-xs ${
              selectionFeedback() === "unavailable"
                ? "text-destructive"
                : "truncate text-muted-foreground"
            }`}
          >
            {selectionMessage() ?? ""}
          </Text>
          <If
            when={
              selectionFeedback() === "unavailable" && props.onScreenshotTranslate !== undefined
            }
          >
            <Button
              testID="quick-translate-selection-screenshot"
              size="xs"
              variant="ghost"
              label={t("settings.shortcuts.screenshotTranslate")}
              onPress={() => props.onScreenshotTranslate?.()}
              class="shrink-0"
            />
          </If>
        </If>
        <If when={hasSourceText()}>
          <View class="ml-auto shrink-0 flex-row items-center gap-0.5">
            <Text
              testID="quick-translate-source-count"
              accessibilityLabel={t("quickTranslate.sourceCharacters", {
                count: sourceCharacterCount(),
              })}
              class="shrink-0 text-xs tabular-nums text-muted-foreground"
            >
              {sourceCharacterCount()}
            </Text>
            <Button
              testID="quick-translate-collapse-source"
              size="icon-xs"
              variant="ghost"
              tooltip={
                isSourceCollapsed()
                  ? t("quickTranslate.editSource")
                  : t("quickTranslate.collapseSource")
              }
              accessibilityLabel={
                isSourceCollapsed()
                  ? t("quickTranslate.editSource")
                  : t("quickTranslate.collapseSource")
              }
              onPress={() => {
                if (isSourceCollapsed()) {
                  expandSource();
                  return;
                }
                props.session.setSourceCollapsed(true);
              }}
            >
              <Icon
                name={isSourceCollapsed() ? "mdi:pencil" : "mdi:arrow-collapse"}
                tone="muted-foreground"
                class="size-3.5"
              />
            </Button>
          </View>
        </If>
      </View>
    </If>
  );

  return (
    <View class="bg-background">
      <View testID="quick-translate-source-section" class="bg-background px-4 pt-4 pb-3">
        <If
          when={isSourceCollapsed()}
          else={
            <View class="flex-row items-start justify-between gap-2">
              <View class="relative min-w-0 flex-1">
                <If when={editorAlive()} else={<View class="h-10 w-full" />}>
                  <If
                    when={platform.os === "windows"}
                    else={
                      <Textarea
                        testID="quick-translate-source"
                        variant="frameless"
                        class="w-full"
                        autoFocus
                        disabled={ocrRecognizing()}
                        submitBehavior="submit"
                        fontScale="stepped"
                        initialFontStep={sourceFontStep()}
                        onFontStep={(step) => {
                          if (sourceFontStep() !== step) sourceFontStep.set(step);
                        }}
                        value={sourceText()}
                        placeholder={ocrRecognizing() ? "" : t("quickTranslate.sourcePlaceholder")}
                        accessibilityLabel={t("quickTranslate.sourceLabel")}
                        inputClass="min-h-10"
                        onPaste={(event) => {
                          if (!props.onPasteImage || event.text.trim().length > 0) return;
                          const image = event.files.find(
                            (file) => file.type.startsWith("image/") && file.size > 0,
                          );
                          if (!image) return;
                          void image.arrayBuffer().then((buffer) => {
                            props.onPasteImage?.(new Uint8Array(buffer));
                          });
                        }}
                        onChange={(nextText) => props.session.handleSourceChange(nextText)}
                        onSubmit={() => {
                          if (isComposing()) return;
                          props.session.handleSourceSubmit();
                        }}
                        onCompositionChange={({ composing }) => isComposing.set(composing)}
                        ref={(node) => {
                          sourceInputRef.set(node);
                          props.onAttachSourceInput?.(node);
                        }}
                      />
                    }
                  >
                    <QuickTranslateSourceEditor
                      testID="quick-translate-source"
                      frameless
                      class="w-full"
                      inputClass="min-h-10"
                      autoFocus
                      editable={!ocrRecognizing()}
                      initialFontStep={sourceFontStep()}
                      onFontStepChange={(step) => {
                        if (sourceFontStep() !== step) sourceFontStep.set(step);
                      }}
                      value={sourceText()}
                      highlightRange={activeSourceHighlight()}
                      placeholder={ocrRecognizing() ? "" : t("quickTranslate.sourcePlaceholder")}
                      accessibilityLabel={t("quickTranslate.sourceLabel")}
                      onPasteImage={props.onPasteImage}
                      onChangeText={(nextText) => props.session.handleSourceChange(nextText)}
                      onSubmitEditing={() => {
                        if (isComposing()) return;
                        props.session.handleSourceSubmit();
                      }}
                      onCompositionChange={(composing) => isComposing.set(composing)}
                      onSelectionChange={(selection) => {
                        if (selection && !selection.empty) {
                          if (activeMatch() !== null) clearActiveMatch();
                          closeSentencePopover("source-selection");
                        }
                      }}
                      ref={(node) => {
                        sourceInputRef.set(node);
                        props.onAttachSourceInput?.(node);
                      }}
                    />
                  </If>
                </If>
                <If when={showOcrEmptyPlaceholder()}>
                  <View
                    testID="quick-translate-ocr-placeholder"
                    accessibilityElementsHidden={true}
                    class="pointer-events-none absolute inset-0 justify-center gap-2.5 bg-background"
                  >
                    <Skeleton class="h-3.5 w-5/6" />
                    <Skeleton class="h-3.5 w-3/5" delay={motion.skeletonStaggerMs} />
                  </View>
                </If>
              </View>
              {renderSourceActions("pt-0.5")}
            </View>
          }
        >
          <View class="flex-row items-center justify-between gap-2">
            <Button
              testID="quick-translate-source-preview"
              variant="ghost"
              size="row"
              accessibilityLabel={t("quickTranslate.editSource")}
              class="h-8 min-h-0 min-w-0 flex-1 justify-start rounded-lg bg-surface-subtle px-2.5 hover:bg-accent"
              onPress={() => expandSource()}
            >
              <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                <Text class="min-w-0 flex-1 truncate text-sm text-foreground">
                  {sourceFirstLine()}
                </Text>
                <If when={sourceHasMultipleLines()}>
                  <Icon name="mdi:chevron-down" tone="muted-foreground" class="size-3.5 shrink-0" />
                </If>
              </View>
            </Button>
            {renderSourceActions()}
          </View>
        </If>
        {renderSourceStatus()}
      </View>

      <If
        when={
          !showingHistory() &&
          (props.session.presetsStatus().kind === "idle" ||
            props.session.presetsStatus().kind === "loading")
        }
      >
        <View
          testID="quick-translate-presets-loading"
          class="border-t border-border/70 bg-surface-subtle px-4 py-2.5"
        >
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.presetsLoading")}</Text>
        </View>
      </If>

      <If when={!showingHistory() && props.session.presetsStatus().kind === "error"}>
        <View
          testID="quick-translate-presets-error"
          class="flex-row items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/5 py-2 pr-3 pl-4"
        >
          <Text role="alert" class="min-w-0 flex-1 text-xs text-destructive">
            {(() => {
              const s = props.session.presetsStatus();
              return s.kind === "error" ? s.message : "";
            })()}
          </Text>
          <RetryIconButton
            testID="quick-translate-retry-presets"
            onPress={() => props.session.retryLoadPresets()}
          />
        </View>
      </If>

      <If
        when={
          !showingHistory() &&
          props.session.presetsStatus().kind === "ready" &&
          props.session.enabledPresets().length === 0
        }
      >
        <View
          testID="quick-translate-no-presets"
          class="border-t border-border/70 bg-surface-subtle px-4 py-2.5"
        >
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.noEnabledPresets")}</Text>
        </View>
      </If>

      <If when={props.session.prefsSaveError() !== null}>
        <View class="border-t border-destructive/30 bg-destructive/5 px-4 py-2">
          <Text
            testID="quick-translate-preferences-error"
            role="alert"
            class="text-xs text-destructive"
          >
            {props.session.prefsSaveError() ?? ""}
          </Text>
        </View>
      </If>

      <If when={!showingHistory()}>
        <InlineDictionaryBand
          state={props.session.inlineDictionary()}
          speakControl={speechControl("inline-dictionary")}
          speechError={inlineDictionarySpeechError()}
          onSpeak={() => {
            if (speechControl("inline-dictionary").busy) cancelSpeech();
            else speakInlineDictionary();
          }}
          onToggleExpand={props.session.handleToggleInlineDictionaryExpanded}
          onRetry={props.session.handleRetryInlineDictionary}
        />
      </If>

      <If when={showingHistory()}>
        <QuickTranslateHistoryResults
          snapshot={props.session.historySnapshot()}
          markdownEnabled={props.markdownEnabled ?? false}
        />
      </If>

      <If when={!showingHistory() && props.session.cards().length > 0}>
        <View testID="quick-translate-stream" class="border-t border-border/70">
          <Each of={props.session.cards()} key={(card) => card.id}>
            {(card) => {
              const cardId = () => card().id;
              return (
                <View
                  onLayout={({ bounds }) => {
                    cardSlots.set(cardId(), {
                      top: bounds.origin.y,
                      height: bounds.size.height,
                    });
                  }}
                  style={{ translate: [0, cardOffset(cardId())] }}
                  class="border-b border-border/70 bg-surface-subtle/85 last:border-b-0"
                  classList={{
                    "z-10 cursor-grabbing bg-card! shadow-md": draggingCardId() === cardId(),
                  }}
                >
                  <PresetCardRow
                    card={card}
                    reorder={{
                      canReorder: canReorderCards,
                      canDrag: () => canReorderCards() && !settlingCards(),
                      dragging: () => draggingCardId() === cardId(),
                      offset: cardOffset(cardId()),
                      onStart: () => handleCardDragStart(cardId()),
                      onEnd: (event) => void handleCardDragEnd(cardId(), event),
                      onMoveBy: (delta, refocus) => moveCardBy(cardId(), delta, refocus),
                      onGripRef: (node) => cardGripNodes.set(cardId(), node),
                    }}
                    markdownEnabled={props.markdownEnabled ?? false}
                    sentenceAlignment={(target) => buildCardSentenceAlignment(card(), target)}
                    resultComparison={() => buildResultComparison(card())}
                    presets={props.session.enabledPresets}
                    presetItems={props.session.presetItems}
                    onOverlayOpenChange={(menuId, open) =>
                      props.session.notifyOverlayOpenChange(menuId, open)
                    }
                    onSelectPreset={(targetId, presetId) =>
                      props.session.handleSelectCardPreset(targetId, presetId)
                    }
                    onSelectTemplate={(targetId, templateId) =>
                      props.session.handleSelectCardTemplate(targetId, templateId)
                    }
                    onToggleCollapse={(targetId) => props.session.handleToggleCollapse(targetId)}
                    onRemove={(targetId) => props.session.handleRemoveCard(targetId)}
                    onRetry={(id) => props.session.handleRetryCard(id)}
                    onCopy={(id) => props.session.handleCopyCard(id)}
                    ankiEnabled={props.session.ankiEnabled}
                    onAddToAnki={(id) => props.session.handleAddToAnki(id)}
                    onBackTranslate={(id) => props.session.handleBackTranslate(id)}
                    onCloseBackTranslation={(id) => props.session.handleCloseBackTranslation(id)}
                    onRetryBackTranslation={(id) => props.session.handleRetryBackTranslation(id)}
                    onCopyBackTranslation={(id) => props.session.handleCopyBackTranslation(id)}
                    speakState={() => {
                      const state = speechControl({ kind: "result", cardId: card().id });
                      return {
                        disabled: state.disabled,
                        tooltip: state.tooltip,
                        label: state.label,
                        icon: state.icon,
                      };
                    }}
                    speakError={() => resultSpeechErrors()[card().id] ?? null}
                    onSpeak={() => {
                      if (speechControl({ kind: "result", cardId: card().id }).busy) cancelSpeech();
                      else speakResult(card().id);
                    }}
                    backTranslationSpeakState={() => {
                      const state = speechControl({ kind: "back-translation", cardId: card().id });
                      return {
                        disabled: state.disabled,
                        tooltip: state.tooltip,
                        label: state.label,
                        icon: state.icon,
                      };
                    }}
                    backTranslationSpeakError={() =>
                      backTranslationSpeechErrors()[card().id] ?? null
                    }
                    onSpeakBackTranslation={() => {
                      if (speechControl({ kind: "back-translation", cardId: card().id }).busy) {
                        cancelSpeech();
                      } else {
                        speakBackTranslation(card().id);
                      }
                    }}
                  />
                </View>
              );
            }}
          </Each>
        </View>
      </If>
      <AnchoredPopover
        open={readPopoverForOverlay() !== null}
        anchor={readPopoverForOverlay()?.anchor ?? null}
        maxWidth={readPopoverForOverlay()?.maxWidth}
        placement="bottom"
        align="start"
        offset={6}
        margin={12}
        testID="quick-translate-sentence-popover"
        accessibilityLabel={t(
          readPopoverForOverlay()?.entry.target === "back-translation"
            ? "quickTranslate.sentenceTranslationPopoverLabel"
            : "quickTranslate.sentenceSourcePopoverLabel",
        )}
        onPressOutside={(event) => handlePopoverPressOutside(event.pagePosition)}
        onCancel={() => closeSentencePopover("cancel")}
      >
        <Scroll class="max-h-44">
          <View selectable>
            <Text
              testID="quick-translate-sentence-popover-text"
              class="text-sm leading-relaxed text-popover-foreground"
            >
              {readPopoverForOverlay()?.sourceText ?? ""}
            </Text>
          </View>
        </Scroll>
      </AnchoredPopover>
      <View
        testID="quick-translate-sentence-announcement"
        role="summary"
        accessibilityLiveRegion="polite"
        accessibilityLabel={keyboardAnnouncement()}
        class="pointer-events-none absolute top-0 left-0 size-0.5 overflow-hidden opacity-0"
      />
    </View>
  );
}
