import {
  cleanup,
  createAnimatedValue,
  createMotion,
  effect,
  Image,
  reduceMotion,
  setAccessibilityFocus,
  signal,
  Text,
  View,
  type AnimatedValue,
  type InputRef,
  type KeyEvent,
  type PanEvent,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import googleCloudIcon from "../../../assets/icons/google-cloud.svg";
import microsoftAzureIcon from "../../../assets/icons/microsoft-azure.svg";
import { motion } from "../../components/motion";
import { Avatar, type AvatarSize } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button, KeyboardButton } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { AppDialog, ConfirmDialog } from "../../components/ui/dialog";
import { ChannelEmptyState } from "../../components/ui/empty-state";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { FormField } from "../../modules/ai/ui/form-field";
import type { LanguageId } from "../presets/languages";
import { googleSampleSpeechRequest, sampleSpeechRequest, synthesizeSpeech } from "../tts/channels";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  googlePreferencesSignature,
  type GoogleVoicePreferences,
} from "../tts/google-preferences";
import { GOOGLE_SAMPLE_LANGUAGE } from "../tts/google-samples";
import { resolveGoogleVoice } from "../tts/google-voices";
import { canPlayTts, playMp3Bytes } from "../tts/playback";
import { TTS_CHANNELS, ttsSettingsStore } from "../tts/settings";
import type { TtsChannelId, TtsFailure, TtsSynthesisRequest } from "../tts/synthesis";
import {
  GoogleOverrideDialog,
  GoogleTtsFields,
  googlePreviewVoiceLabel,
  googleVoiceProblem,
} from "./google-tts-fields";

export type { TtsChannelId };

/** Time a reordered row takes to settle into its new slot. */
const REORDER_SETTLE_MS = 180;

function focusTarget(node: ViewRef | null | undefined) {
  if (!node) return;
  node.focus();
  setAccessibilityFocus(node);
}

interface TtsSectionProps {
  compact: boolean;
  selectedChannel: TtsChannelId | null;
  onSelectChannel: (channel: TtsChannelId | null) => void;
  getAddButtonRef?: () => ViewRef | null;
  onRegisterAddTrigger?: (open: () => void) => () => void;
  onAddBusyChange?: (busy: boolean) => void;
  /** Reports whether one of the section's dialogs owns Escape. */
  onDialogOpenChange?: (open: boolean) => void;
}

type CredentialState = "unknown" | "readable" | "missing";
type CredentialStates = Record<TtsChannelId, CredentialState>;

function channelName(channel: TtsChannelId): string {
  return t(channel === "azure" ? "settings.tts.azure.channel" : "settings.tts.channel");
}

function ChannelAvatar(props: { channel: TtsChannelId; size?: AvatarSize }) {
  return (
    <Avatar
      size={props.size ?? "md"}
      accessibilityLabel=""
      fallback={
        <Image
          src={props.channel === "azure" ? microsoftAzureIcon : googleCloudIcon}
          accessibilityElementsHidden={true}
          class="size-4 overflow-hidden"
        />
      }
    />
  );
}

function AddTtsChannelDialog(props: {
  open: boolean;
  availableChannels: readonly TtsChannelId[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (channel: TtsChannelId) => void;
  onClose?: () => void;
}) {
  const cardRefs: Partial<Record<TtsChannelId, ViewRef>> = {};
  const firstChannel = () => props.availableChannels[0];

  return (
    <AppDialog
      testID="settings-tts-add-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy) props.onOpenChange(open);
      }}
      onOpen={() => {
        const first = firstChannel();
        if (first !== undefined) focusTarget(cardRefs[first]);
      }}
      onClose={() => props.onClose?.()}
      title={t("settings.tts.addChannel")}
      size="md"
      closeOnEscape={!props.busy}
      closeOnBackdropPress={!props.busy}
      footer={
        <Button
          testID="settings-tts-add-cancel"
          variant="outline"
          size="sm"
          label={t("common.cancel")}
          disabled={props.busy}
          onPress={() => props.onOpenChange(false)}
        />
      }
    >
      <View class="grid grid-cols-2 gap-3">
        <Each of={props.availableChannels} key={(channel) => channel}>
          {(channel) => {
            const currentChannel = channel();
            cleanup(() => {
              delete cardRefs[currentChannel];
            });
            return (
              <Button
                testID={`settings-tts-option-${channel()}`}
                ref={(node) => {
                  cardRefs[channel()] = node;
                }}
                variant="outline"
                size="card"
                disabled={props.busy}
                accessibilityLabel={channelName(channel())}
                onPress={() => props.onSelect(channel())}
                class="w-full"
              >
                <ChannelAvatar channel={channel()} />
                <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {channelName(channel())}
                </Text>
              </Button>
            );
          }}
        </Each>
      </View>
    </AppDialog>
  );
}

interface TtsChannelListProps {
  compact: boolean;
  credentialState: CredentialStates;
  busy: boolean;
  listError: string | null;
  onClearError: () => void;
  onSetError: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenChannel: (channel: TtsChannelId) => void;
  onAddAvailableChannel: (channel: TtsChannelId) => void;
  onFocusAddButton: () => void;
  onRowRef: (channel: TtsChannelId, node: ViewRef | null) => void;
  onGripRef: (channel: TtsChannelId, node: ViewRef | null) => void;
  onRowFocusRef: (channel: TtsChannelId, node: ViewRef | null) => void;
  onFocusGrip: (channel: TtsChannelId) => void;
  onFocusChannelFallback: (channel: TtsChannelId) => void;
  onRemoveDialogOpenChange: (open: boolean) => void;
}

function TtsChannelList(props: TtsChannelListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const dragging = signal<TtsChannelId | null>(null);
  const animating = signal(false);
  const pendingRemove = signal<TtsChannelId | null>(null);
  const removeError = signal<string | null>(null);
  // Per-channel drag offsets drive the rows natively; they return to 0 at rest.
  const offsets: Record<TtsChannelId, AnimatedValue> = {
    "google-cloud": createAnimatedValue(0),
    azure: createAnimatedValue(0),
  };
  const rowSlots: Partial<Record<TtsChannelId, { top: number; height: number }>> = {};
  const removeRefs: Partial<Record<TtsChannelId, ViewRef>> = {};
  let removeCancelNode: ViewRef | null = null;
  let pendingRemoveCloseFocus: (() => void) | null = null;

  effect(() => props.onBusyChange(mutating() || animating()));
  cleanup(() => props.onBusyChange(false));
  effect(() => props.onRemoveDialogOpenChange(pendingRemove() !== null));
  cleanup(() => props.onRemoveDialogOpenChange(false));

  const order = () => ttsSettingsStore.channelOrder();
  const enabledOrder = () => order().filter((channel) => ttsSettingsStore.isEnabled(channel));
  const canReorder = () => order().length > 1;
  const isBusy = () => props.busy || mutating() || animating();

  const channelRole = (channel: TtsChannelId): "primary" | "backup" | null => {
    const position = enabledOrder().indexOf(channel);
    if (position === -1) return null;
    return position === 0 ? "primary" : "backup";
  };

  const channelSummary = (
    channel: TtsChannelId,
  ): { text: string; toneClass: "text-muted-foreground" | "text-destructive" } => {
    if (ttsSettingsStore.savedBinding(channel) === null) {
      return { text: t("settings.tts.notConfigured"), toneClass: "text-muted-foreground" };
    }
    if (props.credentialState[channel] === "missing") {
      return { text: t("settings.tts.keyUnreadable"), toneClass: "text-destructive" };
    }
    return { text: t("settings.tts.configured"), toneClass: "text-muted-foreground" };
  };

  const handleToggle = async (channel: TtsChannelId, nextEnabled: boolean) => {
    if (isBusy()) return;
    props.onClearError();
    mutating.set(true);
    try {
      const result = await ttsSettingsStore.setEnabled(channel, nextEnabled);
      if (!result.ok) props.onSetError(result.message);
    } finally {
      mutating.set(false);
    }
  };

  const nextFocusTargetAfterRemove = (
    previousOrder: readonly TtsChannelId[],
    removed: TtsChannelId,
  ): (() => void) => {
    const index = previousOrder.indexOf(removed);
    const remaining = previousOrder.filter((item) => item !== removed);
    if (remaining.length === 0) return props.onFocusAddButton;
    const target = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]!;
    return () => props.onFocusChannelFallback(target);
  };

  const performRemove = async (channel: TtsChannelId, fromConfirmDialog: boolean) => {
    if (isBusy()) return false;
    const previousOrder = order();
    props.onClearError();
    removeError.set(null);
    mutating.set(true);
    try {
      const result = await ttsSettingsStore.removeChannel(channel);
      if (!result.ok) {
        if (fromConfirmDialog) removeError.set(result.message);
        else props.onSetError(result.message);
        return false;
      }
      const nextFocus = nextFocusTargetAfterRemove(previousOrder, channel);
      if (fromConfirmDialog) {
        pendingRemoveCloseFocus = nextFocus;
        pendingRemove.set(null);
      } else {
        queueMicrotask(nextFocus);
      }
      return true;
    } finally {
      mutating.set(false);
    }
  };

  const handleRequestRemove = (channel: TtsChannelId) => {
    if (isBusy()) return;
    props.onClearError();
    removeError.set(null);
    if (ttsSettingsStore.savedBinding(channel) !== null) {
      pendingRemoveCloseFocus = () => focusTarget(removeRefs[channel]);
      pendingRemove.set(channel);
      return;
    }
    void performRemove(channel, false);
  };

  const animateOffset = (channel: TtsChannelId, to: number): Promise<unknown> => {
    if (reduceMotion()) {
      offsets[channel].set(to);
      return Promise.resolve();
    }
    return offsets[channel].timing(to, { duration: REORDER_SETTLE_MS, easing: "easeOut" });
  };

  const resetOffsets = () => {
    for (const channel of TTS_CHANNELS) offsets[channel].set(0);
  };

  const handleDragStart = (channel: TtsChannelId) => {
    if (isBusy() || !canReorder() || dragging() !== null) return;
    props.onClearError();
    dragging.set(channel);
  };

  /** The channel whose measured slot center is nearest the dragged row's center. */
  const nearestChannel = (channel: TtsChannelId, offsetY: number): number | null => {
    const slot = rowSlots[channel];
    if (slot === undefined) return null;
    const center = slot.top + slot.height / 2 + offsetY;
    let target: number | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    order().forEach((other, position) => {
      const otherSlot = rowSlots[other];
      if (otherSlot === undefined) return;
      const distance = Math.abs(otherSlot.top + otherSlot.height / 2 - center);
      if (distance < nearest) {
        nearest = distance;
        target = position;
      }
    });
    return target;
  };

  /** Slides every row into the slot the reordered list gives it, and returns that list. */
  const settleIntoSlots = async (channel: TtsChannelId, target: number) => {
    const list = order();
    const nextOrder = [...list];
    nextOrder.splice(list.indexOf(channel), 1);
    nextOrder.splice(target, 0, channel);
    const moves: Promise<unknown>[] = [];
    nextOrder.forEach((row, position) => {
      const from = rowSlots[row];
      const to = rowSlots[list[position]!];
      if (from === undefined || to === undefined || from.top === to.top) return;
      moves.push(animateOffset(row, to.top - from.top));
    });
    await Promise.all(moves);
    return nextOrder;
  };

  const handleDragEnd = async (channel: TtsChannelId, event: PanEvent) => {
    if (dragging() !== channel) {
      await animateOffset(channel, 0);
      return;
    }
    animating.set(true);
    try {
      const index = order().indexOf(channel);
      const target = nearestChannel(channel, event.value?.y ?? event.translation.y);
      if (event.cancelled || index === -1 || target === null || target === index) {
        await animateOffset(channel, 0);
        return;
      }
      const nextOrder = await settleIntoSlots(channel, target);
      const result = await ttsSettingsStore.moveChannelTo(channel, target);
      if (result.ok) {
        resetOffsets();
        return;
      }
      await Promise.all(nextOrder.map((row) => animateOffset(row, 0)));
      props.onSetError(result.message);
    } finally {
      dragging.set(null);
      animating.set(false);
    }
  };

  const handleMoveBy = async (channel: TtsChannelId, delta: number, refocus: boolean) => {
    if (isBusy() || !canReorder() || dragging() !== null) return;
    const list = order();
    const index = list.indexOf(channel);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return;
    props.onClearError();
    mutating.set(true);
    try {
      const result = await ttsSettingsStore.moveChannelTo(channel, target);
      if (!result.ok) {
        props.onSetError(result.message);
        return;
      }
      if (refocus) queueMicrotask(() => props.onFocusGrip(channel));
    } finally {
      mutating.set(false);
    }
  };

  const handleGripKey = (channel: TtsChannelId, event: KeyEvent) => {
    if (event.key === "ArrowUp") void handleMoveBy(channel, -1, true);
    else if (event.key === "ArrowDown") void handleMoveBy(channel, 1, true);
  };

  const handleAccessibilityMove = (channel: TtsChannelId, actionName: string) => {
    if (actionName === "moveUp") void handleMoveBy(channel, -1, false);
    else if (actionName === "moveDown") void handleMoveBy(channel, 1, false);
  };

  return (
    <View
      // Runtime native entrance motion fades the channel list without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <If when={ttsSettingsStore.loadError() !== null}>
        <Text testID="settings-tts-load-error" role="alert" class="text-sm text-destructive">
          {ttsSettingsStore.loadError()!.message}
        </Text>
      </If>

      <If
        when={order().length > 0}
        else={
          <ChannelEmptyState
            testID="settings-tts-empty"
            icon="mdi:tts"
            title={t("settings.tts.emptyTitle")}
            choicesLabel={t("settings.tts.emptyChannels")}
            busy={props.busy}
            compact={props.compact}
            choices={ttsSettingsStore.availableChannels().map((channel) => ({
              id: channel,
              label: channelName(channel),
              accessibilityLabel: t("settings.tts.emptyAdd", { name: channelName(channel) }),
              testID: `settings-tts-empty-channel-${channel}`,
              leading: <ChannelAvatar channel={channel} size="sm" />,
              onPress: () => props.onAddAvailableChannel(channel),
            }))}
          />
        }
      >
        <Card testID="settings-tts-card" class={props.compact ? "gap-1 p-2" : "gap-1 p-3"}>
          <Each of={order()} key={(channel) => channel}>
            {(channel, index) => {
              const name = () => channelName(channel());
              cleanup(() => {
                delete rowSlots[channel()];
                delete removeRefs[channel()];
                offsets[channel()].set(0);
                props.onRowRef(channel(), null);
                props.onGripRef(channel(), null);
                props.onRowFocusRef(channel(), null);
              });
              const configured = () => ttsSettingsStore.savedBinding(channel()) !== null;
              const enabled = () => ttsSettingsStore.isEnabled(channel());
              const role = () => channelRole(channel());
              const summary = () => channelSummary(channel());
              const rowLabel = () =>
                t("settings.tts.itemLabel", {
                  name: name(),
                  status:
                    role() !== null
                      ? t(`settings.tts.role.${role()!}`)
                      : configured()
                        ? t("models.filter.disabled")
                        : t("settings.tts.notConfigured"),
                });

              return (
                <>
                  <If when={index() > 0}>
                    <View class="mx-2 my-1 h-px bg-border" />
                  </If>
                  <View
                    testID={`settings-tts-row-${channel()}`}
                    pan={isBusy() || !canReorder() ? undefined : { y: offsets[channel()] }}
                    onPanStart={() => handleDragStart(channel())}
                    onPanEnd={(event) => void handleDragEnd(channel(), event)}
                    onLayout={(event) => {
                      rowSlots[channel()] = {
                        top: event.bounds.origin.y,
                        height: event.bounds.size.height,
                      };
                    }}
                    style={{ translate: [0, offsets[channel()]] }}
                    class={`group flex-row items-center gap-1.5 rounded-xl pr-2 ${motion.navigationFeedback} ${
                      dragging() === channel()
                        ? "z-10 cursor-grabbing bg-card shadow-md"
                        : "hover:bg-accent/60 active:bg-accent"
                    }`}
                  >
                    <Button
                      testID={`settings-tts-channel-${channel()}`}
                      ref={(node) => props.onRowRef(channel(), node)}
                      variant="ghost"
                      size="row"
                      accessibilityLabel={rowLabel()}
                      onPress={() => {
                        props.onClearError();
                        props.onOpenChannel(channel());
                      }}
                      class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
                    >
                      <ChannelAvatar channel={channel()} />
                      <View class="min-w-0 flex-1 gap-0.5">
                        <View class="flex-row items-center gap-2">
                          <Text class="min-w-0 shrink truncate text-sm font-medium text-card-foreground">
                            {name()}
                          </Text>
                          <If when={role()}>
                            {(activeRole) => (
                              <Badge
                                testID={`settings-tts-role-${channel()}`}
                                label={t(`settings.tts.role.${activeRole()}`)}
                                tone={activeRole() === "primary" ? "primary" : "neutral"}
                              />
                            )}
                          </If>
                        </View>
                        <Text
                          testID={`settings-tts-summary-${channel()}`}
                          class={`min-w-0 truncate text-xs ${summary().toneClass}`}
                        >
                          {summary().text}
                        </Text>
                      </View>
                    </Button>

                    <If when={canReorder()}>
                      <KeyboardButton
                        testID={`settings-tts-grip-${channel()}`}
                        variant="ghost"
                        size="icon-sm"
                        focusable={true}
                        tooltip={t("settings.tts.reorder", { name: name() })}
                        accessibilityLabel={t("settings.tts.reorder", { name: name() })}
                        accessibilityHint={t("settings.tts.reorderHint")}
                        accessibilityActions={[
                          { name: "moveUp", label: t("settings.tts.moveUp", { name: name() }) },
                          { name: "moveDown", label: t("settings.tts.moveDown", { name: name() }) },
                        ]}
                        onAccessibilityAction={(event) =>
                          handleAccessibilityMove(channel(), event.actionName)
                        }
                        onPress={() => props.onFocusGrip(channel())}
                        captureKeys={["arrowup", "arrowdown"]}
                        onKeyDown={(event) => handleGripKey(channel(), event)}
                        ref={(node) => props.onGripRef(channel(), node)}
                        class={`shrink-0 cursor-grab ${motion.tooltip} ${
                          dragging() === channel()
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        }`}
                      >
                        <Icon name="grip-vertical" tone="muted-foreground" class="size-4" />
                      </KeyboardButton>
                    </If>

                    <Switch
                      testID={`settings-tts-toggle-${channel()}`}
                      variant="inline"
                      checked={enabled()}
                      disabled={mutating() || props.busy || !configured()}
                      accessibilityLabel={t("settings.tts.enableLabel", { name: name() })}
                      tooltip={!configured() ? t("settings.tts.configureBeforeEnable") : undefined}
                      onChange={(checked) => void handleToggle(channel(), checked)}
                    />

                    <Button
                      testID={`settings-tts-remove-${channel()}`}
                      ref={(node) => {
                        removeRefs[channel()] = node;
                        props.onRowFocusRef(channel(), node);
                      }}
                      variant="destructive-ghost"
                      size="icon-sm"
                      disabled={isBusy()}
                      tooltip={t("settings.tts.removeLabel", { name: name() })}
                      accessibilityLabel={t("settings.tts.removeLabel", { name: name() })}
                      onPress={() => handleRequestRemove(channel())}
                    >
                      <Icon name="delete" tone="muted-foreground" class="size-3.5" />
                    </Button>

                    <Button
                      testID={`settings-tts-open-${channel()}`}
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("settings.tts.configureLabel", { name: name() })}
                      accessibilityLabel={t("settings.tts.configureLabel", { name: name() })}
                      onPress={() => {
                        props.onClearError();
                        props.onOpenChannel(channel());
                      }}
                    >
                      <Icon name="chevron-right" tone="muted-foreground" class="size-3.5" />
                    </Button>
                  </View>
                </>
              );
            }}
          </Each>
        </Card>
      </If>

      <If when={props.listError !== null}>
        <Text testID="settings-tts-list-error" role="alert" class="px-1 text-sm text-destructive">
          {props.listError}
        </Text>
      </If>

      <ConfirmDialog
        testID="settings-tts-remove-dialog"
        open={pendingRemove() !== null}
        title={t("settings.tts.removeTitle")}
        description={
          pendingRemove() !== null
            ? t("settings.tts.removeDescription", { name: channelName(pendingRemove()!) })
            : ""
        }
        error={removeError()}
        confirmLabel={t("settings.tts.removeConfirm")}
        confirmVariant="destructive"
        busy={mutating()}
        cancelRef={(node) => {
          removeCancelNode = node;
        }}
        onOpen={() => {
          focusTarget(removeCancelNode);
        }}
        onClose={() => {
          removeError.set(null);
          const run = pendingRemoveCloseFocus;
          pendingRemoveCloseFocus = null;
          run?.();
        }}
        onOpenChange={(open) => {
          if (!open) pendingRemove.set(null);
        }}
        onConfirm={() => {
          const target = pendingRemove();
          if (target !== null) void performRemove(target, true);
        }}
      />
    </View>
  );
}

type PreviewPhase = "idle" | "loading" | "playing";

function previewFailureMessage(channel: TtsChannelId, failure: TtsFailure): string {
  if (failure === "auth") {
    return t(channel === "azure" ? "settings.tts.failure.azureAuth" : "settings.tts.failure.auth");
  }
  if (failure === "rate_limited") return t("settings.tts.failure.azureRateLimited");
  if (failure === "quota") return t("settings.tts.failure.quota");
  return t("settings.tts.failure.playback");
}

function ChannelDetail(props: {
  channel: TtsChannelId;
  compact: boolean;
  credentialState: CredentialState;
}) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const initialSaved = ttsSettingsStore.savedBinding(props.channel);
  const googlePreferences = signal<GoogleVoicePreferences>(
    initialSaved?.channel === "google-cloud"
      ? initialSaved.preferences
      : DEFAULT_GOOGLE_VOICE_PREFERENCES,
  );
  const sampleLanguage = signal<LanguageId>(GOOGLE_SAMPLE_LANGUAGE);
  const overridesOpen = signal(false);
  const overrideLanguage = signal<LanguageId>(GOOGLE_SAMPLE_LANGUAGE);
  const apiKeyDraft = signal("");
  const regionDraft = signal("");
  const error = signal<string | null>(null);
  const previewError = signal<string | null>(null);
  const saving = signal(false);
  const playbackReady = signal(false);
  const phase = signal<PreviewPhase>("idle");
  let apiKeyField: InputRef | undefined;
  let regionTouched = false;
  let mounted = true;
  const active = {
    token: 0,
    abort: null as AbortController | null,
    stop: null as (() => void) | null,
  };

  cleanup(() => {
    mounted = false;
    active.token += 1;
    active.abort?.abort();
    active.stop?.();
    active.stop = null;
  });

  effect(() => {
    if (props.channel !== "azure" || regionTouched) return;
    const saved = ttsSettingsStore.savedBinding("azure");
    regionDraft.set(saved?.channel === "azure" ? saved.region : "");
  });

  effect(() => {
    void canPlayTts().then((ready) => {
      if (mounted) playbackReady.set(ready);
    });
  });

  const savedBinding = () => ttsSettingsStore.savedBinding(props.channel);
  const savedGooglePreferences = () => {
    const saved = ttsSettingsStore.savedBinding("google-cloud");
    return saved?.channel === "google-cloud" ? saved.preferences : null;
  };
  const preferencesDirty = () => {
    const saved = savedGooglePreferences();
    return (
      saved === null ||
      googlePreferencesSignature(saved) !== googlePreferencesSignature(googlePreferences())
    );
  };
  const regionDirty = () => {
    if (props.channel !== "azure") return false;
    const saved = ttsSettingsStore.savedBinding("azure");
    if (saved?.channel !== "azure") return regionDraft().trim().length > 0;
    return regionDraft().trim() !== saved.region;
  };
  const googleProblem = () =>
    props.channel === "google-cloud"
      ? googleVoiceProblem(googlePreferences(), sampleLanguage())
      : null;
  const previewLabel = () => {
    if (phase() === "loading") return t("common.cancel");
    if (phase() === "playing") return t("settings.tts.stop");
    return t("settings.tts.preview");
  };
  const previewNote = (): string | undefined => {
    if (!playbackReady()) return t("settings.tts.previewUnavailable");
    if (savedBinding() === null || props.credentialState !== "readable") {
      return t("settings.tts.previewNeedsKey");
    }
    if (phase() === "idle" && apiKeyDraft().trim().length > 0) {
      return t("settings.tts.previewUnsaved");
    }
    if (phase() === "idle" && regionDirty()) return t("settings.tts.previewUnsavedRegion");
    return googleProblem() ?? undefined;
  };
  const previewDisabled = () => {
    if (phase() !== "idle") return false;
    if (saving() || !playbackReady() || apiKeyDraft().trim().length > 0 || regionDirty()) {
      return true;
    }
    if (savedBinding() === null || props.credentialState !== "readable") return true;
    return googleProblem() !== null;
  };
  const controlsLocked = () => saving() || phase() !== "idle";
  const saveDisabled = () => {
    if (controlsLocked()) return true;
    if (props.channel === "azure") {
      return apiKeyDraft().trim().length === 0 || regionDraft().trim().length === 0;
    }
    const hasNewKey = apiKeyDraft().trim().length > 0;
    const canReuseKey = savedBinding() !== null && props.credentialState === "readable";
    return !hasNewKey && !(canReuseKey && preferencesDirty());
  };

  const editOverrides = (language: LanguageId) => {
    overrideLanguage.set(language);
    overridesOpen.set(true);
  };

  const applyOverride = (language: LanguageId, voiceName: string | null) => {
    const current = googlePreferences();
    const overrides = { ...current.voiceOverrides };
    if (voiceName === null) delete overrides[language];
    else overrides[language] = voiceName;
    googlePreferences.set({ ...current, voiceOverrides: overrides });
    sampleLanguage.set(language);
    error.set(null);
    previewError.set(null);
  };

  const handleSave = async () => {
    const apiKey = apiKeyDraft().trim();
    if (saveDisabled()) return;
    error.set(null);
    saving.set(true);
    try {
      if (props.channel === "azure") {
        const result = await ttsSettingsStore.saveChannel({
          channel: "azure",
          apiKey,
          region: regionDraft().trim(),
        });
        if (!result.ok) {
          error.set(result.message);
          return;
        }
        if (result.binding.channel === "azure") {
          regionTouched = false;
          regionDraft.set(result.binding.region);
        }
      } else {
        const result = await ttsSettingsStore.saveChannel({
          channel: "google-cloud",
          ...(apiKey.length > 0 ? { apiKey } : {}),
          preferences: googlePreferences(),
        });
        if (!result.ok) {
          error.set(result.message);
          return;
        }
        if (result.binding.channel === "google-cloud") {
          googlePreferences.set(result.binding.preferences);
        }
      }
      apiKeyDraft.set("");
      if (mounted) apiKeyField?.blur();
      toast.success(t("settings.tts.saved"));
    } finally {
      saving.set(false);
    }
  };

  const handlePreview = async () => {
    if (phase() === "loading") {
      active.token += 1;
      active.abort?.abort();
      active.stop?.();
      active.stop = null;
      phase.set("idle");
      previewError.set(null);
      return;
    }
    if (phase() === "playing") {
      active.token += 1;
      active.stop?.();
      active.stop = null;
      phase.set("idle");
      previewError.set(null);
      return;
    }
    if (previewDisabled()) return;
    const saved = savedBinding();
    if (saved === null) return;
    const token = active.token + 1;
    active.token = token;
    const controller = new AbortController();
    active.abort = controller;
    previewError.set(null);
    phase.set("loading");
    const apiKey = await ttsSettingsStore.readKey(saved.credentialRef);
    if (!mounted || token !== active.token) return;
    const current = savedBinding();
    const bindingChanged =
      current === null ||
      current.credentialRef !== saved.credentialRef ||
      (saved.channel === "azure" &&
        (current.channel !== "azure" || current.region !== saved.region));
    if (apiKey === null || bindingChanged) {
      phase.set("idle");
      previewError.set(t("settings.tts.keyUnreadable"));
      return;
    }
    let request: TtsSynthesisRequest;
    if (saved.channel === "azure") {
      request = sampleSpeechRequest({ channel: "azure", apiKey, region: saved.region });
    } else {
      const resolved = resolveGoogleVoice(sampleLanguage(), googlePreferences());
      if (!resolved.ok) {
        phase.set("idle");
        previewError.set(googleProblem());
        return;
      }
      request = googleSampleSpeechRequest({
        credentials: { channel: "google-cloud", apiKey },
        language: sampleLanguage(),
        voice: resolved.voice,
        preferences: googlePreferences(),
      });
    }
    const synthesized = await synthesizeSpeech(request, { signal: controller.signal });
    if (!mounted || token !== active.token || controller.signal.aborted) return;
    if (synthesized.status === "cancelled") {
      phase.set("idle");
      return;
    }
    if (synthesized.status === "failed") {
      phase.set("idle");
      previewError.set(previewFailureMessage(props.channel, synthesized.failure));
      return;
    }
    const playback = playMp3Bytes(synthesized.audio, {
      onPlaying: () => {
        if (!mounted || token !== active.token) {
          playback.stop();
          return;
        }
        phase.set("playing");
      },
    });
    active.stop = () => playback.stop();
    const played = await playback.result;
    if (!mounted || token !== active.token) return;
    active.stop = null;
    phase.set("idle");
    if (played.status === "failed") previewError.set(t("settings.tts.failure.playback"));
  };

  return (
    <View
      // Runtime native entrance motion fades the channel detail without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <Card testID="settings-tts-detail-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <View class="min-w-0 flex-row items-center gap-3">
          <ChannelAvatar channel={props.channel} />
          <SectionHeading title={channelName(props.channel)} />
        </View>

        <If when={props.channel === "azure"}>
          <FormField label={t("settings.tts.azure.region")}>
            <Input
              testID="settings-tts-region"
              value={regionDraft()}
              placeholder={t("settings.tts.azure.regionExample")}
              disabled={controlsLocked()}
              accessibilityLabel={t("settings.tts.azure.region")}
              onChange={(value) => {
                regionTouched = true;
                error.set(null);
                regionDraft.set(value);
              }}
            />
          </FormField>
        </If>

        <FormField label={t("settings.tts.apiKey")}>
          <Input
            testID="settings-tts-api-key"
            ref={(node) => {
              apiKeyField = node;
            }}
            value={apiKeyDraft()}
            placeholder={
              props.credentialState === "readable" ? t("settings.tts.savedKey") : undefined
            }
            masked={true}
            disabled={controlsLocked()}
            accessibilityLabel={t("settings.tts.apiKey")}
            onChange={(value) => {
              error.set(null);
              apiKeyDraft.set(value);
            }}
          />
        </FormField>

        <If when={props.credentialState === "missing"}>
          <Text testID="settings-tts-key-missing" role="alert" class="text-sm text-destructive">
            {t("settings.tts.keyUnreadable")}
          </Text>
        </If>

        <If when={props.channel === "google-cloud"}>
          <GoogleTtsFields
            disabled={controlsLocked()}
            preferences={() => googlePreferences()}
            sampleLanguage={() => sampleLanguage()}
            onPreferencesChange={(next) => {
              error.set(null);
              googlePreferences.set(next);
            }}
            onSampleLanguageChange={(language) => sampleLanguage.set(language)}
            onEditOverrides={editOverrides}
          />
        </If>

        <If when={error() !== null}>
          <Text testID="settings-tts-error" role="alert" class="text-sm text-destructive">
            {error()}
          </Text>
        </If>

        <If when={previewError() !== null}>
          <Text testID="settings-tts-preview-error" role="alert" class="text-sm text-destructive">
            {previewError()}
          </Text>
        </If>

        <If when={props.channel === "google-cloud"}>
          <Text
            testID="settings-tts-google-preview-voice"
            class={`text-xs ${googleProblem() !== null ? "text-destructive" : "text-muted-foreground"}`}
          >
            {googleProblem() ?? googlePreviewVoiceLabel(googlePreferences(), sampleLanguage())}
          </Text>
        </If>

        <View class="flex-row justify-end gap-2">
          <Button
            testID="settings-tts-preview"
            variant="outline"
            size="sm"
            label={previewLabel()}
            disabled={previewDisabled()}
            tooltip={previewDisabled() ? previewNote() : undefined}
            onPress={() => void handlePreview()}
          />
          <Button
            testID="settings-tts-save"
            variant="primary"
            size="sm"
            label={saving() ? t("common.saving") : t("common.save")}
            disabled={saveDisabled()}
            onPress={() => void handleSave()}
          />
        </View>
      </Card>

      <If when={props.channel === "google-cloud"}>
        <GoogleOverrideDialog
          open={() => overridesOpen()}
          initialLanguage={() => overrideLanguage()}
          preferences={() => googlePreferences()}
          onOpenChange={(open) => overridesOpen.set(open)}
          onApply={applyOverride}
        />
      </If>
    </View>
  );
}

/** Settings section for the text-to-speech channels. */
export function TtsSection(props: TtsSectionProps) {
  const credentialState = signal<CredentialStates>({
    "google-cloud": "unknown",
    azure: "unknown",
  });
  const addDialogOpen = signal(false);
  const addingChannel = signal(false);
  const listBusy = signal(false);
  const listError = signal<string | null>(null);
  const removeDialogOpen = signal(false);
  const rowRefs: Partial<Record<TtsChannelId, ViewRef>> = {};
  const gripRefs: Partial<Record<TtsChannelId, ViewRef>> = {};
  const fallbackFocusRefs: Partial<Record<TtsChannelId, ViewRef>> = {};
  let pendingDialogCloseFocus: (() => void) | null = null;
  let returnChannel: TtsChannelId | null = null;
  let restoreFocusOnList = false;

  const focusAddButton = () => focusTarget(props.getAddButtonRef?.() ?? null);

  effect(() => props.onAddBusyChange?.(addingChannel() || listBusy()));
  cleanup(() => props.onAddBusyChange?.(false));

  effect(() => props.onDialogOpenChange?.(addDialogOpen() || removeDialogOpen()));
  cleanup(() => props.onDialogOpenChange?.(false));

  effect(() => {
    for (const channel of TTS_CHANNELS) {
      const saved = ttsSettingsStore.savedBinding(channel);
      if (saved === null) {
        if (credentialState()[channel] !== "unknown") {
          credentialState.set({ ...credentialState(), [channel]: "unknown" });
        }
        continue;
      }
      const ref = saved.credentialRef;
      void ttsSettingsStore.readKey(ref).then((key) => {
        if (ttsSettingsStore.savedBinding(channel)?.credentialRef !== ref) return;
        const next = key === null ? "missing" : "readable";
        if (credentialState()[channel] === next) return;
        credentialState.set({ ...credentialState(), [channel]: next });
      });
    }
  });

  effect(() => {
    const current = props.selectedChannel;
    if (current !== null) {
      returnChannel = current;
      restoreFocusOnList = true;
      return;
    }
    if (!restoreFocusOnList) return;
    restoreFocusOnList = false;
    const channel = returnChannel;
    queueMicrotask(() => {
      if (props.selectedChannel === null && channel !== null) rowRefs[channel]?.focus();
    });
  });

  const handleOpenAddDialog = () => {
    if (addingChannel() || listBusy() || ttsSettingsStore.availableChannels().length === 0) {
      return;
    }
    listError.set(null);
    pendingDialogCloseFocus = focusAddButton;
    addDialogOpen.set(true);
  };

  const unregisterAddTrigger = props.onRegisterAddTrigger?.(handleOpenAddDialog);
  if (unregisterAddTrigger) cleanup(unregisterAddTrigger);

  const addChannelKind = async (channel: TtsChannelId): Promise<boolean> => {
    if (addingChannel()) return false;
    listError.set(null);
    addingChannel.set(true);
    try {
      const result = await ttsSettingsStore.addChannel(channel);
      if (!result.ok) {
        listError.set(result.message);
        return false;
      }
      return true;
    } finally {
      addingChannel.set(false);
    }
  };

  const handleSelectAddKind = async (channel: TtsChannelId) => {
    if (addingChannel()) return;
    const added = await addChannelKind(channel);
    addDialogOpen.set(false);
    if (!added) return;
    pendingDialogCloseFocus = null;
    props.onSelectChannel(channel);
  };

  /** Adding from the empty state skips the picker and opens the new channel directly. */
  const handleAddAvailableChannel = async (channel: TtsChannelId) => {
    if (addingChannel()) return;
    const added = await addChannelKind(channel);
    if (!added) return;
    props.onSelectChannel(channel);
  };

  const selected = () => props.selectedChannel;

  return (
    <>
      <If when={selected() === null}>
        <TtsChannelList
          compact={props.compact}
          credentialState={credentialState()}
          busy={addingChannel()}
          listError={listError()}
          onClearError={() => listError.set(null)}
          onSetError={(message) => listError.set(message)}
          onBusyChange={(busy) => listBusy.set(busy)}
          onOpenChannel={(channel) => props.onSelectChannel(channel)}
          onAddAvailableChannel={(channel) => void handleAddAvailableChannel(channel)}
          onFocusAddButton={focusAddButton}
          onRowRef={(channel, node) => {
            if (node) rowRefs[channel] = node;
            else delete rowRefs[channel];
          }}
          onGripRef={(channel, node) => {
            if (node) gripRefs[channel] = node;
            else delete gripRefs[channel];
          }}
          onRowFocusRef={(channel, node) => {
            if (node) fallbackFocusRefs[channel] = node;
            else delete fallbackFocusRefs[channel];
          }}
          onFocusGrip={(channel) => gripRefs[channel]?.focus()}
          onFocusChannelFallback={(channel) =>
            focusTarget(
              rowRefs[channel] ?? fallbackFocusRefs[channel] ?? props.getAddButtonRef?.() ?? null,
            )
          }
          onRemoveDialogOpenChange={(open) => removeDialogOpen.set(open)}
        />
      </If>

      <AddTtsChannelDialog
        open={addDialogOpen()}
        availableChannels={ttsSettingsStore.availableChannels()}
        busy={addingChannel()}
        onOpenChange={(open) => addDialogOpen.set(open)}
        onSelect={(channel) => void handleSelectAddKind(channel)}
        onClose={() => {
          const run = pendingDialogCloseFocus;
          pendingDialogCloseFocus = null;
          run?.();
        }}
      />

      <If when={selected() === "google-cloud"}>
        <ChannelDetail
          channel="google-cloud"
          compact={props.compact}
          credentialState={credentialState()["google-cloud"]}
        />
      </If>
      <If when={selected() === "azure"}>
        <ChannelDetail
          channel="azure"
          compact={props.compact}
          credentialState={credentialState().azure}
        />
      </If>
    </>
  );
}
