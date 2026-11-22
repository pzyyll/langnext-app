import {
  cleanup,
  createAnimatedValue,
  createMotion,
  effect,
  Image,
  reduceMotion,
  signal,
  Text,
  token,
  View,
  type AnimatedValue,
  type InputRef,
  type KeyEvent,
  type PanEvent,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import baiduIcon from "../../assets/icons/baidu.svg";
import { motion } from "../../components/motion";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button, KeyboardButton } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { FormField } from "../../modules/ai/ui/form-field";
import { modelsStore } from "../models/store";
import { readAvailableModelChoices, resolveModelBindingInfo } from "../presets/model-choices";
import {
  BAIDU_OCR_OPERATIONS,
  isBaiduOcrOperation,
  OCR_SERVICE_KINDS,
  ocrSettingsStore,
  type BaiduOcrOperation,
  type OcrServiceKind,
  type SaveOcrBindingInput,
} from "../ocr/settings";

interface OcrSectionProps {
  compact: boolean;
  platformOs: string;
  selectedChannel: OcrServiceKind | null;
  onSelectChannel: (channel: OcrServiceKind | null) => void;
  onManageModels?: () => void;
}

type CredentialState = "unknown" | "readable" | "missing";

/** Time a reordered row takes to settle into its new slot. */
const REORDER_SETTLE_MS = 180;

function OcrChannelAvatar(props: { kind: OcrServiceKind }) {
  return (
    <If
      when={props.kind === "baidu"}
      else={<Avatar size="md" icon="cube-outline" accessibilityLabel="" />}
    >
      <Avatar
        size="md"
        accessibilityLabel=""
        fallback={
          <Image
            src={baiduIcon}
            accessibilityElementsHidden={true}
            class="size-4 overflow-hidden"
            // Runtime theme token tint keeps the monochrome Baidu mark legible in light and dark modes.
            style={{ tintColor: token("foreground") }}
          />
        }
      />
    </If>
  );
}

interface OcrChannelListProps {
  compact: boolean;
  platformOs: string;
  credentialState: CredentialState;
  onOpenChannel: (kind: OcrServiceKind) => void;
  onRowRef: (kind: OcrServiceKind, node: ViewRef) => void;
  onGripRef: (kind: OcrServiceKind, node: ViewRef) => void;
  onFocusGrip: (kind: OcrServiceKind) => void;
}

function OcrChannelList(props: OcrChannelListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const listError = signal<string | null>(null);
  const dragging = signal<OcrServiceKind | null>(null);
  const animating = signal(false);
  // Per-channel drag offsets drive the rows natively; they return to 0 at rest.
  const offsets: Record<OcrServiceKind, AnimatedValue> = {
    ai: createAnimatedValue(0),
    baidu: createAnimatedValue(0),
  };
  const rowSlots: Partial<Record<OcrServiceKind, { top: number; height: number }>> = {};

  const order = () => ocrSettingsStore.channelOrder();
  const enabledOrder = () => order().filter((kind) => ocrSettingsStore.isEnabled(kind));

  const isConfigured = (kind: OcrServiceKind): boolean =>
    kind === "ai"
      ? ocrSettingsStore.savedAiBinding() !== null
      : ocrSettingsStore.savedBaiduBinding() !== null;

  const channelRole = (kind: OcrServiceKind): "primary" | "backup" | null => {
    const position = enabledOrder().indexOf(kind);
    if (position === -1) return null;
    return position === 0 ? "primary" : "backup";
  };

  const channelSummary = (
    kind: OcrServiceKind,
  ): { text: string; toneClass: "text-muted-foreground" | "text-warning" | "text-destructive" } => {
    if (kind === "ai") {
      const saved = ocrSettingsStore.savedAiBinding();
      if (saved === null) {
        return { text: t("settings.ocr.notConfigured"), toneClass: "text-muted-foreground" };
      }
      const info = resolveModelBindingInfo(saved.modelId, "image");
      return info.available
        ? { text: info.label, toneClass: "text-muted-foreground" }
        : { text: info.reason ?? info.label, toneClass: "text-warning" };
    }
    const saved = ocrSettingsStore.savedBaiduBinding();
    if (saved === null) {
      return { text: t("settings.ocr.notConfigured"), toneClass: "text-muted-foreground" };
    }
    if (props.credentialState === "missing") {
      return { text: t("settings.ocr.keysUnreadable"), toneClass: "text-destructive" };
    }
    return {
      text: t(`settings.ocr.operation.${saved.operation}`),
      toneClass: "text-muted-foreground",
    };
  };

  const handleToggle = async (kind: OcrServiceKind, nextEnabled: boolean) => {
    if (mutating()) return;
    listError.set(null);
    mutating.set(true);
    try {
      const result = await ocrSettingsStore.setEnabled(kind, nextEnabled);
      if (!result.ok) listError.set(result.message);
    } finally {
      mutating.set(false);
    }
  };

  const animateOffset = (kind: OcrServiceKind, to: number): Promise<unknown> => {
    if (reduceMotion()) {
      offsets[kind].set(to);
      return Promise.resolve();
    }
    return offsets[kind].timing(to, { duration: REORDER_SETTLE_MS, easing: "easeOut" });
  };

  const resetOffsets = () => {
    for (const row of OCR_SERVICE_KINDS) offsets[row].set(0);
  };

  const handleDragStart = (kind: OcrServiceKind) => {
    if (mutating() || animating() || dragging() !== null) return;
    listError.set(null);
    dragging.set(kind);
  };

  /** The channel whose measured slot center is nearest the dragged row's center. */
  const nearestChannel = (kind: OcrServiceKind, offsetY: number): number | null => {
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
  const settleIntoSlots = async (kind: OcrServiceKind, target: number) => {
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

  const handleDragEnd = async (kind: OcrServiceKind, event: PanEvent) => {
    if (dragging() !== kind) {
      await animateOffset(kind, 0);
      return;
    }
    animating.set(true);
    try {
      const index = order().indexOf(kind);
      const target = nearestChannel(kind, event.value?.y ?? event.translation.y);
      if (event.cancelled || index === -1 || target === null || target === index) {
        await animateOffset(kind, 0);
        return;
      }
      const nextOrder = await settleIntoSlots(kind, target);
      const result = await ocrSettingsStore.moveChannelTo(kind, target);
      if (result.ok) {
        resetOffsets();
        return;
      }
      await Promise.all(nextOrder.map((row) => animateOffset(row, 0)));
      listError.set(result.message);
    } finally {
      dragging.set(null);
      animating.set(false);
    }
  };

  const handleMoveBy = async (kind: OcrServiceKind, delta: number, refocus: boolean) => {
    if (mutating() || animating() || dragging() !== null) return;
    const list = order();
    const index = list.indexOf(kind);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= list.length) return;
    listError.set(null);
    mutating.set(true);
    try {
      const result = await ocrSettingsStore.moveChannelTo(kind, target);
      if (!result.ok) {
        listError.set(result.message);
        return;
      }
      if (refocus) queueMicrotask(() => props.onFocusGrip(kind));
    } finally {
      mutating.set(false);
    }
  };

  const handleGripKey = (kind: OcrServiceKind, event: KeyEvent) => {
    if (event.key === "ArrowUp") void handleMoveBy(kind, -1, true);
    else if (event.key === "ArrowDown") void handleMoveBy(kind, 1, true);
  };

  const handleAccessibilityMove = (kind: OcrServiceKind, actionName: string) => {
    if (actionName === "moveUp") void handleMoveBy(kind, -1, false);
    else if (actionName === "moveDown") void handleMoveBy(kind, 1, false);
  };

  return (
    <View
      // Runtime native entrance motion fades the OCR list without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <If when={ocrSettingsStore.loadError() !== null}>
        <Text testID="settings-ocr-load-error" role="alert" class="text-sm text-destructive">
          {ocrSettingsStore.loadError()!.message}
        </Text>
      </If>

      <Card testID="settings-ocr-card" class={props.compact ? "gap-1 p-2" : "gap-1 p-3"}>
        <Each of={order()} key={(kind) => kind}>
          {(kind, index) => {
            const name = () => t(`settings.ocr.${kind()}`);
            const configured = () => isConfigured(kind());
            const enabled = () => ocrSettingsStore.isEnabled(kind());
            const role = () => channelRole(kind());
            const summary = () => channelSummary(kind());
            const rowLabel = () =>
              t("settings.ocr.itemLabel", {
                name: name(),
                status:
                  role() !== null
                    ? t(`settings.ocr.role.${role()!}`)
                    : configured()
                      ? t("models.filter.disabled")
                      : t("settings.ocr.notConfigured"),
              });

            return (
              <>
                <If when={index() > 0}>
                  <View class="mx-2 my-1 h-px bg-border" />
                </If>
                <View
                  testID={`settings-ocr-row-${kind()}`}
                  pan={mutating() || animating() ? undefined : { y: offsets[kind()] }}
                  onPanStart={() => handleDragStart(kind())}
                  onPanEnd={(event) => void handleDragEnd(kind(), event)}
                  onLayout={(event) => {
                    rowSlots[kind()] = {
                      top: event.bounds.origin.y,
                      height: event.bounds.size.height,
                    };
                  }}
                  style={{ translate: [0, offsets[kind()]] }}
                  class={`flex-row items-center gap-1.5 rounded-lg pr-2 ${motion.navigationFeedback} ${
                    dragging() === kind()
                      ? "z-10 cursor-grabbing bg-card shadow-md"
                      : "hover:bg-accent/60 active:bg-accent"
                  }`}
                >
                  <Button
                    testID={`settings-ocr-channel-${kind()}`}
                    ref={(node) => props.onRowRef(kind(), node)}
                    variant="ghost"
                    size="row"
                    accessibilityLabel={rowLabel()}
                    onPress={() => {
                      listError.set(null);
                      props.onOpenChannel(kind());
                    }}
                    class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
                  >
                    <OcrChannelAvatar kind={kind()} />
                    <View class="min-w-0 flex-1 gap-0.5">
                      <View class="flex-row items-center gap-2">
                        <Text class="min-w-0 shrink truncate text-sm font-medium text-card-foreground">
                          {name()}
                        </Text>
                        <If when={role()}>
                          {(activeRole) => (
                            <Badge
                              testID={`settings-ocr-role-${kind()}`}
                              label={t(`settings.ocr.role.${activeRole()}`)}
                              tone={activeRole() === "primary" ? "primary" : "neutral"}
                            />
                          )}
                        </If>
                      </View>
                      <Text
                        testID={`settings-ocr-summary-${kind()}`}
                        class={`min-w-0 truncate text-xs ${summary().toneClass}`}
                      >
                        {summary().text}
                      </Text>
                    </View>
                  </Button>

                  <KeyboardButton
                    testID={`settings-ocr-grip-${kind()}`}
                    variant="ghost"
                    size="icon-sm"
                    focusable={true}
                    tooltip={t("settings.ocr.reorder", { name: name() })}
                    accessibilityLabel={t("settings.ocr.reorder", { name: name() })}
                    accessibilityHint={t("settings.ocr.reorderHint")}
                    accessibilityActions={[
                      { name: "moveUp", label: t("settings.ocr.moveUp", { name: name() }) },
                      { name: "moveDown", label: t("settings.ocr.moveDown", { name: name() }) },
                    ]}
                    onAccessibilityAction={(event) =>
                      handleAccessibilityMove(kind(), event.actionName)
                    }
                    onPress={() => props.onFocusGrip(kind())}
                    captureKeys={["arrowup", "arrowdown"]}
                    onKeyDown={(event) => handleGripKey(kind(), event)}
                    ref={(node) => props.onGripRef(kind(), node)}
                    class="shrink-0 cursor-grab"
                  >
                    <Icon name="grip-vertical" tone="muted-foreground" class="size-4" />
                  </KeyboardButton>

                  <Switch
                    testID={`settings-ocr-toggle-${kind()}`}
                    variant="inline"
                    checked={enabled()}
                    disabled={mutating() || !configured()}
                    accessibilityLabel={t("settings.ocr.enableLabel", { name: name() })}
                    tooltip={!configured() ? t("settings.ocr.configureBeforeEnable") : undefined}
                    onChange={(checked) => void handleToggle(kind(), checked)}
                  />

                  <Button
                    testID={`settings-ocr-open-${kind()}`}
                    variant="ghost"
                    size="icon-sm"
                    tooltip={t("settings.ocr.configureLabel", { name: name() })}
                    accessibilityLabel={t("settings.ocr.configureLabel", { name: name() })}
                    onPress={() => {
                      listError.set(null);
                      props.onOpenChannel(kind());
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

      <If when={listError() !== null}>
        <Text testID="settings-ocr-list-error" role="alert" class="px-1 text-sm text-destructive">
          {listError()}
        </Text>
      </If>

      <If when={props.platformOs !== "windows"}>
        <Text testID="settings-ocr-windows-only" class="px-1 text-xs text-muted-foreground">
          {t("settings.ocr.windowsOnly")}
        </Text>
      </If>
    </View>
  );
}

interface OcrChannelDetailProps {
  kind: OcrServiceKind;
  compact: boolean;
  credentialState: CredentialState;
  onManageModels?: () => void;
}

function OcrChannelDetail(props: OcrChannelDetailProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const draftModelId = signal<string | null>(ocrSettingsStore.savedAiBinding()?.modelId ?? null);
  const draftOperation = signal<BaiduOcrOperation>(
    ocrSettingsStore.savedBaiduBinding()?.operation ?? "accurate",
  );
  const apiKeyDraft = signal("");
  const secretKeyDraft = signal("");
  const error = signal<string | null>(null);
  const saving = signal(false);
  let apiKeyField: InputRef | undefined;
  let secretKeyField: InputRef | undefined;
  let mounted = true;

  cleanup(() => {
    mounted = false;
  });

  const modelChoices = () => readAvailableModelChoices("image");
  const catalogUnusable = () => modelsStore.channelsError() !== null || modelChoices().length === 0;
  const eligibleModelId = () =>
    modelChoices().find((choice) => choice.id === draftModelId())?.id ?? null;
  const binding = () => {
    const modelId = draftModelId();
    return modelId === null ? null : resolveModelBindingInfo(modelId, "image");
  };
  const bindingUnavailable = () => {
    const info = binding();
    return info !== null && !info.available;
  };
  const showAiRecovery = () => props.kind === "ai" && catalogUnusable();
  const canKeepKeys = () =>
    props.kind === "baidu" &&
    ocrSettingsStore.savedBaiduBinding() !== null &&
    props.credentialState === "readable";
  const savedKeysPlaceholder = () => (canKeepKeys() ? t("settings.ocr.savedKeys") : undefined);

  const modelItems = (): SelectItem[] =>
    modelChoices().map((choice) => ({ value: choice.id, title: choice.label }));
  const operationItems = (): SelectItem[] =>
    BAIDU_OCR_OPERATIONS.map((operation) => ({
      value: operation,
      title: t(`settings.ocr.operation.${operation}`),
    }));

  const selectModel = (modelId: string | null) => {
    if (modelId === null || saving()) return;
    error.set(null);
    draftModelId.set(modelId);
  };

  const selectOperation = (value: string | null) => {
    if (!isBaiduOcrOperation(value) || saving()) return;
    error.set(null);
    draftOperation.set(value);
  };

  const draftSaveInput = (): SaveOcrBindingInput | null => {
    if (props.kind === "ai") {
      const modelId = eligibleModelId();
      return modelId === null ? null : { kind: "ai", modelId };
    }
    const apiKey = apiKeyDraft().trim();
    const secretKey = secretKeyDraft().trim();
    if (apiKey.length > 0 && secretKey.length > 0) {
      return {
        kind: "baidu",
        operation: draftOperation(),
        credentials: { kind: "replace", apiKey, secretKey },
      };
    }
    if (apiKey.length === 0 && secretKey.length === 0 && canKeepKeys()) {
      return { kind: "baidu", operation: draftOperation(), credentials: { kind: "keep" } };
    }
    return null;
  };

  const handleSave = async () => {
    const input = draftSaveInput();
    if (saving() || input === null) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await ocrSettingsStore.save(input);
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      apiKeyDraft.set("");
      secretKeyDraft.set("");
      if (result.binding.kind === "ai") draftModelId.set(result.binding.modelId);
      if (result.binding.kind === "baidu") {
        draftOperation.set(result.binding.operation);
        if (mounted) {
          apiKeyField?.blur();
          secretKeyField?.blur();
        }
      }
      toast.success(t("settings.ocr.saved"));
    } finally {
      saving.set(false);
    }
  };

  return (
    <View
      // Runtime native entrance motion fades the channel detail view without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <Card testID="settings-ocr-detail-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <View class="flex-row items-center justify-between gap-2">
          <View class="min-w-0 flex-1 flex-row items-center gap-3">
            <OcrChannelAvatar kind={props.kind} />
            <SectionHeading title={t(`settings.ocr.${props.kind}`)} />
          </View>
          <If when={props.kind === "ai" && !catalogUnusable() && bindingUnavailable()}>
            <Button
              testID="settings-ocr-manage-models"
              variant="outline"
              size="sm"
              label={t("presets.action.manageModels")}
              disabled={saving()}
              onPress={() => props.onManageModels?.()}
            />
          </If>
        </View>

        <If when={showAiRecovery()}>
          <View
            testID="settings-ocr-models-recovery"
            class="gap-2 rounded-lg border border-border bg-muted/50 p-3"
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
                : t("presets.model.noEligibleImageModel")}
            </Text>
            <View class="flex-row">
              <Button
                testID="settings-ocr-manage-models"
                variant="outline"
                size="sm"
                label={t("presets.action.manageModels")}
                disabled={saving()}
                onPress={() => props.onManageModels?.()}
              />
            </View>
          </View>
        </If>

        <If when={props.kind === "ai"}>
          <FormField label={t("settings.ocr.model")}>
            <Select
              testID="settings-ocr-model"
              items={modelItems()}
              value={eligibleModelId()}
              placeholder={t("presets.model.selectPlaceholder")}
              disabled={saving() || modelItems().length === 0}
              accessibilityLabel={t("settings.ocr.model")}
              onChange={selectModel}
            />
            <If when={bindingUnavailable()}>
              <Text testID="settings-ocr-model-unavailable" class="text-xs text-warning">
                {binding()?.reason}
              </Text>
            </If>
          </FormField>
        </If>

        <If when={props.kind === "baidu"}>
          <FormField label={t("settings.ocr.mode")}>
            <Select
              testID="settings-ocr-baidu-operation"
              items={operationItems()}
              value={draftOperation()}
              disabled={saving()}
              accessibilityLabel={t("settings.ocr.mode")}
              onChange={selectOperation}
            />
          </FormField>
          <FormField label={t("settings.ocr.apiKey")}>
            <Input
              testID="settings-ocr-baidu-api-key"
              ref={(node) => {
                apiKeyField = node;
              }}
              value={apiKeyDraft()}
              placeholder={savedKeysPlaceholder()}
              masked={true}
              disabled={saving()}
              accessibilityLabel={t("settings.ocr.apiKey")}
              onChange={(value) => {
                error.set(null);
                apiKeyDraft.set(value);
              }}
            />
          </FormField>
          <FormField label={t("settings.ocr.secretKey")}>
            <Input
              testID="settings-ocr-baidu-secret-key"
              ref={(node) => {
                secretKeyField = node;
              }}
              value={secretKeyDraft()}
              placeholder={savedKeysPlaceholder()}
              masked={true}
              disabled={saving()}
              accessibilityLabel={t("settings.ocr.secretKey")}
              onChange={(value) => {
                error.set(null);
                secretKeyDraft.set(value);
              }}
            />
          </FormField>
        </If>

        <If when={props.kind === "baidu" && props.credentialState === "missing"}>
          <Text
            testID="settings-ocr-baidu-keys-missing"
            role="alert"
            class="text-sm text-destructive"
          >
            {t("settings.ocr.keysUnreadable")}
          </Text>
        </If>

        <If when={error() !== null}>
          <Text testID="settings-ocr-error" role="alert" class="text-sm text-destructive">
            {error()}
          </Text>
        </If>

        <View class="flex-row justify-end">
          <Button
            testID="settings-ocr-save"
            variant="primary"
            size="sm"
            label={saving() ? t("common.saving") : t("common.save")}
            disabled={saving() || draftSaveInput() === null}
            onPress={() => void handleSave()}
          />
        </View>
      </Card>
    </View>
  );
}

/** Settings section for prioritized OCR channels and their per-channel configuration pages. */
export function OcrSection(props: OcrSectionProps) {
  const credentialState = signal<CredentialState>("unknown");
  const rowRefs: Partial<Record<OcrServiceKind, ViewRef>> = {};
  const gripRefs: Partial<Record<OcrServiceKind, ViewRef>> = {};
  let lastOpenedChannel: OcrServiceKind | null = null;
  let restoreFocusOnList = false;

  effect(() => {
    const saved = ocrSettingsStore.savedBaiduBinding();
    if (saved === null) {
      credentialState.set("unknown");
      return;
    }
    const ref = saved.credentialRef;
    void ocrSettingsStore.readBaiduCredentials(ref).then((pair) => {
      if (ocrSettingsStore.savedBaiduBinding()?.credentialRef !== ref) return;
      credentialState.set(pair ? "readable" : "missing");
    });
  });

  effect(() => {
    const current = props.selectedChannel;
    if (current !== null) {
      lastOpenedChannel = current;
      restoreFocusOnList = true;
      return;
    }
    if (restoreFocusOnList && lastOpenedChannel !== null) {
      restoreFocusOnList = false;
      const channel = lastOpenedChannel;
      queueMicrotask(() => {
        if (props.selectedChannel === null) rowRefs[channel]?.focus();
      });
    }
  });

  return (
    <If
      when={props.selectedChannel === null}
      else={
        <Each
          of={props.selectedChannel === null ? [] : [props.selectedChannel]}
          key={(kind) => kind}
        >
          {(kind) => (
            <OcrChannelDetail
              kind={kind()}
              compact={props.compact}
              credentialState={credentialState()}
              onManageModels={props.onManageModels}
            />
          )}
        </Each>
      }
    >
      <OcrChannelList
        compact={props.compact}
        platformOs={props.platformOs}
        credentialState={credentialState()}
        onOpenChannel={(kind) => props.onSelectChannel(kind)}
        onRowRef={(kind, node) => {
          rowRefs[kind] = node;
        }}
        onGripRef={(kind, node) => {
          gripRefs[kind] = node;
        }}
        onFocusGrip={(kind) => gripRefs[kind]?.focus()}
      />
    </If>
  );
}
