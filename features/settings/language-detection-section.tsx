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
import googleMark from "../../assets/icons/google.svg";
import googleCloudMark from "../../assets/icons/google-cloud.svg";
import { motion } from "../../components/motion";
import { Avatar, type AvatarSize } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button, KeyboardButton } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { AppDialog, ConfirmDialog } from "../../components/ui/dialog";
import { ChannelEmptyState } from "../../components/ui/empty-state";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { FormField } from "../../modules/ai/ui/form-field";
import {
  LANGUAGE_DETECTOR_KINDS,
  languageDetectionStore,
  type LanguageDetectionPreferences,
  type LanguageDetectorKind,
} from "../language-detection/settings";
import { modelsStore } from "../models/store";
import { getLanguageLabel, isLanguageId, LANGUAGE_IDS } from "../presets/languages";
import { readAvailableModelChoices, resolveModelBindingInfo } from "../presets/model-choices";

/** Time a reordered row takes to settle into its new slot. */
const REORDER_SETTLE_MS = 180;

/** Select value for an unset language preference (`null` in storage). */
const UNSET_LANGUAGE_CHOICE = "__unset__";

type SummaryToneClass = "text-muted-foreground" | "text-warning" | "text-destructive";

/** Whether a saved Google Cloud API key could be read from storage. */
type CredentialState = "unknown" | "readable" | "missing";

interface ChannelSummary {
  text: string;
  toneClass: SummaryToneClass;
}

function languageItems(): SelectItem[] {
  return [
    { value: UNSET_LANGUAGE_CHOICE, title: t("settings.languageDetection.preferenceUnset") },
    ...LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) })),
  ];
}

function isDetectorConfigured(kind: LanguageDetectorKind): boolean {
  if (kind === "ai") return languageDetectionStore.savedAiBinding() !== null;
  if (kind === "google-cloud") return languageDetectionStore.savedGoogleCloudBinding() !== null;
  return true;
}

/** Only the free Google endpoint has nothing to configure, so only it stays a static row. */
function isDetectorOpenable(kind: LanguageDetectorKind): boolean {
  return kind !== "google";
}

function detectorRole(kind: LanguageDetectorKind): "primary" | "backup" | null {
  const enabledOrder = languageDetectionStore
    .detectorOrder()
    .filter((item) => languageDetectionStore.isEnabled(item));
  const position = enabledOrder.indexOf(kind);
  if (position === -1) return null;
  return position === 0 ? "primary" : "backup";
}

function detectorSummary(
  kind: LanguageDetectorKind,
  credentialState: CredentialState,
): ChannelSummary {
  if (kind === "google") {
    return {
      text: t("settings.languageDetection.googleSummary"),
      toneClass: "text-muted-foreground",
    };
  }
  if (kind === "google-cloud") {
    if (languageDetectionStore.savedGoogleCloudBinding() === null) {
      return {
        text: t("settings.languageDetection.notConfigured"),
        toneClass: "text-muted-foreground",
      };
    }
    if (credentialState === "missing") {
      return {
        text: t("settings.languageDetection.googleCloudKeyUnreadable"),
        toneClass: "text-destructive",
      };
    }
    return {
      text: t("settings.languageDetection.googleCloudSummary"),
      toneClass: "text-muted-foreground",
    };
  }
  const saved = languageDetectionStore.savedAiBinding();
  if (saved === null) {
    return {
      text: t("settings.languageDetection.notConfigured"),
      toneClass: "text-muted-foreground",
    };
  }
  const info = resolveModelBindingInfo(saved.modelId);
  return info.available
    ? { text: info.label, toneClass: "text-muted-foreground" }
    : { text: info.reason ?? info.label, toneClass: "text-warning" };
}

function DetectionChannelAvatar(props: { kind: LanguageDetectorKind; size?: AvatarSize }) {
  const mark = () =>
    props.kind === "google" ? googleMark : props.kind === "google-cloud" ? googleCloudMark : null;

  return (
    <If
      when={mark() !== null}
      else={<Avatar size={props.size ?? "md"} icon="cube-outline" accessibilityLabel="" />}
    >
      <Avatar
        size={props.size ?? "md"}
        accessibilityLabel=""
        fallback={
          <Image src={mark()!} accessibilityElementsHidden={true} class="size-4 overflow-hidden" />
        }
      />
    </If>
  );
}

/** One row's identity block, shared by the pressable rows and the static Google row. */
function DetectionChannelIdentity(props: {
  kind: LanguageDetectorKind;
  credentialState: CredentialState;
}) {
  const role = () => detectorRole(props.kind);
  const summary = () => detectorSummary(props.kind, props.credentialState);

  return (
    <>
      <DetectionChannelAvatar kind={props.kind} />
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text class="min-w-0 shrink truncate text-sm font-medium text-card-foreground">
            {t(`settings.languageDetection.${props.kind}`)}
          </Text>
          <If when={role()}>
            {(activeRole) => (
              <Badge
                testID={`settings-detection-role-${props.kind}`}
                label={t(`settings.languageDetection.role.${activeRole()}`)}
                tone={activeRole() === "primary" ? "primary" : "neutral"}
              />
            )}
          </If>
        </View>
        <Text
          testID={`settings-detection-summary-${props.kind}`}
          class={`min-w-0 truncate text-xs ${summary().toneClass}`}
        >
          {summary().text}
        </Text>
      </View>
    </>
  );
}

function focusTarget(node: ViewRef | null | undefined) {
  if (!node) return;
  node.focus();
  setAccessibilityFocus(node);
}

function AddDetectionChannelDialog(props: {
  open: boolean;
  availableKinds: readonly LanguageDetectorKind[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (kind: LanguageDetectorKind) => void;
  onClose?: () => void;
}) {
  const cardRefs: Partial<Record<LanguageDetectorKind, ViewRef>> = {};
  const firstKind = () => props.availableKinds[0];

  return (
    <AppDialog
      testID="settings-detection-add-dialog"
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy) props.onOpenChange(open);
      }}
      onOpen={() => {
        const first = firstKind();
        if (first !== undefined) focusTarget(cardRefs[first]);
      }}
      onClose={() => props.onClose?.()}
      title={t("settings.languageDetection.addChannel")}
      size="md"
      closeOnEscape={!props.busy}
      closeOnBackdropPress={!props.busy}
      footer={
        <Button
          testID="settings-detection-add-cancel"
          variant="outline"
          size="sm"
          label={t("common.cancel")}
          disabled={props.busy}
          onPress={() => props.onOpenChange(false)}
        />
      }
    >
      <View class="grid grid-cols-2 gap-3">
        <Each of={props.availableKinds} key={(kind) => kind}>
          {(kind) => {
            const currentKind = kind();
            cleanup(() => {
              delete cardRefs[currentKind];
            });
            return (
              <Button
                testID={`settings-detection-option-${kind()}`}
                ref={(node) => {
                  cardRefs[kind()] = node;
                }}
                variant="outline"
                size="card"
                disabled={props.busy}
                accessibilityLabel={t(`settings.languageDetection.${kind()}`)}
                onPress={() => props.onSelect(kind())}
                class="w-full"
              >
                <DetectionChannelAvatar kind={kind()} />
                <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {t(`settings.languageDetection.${kind()}`)}
                </Text>
              </Button>
            );
          }}
        </Each>
      </View>
    </AppDialog>
  );
}

interface DetectionChannelListProps {
  compact: boolean;
  credentialState: CredentialState;
  busy: boolean;
  listError: string | null;
  onClearError: () => void;
  onSetError: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenChannel: (kind: LanguageDetectorKind) => void;
  onFocusAddButton: () => void;
  onRowRef: (kind: LanguageDetectorKind, node: ViewRef | null) => void;
  onGripRef: (kind: LanguageDetectorKind, node: ViewRef | null) => void;
  onRowFocusRef: (kind: LanguageDetectorKind, node: ViewRef | null) => void;
  onFocusGrip: (kind: LanguageDetectorKind) => void;
  onFocusChannelFallback: (kind: LanguageDetectorKind) => void;
  onAddAvailableDetector: (kind: LanguageDetectorKind) => void;
  onRemoveDialogOpenChange: (open: boolean) => void;
}

function DetectionChannelList(props: DetectionChannelListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const dragging = signal<LanguageDetectorKind | null>(null);
  const animating = signal(false);
  const pendingRemove = signal<LanguageDetectorKind | null>(null);
  const removeError = signal<string | null>(null);
  effect(() => props.onRemoveDialogOpenChange(pendingRemove() !== null));
  cleanup(() => props.onRemoveDialogOpenChange(false));
  // Per-detector drag offsets drive the rows natively; they return to 0 at rest.
  const offsets: Record<LanguageDetectorKind, AnimatedValue> = {
    ai: createAnimatedValue(0),
    google: createAnimatedValue(0),
    "google-cloud": createAnimatedValue(0),
  };
  const rowSlots: Partial<Record<LanguageDetectorKind, { top: number; height: number }>> = {};
  const removeRefs: Partial<Record<LanguageDetectorKind, ViewRef>> = {};
  let removeCancelNode: ViewRef | null = null;
  let pendingRemoveCloseFocus: (() => void) | null = null;

  effect(() => props.onBusyChange(mutating() || animating()));
  cleanup(() => props.onBusyChange(false));

  const order = () => languageDetectionStore.detectorOrder();
  const canReorder = () => order().length > 1;
  const isBusy = () => props.busy || mutating() || animating();
  const name = (kind: LanguageDetectorKind) => t(`settings.languageDetection.${kind}`);

  const rowLabel = (kind: LanguageDetectorKind): string => {
    const role = detectorRole(kind);
    return t("settings.languageDetection.itemLabel", {
      name: name(kind),
      status:
        role !== null
          ? t(`settings.languageDetection.role.${role}`)
          : isDetectorConfigured(kind)
            ? t("models.filter.disabled")
            : t("settings.languageDetection.notConfigured"),
    });
  };

  const handleToggle = async (kind: LanguageDetectorKind, nextEnabled: boolean) => {
    if (isBusy()) return;
    props.onClearError();
    mutating.set(true);
    try {
      const result = await languageDetectionStore.setEnabled(kind, nextEnabled);
      if (!result.ok) props.onSetError(result.message);
    } finally {
      mutating.set(false);
    }
  };

  const nextFocusTargetAfterRemove = (
    previousOrder: readonly LanguageDetectorKind[],
    removed: LanguageDetectorKind,
  ): (() => void) => {
    const index = previousOrder.indexOf(removed);
    const remaining = previousOrder.filter((item) => item !== removed);
    if (remaining.length === 0) return props.onFocusAddButton;
    const target = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]!;
    return () => props.onFocusChannelFallback(target);
  };

  const performRemove = async (kind: LanguageDetectorKind, fromConfirmDialog: boolean) => {
    if (isBusy()) return false;
    const previousOrder = order();
    props.onClearError();
    removeError.set(null);
    mutating.set(true);
    try {
      const result = await languageDetectionStore.removeDetector(kind);
      if (!result.ok) {
        if (fromConfirmDialog) removeError.set(result.message);
        else props.onSetError(result.message);
        return false;
      }
      const nextFocus = nextFocusTargetAfterRemove(previousOrder, kind);
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

  const handleRequestRemove = (kind: LanguageDetectorKind) => {
    if (isBusy()) return;
    props.onClearError();
    removeError.set(null);
    if (kind !== "google" && isDetectorConfigured(kind)) {
      pendingRemoveCloseFocus = () => focusTarget(removeRefs[kind]);
      pendingRemove.set(kind);
      return;
    }
    void performRemove(kind, false);
  };

  const animateOffset = (kind: LanguageDetectorKind, to: number): Promise<unknown> => {
    if (reduceMotion()) {
      offsets[kind].set(to);
      return Promise.resolve();
    }
    return offsets[kind].timing(to, { duration: REORDER_SETTLE_MS, easing: "easeOut" });
  };

  const resetOffsets = () => {
    for (const kind of LANGUAGE_DETECTOR_KINDS) offsets[kind].set(0);
  };

  const handleDragStart = (kind: LanguageDetectorKind) => {
    if (isBusy() || !canReorder() || dragging() !== null) return;
    props.onClearError();
    dragging.set(kind);
  };

  /** The detector whose measured slot center is nearest the dragged row's center. */
  const nearestDetector = (kind: LanguageDetectorKind, offsetY: number): number | null => {
    const slot = rowSlots[kind];
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
  const settleIntoSlots = async (kind: LanguageDetectorKind, target: number) => {
    const list = order();
    const nextOrder = [...list];
    nextOrder.splice(list.indexOf(kind), 1);
    nextOrder.splice(target, 0, kind);
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

  const handleDragEnd = async (kind: LanguageDetectorKind, event: PanEvent) => {
    if (dragging() !== kind) {
      await animateOffset(kind, 0);
      return;
    }
    animating.set(true);
    try {
      const index = order().indexOf(kind);
      const target = nearestDetector(kind, event.value?.y ?? event.translation.y);
      if (event.cancelled || index === -1 || target === null || target === index) {
        await animateOffset(kind, 0);
        return;
      }
      const nextOrder = await settleIntoSlots(kind, target);
      const result = await languageDetectionStore.moveDetectorTo(kind, target);
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

  const handleMoveBy = async (kind: LanguageDetectorKind, delta: number, refocus: boolean) => {
    if (isBusy() || !canReorder() || dragging() !== null) return;
    const list = order();
    const index = list.indexOf(kind);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return;
    props.onClearError();
    mutating.set(true);
    try {
      const result = await languageDetectionStore.moveDetectorTo(kind, target);
      if (!result.ok) {
        props.onSetError(result.message);
        return;
      }
      if (refocus) queueMicrotask(() => props.onFocusGrip(kind));
    } finally {
      mutating.set(false);
    }
  };

  const handleGripKey = (kind: LanguageDetectorKind, event: KeyEvent) => {
    if (event.key === "ArrowUp") void handleMoveBy(kind, -1, true);
    else if (event.key === "ArrowDown") void handleMoveBy(kind, 1, true);
  };

  const handleAccessibilityMove = (kind: LanguageDetectorKind, actionName: string) => {
    if (actionName === "moveUp") void handleMoveBy(kind, -1, false);
    else if (actionName === "moveDown") void handleMoveBy(kind, 1, false);
  };

  return (
    <View
      // Runtime native entrance motion fades the detector list without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <If when={languageDetectionStore.loadError() !== null}>
        <Text testID="settings-detection-load-error" role="alert" class="text-sm text-destructive">
          {languageDetectionStore.loadError()!.message}
        </Text>
      </If>

      <If
        when={order().length > 0}
        else={
          <ChannelEmptyState
            testID="settings-detection-empty"
            icon="mdi:text-recognition"
            title={t("settings.languageDetection.emptyTitle")}
            choicesLabel={t("settings.languageDetection.emptyChannels")}
            busy={props.busy}
            compact={props.compact}
            choices={languageDetectionStore.availableDetectors().map((kind) => ({
              id: kind,
              label: t(`settings.languageDetection.${kind}`),
              accessibilityLabel: t("settings.languageDetection.emptyAdd", {
                name: t(`settings.languageDetection.${kind}`),
              }),
              testID: `settings-detection-empty-channel-${kind}`,
              leading: <DetectionChannelAvatar kind={kind} size="sm" />,
              onPress: () => props.onAddAvailableDetector(kind),
            }))}
          />
        }
      >
        <Card testID="settings-detection-card" class={props.compact ? "gap-1 p-2" : "gap-1 p-3"}>
          <Each of={order()} key={(kind) => kind}>
            {(kind, index) => {
              const currentKind = kind();
              cleanup(() => {
                delete rowSlots[currentKind];
                delete removeRefs[currentKind];
                offsets[currentKind].set(0);
                props.onRowRef(currentKind, null);
                props.onGripRef(currentKind, null);
                props.onRowFocusRef(currentKind, null);
              });
              const configured = () => isDetectorConfigured(kind());
              const enabled = () => languageDetectionStore.isEnabled(kind());

              return (
                <>
                  <If when={index() > 0}>
                    <View class="mx-2 my-1 h-px bg-border" />
                  </If>
                  <View
                    testID={`settings-detection-row-${kind()}`}
                    pan={isBusy() || !canReorder() ? undefined : { y: offsets[kind()] }}
                    onPanStart={() => handleDragStart(kind())}
                    onPanEnd={(event) => void handleDragEnd(kind(), event)}
                    onLayout={(event) => {
                      rowSlots[kind()] = {
                        top: event.bounds.origin.y,
                        height: event.bounds.size.height,
                      };
                    }}
                    style={{ translate: [0, offsets[kind()]] }}
                    class={`group flex-row items-center gap-1.5 rounded-xl pr-2 ${motion.navigationFeedback} ${
                      dragging() === kind()
                        ? "z-10 cursor-grabbing bg-card shadow-md"
                        : "hover:bg-accent/60 active:bg-accent"
                    }`}
                  >
                    <If
                      when={isDetectorOpenable(kind())}
                      else={
                        <View class="min-w-0 flex-1 flex-row items-center gap-2.5 rounded-xl py-2.5 pl-3 pr-2">
                          <DetectionChannelIdentity
                            kind={kind()}
                            credentialState={props.credentialState}
                          />
                        </View>
                      }
                    >
                      <Button
                        testID={`settings-detection-channel-${kind()}`}
                        ref={(node) => props.onRowRef(kind(), node)}
                        variant="ghost"
                        size="row"
                        accessibilityLabel={rowLabel(kind())}
                        onPress={() => {
                          props.onClearError();
                          props.onOpenChannel(kind());
                        }}
                        class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
                      >
                        <DetectionChannelIdentity
                          kind={kind()}
                          credentialState={props.credentialState}
                        />
                      </Button>
                    </If>

                    <If when={canReorder()}>
                      <KeyboardButton
                        testID={`settings-detection-grip-${kind()}`}
                        variant="ghost"
                        size="icon-sm"
                        focusable={true}
                        tooltip={t("settings.languageDetection.reorder", { name: name(kind()) })}
                        accessibilityLabel={t("settings.languageDetection.reorder", {
                          name: name(kind()),
                        })}
                        accessibilityHint={t("settings.languageDetection.reorderHint")}
                        accessibilityActions={[
                          {
                            name: "moveUp",
                            label: t("settings.languageDetection.moveUp", { name: name(kind()) }),
                          },
                          {
                            name: "moveDown",
                            label: t("settings.languageDetection.moveDown", { name: name(kind()) }),
                          },
                        ]}
                        onAccessibilityAction={(event) =>
                          handleAccessibilityMove(kind(), event.actionName)
                        }
                        onPress={() => props.onFocusGrip(kind())}
                        captureKeys={["arrowup", "arrowdown"]}
                        onKeyDown={(event) => handleGripKey(kind(), event)}
                        ref={(node) => props.onGripRef(kind(), node)}
                        class={`shrink-0 cursor-grab ${motion.tooltip} ${
                          dragging() === kind()
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        }`}
                      >
                        <Icon name="grip-vertical" tone="muted-foreground" class="size-4" />
                      </KeyboardButton>
                    </If>

                    <Switch
                      testID={`settings-detection-toggle-${kind()}`}
                      variant="inline"
                      checked={enabled()}
                      disabled={mutating() || props.busy || !configured()}
                      accessibilityLabel={t("settings.languageDetection.enableLabel", {
                        name: name(kind()),
                      })}
                      tooltip={
                        !configured()
                          ? t("settings.languageDetection.configureBeforeEnable")
                          : undefined
                      }
                      onChange={(checked) => void handleToggle(kind(), checked)}
                    />

                    <Button
                      testID={`settings-detection-remove-${kind()}`}
                      ref={(node) => {
                        removeRefs[kind()] = node;
                        props.onRowFocusRef(kind(), node);
                      }}
                      variant="destructive-ghost"
                      size="icon-sm"
                      disabled={isBusy()}
                      tooltip={t("settings.languageDetection.removeLabel", { name: name(kind()) })}
                      accessibilityLabel={t("settings.languageDetection.removeLabel", {
                        name: name(kind()),
                      })}
                      onPress={() => handleRequestRemove(kind())}
                    >
                      <Icon name="delete" tone="muted-foreground" class="size-3.5" />
                    </Button>

                    <If when={isDetectorOpenable(kind())} else={<View class="size-7 shrink-0" />}>
                      <Button
                        testID={`settings-detection-open-${kind()}`}
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("settings.languageDetection.configureLabel", {
                          name: name(kind()),
                        })}
                        accessibilityLabel={t("settings.languageDetection.configureLabel", {
                          name: name(kind()),
                        })}
                        onPress={() => {
                          props.onClearError();
                          props.onOpenChannel(kind());
                        }}
                      >
                        <Icon name="chevron-right" tone="muted-foreground" class="size-3.5" />
                      </Button>
                    </If>
                  </View>
                </>
              );
            }}
          </Each>
        </Card>
      </If>

      <If when={props.listError !== null}>
        <Text
          testID="settings-detection-list-error"
          role="alert"
          class="px-1 text-sm text-destructive"
        >
          {props.listError}
        </Text>
      </If>

      <LanguagePreferencesCard compact={props.compact} />

      <ConfirmDialog
        testID="settings-detection-remove-dialog"
        open={pendingRemove() !== null}
        title={t("settings.languageDetection.removeTitle")}
        description={
          pendingRemove() !== null
            ? t("settings.languageDetection.removeDescription", {
                name: name(pendingRemove()!),
              })
            : ""
        }
        error={removeError()}
        confirmLabel={t("settings.languageDetection.removeConfirm")}
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

function LanguagePreferencesCard(props: { compact: boolean }) {
  const error = signal<string | null>(null);

  const preferenceValue = (field: keyof LanguageDetectionPreferences): string =>
    languageDetectionStore.preferences()[field] ?? UNSET_LANGUAGE_CHOICE;

  const selectPreference = async (
    field: keyof LanguageDetectionPreferences,
    value: string | null,
  ) => {
    if (value === null) return;
    if (value !== UNSET_LANGUAGE_CHOICE && !isLanguageId(value)) return;
    error.set(null);
    const result = await languageDetectionStore.setPreference(
      field,
      value === UNSET_LANGUAGE_CHOICE ? null : value,
    );
    if (!result.ok) error.set(result.message);
  };

  return (
    <Card
      testID="settings-detection-preferences-card"
      class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}
    >
      <SectionHeading title={t("settings.languageDetection.preferences")} />

      <View class={props.compact ? "gap-4" : "flex-row gap-4"}>
        <FormField
          class={props.compact ? "" : "min-w-0 flex-1"}
          label={t("settings.languageDetection.nativeLanguage")}
          labelTestID="settings-detection-native-language-label"
          tooltip={t("settings.languageDetection.nativeLanguageHelp")}
        >
          <Select
            testID="settings-detection-native-language"
            items={languageItems()}
            value={preferenceValue("nativeLanguage")}
            accessibilityLabel={t("settings.languageDetection.nativeLanguage")}
            onChange={(value) => void selectPreference("nativeLanguage", value)}
          />
        </FormField>
        <FormField
          class={props.compact ? "" : "min-w-0 flex-1"}
          label={t("settings.languageDetection.preferredTranslation")}
          labelTestID="settings-detection-preferred-language-label"
          tooltip={t("settings.languageDetection.preferredTranslationHelp")}
        >
          <Select
            testID="settings-detection-preferred-language"
            items={languageItems()}
            value={preferenceValue("preferredTranslationLanguage")}
            accessibilityLabel={t("settings.languageDetection.preferredTranslation")}
            onChange={(value) => void selectPreference("preferredTranslationLanguage", value)}
          />
        </FormField>
      </View>

      <If when={error() !== null}>
        <Text testID="settings-detection-error" role="alert" class="text-sm text-destructive">
          {error()}
        </Text>
      </If>
    </Card>
  );
}

interface AiChannelDetailProps {
  compact: boolean;
  onManageModels?: () => void;
}

function AiChannelDetail(props: AiChannelDetailProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const draftModelId = signal<string | null>(
    languageDetectionStore.savedAiBinding()?.modelId ?? null,
  );
  const error = signal<string | null>(null);
  const saving = signal(false);

  const modelChoices = () => readAvailableModelChoices();
  const catalogUnusable = () => modelsStore.channelsError() !== null || modelChoices().length === 0;
  const eligibleModelId = () =>
    modelChoices().find((choice) => choice.id === draftModelId())?.id ?? null;
  const binding = () => {
    const modelId = draftModelId();
    return modelId === null ? null : resolveModelBindingInfo(modelId);
  };
  const bindingUnavailable = () => {
    const info = binding();
    return info !== null && !info.available;
  };

  const modelItems = (): SelectItem[] =>
    modelChoices().map((choice) => ({ value: choice.id, title: choice.label }));

  const selectModel = (modelId: string | null) => {
    if (modelId === null || saving()) return;
    error.set(null);
    draftModelId.set(modelId);
  };

  const handleSave = async () => {
    const modelId = eligibleModelId();
    if (saving() || modelId === null) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await languageDetectionStore.saveAiModel(modelId);
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      draftModelId.set(result.binding.modelId);
      toast.success(t("settings.languageDetection.saved"));
    } finally {
      saving.set(false);
    }
  };

  return (
    <View
      // Runtime native entrance motion fades the detector detail view without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <Card
        testID="settings-detection-detail-card"
        class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}
      >
        <View class="flex-row items-center justify-between gap-2">
          <View class="min-w-0 flex-1 flex-row items-center gap-3">
            <DetectionChannelAvatar kind="ai" />
            <SectionHeading title={t("settings.languageDetection.ai")} />
          </View>
          <If when={!catalogUnusable() && bindingUnavailable()}>
            <Button
              testID="settings-detection-manage-models"
              variant="outline"
              size="sm"
              label={t("presets.action.manageModels")}
              disabled={saving()}
              onPress={() => props.onManageModels?.()}
            />
          </If>
        </View>

        <If when={catalogUnusable()}>
          <View
            testID="settings-detection-models-recovery"
            class="gap-2 rounded-xl border border-border bg-surface-subtle p-3"
          >
            <Text
              role="alert"
              class={
                modelsStore.channelsError() !== null
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {modelsStore.channelsError() !== null
                ? t("presets.model.catalogLoadError")
                : t("presets.model.noEligible")}
            </Text>
            <View class="flex-row">
              <Button
                testID="settings-detection-manage-models"
                variant="outline"
                size="sm"
                label={t("presets.action.manageModels")}
                disabled={saving()}
                onPress={() => props.onManageModels?.()}
              />
            </View>
          </View>
        </If>

        <FormField label={t("settings.languageDetection.model")}>
          <Select
            testID="settings-detection-model"
            items={modelItems()}
            value={eligibleModelId()}
            placeholder={t("presets.model.selectPlaceholder")}
            disabled={saving() || modelItems().length === 0}
            accessibilityLabel={t("settings.languageDetection.model")}
            onChange={selectModel}
          />
          <If when={bindingUnavailable()}>
            <Text testID="settings-detection-model-unavailable" class="text-xs text-warning">
              {binding()?.reason}
            </Text>
          </If>
        </FormField>

        <If when={error() !== null}>
          <Text
            testID="settings-detection-detail-error"
            role="alert"
            class="text-sm text-destructive"
          >
            {error()}
          </Text>
        </If>

        <View class="flex-row justify-end">
          <Button
            testID="settings-detection-save"
            variant="primary"
            size="sm"
            label={saving() ? t("common.saving") : t("common.save")}
            disabled={saving() || eligibleModelId() === null}
            onPress={() => void handleSave()}
          />
        </View>
      </Card>
    </View>
  );
}

interface GoogleCloudChannelDetailProps {
  compact: boolean;
  credentialState: CredentialState;
}

/** Settings page for the Google Cloud detector: one stored API key, reused when left blank. */
function GoogleCloudChannelDetail(props: GoogleCloudChannelDetailProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const apiKeyDraft = signal("");
  const error = signal<string | null>(null);
  const saving = signal(false);
  let apiKeyField: InputRef | undefined;
  let mounted = true;

  cleanup(() => {
    mounted = false;
  });

  const canKeepKey = () =>
    languageDetectionStore.savedGoogleCloudBinding() !== null &&
    props.credentialState === "readable";
  const draftKey = () => apiKeyDraft().trim();
  const canSave = () => draftKey().length > 0 || canKeepKey();

  const handleSave = async () => {
    if (saving() || !canSave()) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await languageDetectionStore.saveGoogleCloudKey(
        draftKey().length > 0 ? draftKey() : null,
      );
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      apiKeyDraft.set("");
      if (mounted) apiKeyField?.blur();
      toast.success(t("settings.languageDetection.saved"));
    } finally {
      saving.set(false);
    }
  };

  return (
    <View
      // Runtime native entrance motion fades the detector detail view without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <Card
        testID="settings-detection-detail-card"
        class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}
      >
        <View class="min-w-0 flex-1 flex-row items-center gap-3">
          <DetectionChannelAvatar kind="google-cloud" />
          <SectionHeading title={t("settings.languageDetection.google-cloud")} />
        </View>

        <FormField label={t("settings.languageDetection.apiKey")}>
          <Input
            testID="settings-detection-google-cloud-api-key"
            ref={(node) => {
              apiKeyField = node;
            }}
            value={apiKeyDraft()}
            placeholder={canKeepKey() ? t("settings.languageDetection.savedApiKey") : undefined}
            masked={true}
            disabled={saving()}
            accessibilityLabel={t("settings.languageDetection.apiKey")}
            onChange={(value) => {
              error.set(null);
              apiKeyDraft.set(value);
            }}
          />
        </FormField>

        <If when={props.credentialState === "missing"}>
          <Text
            testID="settings-detection-google-cloud-key-missing"
            role="alert"
            class="text-sm text-destructive"
          >
            {t("settings.languageDetection.googleCloudKeyUnreadable")}
          </Text>
        </If>

        <If when={error() !== null}>
          <Text
            testID="settings-detection-detail-error"
            role="alert"
            class="text-sm text-destructive"
          >
            {error()}
          </Text>
        </If>

        <View class="flex-row justify-end">
          <Button
            testID="settings-detection-save"
            variant="primary"
            size="sm"
            label={saving() ? t("common.saving") : t("common.save")}
            disabled={saving() || !canSave()}
            onPress={() => void handleSave()}
          />
        </View>
      </Card>
    </View>
  );
}

interface LanguageDetectionSectionProps {
  compact: boolean;
  selectedChannel: LanguageDetectorKind | null;
  onSelectChannel: (channel: LanguageDetectorKind) => void;
  onManageModels?: () => void;
  getAddButtonRef?: () => ViewRef | null;
  onRegisterAddTrigger?: (open: () => void) => () => void;
  onAddBusyChange?: (busy: boolean) => void;
  /** Reports whether one of the section's dialogs owns Escape. */
  onDialogOpenChange?: (open: boolean) => void;
}

/** Settings section for prioritized detectors, their configuration pages, and language preferences. */
export function LanguageDetectionSection(props: LanguageDetectionSectionProps) {
  const credentialState = signal<CredentialState>("unknown");
  const addDialogOpen = signal(false);
  const addingChannel = signal(false);
  const listBusy = signal(false);
  const listError = signal<string | null>(null);
  const removeDialogOpen = signal(false);
  const rowRefs: Partial<Record<LanguageDetectorKind, ViewRef>> = {};
  const gripRefs: Partial<Record<LanguageDetectorKind, ViewRef>> = {};
  const fallbackFocusRefs: Partial<Record<LanguageDetectorKind, ViewRef>> = {};
  let pendingDialogCloseFocus: (() => void) | null = null;
  let lastOpenedChannel: LanguageDetectorKind | null = null;
  let restoreFocus = false;

  const focusAddButton = () => focusTarget(props.getAddButtonRef?.() ?? null);

  effect(() => props.onAddBusyChange?.(addingChannel() || listBusy()));
  cleanup(() => props.onAddBusyChange?.(false));

  effect(() => props.onDialogOpenChange?.(addDialogOpen() || removeDialogOpen()));
  cleanup(() => props.onDialogOpenChange?.(false));

  effect(() => {
    const saved = languageDetectionStore.savedGoogleCloudBinding();
    if (saved === null) {
      credentialState.set("unknown");
      return;
    }
    const credentialRef = saved.credentialRef;
    void languageDetectionStore.readGoogleCloudCredential(credentialRef).then((apiKey) => {
      if (languageDetectionStore.savedGoogleCloudBinding()?.credentialRef !== credentialRef) {
        return;
      }
      credentialState.set(apiKey === null ? "missing" : "readable");
    });
  });

  effect(() => {
    const current = props.selectedChannel;
    if (current !== null) {
      lastOpenedChannel = current;
      restoreFocus = true;
      return;
    }
    if (restoreFocus && lastOpenedChannel !== null) {
      restoreFocus = false;
      const channel = lastOpenedChannel;
      queueMicrotask(() => {
        if (props.selectedChannel === null) rowRefs[channel]?.focus();
      });
    }
  });

  const showingDetail = () =>
    props.selectedChannel !== null && isDetectorOpenable(props.selectedChannel);

  const handleOpenAddDialog = () => {
    if (addingChannel() || listBusy() || languageDetectionStore.availableDetectors().length === 0) {
      return;
    }
    listError.set(null);
    pendingDialogCloseFocus = focusAddButton;
    addDialogOpen.set(true);
  };

  const unregisterAddTrigger = props.onRegisterAddTrigger?.(handleOpenAddDialog);
  if (unregisterAddTrigger) cleanup(unregisterAddTrigger);

  const addDetectorKind = async (kind: LanguageDetectorKind): Promise<boolean> => {
    if (addingChannel()) return false;
    listError.set(null);
    addingChannel.set(true);
    try {
      const result = await languageDetectionStore.addDetector(kind);
      if (!result.ok) {
        listError.set(result.message);
        return false;
      }
      return true;
    } finally {
      addingChannel.set(false);
    }
  };

  const handleSelectAddKind = async (kind: LanguageDetectorKind) => {
    if (addingChannel()) return;
    const added = await addDetectorKind(kind);
    addDialogOpen.set(false);
    if (!added) return;
    pendingDialogCloseFocus = isDetectorOpenable(kind)
      ? null
      : () =>
          focusTarget(
            rowRefs[kind] ?? fallbackFocusRefs[kind] ?? props.getAddButtonRef?.() ?? null,
          );
    if (isDetectorOpenable(kind)) {
      props.onSelectChannel(kind);
    }
  };

  /** Adding from the empty state skips the picker and opens the new detector directly. */
  const handleAddAvailableDetector = async (kind: LanguageDetectorKind) => {
    if (addingChannel()) return;
    const added = await addDetectorKind(kind);
    if (!added) return;
    if (isDetectorOpenable(kind)) {
      props.onSelectChannel(kind);
      return;
    }
    queueMicrotask(() =>
      focusTarget(rowRefs[kind] ?? fallbackFocusRefs[kind] ?? props.getAddButtonRef?.() ?? null),
    );
  };

  return (
    <>
      <If
        when={!showingDetail()}
        else={
          <If
            when={props.selectedChannel === "google-cloud"}
            else={<AiChannelDetail compact={props.compact} onManageModels={props.onManageModels} />}
          >
            <GoogleCloudChannelDetail compact={props.compact} credentialState={credentialState()} />
          </If>
        }
      >
        <DetectionChannelList
          compact={props.compact}
          credentialState={credentialState()}
          busy={addingChannel()}
          listError={listError()}
          onClearError={() => listError.set(null)}
          onSetError={(message) => listError.set(message)}
          onBusyChange={(busy) => listBusy.set(busy)}
          onOpenChannel={(kind) => props.onSelectChannel(kind)}
          onFocusAddButton={focusAddButton}
          onRowRef={(kind, node) => {
            if (node) rowRefs[kind] = node;
            else delete rowRefs[kind];
          }}
          onGripRef={(kind, node) => {
            if (node) gripRefs[kind] = node;
            else delete gripRefs[kind];
          }}
          onRowFocusRef={(kind, node) => {
            if (node) fallbackFocusRefs[kind] = node;
            else delete fallbackFocusRefs[kind];
          }}
          onFocusGrip={(kind) => gripRefs[kind]?.focus()}
          onFocusChannelFallback={(kind) =>
            focusTarget(
              rowRefs[kind] ?? fallbackFocusRefs[kind] ?? props.getAddButtonRef?.() ?? null,
            )
          }
          onAddAvailableDetector={(kind) => void handleAddAvailableDetector(kind)}
          onRemoveDialogOpenChange={(open) => removeDialogOpen.set(open)}
        />
      </If>

      <AddDetectionChannelDialog
        open={addDialogOpen()}
        availableKinds={languageDetectionStore.availableDetectors()}
        busy={addingChannel()}
        onOpenChange={(open) => addDialogOpen.set(open)}
        onSelect={(kind) => void handleSelectAddKind(kind)}
        onClose={() => {
          const run = pendingDialogCloseFocus;
          pendingDialogCloseFocus = null;
          run?.();
        }}
      />
    </>
  );
}
