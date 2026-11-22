import {
  cleanup,
  effect,
  platform,
  signal,
  Text,
  View,
  type Accessor,
  type Align,
  type InputRef,
  type Placement,
} from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { LARGEST_FONT_STEP } from "../../components/ui/font-step";
import { Icon } from "../../components/ui/icon";
import { Kbd } from "../../components/ui/kbd";
import { Menu, MenuItem } from "../../components/ui/menu";
import { Select, type SelectItem } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { ProviderMark } from "../../modules/ai/ui/provider-mark";
import { providerSettingsRegistry } from "../../modules/ai/ui/registry";
import { languageDetectionStore } from "../language-detection/settings";
import { AUTO_LANGUAGE, type LanguageId } from "../presets/languages";
import { modelsStore } from "../models/store";
import type { TranslationPreset } from "../presets/types";
import { synthesizeSpeech } from "../tts/channels";
import { playMp3Bytes } from "../tts/playback";
import { prepareQuickSpeech, quickSpeechFailureMessage } from "../tts/quick-speech";
import { ttsSettingsStore } from "../tts/settings";
import type { CardViewItem, QuickTranslateSession } from "./session";
import { resolvePresetTemplate } from "./translate";

/** What the OCR action reports while it runs, and after it stops. */
export interface QuickTranslateOcrStatus {
  phase: "idle" | "selecting" | "recognizing";
  message: string | null;
}

export interface QuickTranslatePopupProps {
  session: QuickTranslateSession;
  /** OCR progress and alerts; the window entry point passes the controller's state. */
  ocrState?: Accessor<QuickTranslateOcrStatus>;
  /** False while the native window is hidden. Omitted in a harness with no window. */
  playbackAllowed?: Accessor<boolean>;
  onAttachSourceInput?: (input: InputRef | null) => void;
}

function buildTemplateItems(preset: TranslationPreset | null): SelectItem[] {
  if (!preset || preset.engine.kind !== "ai") return [];
  return preset.engine.templates.map((tpl) => ({
    value: tpl.id,
    title: tpl.name,
  }));
}

/** Shared icon-only retry trigger used across card failures, result actions, and preset reload. */
function RetryIconButton(props: { testID: string; onPress: () => void }) {
  return (
    <Button
      testID={props.testID}
      size="icon-xs"
      variant="ghost"
      tooltip={t("common.retry")}
      accessibilityLabel={t("common.retry")}
      onPress={() => props.onPress()}
    >
      <Icon name="refresh" tone="muted-foreground" class="size-3.5" />
    </Button>
  );
}

function SpeakerButton(props: {
  testID: string;
  disabled: boolean;
  tooltip: string;
  label: string;
  icon: "speaker-one" | "close-circle" | "pause";
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
        name="plus"
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
      class="shrink-0 flex-row items-center justify-between gap-2 border-t border-border bg-surface-subtle px-4 py-2"
    >
      <QuickTranslateAddPresetMenu session={props.session} placement="top" align="start" />
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

/** Visual engine indicator on the preset chip: DeepL mark, known AI provider mark, or brand dot. */
function PresetLeadingMark(props: { preset: TranslationPreset | null }) {
  const providerIcon = () => {
    const preset = props.preset;
    if (!preset || preset.engine.kind !== "ai") return null;
    const primaryModelId = preset.engine.modelIds[0];
    if (!primaryModelId) return null;
    const model = modelsStore.models().find((item) => item.id === primaryModelId);
    if (!model) return null;
    const channel = modelsStore.channels().find((item) => item.id === model.providerId);
    if (!channel || channel.presetId === "custom") return null;
    return providerSettingsRegistry.find(channel.presetId)?.icon ?? null;
  };

  return (
    <If
      when={props.preset?.engine.kind === "deepl"}
      else={
        <If when={providerIcon()} else={<View class="size-1.5 shrink-0 rounded-full bg-brand" />}>
          {(asset) => <ProviderMark icon={asset()} class="size-3 shrink-0" />}
        </If>
      }
    >
      <Icon name="deepl" tone="foreground" class="size-3 shrink-0" />
    </If>
  );
}

interface PresetCardRowProps {
  card: Accessor<CardViewItem>;
  presets: Accessor<readonly TranslationPreset[]>;
  presetItems: Accessor<SelectItem[]>;
  onOverlayOpenChange: (menuId: string, open: boolean) => void;
  onSelectPreset: (cardId: string, presetId: string | null) => void;
  onSelectTemplate: (cardId: string, templateId: string | null) => void;
  onToggleCollapse: (cardId: string) => void;
  onRemove: (cardId: string) => void;
  onRetry: (cardId: string) => void;
  onCopy: (cardId: string) => void;
  speakState: Accessor<{
    disabled: boolean;
    tooltip: string;
    label: string;
    icon: "speaker-one" | "close-circle" | "pause";
  }>;
  speakError: Accessor<string | null>;
  onSpeak: () => void;
}

function PresetCardRow(props: PresetCardRowProps) {
  const resolvedPreset = () =>
    props.presets().find((item) => item.id === props.card().presetId) ?? null;

  const templateItems = () => buildTemplateItems(resolvedPreset());

  const hasTemplates = () => resolvedPreset()?.engine.kind === "ai";

  const activeTemplateValue = () => {
    const preset = resolvedPreset();
    if (!preset) return null;
    const resolution = resolvePresetTemplate(preset, props.card().templateId);
    return resolution ? resolution.template.id : null;
  };

  const hasBody = () => !props.card().collapsed && props.card().result.status !== "idle";

  return (
    <Card testID={`quick-translate-card-${props.card().id}`} variant="subtle">
      <View
        class={`flex-row items-center justify-between gap-2 px-3 pt-2.5 ${hasBody() ? "pb-2" : "pb-2.5"}`}
      >
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Select
            testID="quick-translate-preset"
            variant="chip"
            class="min-w-0 shrink"
            labelClass="font-semibold"
            leading={<PresetLeadingMark preset={resolvedPreset()} />}
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
              variant="chip"
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
          <Button
            testID="quick-translate-collapse"
            variant="ghost"
            size="icon-xs"
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
            size="icon-xs"
            tooltip={t("quickTranslate.removeCard")}
            accessibilityLabel={t("quickTranslate.removeCard")}
            onPress={() => props.onRemove(props.card().id)}
          >
            <Icon name="close" tone="muted-foreground" class="size-3.5" />
          </Button>
        </View>
      </View>

      <If when={hasBody()}>
        <If when={props.card().result.status === "loading"}>
          <View class="px-3 pb-3">
            <Text testID="quick-translate-status" class="text-xs text-muted-foreground">
              {t("quickTranslate.translating")}
            </Text>
          </View>
        </If>

        <If when={props.card().result.status === "streaming"}>
          <View class="px-3 pb-3">
            <View selectable>
              <Text
                testID="quick-translate-result-text"
                class="text-base leading-relaxed text-card-foreground"
              >
                {(() => {
                  const res = props.card().result;
                  return res.status === "streaming" ? res.text : "";
                })()}
              </Text>
            </View>
          </View>
        </If>

        <If when={props.card().result.status === "error"}>
          <View>
            <View class="gap-1.5 px-3 pb-2.5">
              <If
                when={(() => {
                  const res = props.card().result;
                  return res.status === "error" && (res.text ?? "").length > 0;
                })()}
              >
                <View selectable>
                  <Text
                    testID="quick-translate-partial-text"
                    class="text-base leading-relaxed text-card-foreground"
                  >
                    {(() => {
                      const res = props.card().result;
                      return res.status === "error" ? (res.text ?? "") : "";
                    })()}
                  </Text>
                </View>
              </If>
              <Text testID="quick-translate-error" role="alert" class="text-xs text-destructive">
                {(() => {
                  const res = props.card().result;
                  return res.status === "error" ? res.message : "";
                })()}
              </Text>
            </View>
            <View class="flex-row items-center justify-end border-t border-border/60 px-2 py-1.5">
              <RetryIconButton
                testID="quick-translate-retry"
                onPress={() => props.onRetry(props.card().id)}
              />
            </View>
          </View>
        </If>

        <If when={props.card().result.status === "success"}>
          <View>
            <View selectable class="px-3 pb-2.5">
              <Text
                testID="quick-translate-result-text"
                class="text-base leading-relaxed text-card-foreground"
              >
                {(() => {
                  const res = props.card().result;
                  return res.status === "success" ? res.text : "";
                })()}
              </Text>
            </View>
            <View class="flex-row items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5">
              <View class="flex-row items-center gap-0.5">
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
                    name={props.card().copied ? "check" : "copy"}
                    tone={props.card().copied ? "success" : "muted-foreground"}
                    class="size-3.5"
                  />
                </Button>
              </View>
              <RetryIconButton
                testID="quick-translate-retry"
                onPress={() => props.onRetry(props.card().id)}
              />
            </View>
            <If when={props.speakError() !== null}>
              <View class="px-3 pb-2.5">
                <Text
                  testID="quick-translate-speak-result-error"
                  role="alert"
                  class="text-xs text-destructive"
                >
                  {props.speakError() ?? ""}
                </Text>
              </View>
            </If>
            <If when={props.card().copyError !== null}>
              <View class="px-3 pb-2.5">
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
    </Card>
  );
}

/** Compact Quick Translate popup body composed inside the floating window or standalone harness. */
export function QuickTranslatePopup(props: QuickTranslatePopupProps) {
  const isComposing = signal(false);
  // TODO(https://github.com/longbridge/nsh/issues/2655): Restore "min-h-10" on all platforms
  // once the pinned NSH release aligns Windows input measurement with drawing.
  // Zero uses the font's natural line height in NSH 0.6.1.
  const sourceInputClass = platform.os === "windows" ? "min-h-10 leading-[0]" : "min-h-10";
  const sourceText = () => props.session.sourceText();
  const hasSourceText = () => sourceText().length > 0;
  const hasSpeakableSource = () => sourceText().trim().length > 0;
  // Collapse is a view-only mode: an empty field always shows the editor for the next input.
  // Clipboard and selection arrive collapsed: the user asked to translate, not to edit.
  const delivery = () => props.session.sourceDelivery();
  const sourceCollapsed = signal(
    (delivery()?.kind === "clipboard" || delivery()?.kind === "selection") && hasSourceText(),
  );
  const isSourceCollapsed = () => sourceCollapsed() && hasSourceText();
  const sourceFirstLine = () => sourceText().split(/\r?\n/, 1)[0] ?? "";
  const sourceHasMultipleLines = () => /\r?\n/.test(sourceText());
  const sourceInputRef = signal<InputRef | null>(null);
  // Survives the editor unmounting into the one-line preview, so expand does not flash the largest step.
  const sourceFontStep = signal(LARGEST_FONT_STEP);
  const focusSourceAfterExpand = signal(false);
  let lastDeliverySeq = delivery()?.seq ?? 0;

  effect(() => {
    if (!hasSourceText()) sourceCollapsed.set(false);
  });

  // Recognized text opens the editor and takes the caret; copied text stays a one-line preview.
  effect(() => {
    const current = delivery();
    const seq = current?.seq ?? 0;
    if (seq === lastDeliverySeq) return;
    lastDeliverySeq = seq;
    if (!hasSourceText() || current === null) return;
    if (current.kind === "ocr") {
      focusSourceAfterExpand.set(true);
      sourceCollapsed.set(false);
      return;
    }
    sourceCollapsed.set(true);
  });

  const expandSource = () => {
    focusSourceAfterExpand.set(true);
    sourceCollapsed.set(false);
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

  const sourceSpeechError = signal<string | null>(null);
  const resultSpeechErrors = signal<Readonly<Record<string, string>>>({});
  const speechPhase = signal<"idle" | "loading" | "playing">("idle");
  const speechOwner = signal<
    | { kind: "source"; text: string; language: string }
    | { kind: "result"; cardId: string; text: string; language: string }
    | null
  >(null);
  let speechToken = 0;
  let speechAbort: AbortController | null = null;
  let stopSpeech: (() => void) | null = null;
  let activeCredential = "";
  const activeSpeech = () => ttsSettingsStore.activeBinding();
  const speakEnabled = () => activeSpeech() !== null;
  const speakTooltip = () => {
    const active = activeSpeech();
    if (active === null) return t("quickTranslate.speakOff");
    const name = t(
      active.channel === "azure" ? "settings.tts.azure.channel" : "settings.tts.channel",
    );
    return t("quickTranslate.speakSending", { name });
  };
  const credentialSignature = () => {
    const active = activeSpeech();
    if (active === null) return "";
    if (active.channel === "azure") {
      return `azure\0${active.credentialRef}\0${active.region}`;
    }
    return `google-cloud\0${active.credentialRef}`;
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
    const selected = props.session.sourceLanguage();
    const detected = props.session.sourceDetection();
    const effective =
      selected === AUTO_LANGUAGE
        ? detected.status === "detected"
          ? detected.language
          : ""
        : selected;
    if (owner.text !== sourceText() || owner.language !== `${selected}:${effective}`) {
      cancelSpeech();
    }
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
    if (speechPhase() !== "idle" && credentialSignature() !== activeCredential) cancelSpeech();
  });

  effect(() => {
    if (props.playbackAllowed && !props.playbackAllowed() && speechPhase() !== "idle") {
      cancelSpeech();
    }
  });

  const setResultSpeechError = (cardId: string, message: string | null) => {
    const next = { ...resultSpeechErrors() };
    if (message === null) delete next[cardId];
    else next[cardId] = message;
    resultSpeechErrors.set(next);
  };

  const mountedSpeech = (token: number) => token === speechToken;

  const finishSpeech = (token: number) => {
    if (!mountedSpeech(token)) return;
    stopSpeech = null;
    speechPhase.set("idle");
    speechOwner.set(null);
  };

  const runSpeech = async (input: {
    owner:
      | { kind: "source"; text: string; language: string }
      | { kind: "result"; cardId: string; text: string; language: string };
    text: string;
    language: LanguageId | null;
    unresolvedAuto: "choose-source" | "translate-first" | null;
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
    const prepared = await prepareQuickSpeech({
      text: input.text,
      language: input.language,
      unresolvedAuto: input.unresolvedAuto,
    });
    if (!mountedSpeech(token)) return;
    if (!prepared.ok) {
      finishSpeech(token);
      input.report(prepared.message);
      return;
    }
    const request = prepared.speech.request;
    if (!mountedSpeech(token) || credentialSignature() !== activeCredential) {
      finishSpeech(token);
      return;
    }
    const synthesized = await synthesizeSpeech(request, { signal: controller.signal });
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
      input.report(quickSpeechFailureMessage(synthesized.failure, request.credentials.channel));
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
    const detected = props.session.sourceDetection();
    const language =
      selected === AUTO_LANGUAGE
        ? detected.status === "detected"
          ? detected.language
          : null
        : selected;
    const unresolvedAuto =
      language === null
        ? languageDetectionStore.enabledDetectors().length === 0
          ? ("choose-source" as const)
          : ("translate-first" as const)
        : null;
    void runSpeech({
      owner: { kind: "source", text: sourceText(), language: `${selected}:${language ?? ""}` },
      text: sourceText(),
      language,
      unresolvedAuto,
      report: (message) => sourceSpeechError.set(message),
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
      unresolvedAuto: null,
      report: (message) => setResultSpeechError(cardId, message),
    });
  };

  const speechControl = (target: "source" | { cardId: string }) => {
    const owner = speechOwner();
    const mine =
      owner !== null &&
      (target === "source"
        ? owner.kind === "source"
        : owner.kind === "result" && owner.cardId === target.cardId);
    const phase = mine ? speechPhase() : "idle";
    if (phase === "loading") {
      return {
        disabled: false,
        tooltip: t("common.cancel"),
        label: t("common.cancel"),
        icon: "close-circle" as const,
        busy: true,
      };
    }
    if (phase === "playing") {
      return {
        disabled: false,
        tooltip: t("settings.tts.stop"),
        label: t("settings.tts.stop"),
        icon: "pause" as const,
        busy: true,
      };
    }
    return {
      disabled: !speakEnabled(),
      tooltip: speakTooltip(),
      label: speakEnabled() ? t("quickTranslate.speak") : speakTooltip(),
      icon: "speaker-one" as const,
      busy: false,
    };
  };

  const ocrMessage = () => (props.ocrState ? props.ocrState().message : null);
  const ocrRecognizing = () => (props.ocrState ? props.ocrState().phase === "recognizing" : false);
  // One bottom-left status slot serves OCR errors and active recognition by priority.
  const showOcrError = () => ocrMessage() !== null;
  const showOcrBusy = () => !showOcrError() && ocrRecognizing();
  const hasToolbarStatus = () => showOcrError() || showOcrBusy();
  const hasSourceToolbar = () => hasSpeakableSource() || hasToolbarStatus();

  const renderSourceActions = (extraClass = "") => (
    <If when={hasSourceText()}>
      <View
        testID="quick-translate-source-actions"
        class={`shrink-0 flex-row items-center gap-0.5 ${extraClass}`}
      >
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
            sourceCollapsed.set(true);
          }}
        >
          <Icon
            name={isSourceCollapsed() ? "edit" : "collapse-text-input"}
            tone="muted-foreground"
            class="size-3.5"
          />
        </Button>
        <Button
          testID="quick-translate-clear"
          size="icon-xs"
          variant="ghost"
          tooltip={t("common.clearInput")}
          accessibilityLabel={t("common.clearInput")}
          onPress={() => props.session.handleClearSource()}
        >
          <Icon name="close-circle" tone="muted-foreground" class="size-3.5" />
        </Button>
      </View>
    </If>
  );

  const renderSourceStatus = () => (
    <If when={hasSourceToolbar()}>
      <View testID="quick-translate-source-toolbar" class="mt-1 flex-row items-center gap-1.5">
        <If when={hasSpeakableSource()}>
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
          <Text
            testID="quick-translate-ocr-busy"
            class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          >
            {t("quickTranslate.ocrRecognizing")}
          </Text>
        </If>
      </View>
    </If>
  );

  return (
    <View class="gap-3 px-4 pt-3.5 pb-3">
      <If
        when={
          props.session.presetsStatus().kind === "idle" ||
          props.session.presetsStatus().kind === "loading"
        }
      >
        <Card testID="quick-translate-presets-loading" variant="subtle" class="gap-1.5 p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.presetsLoading")}</Text>
        </Card>
      </If>

      <If when={props.session.presetsStatus().kind === "error"}>
        <Card
          testID="quick-translate-presets-error"
          variant="subtle"
          class="flex-row items-center justify-between gap-2 border-destructive/40 py-2 pl-3 pr-2"
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
        </Card>
      </If>

      <If
        when={
          props.session.presetsStatus().kind === "ready" &&
          props.session.enabledPresets().length === 0
        }
      >
        <Card testID="quick-translate-no-presets" variant="subtle" class="p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.noEnabledPresets")}</Text>
        </Card>
      </If>

      <View testID="quick-translate-source-section">
        <If
          when={isSourceCollapsed()}
          else={
            <View class="flex-row items-start justify-between gap-2">
              <Textarea
                testID="quick-translate-source"
                variant="frameless"
                class="min-w-0 flex-1"
                autoFocus
                submitBehavior="submit"
                fontScale="stepped"
                initialFontStep={sourceFontStep()}
                onFontStep={(step) => {
                  if (sourceFontStep() !== step) sourceFontStep.set(step);
                }}
                value={sourceText()}
                placeholder={t("quickTranslate.sourcePlaceholder")}
                accessibilityLabel={t("quickTranslate.sourceLabel")}
                inputClass={sourceInputClass}
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
                  <Icon name="chevron-down" tone="muted-foreground" class="size-3.5 shrink-0" />
                </If>
              </View>
            </Button>
            {renderSourceActions()}
          </View>
        </If>
        {renderSourceStatus()}
      </View>

      <If when={props.session.prefsSaveError() !== null}>
        <Text
          testID="quick-translate-preferences-error"
          role="alert"
          class="text-xs text-destructive"
        >
          {props.session.prefsSaveError() ?? ""}
        </Text>
      </If>

      <If when={props.session.cards().length > 0}>
        <View class="gap-2.5">
          <Each of={props.session.cards()} key={(card) => card.id}>
            {(card) => (
              <PresetCardRow
                card={card}
                presets={props.session.enabledPresets}
                presetItems={props.session.presetItems}
                onOverlayOpenChange={(menuId, open) =>
                  props.session.notifyOverlayOpenChange(menuId, open)
                }
                onSelectPreset={(cardId, presetId) =>
                  props.session.handleSelectCardPreset(cardId, presetId)
                }
                onSelectTemplate={(cardId, templateId) =>
                  props.session.handleSelectCardTemplate(cardId, templateId)
                }
                onToggleCollapse={(cardId) => props.session.handleToggleCollapse(cardId)}
                onRemove={(cardId) => props.session.handleRemoveCard(cardId)}
                onRetry={(id) => props.session.handleRetryCard(id)}
                onCopy={(id) => props.session.handleCopyCard(id)}
                speakState={() => {
                  const state = speechControl({ cardId: card().id });
                  return {
                    disabled: state.disabled,
                    tooltip: state.tooltip,
                    label: state.label,
                    icon: state.icon,
                  };
                }}
                speakError={() => resultSpeechErrors()[card().id] ?? null}
                onSpeak={() => {
                  if (speechControl({ cardId: card().id }).busy) cancelSpeech();
                  else speakResult(card().id);
                }}
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
