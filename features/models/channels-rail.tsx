import {
  createAnimatedValue,
  reduceMotion,
  Scroll,
  signal,
  Text,
  View,
  type AnimatedValue,
  type KeyEvent,
  type PanEvent,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Badge } from "../../components/ui/badge";
import { Button, KeyboardButton } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { getProviderTypeLabel } from "../../modules/ai/ui/labels";
import { ProviderMark } from "../../modules/ai/ui/provider-mark";
import { providerSettingsRegistry } from "../../modules/ai/ui/registry";
import type { ProviderChannel } from "../../modules/ai/contracts/channel";

interface ChannelsRailProps {
  channels: ProviderChannel[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onMoveTo: (id: string, targetIndex: number) => Promise<void>;
  onAdd: () => void;
  onRetry: () => void;
  addButtonRef?: (node: ViewRef) => void;
  onChannelItemRef?: (id: string, node: ViewRef) => void;
}

/** Time a reordered row takes to settle into its new slot. */
const REORDER_SETTLE_MS = 180;

/** Left master list of configured provider channels with selection and drag reordering. */
export function ChannelsRail(props: ChannelsRailProps) {
  const providerLabel = (presetId: string) => getProviderTypeLabel(presetId) ?? presetId;
  const providerPresentation = (presetId: string) => providerSettingsRegistry.find(presetId);

  const mutating = signal(false);
  const animating = signal(false);
  const dragging = signal<string | null>(null);
  const listError = signal<string | null>(null);
  // Per-channel drag offsets drive the rows natively; they return to 0 at rest.
  const offsets = new Map<string, AnimatedValue>();
  const rowSlots = new Map<string, { top: number; height: number }>();
  const gripNodes = new Map<string, ViewRef>();

  const order = () => props.channels.map((channel) => channel.id);

  const offsetOf = (id: string): AnimatedValue => {
    const existing = offsets.get(id);
    if (existing !== undefined) return existing;
    const created = createAnimatedValue(0);
    offsets.set(id, created);
    return created;
  };

  const animateOffset = (id: string, to: number): Promise<unknown> => {
    if (reduceMotion()) {
      offsetOf(id).set(to);
      return Promise.resolve();
    }
    return offsetOf(id).timing(to, { duration: REORDER_SETTLE_MS, easing: "easeOut" });
  };

  const resetOffsets = () => {
    for (const offset of offsets.values()) offset.set(0);
  };

  const reportMoveError = (error: unknown) => {
    listError.set(error instanceof Error ? error.message : t("models.channels.reorderFailed"));
  };

  const handleDragStart = (id: string) => {
    if (mutating() || animating() || dragging() !== null) return;
    listError.set(null);
    dragging.set(id);
  };

  /** The channel whose measured slot center is nearest the dragged row's center. */
  const nearestSlot = (id: string, offsetY: number): number | null => {
    const slot = rowSlots.get(id);
    if (slot === undefined) return null;
    const center = slot.top + slot.height / 2 + offsetY;
    let target: number | null = null;
    let nearest = Number.POSITIVE_INFINITY;
    order().forEach((other, position) => {
      const otherSlot = rowSlots.get(other);
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
  const settleIntoSlots = async (id: string, target: number) => {
    const list = order();
    const nextOrder = [...list];
    nextOrder.splice(list.indexOf(id), 1);
    nextOrder.splice(target, 0, id);
    const moves: Promise<unknown>[] = [];
    nextOrder.forEach((row, position) => {
      const from = rowSlots.get(row);
      const to = rowSlots.get(list[position]!);
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
      const target = nearestSlot(id, event.value?.y ?? event.translation.y);
      if (event.cancelled || index === -1 || target === null || target === index) {
        await animateOffset(id, 0);
        return;
      }
      const nextOrder = await settleIntoSlots(id, target);
      try {
        await props.onMoveTo(id, target);
      } catch (error) {
        await Promise.all(nextOrder.map((row) => animateOffset(row, 0)));
        reportMoveError(error);
        return;
      }
      resetOffsets();
    } finally {
      dragging.set(null);
      animating.set(false);
    }
  };

  const handleMoveBy = async (id: string, delta: number, refocus: boolean) => {
    if (mutating() || animating() || dragging() !== null) return;
    const list = order();
    const index = list.indexOf(id);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return;
    listError.set(null);
    mutating.set(true);
    try {
      await props.onMoveTo(id, target);
      if (refocus) queueMicrotask(() => gripNodes.get(id)?.focus());
    } catch (error) {
      reportMoveError(error);
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

  return (
    <View testID="channels-rail" class="min-w-0 flex-1 bg-surface-rail">
      <View class="h-14 shrink-0 flex-row items-center justify-between gap-2 px-4">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Text role="header" class="min-w-0 truncate text-sm font-semibold text-foreground">
            {t("models.channels.title")}
          </Text>
          <If when={props.channels.length > 0}>
            <Badge label={String(props.channels.length)} tone="neutral" pill />
          </If>
        </View>
        <Button
          testID="add-channel-button"
          ref={(node) => props.addButtonRef?.(node)}
          variant="primary"
          size="icon-sm"
          tooltip={t("models.channel.add")}
          accessibilityLabel={t("models.channel.add")}
          onPress={() => props.onAdd()}
        >
          <Icon name="plus" tone="primary-foreground" class="size-4" />
        </Button>
      </View>

      <Scroll class="min-h-0 flex-1">
        <If
          when={props.loading && props.channels.length === 0}
          else={
            <If
              when={Boolean(props.error) && props.channels.length === 0}
              else={
                <If
                  when={props.channels.length > 0}
                  else={
                    <View class="px-4 pb-4 pt-1">
                      <Text class="text-xs text-muted-foreground">
                        {t("models.channels.empty")}
                      </Text>
                    </View>
                  }
                >
                  <View class="gap-1.5 px-2.5 py-2.5">
                    <Each of={props.channels} key={(channel) => channel.id}>
                      {(channel) => {
                        const id = () => channel().id;
                        const isSelected = () => props.selectedId === id();
                        return (
                          <View
                            testID={`channel-row-${id()}`}
                            pan={mutating() || animating() ? undefined : { y: offsetOf(id()) }}
                            onPanStart={() => handleDragStart(id())}
                            onPanEnd={(event) => void handleDragEnd(id(), event)}
                            onLayout={(event) => {
                              rowSlots.set(id(), {
                                top: event.bounds.origin.y,
                                height: event.bounds.size.height,
                              });
                            }}
                            style={{ translate: [0, offsetOf(id())] }}
                            class={`flex-row items-center gap-1 rounded-xl border pr-1.5 ${motion.navigationFeedback} ${
                              dragging() === id()
                                ? "z-10 cursor-grabbing border-border bg-card shadow-md"
                                : isSelected()
                                  ? "border-border bg-card shadow-card dark:shadow-card-dark"
                                  : "border-transparent hover:bg-accent/70 active:bg-accent"
                            }`}
                          >
                            <Button
                              testID={`channel-item-${id()}`}
                              ref={(node) => {
                                props.onChannelItemRef?.(id(), node);
                              }}
                              variant="ghost"
                              size="row"
                              selected={isSelected()}
                              accessibilityLabel={t("models.channels.itemLabel", {
                                name: channel().displayName,
                                provider: providerLabel(channel().presetId),
                                status: channel().enabled
                                  ? t("models.channel.enabled")
                                  : t("models.filter.disabled"),
                              })}
                              onPress={() => props.onSelect(id())}
                              class="min-w-0 flex-1 hover:bg-transparent active:bg-transparent selected:bg-transparent"
                            >
                              <View class="w-4 shrink-0 items-center justify-center">
                                <If
                                  when={channel().enabled}
                                  else={
                                    <Icon
                                      name="minus"
                                      tone="muted-foreground"
                                      class="size-3.5 opacity-60"
                                    />
                                  }
                                >
                                  <Icon name="check-circle" tone="success" class="size-4" />
                                </If>
                              </View>

                              <View class="min-w-0 flex-1 gap-0.5">
                                <View class="flex-row items-center gap-1.5">
                                  <Text
                                    class={
                                      isSelected()
                                        ? "min-w-0 shrink truncate text-sm font-semibold text-foreground"
                                        : channel().enabled
                                          ? "min-w-0 shrink truncate text-sm font-medium text-foreground"
                                          : "min-w-0 shrink truncate text-sm text-muted-foreground"
                                    }
                                  >
                                    {channel().displayName}
                                  </Text>
                                  <If when={!channel().enabled}>
                                    <Badge label={t("models.filter.disabled")} tone="neutral" />
                                  </If>
                                </View>
                                <View class="flex-row items-center gap-1">
                                  <If when={providerPresentation(channel().presetId) !== null}>
                                    <ProviderMark
                                      presentation={providerPresentation(channel().presetId)!}
                                      class="size-3 shrink-0"
                                    />
                                  </If>
                                  <Text class="min-w-0 truncate text-xs text-muted-foreground">
                                    {providerLabel(channel().presetId)}
                                  </Text>
                                </View>
                              </View>
                            </Button>

                            <If when={props.channels.length > 1}>
                              <KeyboardButton
                                testID={`channel-grip-${id()}`}
                                variant="ghost"
                                size="icon-xs"
                                focusable={true}
                                tooltip={t("models.channels.reorder", {
                                  name: channel().displayName,
                                })}
                                accessibilityLabel={t("models.channels.reorder", {
                                  name: channel().displayName,
                                })}
                                accessibilityHint={t("models.channels.reorderHint")}
                                accessibilityActions={[
                                  {
                                    name: "moveUp",
                                    label: t("models.channels.moveUp", {
                                      name: channel().displayName,
                                    }),
                                  },
                                  {
                                    name: "moveDown",
                                    label: t("models.channels.moveDown", {
                                      name: channel().displayName,
                                    }),
                                  },
                                ]}
                                onAccessibilityAction={(event) =>
                                  handleAccessibilityMove(id(), event.actionName)
                                }
                                onPress={() => gripNodes.get(id())?.focus()}
                                captureKeys={["arrowup", "arrowdown"]}
                                onKeyDown={(event) => handleGripKey(id(), event)}
                                ref={(node) => {
                                  gripNodes.set(id(), node);
                                }}
                                class="shrink-0 cursor-grab"
                              >
                                <Icon name="grip-vertical" tone="muted-foreground" class="size-4" />
                              </KeyboardButton>
                            </If>
                          </View>
                        );
                      }}
                    </Each>

                    <If when={listError() !== null}>
                      <Text
                        testID="channels-reorder-error"
                        role="alert"
                        class="pt-1 text-xs text-destructive"
                      >
                        {listError()}
                      </Text>
                    </If>
                  </View>
                </If>
              }
            >
              <View class="gap-3 px-4 pb-4 pt-1">
                <Text role="alert" class="text-xs text-destructive">
                  {props.error}
                </Text>
                <Button
                  size="sm"
                  variant="outline"
                  label={t("common.retry")}
                  onPress={() => props.onRetry()}
                />
              </View>
            </If>
          }
        >
          <View class="px-4 pb-4 pt-1">
            <Text class="text-xs text-muted-foreground">{t("models.channels.loading")}</Text>
          </View>
        </If>
      </Scroll>
    </View>
  );
}
