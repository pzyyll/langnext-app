// ABOUTME: One settings host for capability channels: list, add, enable, reorder, detail, save, remove.
// ABOUTME: Capability-specific UI arrives only through the definition's controlled Settings component.
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
  type JSX,
  type KeyEvent,
  type PanEvent,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Avatar, type AvatarSize } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button, KeyboardButton } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { ChannelEmptyState } from "../../components/ui/empty-state";
import { Icon, type IconName } from "../../components/ui/icon";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import type {
  CapabilityChannelDefinition,
  CapabilityId,
  ChannelAudioHost,
  ChannelBinding,
  ChannelCollection,
  ChannelSaveDraft,
  ChannelSettingsHost,
  IntegrationRegistry,
  CredentialInput,
  CredentialRecord,
  ModelBindingStatus,
  ModelChoiceOption,
  ModelPurpose,
} from "../../framework/integrations";
import { CapabilitySectionAddDialog } from "./capability-section-add-dialog";

type ErasedChannelDefinition = CapabilityChannelDefinition<unknown, unknown, unknown>;
type CredentialState = "unknown" | "readable" | "missing";

/** Time a reordered row takes to settle into its new slot. */
const REORDER_SETTLE_MS = 180;

const EMPTY_ICONS: Record<CapabilityId, IconName> = {
  tts: "mdi:tts",
  ocr: "mdi:ocr",
  detect: "mdi:translate",
  dictionary: "mdi:book-open-variant-outline",
};

/** Domain titles and copy the shared host cannot infer from a definition. */
export interface CapabilitySectionLabels {
  titleKey: string;
  addKey: string;
  emptyKey: string;
  priorityHintKey?: string;
}

/** Feature-owned services a definition's Settings or runtime hook can use. */
export interface CapabilitySectionHostServices {
  audio?: ChannelAudioHost;
  modelChoices?: () => readonly ModelChoiceOption[];
  resolveModelBinding?: (modelId: string, purpose: ModelPurpose) => ModelBindingStatus;
  onManageModels?: () => void;
}

export interface CapabilitySectionProps {
  capability: CapabilityId;
  testIdPrefix: string;
  registry: IntegrationRegistry;
  collection: ChannelCollection;
  labels: CapabilitySectionLabels;
  compact: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  extra?: () => JSX.Element;
  notice?: () => JSX.Element | null;
  hostServices?: CapabilitySectionHostServices;
  getAddButtonRef?: () => ViewRef | null;
  onRegisterAddTrigger?: (open: () => void) => () => void;
  onAddBusyChange?: (busy: boolean) => void;
  onDialogOpenChange?: (open: boolean) => void;
}

function focusTarget(node: ViewRef | null | undefined) {
  if (!node) return;
  node.focus();
  setAccessibilityFocus(node);
}

function ChannelAvatar(props: { definition: ErasedChannelDefinition; size?: AvatarSize }) {
  return (
    <Avatar
      size={props.size ?? "md"}
      accessibilityLabel=""
      fallback={
        <Image
          src={props.definition.icon}
          accessibilityElementsHidden={true}
          class="size-4 overflow-hidden"
        />
      }
    />
  );
}

function ChannelIdentity(props: {
  testIdPrefix: string;
  channelId: string;
  definition: ErasedChannelDefinition;
  name: string;
  role: "primary" | "backup" | null;
  summary: { text: string; toneClass: string };
}) {
  return (
    <>
      <ChannelAvatar definition={props.definition} />
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text class="min-w-0 shrink truncate text-sm font-medium text-card-foreground">
            {props.name}
          </Text>
          <If when={props.role !== null}>
            <Badge
              testID={`${props.testIdPrefix}-role-${props.channelId}`}
              label={t(`settings.capabilities.role.${props.role!}`)}
              tone={props.role === "primary" ? "primary" : "neutral"}
            />
          </If>
        </View>
        <Text
          testID={`${props.testIdPrefix}-summary-${props.channelId}`}
          class={`min-w-0 truncate text-xs ${props.summary.toneClass}`}
        >
          {props.summary.text}
        </Text>
      </View>
    </>
  );
}

function asConfig(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

interface CapabilityListProps {
  testIdPrefix: string;
  compact: boolean;
  collection: ChannelCollection;
  definitions: ReadonlyMap<string, ErasedChannelDefinition>;
  describeChannel: (id: string) => string;
  credentialStates: Record<string, CredentialState>;
  busy: boolean;
  listError: string | null;
  icon: IconName;
  emptyTitleKey: string;
  priorityHintKey?: string;
  extra?: () => JSX.Element;
  notice?: () => JSX.Element | null;
  onClearError: () => void;
  onSetError: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenChannel: (id: string) => void;
  onAddAvailableChannel: (id: string) => void;
  onFocusAddButton: () => void;
  /** Channel whose Remove control takes focus after an add; null when none is pending. */
  focusRemoveId: () => string | null;
  onFocusRemoveConsumed: () => void;
  onRowRef: (id: string, node: ViewRef | null) => void;
  onGripRef: (id: string, node: ViewRef | null) => void;
  onRowFocusRef: (id: string, node: ViewRef | null) => void;
  onFocusGrip: (id: string) => void;
  onFocusChannelFallback: (id: string) => void;
  onRemoveDialogOpenChange: (open: boolean) => void;
}

function CapabilityList(props: CapabilityListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const dragging = signal<string | null>(null);
  const animating = signal(false);
  const pendingRemove = signal<string | null>(null);
  const removeError = signal<string | null>(null);
  const offsets = new Map<string, AnimatedValue>();
  const rowSlots: Record<string, { top: number; height: number }> = {};
  const removeRefs: Record<string, ViewRef> = {};
  let removeCancelNode: ViewRef | null = null;
  let pendingRemoveCloseFocus: (() => void) | null = null;

  effect(() => props.onBusyChange(mutating() || animating()));
  cleanup(() => props.onBusyChange(false));
  effect(() => props.onRemoveDialogOpenChange(pendingRemove() !== null));
  cleanup(() => props.onRemoveDialogOpenChange(false));

  // A static channel has no pressable row, so its Remove control takes focus after an add.
  effect(() => {
    const target = props.focusRemoveId();
    const rows = order();
    if (target === null || !rows.includes(target)) return;
    queueMicrotask(() => {
      const node = removeRefs[target];
      if (node === undefined) return;
      focusTarget(node);
      props.onFocusRemoveConsumed();
    });
  });

  const order = () => props.collection.order();
  const name = (id: string) => t(props.definitions.get(id)?.labelKey ?? id);
  const enabledOrder = () => order().filter((id) => props.collection.isEnabled(id));
  const canReorder = () => order().length > 1;
  const isBusy = () => props.busy || mutating() || animating();

  const offset = (id: string): AnimatedValue => {
    let value = offsets.get(id);
    if (value === undefined) {
      value = createAnimatedValue(0);
      offsets.set(id, value);
    }
    return value;
  };

  const channelRole = (id: string): "primary" | "backup" | null => {
    const position = enabledOrder().indexOf(id);
    if (position === -1) return null;
    return position === 0 ? "primary" : "backup";
  };

  const channelSummary = (id: string): { text: string; toneClass: string } => {
    const binding = props.collection.binding(id);
    if (binding === null || !binding.configured) {
      return { text: t("settings.capabilities.notConfigured"), toneClass: "text-muted-foreground" };
    }
    if (props.credentialStates[id] === "missing") {
      return {
        text: t("settings.capabilities.error.credentialUnreadable"),
        toneClass: "text-destructive",
      };
    }
    const described = props.describeChannel(id);
    return {
      text: described.length > 0 ? described : t("settings.capabilities.configured"),
      toneClass: "text-muted-foreground",
    };
  };

  const handleToggle = async (id: string, nextEnabled: boolean) => {
    if (isBusy()) return;
    props.onClearError();
    mutating.set(true);
    try {
      const result = await props.collection.setEnabled(id, nextEnabled);
      if (!result.ok) props.onSetError(result.message);
    } finally {
      mutating.set(false);
    }
  };

  const nextFocusTargetAfterRemove = (previousOrder: readonly string[], removed: string) => {
    const index = previousOrder.indexOf(removed);
    const remaining = previousOrder.filter((item) => item !== removed);
    if (remaining.length === 0) return props.onFocusAddButton;
    const target = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]!;
    return () => props.onFocusChannelFallback(target);
  };

  const performRemove = async (id: string, fromConfirmDialog: boolean): Promise<boolean> => {
    if (isBusy()) return false;
    const previousOrder = order();
    props.onClearError();
    removeError.set(null);
    mutating.set(true);
    try {
      const result = await props.collection.remove(id);
      if (!result.ok) {
        if (fromConfirmDialog) removeError.set(result.message);
        else props.onSetError(result.message);
        return false;
      }
      const nextFocus = nextFocusTargetAfterRemove(previousOrder, id);
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

  const handleRequestRemove = (id: string) => {
    if (isBusy()) return;
    props.onClearError();
    removeError.set(null);
    if (props.collection.binding(id)?.configured === true) {
      pendingRemoveCloseFocus = () => focusTarget(removeRefs[id]);
      pendingRemove.set(id);
      return;
    }
    void performRemove(id, false);
  };

  const animateOffset = (id: string, to: number): Promise<unknown> => {
    if (reduceMotion()) {
      offset(id).set(to);
      return Promise.resolve();
    }
    return offset(id).timing(to, { duration: REORDER_SETTLE_MS, easing: "easeOut" });
  };

  const resetOffsets = () => {
    for (const id of order()) offset(id).set(0);
  };

  const handleDragStart = (id: string) => {
    if (isBusy() || !canReorder() || dragging() !== null) return;
    props.onClearError();
    dragging.set(id);
  };

  const nearestChannel = (id: string, offsetY: number): number | null => {
    const slot = rowSlots[id];
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

  const settleIntoSlots = async (id: string, target: number) => {
    const list = order();
    const nextOrder = [...list];
    nextOrder.splice(list.indexOf(id), 1);
    nextOrder.splice(target, 0, id);
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

  const handleDragEnd = async (id: string, event: PanEvent) => {
    if (dragging() !== id) {
      await animateOffset(id, 0);
      return;
    }
    animating.set(true);
    try {
      const index = order().indexOf(id);
      const target = nearestChannel(id, event.value?.y ?? event.translation.y);
      if (event.cancelled || index === -1 || target === null || target === index) {
        await animateOffset(id, 0);
        return;
      }
      const nextOrder = await settleIntoSlots(id, target);
      const result = await props.collection.moveTo(id, target);
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

  const handleMoveBy = async (id: string, delta: number, refocus: boolean) => {
    if (isBusy() || !canReorder() || dragging() !== null) return;
    const list = order();
    const index = list.indexOf(id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return;
    props.onClearError();
    mutating.set(true);
    try {
      const result = await props.collection.moveTo(id, target);
      if (!result.ok) {
        props.onSetError(result.message);
        return;
      }
      if (refocus) queueMicrotask(() => props.onFocusGrip(id));
    } finally {
      mutating.set(false);
    }
  };

  const handleGripKey = (id: string, event: KeyEvent) => {
    if (event.key === "ArrowUp") void handleMoveBy(id, -1, true);
    else if (event.key === "ArrowDown") void handleMoveBy(id, 1, true);
  };

  const handleAccessibilityMove = (id: string, actionName: string) => {
    if (actionName === "moveUp") void handleMoveBy(id, -1, false);
    else if (actionName === "moveDown") void handleMoveBy(id, 1, false);
  };

  const available = () => {
    // A failed load leaves the stored record untouched; never offer an action that would overwrite it.
    if (props.collection.loadError() !== null) return [];
    return props.collection
      .available()
      .map((id) => props.definitions.get(id))
      .filter((definition): definition is ErasedChannelDefinition => definition !== undefined);
  };

  return (
    <View
      // Runtime native entrance motion fades the channel list without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <If when={props.collection.loadError() !== null}>
        <Text
          testID={`${props.testIdPrefix}-load-error`}
          role="alert"
          class="text-sm text-destructive"
        >
          {props.collection.loadError()!.message}
        </Text>
      </If>

      <If when={props.collection.skippedCount() > 0}>
        <Text testID={`${props.testIdPrefix}-skipped`} class="text-xs text-muted-foreground">
          {props.collection.skippedCount() === 1
            ? t("settings.capabilities.skippedOne")
            : t("settings.capabilities.skipped", { count: props.collection.skippedCount() })}
        </Text>
      </If>

      <If
        when={order().length > 0}
        else={
          <ChannelEmptyState
            testID={`${props.testIdPrefix}-empty`}
            icon={props.icon}
            title={t(props.emptyTitleKey)}
            choicesLabel={t("settings.capabilities.emptyChannels")}
            busy={props.busy}
            compact={props.compact}
            choices={available().map((definition) => ({
              id: definition.id,
              label: t(definition.labelKey),
              accessibilityLabel: t("settings.capabilities.emptyAdd", {
                name: t(definition.labelKey),
              }),
              testID: `${props.testIdPrefix}-empty-channel-${definition.id}`,
              leading: <ChannelAvatar definition={definition} size="sm" />,
              onPress: () => props.onAddAvailableChannel(definition.id),
            }))}
          />
        }
      >
        <Card
          testID={`${props.testIdPrefix}-card`}
          class={props.compact ? "gap-1 p-2" : "gap-1 p-3"}
        >
          <Each of={order()} key={(id) => id}>
            {(channelId, index) => {
              const id = () => channelId();
              const nameOf = () => name(id());
              cleanup(() => {
                delete rowSlots[id()];
                delete removeRefs[id()];
                offsets.delete(id());
                props.onRowRef(id(), null);
                props.onGripRef(id(), null);
                props.onRowFocusRef(id(), null);
              });
              const configured = () => props.collection.binding(id())?.configured === true;
              const configurable = () => props.definitions.get(id())?.configurable === true;
              const enabled = () => props.collection.isEnabled(id());
              const role = () => channelRole(id());
              const summary = () => channelSummary(id());
              const rowLabel = () =>
                t("settings.capabilities.itemLabel", {
                  name: nameOf(),
                  status:
                    role() !== null
                      ? t(`settings.capabilities.role.${role()!}`)
                      : configured()
                        ? t("models.filter.disabled")
                        : t("settings.capabilities.notConfigured"),
                });

              return (
                <>
                  <If when={index() > 0}>
                    <View class="mx-2 my-1 h-px bg-border" />
                  </If>
                  <View
                    testID={`${props.testIdPrefix}-row-${id()}`}
                    pan={isBusy() || !canReorder() ? undefined : { y: offset(id()) }}
                    onPanStart={() => handleDragStart(id())}
                    onPanEnd={(event) => void handleDragEnd(id(), event)}
                    onLayout={(event) => {
                      rowSlots[id()] = {
                        top: event.bounds.origin.y,
                        height: event.bounds.size.height,
                      };
                    }}
                    style={{ translate: [0, offset(id())] }}
                    class={`group flex-row items-center gap-1.5 rounded-xl pr-2 ${motion.navigationFeedback} ${
                      dragging() === id()
                        ? "z-10 cursor-grabbing bg-card shadow-md"
                        : "hover:bg-accent/60 active:bg-accent"
                    }`}
                  >
                    <If
                      when={configurable()}
                      else={
                        <View class="min-w-0 flex-1 flex-row items-center gap-2.5 rounded-xl py-2.5 pl-3 pr-2">
                          <If when={props.definitions.get(id())}>
                            {(definition) => (
                              <ChannelIdentity
                                testIdPrefix={props.testIdPrefix}
                                channelId={id()}
                                definition={definition()}
                                name={nameOf()}
                                role={role()}
                                summary={summary()}
                              />
                            )}
                          </If>
                        </View>
                      }
                    >
                      <Button
                        testID={`${props.testIdPrefix}-channel-${id()}`}
                        ref={(node) => props.onRowRef(id(), node)}
                        variant="ghost"
                        size="row"
                        accessibilityLabel={rowLabel()}
                        onPress={() => {
                          props.onClearError();
                          props.onOpenChannel(id());
                        }}
                        class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
                      >
                        <If when={props.definitions.get(id())}>
                          {(definition) => (
                            <ChannelIdentity
                              testIdPrefix={props.testIdPrefix}
                              channelId={id()}
                              definition={definition()}
                              name={nameOf()}
                              role={role()}
                              summary={summary()}
                            />
                          )}
                        </If>
                      </Button>
                    </If>

                    <If when={canReorder()}>
                      <KeyboardButton
                        testID={`${props.testIdPrefix}-grip-${id()}`}
                        variant="ghost"
                        size="icon-sm"
                        focusable={true}
                        tooltip={t("settings.capabilities.reorder", { name: nameOf() })}
                        accessibilityLabel={t("settings.capabilities.reorder", { name: nameOf() })}
                        accessibilityHint={t("settings.capabilities.reorderHint")}
                        accessibilityActions={[
                          {
                            name: "moveUp",
                            label: t("settings.capabilities.moveUp", { name: nameOf() }),
                          },
                          {
                            name: "moveDown",
                            label: t("settings.capabilities.moveDown", { name: nameOf() }),
                          },
                        ]}
                        onAccessibilityAction={(event) =>
                          handleAccessibilityMove(id(), event.actionName)
                        }
                        onPress={() => props.onFocusGrip(id())}
                        captureKeys={["arrowup", "arrowdown"]}
                        onKeyDown={(event) => handleGripKey(id(), event)}
                        ref={(node) => props.onGripRef(id(), node)}
                        class={`shrink-0 cursor-grab ${motion.tooltip} ${
                          dragging() === id()
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        }`}
                      >
                        <Icon name="grip-vertical" tone="muted-foreground" class="size-4" />
                      </KeyboardButton>
                    </If>

                    <Switch
                      testID={`${props.testIdPrefix}-toggle-${id()}`}
                      variant="inline"
                      checked={enabled()}
                      disabled={mutating() || props.busy || !configured()}
                      accessibilityLabel={t("settings.capabilities.enableLabel", {
                        name: nameOf(),
                      })}
                      tooltip={
                        !configured() ? t("settings.capabilities.configureBeforeEnable") : undefined
                      }
                      onChange={(checked) => void handleToggle(id(), checked)}
                    />

                    <Button
                      testID={`${props.testIdPrefix}-remove-${id()}`}
                      ref={(node) => {
                        removeRefs[id()] = node;
                        props.onRowFocusRef(id(), node);
                      }}
                      variant="destructive-ghost"
                      size="icon-sm"
                      disabled={isBusy()}
                      tooltip={t("settings.capabilities.removeLabel", { name: nameOf() })}
                      accessibilityLabel={t("settings.capabilities.removeLabel", {
                        name: nameOf(),
                      })}
                      onPress={() => handleRequestRemove(id())}
                    >
                      <Icon name="delete" tone="muted-foreground" class="size-3.5" />
                    </Button>

                    <If when={configurable()}>
                      <Button
                        testID={`${props.testIdPrefix}-open-${id()}`}
                        variant="ghost"
                        size="icon-sm"
                        tooltip={t("settings.capabilities.configureLabel", { name: nameOf() })}
                        accessibilityLabel={t("settings.capabilities.configureLabel", {
                          name: nameOf(),
                        })}
                        onPress={() => {
                          props.onClearError();
                          props.onOpenChannel(id());
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

      <If when={props.notice !== undefined}>{props.notice?.()}</If>

      <If when={props.extra !== undefined}>{props.extra?.()}</If>

      <If when={props.listError !== null}>
        <Text
          testID={`${props.testIdPrefix}-list-error`}
          role="alert"
          class="px-1 text-sm text-destructive"
        >
          {props.listError}
        </Text>
      </If>

      <ConfirmDialog
        testID={`${props.testIdPrefix}-remove-dialog`}
        open={pendingRemove() !== null}
        title={t("settings.capabilities.removeTitle")}
        description={
          pendingRemove() !== null
            ? t("settings.capabilities.removeDescription", { name: name(pendingRemove()!) })
            : ""
        }
        error={removeError()}
        confirmLabel={t("settings.capabilities.removeConfirm")}
        confirmVariant="destructive"
        busy={mutating()}
        confirmTestID={`${props.testIdPrefix}-remove-confirm`}
        cancelTestID={`${props.testIdPrefix}-remove-cancel`}
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

interface CapabilityDetailProps {
  channelId: string;
  definition: ErasedChannelDefinition;
  collection: ChannelCollection;
  testIdPrefix: string;
  compact: boolean;
  hostServices: CapabilitySectionHostServices;
  onDialogOpenChange: (open: boolean) => void;
}

function CapabilityDetail(props: CapabilityDetailProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const initial = props.collection.binding(props.channelId);
  const configDraft = signal<unknown>(initial?.config ?? props.definition.config.defaults());
  const credentialDraft = signal<CredentialRecord>({});
  const credentialAction = signal<"keep" | "clear">("keep");
  const credentialState = signal<CredentialState>("unknown");
  const previewBusy = signal(false);
  const error = signal<string | null>(null);
  const saving = signal(false);
  let mounted = true;
  cleanup(() => {
    mounted = false;
    previewBusy.set(false);
  });

  const binding = () => props.collection.binding(props.channelId);
  const savedCredential = () => (binding()?.credentialRef ?? null) !== null;
  const credentialReadable = () => credentialState() === "readable";

  effect(() => {
    const ref = binding()?.credentialRef ?? null;
    if (ref === null) {
      credentialState.set("unknown");
      return;
    }
    void props.collection.readCredential(ref).then((record) => {
      if (!mounted) return;
      if ((props.collection.binding(props.channelId)?.credentialRef ?? null) !== ref) return;
      credentialState.set(record === null ? "missing" : "readable");
    });
  });

  const validate = () => {
    if (!props.definition.validate) return { ok: true as const };
    return props.definition.validate({
      config: configDraft() as never,
      credentialDraft: credentialDraft(),
      savedCredential: savedCredential(),
    });
  };

  const saveDraftValues = (): ChannelSaveDraft<unknown> => ({
    config: configDraft(),
    credentialDraft: credentialDraft(),
    savedBinding: savedBinding(),
    credentialReadable: credentialReadable(),
    resolveModelBinding: props.hostServices.resolveModelBinding,
  });

  const saveAvailable = () => props.definition.saveAvailable?.(saveDraftValues()) ?? true;

  const save = async () => {
    if (saving() || previewBusy() || !saveAvailable()) return;
    const checked = validate();
    if (!checked.ok) {
      error.set(t(checked.key));
      return;
    }
    error.set(null);
    saving.set(true);
    const draft = credentialDraft();
    const hasDraft = Object.values(draft).some((value) => value.trim().length > 0);
    const credential: CredentialInput =
      credentialAction() === "clear"
        ? { mode: "clear" }
        : hasDraft
          ? { mode: "replace", value: draft }
          : { mode: "keep" };
    const result = await props.collection.save(props.channelId, configDraft(), credential);
    if (!mounted) return;
    saving.set(false);
    if (!result.ok) {
      error.set(result.message);
      return;
    }
    credentialDraft.set({});
    credentialAction.set("keep");
    configDraft.set(props.collection.binding(props.channelId)?.config ?? configDraft());
    toast.success(t("settings.capabilities.saved"));
  };

  const savedBinding = (): ChannelBinding<unknown> => {
    const current = binding();
    if (current !== null) return current;
    return {
      enabled: false,
      configured: false,
      config: props.definition.config.defaults(),
      credentialRef: null,
    };
  };

  const draftBinding = (): ChannelBinding<unknown> => ({
    enabled: binding()?.enabled ?? false,
    configured: binding()?.configured ?? false,
    config: configDraft(),
    credentialRef: binding()?.credentialRef ?? null,
  });

  const settingsHost = (): ChannelSettingsHost => ({
    ...props.hostServices,
    onDialogOpenChange: props.onDialogOpenChange,
    onPreviewBusyChange: (busy) => previewBusy.set(busy),
    readSavedCredential: () => props.collection.readCredential(binding()?.credentialRef ?? null),
  });

  const changeConfig = (patch: Partial<unknown>) => {
    configDraft.set({ ...asConfig(configDraft()), ...asConfig(patch) });
    error.set(null);
  };

  const changeCredential = (field: string, value: string) => {
    credentialDraft.set({ ...credentialDraft(), [field]: value });
    credentialAction.set("keep");
    error.set(null);
  };

  const clearCredential = () => {
    credentialDraft.set({});
    credentialAction.set("clear");
    error.set(null);
  };

  return (
    <View
      // Runtime native entrance motion fades the channel detail without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <Card
        testID={`${props.testIdPrefix}-detail-card`}
        class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}
      >
        <View class="min-w-0 flex-row items-center gap-3">
          <ChannelAvatar definition={props.definition} />
          <SectionHeading title={t(props.definition.labelKey)} />
        </View>

        <If when={credentialState() === "missing"}>
          <Text
            testID={`${props.testIdPrefix}-key-missing`}
            role="alert"
            class="text-sm text-destructive"
          >
            {t(
              props.definition.credentialUnreadableKey ??
                "settings.capabilities.error.credentialUnreadable",
            )}
          </Text>
        </If>

        <If when={props.definition.Settings !== undefined}>
          {() => {
            const Settings = props.definition.Settings!;
            // NSH snapshots spread props; pass each attribute so the controlled
            // binding and credential draft stay live while the user edits.
            return (
              <Settings
                binding={draftBinding()}
                savedBinding={savedBinding()}
                compact={props.compact}
                disabled={saving() || previewBusy()}
                savedCredential={savedCredential()}
                credentialState={credentialState()}
                credentialDraft={credentialDraft()}
                host={settingsHost()}
                onChange={changeConfig}
                onCredentialChange={changeCredential}
                onClearCredential={clearCredential}
              />
            );
          }}
        </If>

        <If when={props.definition.credential !== null}>
          <Text testID={`${props.testIdPrefix}-plaintext`} class="text-xs text-muted-foreground">
            {t("settings.capabilities.plaintextCredential")}
          </Text>
        </If>

        <If when={error() !== null}>
          <Text
            testID={`${props.testIdPrefix}-error`}
            role="alert"
            class="text-sm text-destructive"
          >
            {error()}
          </Text>
        </If>

        <View class="flex-row justify-end gap-2">
          <Button
            testID={`${props.testIdPrefix}-save`}
            variant="primary"
            size="sm"
            label={saving() ? t("common.saving") : t("common.save")}
            disabled={saving() || previewBusy() || !saveAvailable()}
            onPress={() => void save()}
          />
        </View>
      </Card>
    </View>
  );
}

/** One capability's settings section: priority list or one channel's detail. */
export function CapabilitySection(props: CapabilitySectionProps) {
  const credentialStates = signal<Record<string, CredentialState>>({});
  const addDialogOpen = signal(false);
  const adding = signal(false);
  const listBusy = signal(false);
  const focusRemoveAfterAdd = signal<string | null>(null);
  const listError = signal<string | null>(null);
  const removeDialogOpen = signal(false);
  const detailDialogOpen = signal(false);
  const rowRefs: Record<string, ViewRef> = {};
  const gripRefs: Record<string, ViewRef> = {};
  const fallbackFocusRefs: Record<string, ViewRef> = {};
  let pendingDialogCloseFocus: (() => void) | null = null;
  let returnChannel: string | null = null;
  let restoreFocusOnList = false;

  const selected = () => props.selected;
  const definitions = () =>
    new Map(props.registry.capabilities(props.capability).map((entry) => [entry.id, entry]));

  const focusAddButton = () => focusTarget(props.getAddButtonRef?.() ?? null);

  effect(() => props.onAddBusyChange?.(adding() || listBusy()));
  cleanup(() => props.onAddBusyChange?.(false));

  effect(() =>
    props.onDialogOpenChange?.(addDialogOpen() || removeDialogOpen() || detailDialogOpen()),
  );
  cleanup(() => props.onDialogOpenChange?.(false));

  effect(() => {
    for (const id of props.collection.order()) {
      const ref = props.collection.binding(id)?.credentialRef ?? null;
      if (ref === null) {
        if (credentialStates()[id] !== "unknown") {
          credentialStates.set({ ...credentialStates(), [id]: "unknown" });
        }
        continue;
      }
      void props.collection.readCredential(ref).then((record) => {
        if ((props.collection.binding(id)?.credentialRef ?? null) !== ref) return;
        const next: CredentialState = record === null ? "missing" : "readable";
        if (credentialStates()[id] === next) return;
        credentialStates.set({ ...credentialStates(), [id]: next });
      });
    }
  });

  effect(() => {
    const current = selected();
    if (current !== null) {
      returnChannel = current;
      restoreFocusOnList = true;
      return;
    }
    if (!restoreFocusOnList) return;
    restoreFocusOnList = false;
    const channel = returnChannel;
    queueMicrotask(() => {
      if (selected() === null && channel !== null) rowRefs[channel]?.focus();
    });
  });

  const handleOpenAddDialog = () => {
    if (
      adding() ||
      listBusy() ||
      props.collection.loadError() !== null ||
      props.collection.available().length === 0
    ) {
      return;
    }
    listError.set(null);
    pendingDialogCloseFocus = focusAddButton;
    addDialogOpen.set(true);
  };

  const unregisterAddTrigger = props.onRegisterAddTrigger?.(handleOpenAddDialog);
  if (unregisterAddTrigger) cleanup(unregisterAddTrigger);

  const addChannel = async (id: string): Promise<boolean> => {
    if (adding() || props.collection.loadError() !== null) return false;
    listError.set(null);
    adding.set(true);
    try {
      const result = await props.collection.add(id);
      if (!result.ok) {
        listError.set(result.message);
        return false;
      }
      return true;
    } finally {
      adding.set(false);
    }
  };

  const openAfterAdd = (id: string) => {
    if (definitions().get(id)?.configurable === true) {
      props.onSelect(id);
      return;
    }
    focusRemoveAfterAdd.set(id);
  };

  const handleSelectAddKind = async (id: string) => {
    if (adding()) return;
    const added = await addChannel(id);
    addDialogOpen.set(false);
    if (!added) return;
    pendingDialogCloseFocus = null;
    openAfterAdd(id);
  };

  const handleAddAvailableChannel = async (id: string) => {
    if (adding()) return;
    const added = await addChannel(id);
    if (!added) return;
    openAfterAdd(id);
  };

  const availableDefinitions = () => {
    if (props.collection.loadError() !== null) return [];
    const map = definitions();
    return props.collection
      .available()
      .map((id) => map.get(id))
      .filter((definition): definition is ErasedChannelDefinition => definition !== undefined);
  };

  /** Summaries may resolve a saved model to its display label through host services. */
  const describeChannel = (id: string): string => {
    const definition = definitions().get(id);
    const binding = props.collection.binding(id);
    if (definition === undefined || binding === null) return "";
    return definition.describe(binding, {
      resolveModelBinding: props.hostServices?.resolveModelBinding,
    });
  };

  const selectedDefinition = () => {
    const id = selected();
    if (id === null) return null;
    return definitions().get(id) ?? null;
  };

  /** Only a configurable channel with a saved binding gets a detail pane. */
  const selectedDetail = () => {
    const definition = selectedDefinition();
    const id = selected();
    if (definition === null || !definition.configurable || id === null) return null;
    return props.collection.binding(id) === null ? null : definition;
  };

  return (
    <>
      <If when={selectedDetail() === null}>
        <CapabilityList
          testIdPrefix={props.testIdPrefix}
          compact={props.compact}
          collection={props.collection}
          definitions={definitions()}
          describeChannel={describeChannel}
          credentialStates={credentialStates()}
          busy={adding()}
          listError={listError()}
          icon={EMPTY_ICONS[props.capability]}
          emptyTitleKey={props.labels.emptyKey}
          priorityHintKey={props.labels.priorityHintKey}
          extra={props.extra}
          notice={props.notice}
          onClearError={() => listError.set(null)}
          onSetError={(message) => listError.set(message)}
          onBusyChange={(busy) => listBusy.set(busy)}
          onOpenChannel={(id) => props.onSelect(id)}
          onAddAvailableChannel={(id) => void handleAddAvailableChannel(id)}
          onFocusAddButton={focusAddButton}
          focusRemoveId={() => focusRemoveAfterAdd()}
          onFocusRemoveConsumed={() => focusRemoveAfterAdd.set(null)}
          onRowRef={(id, node) => {
            if (node) rowRefs[id] = node;
            else delete rowRefs[id];
          }}
          onGripRef={(id, node) => {
            if (node) gripRefs[id] = node;
            else delete gripRefs[id];
          }}
          onRowFocusRef={(id, node) => {
            if (node) fallbackFocusRefs[id] = node;
            else delete fallbackFocusRefs[id];
          }}
          onFocusGrip={(id) => gripRefs[id]?.focus()}
          onFocusChannelFallback={(id) =>
            focusTarget(rowRefs[id] ?? fallbackFocusRefs[id] ?? props.getAddButtonRef?.() ?? null)
          }
          onRemoveDialogOpenChange={(open) => removeDialogOpen.set(open)}
        />
      </If>

      <CapabilitySectionAddDialog
        testIdPrefix={props.testIdPrefix}
        open={addDialogOpen()}
        available={availableDefinitions()}
        busy={adding()}
        onOpenChange={(open) => addDialogOpen.set(open)}
        onSelect={(id) => void handleSelectAddKind(id)}
        onClose={() => {
          const run = pendingDialogCloseFocus;
          pendingDialogCloseFocus = null;
          run?.();
        }}
      />

      <If when={selectedDetail()}>
        {(definition) =>
          selected() !== null && props.collection.binding(selected()!) !== null ? (
            <CapabilityDetail
              channelId={selected()!}
              definition={definition()}
              collection={props.collection}
              testIdPrefix={props.testIdPrefix}
              compact={props.compact}
              hostServices={props.hostServices ?? {}}
              onDialogOpenChange={(open) => detailDialogOpen.set(open)}
            />
          ) : null
        }
      </If>
    </>
  );
}
