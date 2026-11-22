import { createMotion, effect, signal, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { FormField } from "../../modules/ai/ui/form-field";
import {
  languageDetectionStore,
  type LanguageDetectionPreferences,
  type LanguageDetectorKind,
} from "../language-detection/settings";
import { modelsStore } from "../models/store";
import {
  getLanguageLabel,
  isLanguageId,
  LANGUAGE_IDS,
  type LanguageId,
} from "../presets/languages";
import { readAvailableModelChoices, resolveModelBindingInfo } from "../presets/model-choices";

/** Select value for an unset language preference (`null` in storage). */
const UNSET_LANGUAGE_CHOICE = "__unset__";

type SummaryToneClass = "text-muted-foreground" | "text-warning" | "text-destructive";

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
  return kind === "ai" ? languageDetectionStore.savedAiBinding() !== null : true;
}

function detectorRole(kind: LanguageDetectorKind): "primary" | "backup" | null {
  const enabledOrder = languageDetectionStore
    .detectorOrder()
    .filter((item) => languageDetectionStore.isEnabled(item));
  const position = enabledOrder.indexOf(kind);
  if (position === -1) return null;
  return position === 0 ? "primary" : "backup";
}

function detectorSummary(kind: LanguageDetectorKind): ChannelSummary {
  if (kind === "google") {
    return {
      text: t("settings.languageDetection.googleSummary"),
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

function DetectionChannelAvatar(props: { kind: LanguageDetectorKind }) {
  return (
    <If when={props.kind === "ai"} else={<Avatar size="md" name="G" accessibilityLabel="" />}>
      <Avatar size="md" icon="cube-outline" accessibilityLabel="" />
    </If>
  );
}

/** One row's identity block, shared by the pressable AI row and the static Google row. */
function DetectionChannelIdentity(props: { kind: LanguageDetectorKind }) {
  const role = () => detectorRole(props.kind);
  const summary = () => detectorSummary(props.kind);

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

interface DetectionChannelListProps {
  compact: boolean;
  onOpenChannel: (kind: LanguageDetectorKind) => void;
  onRowRef: (node: ViewRef) => void;
}

function DetectionChannelList(props: DetectionChannelListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const listError = signal<string | null>(null);

  const order = () => languageDetectionStore.detectorOrder();

  const rowLabel = (kind: LanguageDetectorKind): string => {
    const role = detectorRole(kind);
    return t("settings.languageDetection.itemLabel", {
      name: t(`settings.languageDetection.${kind}`),
      status:
        role !== null
          ? t(`settings.languageDetection.role.${role}`)
          : isDetectorConfigured(kind)
            ? t("models.filter.disabled")
            : t("settings.languageDetection.notConfigured"),
    });
  };

  const handleToggle = async (kind: LanguageDetectorKind, nextEnabled: boolean) => {
    if (mutating()) return;
    listError.set(null);
    mutating.set(true);
    try {
      const result = await languageDetectionStore.setEnabled(kind, nextEnabled);
      if (!result.ok) listError.set(result.message);
    } finally {
      mutating.set(false);
    }
  };

  const handleMove = async (kind: LanguageDetectorKind, direction: "up" | "down") => {
    if (mutating()) return;
    listError.set(null);
    mutating.set(true);
    try {
      const result = await languageDetectionStore.moveDetector(kind, direction);
      if (!result.ok) listError.set(result.message);
    } finally {
      mutating.set(false);
    }
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

      <Card testID="settings-detection-card" class={props.compact ? "gap-1 p-2" : "gap-1 p-3"}>
        <Each of={order()} key={(kind) => kind}>
          {(kind, index) => {
            const name = () => t(`settings.languageDetection.${kind()}`);
            const configured = () => isDetectorConfigured(kind());
            const enabled = () => languageDetectionStore.isEnabled(kind());

            return (
              <>
                <If when={index() > 0}>
                  <View class="mx-2 my-1 h-px bg-border" />
                </If>
                <View
                  testID={`settings-detection-row-${kind()}`}
                  class={`flex-row items-center gap-1.5 rounded-lg pr-2 ${motion.navigationFeedback} ${
                    kind() === "ai" ? "hover:bg-accent/60 active:bg-accent" : ""
                  }`}
                >
                  <If
                    when={kind() === "ai"}
                    else={
                      <View class="min-w-0 flex-1 flex-row items-center gap-2.5 rounded-lg py-2.5 pl-3 pr-2">
                        <DetectionChannelIdentity kind={kind()} />
                      </View>
                    }
                  >
                    <Button
                      testID="settings-detection-channel-ai"
                      ref={(node) => props.onRowRef(node)}
                      variant="ghost"
                      size="row"
                      accessibilityLabel={rowLabel(kind())}
                      onPress={() => {
                        listError.set(null);
                        props.onOpenChannel("ai");
                      }}
                      class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
                    >
                      <DetectionChannelIdentity kind={kind()} />
                    </Button>
                  </If>

                  <View class="shrink-0 flex-row items-center gap-0.5">
                    <Button
                      testID={`settings-detection-move-up-${kind()}`}
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("settings.languageDetection.moveUp", { name: name() })}
                      accessibilityLabel={t("settings.languageDetection.moveUp", { name: name() })}
                      disabled={mutating() || index() === 0}
                      onPress={() => void handleMove(kind(), "up")}
                    >
                      <Icon name="arrow-up" tone="muted-foreground" class="size-3.5" />
                    </Button>
                    <Button
                      testID={`settings-detection-move-down-${kind()}`}
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("settings.languageDetection.moveDown", { name: name() })}
                      accessibilityLabel={t("settings.languageDetection.moveDown", {
                        name: name(),
                      })}
                      disabled={mutating() || index() === order().length - 1}
                      onPress={() => void handleMove(kind(), "down")}
                    >
                      <Icon name="arrow-down" tone="muted-foreground" class="size-3.5" />
                    </Button>
                  </View>

                  <Switch
                    testID={`settings-detection-toggle-${kind()}`}
                    variant="inline"
                    checked={enabled()}
                    disabled={mutating() || !configured()}
                    accessibilityLabel={t("settings.languageDetection.enableLabel", {
                      name: name(),
                    })}
                    tooltip={
                      !configured()
                        ? t("settings.languageDetection.configureBeforeEnable")
                        : undefined
                    }
                    onChange={(checked) => void handleToggle(kind(), checked)}
                  />

                  <If when={kind() === "ai"} else={<View class="size-7 shrink-0" />}>
                    <Button
                      testID="settings-detection-open-ai"
                      variant="ghost"
                      size="icon-sm"
                      tooltip={t("settings.languageDetection.configureLabel", { name: name() })}
                      accessibilityLabel={t("settings.languageDetection.configureLabel", {
                        name: name(),
                      })}
                      onPress={() => {
                        listError.set(null);
                        props.onOpenChannel("ai");
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

      <If when={listError() !== null}>
        <Text
          testID="settings-detection-list-error"
          role="alert"
          class="px-1 text-sm text-destructive"
        >
          {listError()}
        </Text>
      </If>

      <LanguagePreferencesCard compact={props.compact} />
    </View>
  );
}

function LanguagePreferencesCard(props: { compact: boolean }) {
  const initial = languageDetectionStore.snapshot();
  const draft = signal<LanguageDetectionPreferences>({
    nativeLanguage: initial.nativeLanguage,
    preferredTranslationLanguage: initial.preferredTranslationLanguage,
  });
  const error = signal<string | null>(null);
  const saving = signal(false);

  const setPreference = (
    field: "nativeLanguage" | "preferredTranslationLanguage",
    value: string | null,
  ) => {
    if (value === null) return;
    if (value !== UNSET_LANGUAGE_CHOICE && !isLanguageId(value)) return;
    error.set(null);
    draft.set({
      ...draft(),
      [field]: value === UNSET_LANGUAGE_CHOICE ? null : (value as LanguageId),
    });
  };

  const handleSave = async () => {
    if (saving()) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await languageDetectionStore.savePreferences({ ...draft() });
      if (!result.ok) error.set(result.message);
    } finally {
      saving.set(false);
    }
  };

  return (
    <Card
      testID="settings-detection-preferences-card"
      class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}
    >
      <SectionHeading title={t("settings.languageDetection.languages")} />

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
            value={draft().nativeLanguage ?? UNSET_LANGUAGE_CHOICE}
            disabled={saving()}
            accessibilityLabel={t("settings.languageDetection.nativeLanguage")}
            onChange={(value) => setPreference("nativeLanguage", value)}
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
            value={draft().preferredTranslationLanguage ?? UNSET_LANGUAGE_CHOICE}
            disabled={saving()}
            accessibilityLabel={t("settings.languageDetection.preferredTranslation")}
            onChange={(value) => setPreference("preferredTranslationLanguage", value)}
          />
        </FormField>
      </View>

      <If when={error() !== null}>
        <Text testID="settings-detection-error" role="alert" class="text-sm text-destructive">
          {error()}
        </Text>
      </If>

      <View class="flex-row justify-end">
        <Button
          testID="settings-detection-save"
          variant="primary"
          size="sm"
          label={saving() ? t("common.saving") : t("common.save")}
          disabled={saving()}
          onPress={() => void handleSave()}
        />
      </View>
    </Card>
  );
}

interface DetectionChannelDetailProps {
  compact: boolean;
  onManageModels?: () => void;
}

function DetectionChannelDetail(props: DetectionChannelDetailProps) {
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

interface LanguageDetectionSectionProps {
  compact: boolean;
  selectedChannel: LanguageDetectorKind | null;
  onSelectChannel: (channel: LanguageDetectorKind) => void;
  onManageModels?: () => void;
}

/** Settings section for prioritized detectors, their configuration pages, and language preferences. */
export function LanguageDetectionSection(props: LanguageDetectionSectionProps) {
  let rowRef: ViewRef | undefined;
  let openedDetail = false;
  let restoreFocus = false;

  effect(() => {
    if (props.selectedChannel !== null) {
      openedDetail = true;
      restoreFocus = true;
      return;
    }
    if (restoreFocus && openedDetail) {
      restoreFocus = false;
      queueMicrotask(() => {
        if (props.selectedChannel === null) rowRef?.focus();
      });
    }
  });

  const showingDetail = () => props.selectedChannel === "ai";

  return (
    <If
      when={!showingDetail()}
      else={
        <DetectionChannelDetail compact={props.compact} onManageModels={props.onManageModels} />
      }
    >
      <DetectionChannelList
        compact={props.compact}
        onOpenChannel={(kind) => props.onSelectChannel(kind)}
        onRowRef={(node) => {
          rowRef = node;
        }}
      />
    </If>
  );
}
