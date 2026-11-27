import { cleanup, platform, Scroll, signal, Text, View, windowSize, type ViewRef } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { t } from "nsh/i18n";
import type { NavigationLeaveGuard } from "../../components/layout/navigation-leave-guard";
import { SplitPane } from "../../components/layout/split-pane";
import { motion } from "../../components/motion";
import { Breadcrumb, type BreadcrumbItem } from "../../components/ui/breadcrumb";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { buildTooltip } from "../../components/ui/tooltip";
import { canOpenLogsFolder, openLogsFolder } from "../../platform/logs";
import { logLevel, type LogLevel } from "../../services/log";
import {
  getIntegrationRegistry,
  type CapabilityId,
  type ChannelCollection,
} from "../../framework/integrations";
import { detectChannels } from "../language-detection/store";
import { ocrChannels } from "../ocr/store";
import { ttsChannels } from "../tts/store";
import { BUNDLED_FONTS } from "../../fonts";
import { appearance, appearanceError, selectAppearance, type Appearance } from "./appearance";
import { language, languageError, selectLanguage, type LanguagePreference } from "./language";
import { CapabilitySection } from "./capability-section";
import { modelHostServices, ttsAudioHost } from "./capability-host-services";
import { DetectionPreferencesCard } from "./detection-preferences-card";
import { fontError, fontPreference, installedFonts, selectFont, SYSTEM_FONT } from "./font";
import { logLevelError, selectLogLevel } from "./log-level";
import { QuickTranslateSection } from "./quick-translate-section";
import { ShortcutsSection } from "./shortcuts-section";
import { WordbookSection } from "./wordbook-section";
import { selectSilentLaunch, silentLaunch, silentLaunchError } from "./silent-launch";
import type { TranslationShortcutId, TranslationShortcutSetting } from "./shortcuts";
import { selectTransparency, transparency, transparencyError } from "./transparency";

export type SettingsSection =
  | "general"
  | "appearance"
  | "shortcuts"
  | "quick-translate"
  | "language-detection"
  | "ocr"
  | "tts"
  | "wordbook";

interface SettingsSectionEntry {
  id: SettingsSection;
  labelKey: string;
}

interface SettingsGroup {
  id: string;
  labelKey: string;
  sections: readonly SettingsSectionEntry[];
}

/** Rail order. Integrations collect the categories that connect the app to a service. */
const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "application",
    labelKey: "settings.groups.application",
    sections: [
      { id: "general", labelKey: "settings.sections.general" },
      { id: "appearance", labelKey: "settings.sections.appearance" },
      { id: "shortcuts", labelKey: "settings.sections.shortcuts" },
      { id: "quick-translate", labelKey: "settings.sections.quickTranslate" },
    ],
  },
  {
    id: "integrations",
    labelKey: "settings.groups.integrations",
    sections: [
      { id: "language-detection", labelKey: "settings.sections.languageDetection" },
      { id: "ocr", labelKey: "settings.sections.ocr" },
      { id: "tts", labelKey: "settings.sections.tts" },
      { id: "wordbook", labelKey: "settings.sections.wordbook" },
    ],
  },
];

const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.sections);

function sectionLabelKey(section: SettingsSection) {
  return (
    SETTINGS_SECTIONS.find((item) => item.id === section)?.labelKey ?? "settings.sections.general"
  );
}

const selectedSection = signal<SettingsSection>("general");

type CapabilitySectionId = "language-detection" | "ocr" | "tts";

interface CapabilitySectionMeta {
  capability: CapabilityId;
  testIdPrefix: string;
  titleKey: string;
  addKey: string;
  emptyKey: string;
  priorityHintKey: string;
  breadcrumbLabelKey: string;
}

/** The three integration sections rendered by the shared capability host. */
const CAPABILITY_SECTIONS: Record<CapabilitySectionId, CapabilitySectionMeta> = {
  "language-detection": {
    capability: "detect",
    testIdPrefix: "settings-detection",
    titleKey: "settings.sections.languageDetection",
    addKey: "settings.languageDetection.addChannel",
    emptyKey: "settings.languageDetection.emptyTitle",
    priorityHintKey: "settings.languageDetection.priorityHint",
    breadcrumbLabelKey: "settings.languageDetection.breadcrumbLabel",
  },
  ocr: {
    capability: "ocr",
    testIdPrefix: "settings-ocr",
    titleKey: "settings.sections.ocr",
    addKey: "settings.ocr.addChannel",
    emptyKey: "settings.ocr.emptyTitle",
    priorityHintKey: "settings.ocr.priorityHint",
    breadcrumbLabelKey: "settings.ocr.breadcrumbLabel",
  },
  tts: {
    capability: "tts",
    testIdPrefix: "settings-tts",
    titleKey: "settings.sections.tts",
    addKey: "settings.tts.addChannel",
    emptyKey: "settings.tts.emptyTitle",
    priorityHintKey: "settings.tts.priorityHint",
    breadcrumbLabelKey: "settings.tts.breadcrumbLabel",
  },
};

function isCapabilitySection(section: SettingsSection): section is CapabilitySectionId {
  return section === "language-detection" || section === "ocr" || section === "tts";
}

function collectionFor(capability: CapabilityId): ChannelCollection {
  if (capability === "tts") return ttsChannels;
  if (capability === "ocr") return ocrChannels;
  return detectChannels;
}

function capabilityLabels(section: CapabilitySectionId) {
  const meta = CAPABILITY_SECTIONS[section];
  return {
    titleKey: meta.titleKey,
    addKey: meta.addKey,
    emptyKey: meta.emptyKey,
    priorityHintKey: meta.priorityHintKey,
  };
}

interface HeaderBreadcrumb {
  testID: string;
  accessibilityLabel: string;
  items: readonly BreadcrumbItem[];
}

interface ChoiceOptionProps {
  testID: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
}

/** One card of a radio group, for a setting the user picks exactly one value of. */
function ChoiceOption(props: ChoiceOptionProps) {
  return (
    <Radio
      testID={props.testID}
      checked={props.checked}
      onChange={() => props.onSelect()}
      class={`flex-1 rounded-xl border border-border bg-surface-control p-4 checked:border-primary checked:bg-card checked:shadow-card dark:checked:shadow-card-dark hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring ${motion.navigationFeedback}`}
    >
      <Text class="text-sm font-medium text-card-foreground">{props.label}</Text>
    </Radio>
  );
}

function ThemeOption(props: { value: Appearance; label: string }) {
  return (
    <ChoiceOption
      testID={`theme-${props.value}`}
      checked={appearance() === props.value}
      label={props.label}
      onSelect={() => void selectAppearance(props.value)}
    />
  );
}

function LanguageOption(props: { value: LanguagePreference; label: string }) {
  return (
    <ChoiceOption
      testID={`language-${props.value}`}
      checked={language() === props.value}
      label={props.label}
      onSelect={() => void selectLanguage(props.value)}
    />
  );
}

/** The font choices: the system font, the app's fonts, then the ones this system has. */
function fontItems(): SelectItem[] {
  const items: SelectItem[] = [{ value: SYSTEM_FONT, title: t("settings.font.system") }];
  for (const font of BUNDLED_FONTS) {
    items.push({
      value: font.family,
      title: t(font.labelKey),
      group: t("settings.font.bundled"),
    });
  }
  for (const family of installedFonts()) {
    items.push({ value: family, title: family, group: t("settings.font.installed") });
  }
  return items;
}

function GeneralSection(props: { compact: boolean; os: string }) {
  const logsError = signal(false);
  const openLogs = async () => logsError.set(!(await openLogsFolder()));

  return (
    <>
      <Card testID="settings-general-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <SectionHeading title={t("settings.language.title")} />
        <RadioGroup accessibilityLabel={t("settings.language.title")} class="flex-row gap-3">
          <LanguageOption value="system" label={t("settings.language.system")} />
          <LanguageOption value="en" label={t("settings.language.en")} />
          <LanguageOption value="zh-CN" label={t("settings.language.zh-CN")} />
        </RadioGroup>
        <If when={languageError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {languageError()}
          </Text>
        </If>
      </Card>

      <Card
        testID="settings-general-options-card"
        class={props.compact ? "gap-2 p-2" : "gap-2 p-3"}
      >
        <View class="gap-2">
          <Switch
            testID="settings-silent-launch-switch"
            label={t("settings.silentLaunch.label")}
            checked={silentLaunch()}
            onChange={(checked) => void selectSilentLaunch(checked)}
          />
          <If when={silentLaunchError() !== null}>
            <Text
              testID="settings-silent-launch-error"
              role="alert"
              class="px-3 pb-1 text-sm text-destructive"
            >
              {silentLaunchError()}
            </Text>
          </If>
        </View>

        <View class="mx-3 h-px bg-border" />

        <View class="gap-2">
          <View class="flex-row items-center justify-between gap-4 px-3 py-0.5">
            <Text class="text-sm font-medium text-card-foreground">
              {t("settings.logLevel.title")}
            </Text>
            <Select
              testID="settings-log-level"
              size="sm"
              items={[
                { value: "error", title: t("settings.logLevel.error") },
                { value: "warn", title: t("settings.logLevel.warning") },
                { value: "info", title: t("settings.logLevel.info") },
              ]}
              value={logLevel()}
              align="end"
              accessibilityLabel={t("settings.logLevel.title")}
              triggerClass="w-40"
              onChange={(value) => {
                if (value !== null) void selectLogLevel(value as LogLevel);
              }}
            />
          </View>
          <If when={logLevelError() !== null}>
            <Text
              testID="settings-log-level-error"
              role="alert"
              class="px-3 pb-1 text-sm text-destructive"
            >
              {logLevelError()}
            </Text>
          </If>
        </View>

        <If when={canOpenLogsFolder(props.os)}>
          <View class="gap-2">
            <View class="mx-3 h-px bg-border" />
            <View class="gap-2">
              <View class="flex-row items-center justify-between gap-4 px-3 py-0.5">
                <Text class="text-sm font-medium text-card-foreground">
                  {t("settings.logs.label")}
                </Text>
                <Button
                  testID="settings-open-logs"
                  variant="outline"
                  size="sm"
                  label={t("settings.logs.open")}
                  accessibilityLabel={t("settings.logs.openLabel")}
                  onPress={() => void openLogs()}
                />
              </View>
              <If when={logsError()}>
                <Text
                  testID="settings-logs-error"
                  role="alert"
                  class="px-3 pb-1 text-sm text-destructive"
                >
                  {t("settings.logs.error")}
                </Text>
              </If>
            </View>
          </View>
        </If>
      </Card>
    </>
  );
}

function AppearanceSection(props: { compact: boolean }) {
  return (
    <>
      <Card testID="settings-theme-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <SectionHeading title={t("settings.theme.title")} />
        <RadioGroup accessibilityLabel={t("settings.theme.title")} class="flex-row gap-3">
          <ThemeOption value="system" label={t("settings.appearance.system")} />
          <ThemeOption value="light" label={t("settings.appearance.light")} />
          <ThemeOption value="dark" label={t("settings.appearance.dark")} />
        </RadioGroup>
        <If when={appearanceError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {appearanceError()}
          </Text>
        </If>
      </Card>

      <Card testID="settings-font-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <SectionHeading title={t("settings.font.title")} />
        <Select
          testID="settings-font"
          items={fontItems()}
          value={fontPreference()}
          class="w-full"
          triggerClass="w-full"
          accessibilityLabel={t("settings.font.title")}
          onChange={(value) => {
            if (value !== null) void selectFont(value);
          }}
        />
        <If when={fontError() !== null}>
          <Text testID="settings-font-error" role="alert" class="text-sm text-destructive">
            {fontError()}
          </Text>
        </If>
      </Card>

      <Card testID="settings-transparency-card" class={props.compact ? "gap-2 p-2" : "gap-2 p-3"}>
        <Switch
          label={t("settings.transparency.label")}
          checked={transparency()}
          onChange={(checked) => void selectTransparency(checked)}
        />
        <If when={transparencyError() !== null}>
          <Text role="alert" class="px-3 pb-1 text-sm text-destructive">
            {transparencyError()}
          </Text>
        </If>
      </Card>
    </>
  );
}

function AddChannelHeaderButton(props: {
  testID: string;
  label: string;
  disabled: boolean;
  onRef: (node: ViewRef | null) => void;
  onPress: () => void;
}) {
  cleanup(() => props.onRef(null));

  return (
    <Button
      testID={props.testID}
      ref={(node) => props.onRef(node)}
      variant="primary"
      size="sm"
      disabled={props.disabled}
      accessibilityLabel={props.label}
      onPress={() => props.onPress()}
      class="shrink-0"
    >
      <Icon name="plus" tone="primary-foreground" class="size-3.5" />
      <Text class="text-sm font-medium text-primary-foreground">{props.label}</Text>
    </Button>
  );
}

/** Master-detail Settings workspace with resizable category rail and scrollable detail pane. */
export function SettingsPage(props: {
  platformOs?: string;
  onNavigateToModels?: () => void;
  onRegisterLeaveGuard?: (guard: NavigationLeaveGuard) => () => void;
  shortcuts?: Record<TranslationShortcutId, TranslationShortcutSetting>;
}) {
  const compact = () => windowSize().width < 860;
  const currentOs = () => props.platformOs ?? platform.os;
  const activeSectionLabelKey = () => sectionLabelKey(selectedSection());
  const selectedChannel = signal<string | null>(null);
  const detectionAddBusy = signal(false);
  const ocrAddBusy = signal(false);
  const ttsAddBusy = signal(false);
  const sectionDialogOpen = signal(false);
  const wordbookDirty = signal(false);
  const pendingWordbookLeave = signal<(() => void) | null>(null);
  let wordbookDiscardConfirmed = false;

  if (props.onRegisterLeaveGuard) {
    const unregister = props.onRegisterLeaveGuard((proceed) => {
      if (selectedSection() !== "wordbook" || !wordbookDirty()) return true;
      pendingWordbookLeave.set(proceed);
      return false;
    });
    cleanup(unregister);
  }

  const confirmWordbookDiscard = () => {
    const proceed = pendingWordbookLeave();
    wordbookDiscardConfirmed = true;
    pendingWordbookLeave.set(null);
    wordbookDirty.set(false);
    proceed?.();
  };
  let detectionAddButtonNode: ViewRef | null = null;
  let ocrAddButtonNode: ViewRef | null = null;
  let ttsAddButtonNode: ViewRef | null = null;
  let openDetectionAddDialog: (() => void) | null = null;
  let openOcrAddDialog: (() => void) | null = null;
  let openTtsAddDialog: (() => void) | null = null;

  const activeCapabilitySection = (): CapabilitySectionMeta | null => {
    const section = selectedSection();
    return isCapabilitySection(section) ? CAPABILITY_SECTIONS[section] : null;
  };

  const selectedDefinition = () => {
    const meta = activeCapabilitySection();
    const id = selectedChannel();
    if (meta === null || id === null) return null;
    return (
      getIntegrationRegistry()
        .capabilities(meta.capability)
        .find((definition) => definition.id === id) ?? null
    );
  };

  const headerBreadcrumb = (): HeaderBreadcrumb | null => {
    const meta = activeCapabilitySection();
    const definition = selectedDefinition();
    if (meta === null || definition === null) return null;
    return {
      testID: `${meta.testIdPrefix}-breadcrumb`,
      accessibilityLabel: t(meta.breadcrumbLabelKey),
      items: [
        {
          label: t(meta.titleKey),
          testID: `${meta.testIdPrefix}-breadcrumb-root`,
          onPress: () => selectedChannel.set(null),
        },
        {
          label: t(definition.labelKey),
          testID: `${meta.testIdPrefix}-detail-title`,
        },
      ],
    };
  };

  const showingBreadcrumb = () => headerBreadcrumb() !== null;
  const showAddButton = (section: CapabilitySectionId) => {
    const collection = collectionFor(CAPABILITY_SECTIONS[section].capability);
    return (
      selectedSection() === section &&
      !showingBreadcrumb() &&
      collection.loadError() === null &&
      collection.available().length > 0
    );
  };
  const showDetectionAddButton = () => showAddButton("language-detection");
  const showOcrAddButton = () => showAddButton("ocr");
  const showTtsAddButton = () => showAddButton("tts");
  const headerPaddingClass = () =>
    compact()
      ? showingBreadcrumb()
        ? "pl-2 pr-4"
        : "px-4"
      : showingBreadcrumb()
        ? "pl-4 pr-6"
        : "px-6";

  return (
    <>
      <SplitPane
        page="settings"
        handleAccessibilityLabel={t("settings.resizeLabel")}
        rail={
          <View testID="settings-rail" class="min-w-0 flex-1 bg-surface-rail">
            <View class="h-14 shrink-0 flex-row items-center justify-between gap-2 px-4">
              <Text role="header" class="min-w-0 truncate text-sm font-semibold text-foreground">
                {t("settings.title")}
              </Text>
            </View>
            <Scroll class="min-h-0 flex-1">
              <View
                role="navigation"
                accessibilityLabel={t("settings.navLabel")}
                class="gap-5 px-2.5 py-3"
              >
                <Each of={SETTINGS_GROUPS} key={(group) => group.id}>
                  {(group) => (
                    <View class="gap-1.5">
                      <Text
                        testID={`settings-group-${group().id}`}
                        role="header"
                        class="min-w-0 truncate px-2 text-xs font-medium text-muted-foreground"
                      >
                        {t(group().labelKey)}
                      </Text>
                      <View class="gap-0.5">
                        <Each of={group().sections} key={(item) => item.id}>
                          {(item) => {
                            const isSelected = () => selectedSection() === item().id;
                            return (
                              <Button
                                testID={`settings-nav-${item().id}`}
                                variant="nav"
                                size="nav"
                                selected={isSelected()}
                                label={t(item().labelKey)}
                                onPress={() => {
                                  const apply = () => {
                                    selectedSection.set(item().id);
                                    selectedChannel.set(null);
                                    sectionDialogOpen.set(false);
                                  };
                                  if (
                                    item().id !== selectedSection() &&
                                    selectedSection() === "wordbook" &&
                                    wordbookDirty()
                                  ) {
                                    pendingWordbookLeave.set(apply);
                                    return;
                                  }
                                  apply();
                                }}
                                class="w-full"
                              />
                            );
                          }}
                        </Each>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </View>
        }
        detail={
          <View testID="settings-detail" class="min-w-0 flex-1 bg-background">
            <View class="shrink-0">
              <View
                class={`mx-auto h-14 w-full max-w-4xl flex-row items-center justify-between gap-3 ${headerPaddingClass()}`}
              >
                <If
                  when={headerBreadcrumb() !== null}
                  else={
                    <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                      <Text
                        role="header"
                        class="min-w-0 shrink truncate text-lg font-semibold text-foreground"
                      >
                        {t(activeSectionLabelKey())}
                      </Text>
                      <If when={selectedSection() === "ocr"}>
                        <View
                          testID="settings-ocr-priority-info"
                          accessibilityLabel={t("settings.ocr.priorityHint")}
                          tooltip={buildTooltip(t("settings.ocr.priorityHint"), "top", {
                            align: "start",
                            disabled: sectionDialogOpen(),
                          })}
                          class="shrink-0 items-center justify-center p-1"
                        >
                          <Icon name="info" tone="muted-foreground" class="size-4" />
                        </View>
                      </If>
                      <If when={selectedSection() === "tts"}>
                        <View
                          testID="settings-tts-priority-info"
                          accessibilityLabel={t("settings.tts.priorityHint")}
                          tooltip={buildTooltip(t("settings.tts.priorityHint"), "top", {
                            align: "start",
                            disabled: sectionDialogOpen(),
                          })}
                          class="shrink-0 items-center justify-center p-1"
                        >
                          <Icon name="info" tone="muted-foreground" class="size-4" />
                        </View>
                      </If>
                      <If when={selectedSection() === "language-detection"}>
                        <View
                          testID="settings-detection-priority-info"
                          accessibilityLabel={t("settings.languageDetection.priorityHint")}
                          tooltip={buildTooltip(
                            t("settings.languageDetection.priorityHint"),
                            "top",
                            {
                              align: "start",
                              disabled: sectionDialogOpen(),
                            },
                          )}
                          class="shrink-0 items-center justify-center p-1"
                        >
                          <Icon name="info" tone="muted-foreground" class="size-4" />
                        </View>
                      </If>
                    </View>
                  }
                >
                  <Breadcrumb
                    testID={headerBreadcrumb()!.testID}
                    accessibilityLabel={headerBreadcrumb()!.accessibilityLabel}
                    items={headerBreadcrumb()!.items}
                  />
                </If>
                <If when={showDetectionAddButton()}>
                  <AddChannelHeaderButton
                    testID="settings-detection-add"
                    label={t("settings.languageDetection.addChannel")}
                    disabled={detectionAddBusy()}
                    onRef={(node) => {
                      detectionAddButtonNode = node;
                    }}
                    onPress={() => openDetectionAddDialog?.()}
                  />
                </If>
                <If when={showOcrAddButton()}>
                  <AddChannelHeaderButton
                    testID="settings-ocr-add"
                    label={t("settings.ocr.addChannel")}
                    disabled={ocrAddBusy()}
                    onRef={(node) => {
                      ocrAddButtonNode = node;
                    }}
                    onPress={() => openOcrAddDialog?.()}
                  />
                </If>
                <If when={showTtsAddButton()}>
                  <AddChannelHeaderButton
                    testID="settings-tts-add"
                    label={t("settings.tts.addChannel")}
                    disabled={ttsAddBusy()}
                    onRef={(node) => {
                      ttsAddButtonNode = node;
                    }}
                    onPress={() => openTtsAddDialog?.()}
                  />
                </If>
              </View>
            </View>
            <Scroll class="min-h-0 flex-1">
              <View
                class={`mx-auto w-full max-w-4xl ${compact() ? "gap-4 px-4 pb-4 pt-1" : "gap-5 px-6 pb-6 pt-2"}`}
              >
                <If when={selectedSection() === "general"}>
                  <GeneralSection compact={compact()} os={currentOs()} />
                </If>
                <If when={selectedSection() === "appearance"}>
                  <AppearanceSection compact={compact()} />
                </If>
                <If when={selectedSection() === "shortcuts"}>
                  <ShortcutsSection
                    compact={compact()}
                    platformOs={currentOs()}
                    shortcuts={props.shortcuts}
                  />
                </If>
                <If when={selectedSection() === "quick-translate"}>
                  <QuickTranslateSection compact={compact()} platformOs={currentOs()} />
                </If>
                <If when={selectedSection() === "language-detection"}>
                  <CapabilitySection
                    capability="detect"
                    testIdPrefix="settings-detection"
                    registry={getIntegrationRegistry()}
                    collection={detectChannels}
                    labels={capabilityLabels("language-detection")}
                    compact={compact()}
                    selected={selectedChannel()}
                    onSelect={(id) => selectedChannel.set(id)}
                    extra={() => <DetectionPreferencesCard compact={compact()} />}
                    hostServices={modelHostServices("text", props.onNavigateToModels)}
                    getAddButtonRef={() => detectionAddButtonNode}
                    onRegisterAddTrigger={(open) => {
                      openDetectionAddDialog = open;
                      return () => {
                        if (openDetectionAddDialog === open) openDetectionAddDialog = null;
                      };
                    }}
                    onAddBusyChange={(busy) => detectionAddBusy.set(busy)}
                    onDialogOpenChange={(open) => sectionDialogOpen.set(open)}
                  />
                </If>
                <If when={selectedSection() === "ocr"}>
                  <CapabilitySection
                    capability="ocr"
                    testIdPrefix="settings-ocr"
                    registry={getIntegrationRegistry()}
                    collection={ocrChannels}
                    labels={capabilityLabels("ocr")}
                    compact={compact()}
                    selected={selectedChannel()}
                    onSelect={(id) => selectedChannel.set(id)}
                    notice={() =>
                      currentOs() !== "windows" ? (
                        <Text
                          testID="settings-ocr-windows-only"
                          class="px-1 text-xs text-muted-foreground"
                        >
                          {t("settings.ocr.windowsOnly")}
                        </Text>
                      ) : null
                    }
                    hostServices={modelHostServices("image", props.onNavigateToModels)}
                    getAddButtonRef={() => ocrAddButtonNode}
                    onRegisterAddTrigger={(open) => {
                      openOcrAddDialog = open;
                      return () => {
                        if (openOcrAddDialog === open) openOcrAddDialog = null;
                      };
                    }}
                    onAddBusyChange={(busy) => ocrAddBusy.set(busy)}
                    onDialogOpenChange={(open) => sectionDialogOpen.set(open)}
                  />
                </If>
                <If when={selectedSection() === "tts"}>
                  <CapabilitySection
                    capability="tts"
                    testIdPrefix="settings-tts"
                    registry={getIntegrationRegistry()}
                    collection={ttsChannels}
                    labels={capabilityLabels("tts")}
                    compact={compact()}
                    selected={selectedChannel()}
                    onSelect={(id) => selectedChannel.set(id)}
                    hostServices={{ audio: ttsAudioHost }}
                    getAddButtonRef={() => ttsAddButtonNode}
                    onRegisterAddTrigger={(open) => {
                      openTtsAddDialog = open;
                      return () => {
                        if (openTtsAddDialog === open) openTtsAddDialog = null;
                      };
                    }}
                    onAddBusyChange={(busy) => ttsAddBusy.set(busy)}
                    onDialogOpenChange={(open) => sectionDialogOpen.set(open)}
                  />
                </If>
                <If when={selectedSection() === "wordbook"}>
                  <WordbookSection
                    compact={compact()}
                    onDirtyChange={(dirty) => wordbookDirty.set(dirty)}
                  />
                </If>
              </View>
            </Scroll>
          </View>
        }
      />
      <ConfirmDialog
        testID="settings-wordbook-discard"
        open={pendingWordbookLeave() !== null}
        title={t("settings.wordbook.discardTitle")}
        description={t("settings.wordbook.discardDescription")}
        confirmLabel={t("settings.wordbook.discardConfirm")}
        onOpenChange={(open) => {
          if (!open) pendingWordbookLeave.set(null);
        }}
        onClose={() => {
          if (wordbookDiscardConfirmed) wordbookDiscardConfirmed = false;
        }}
        onConfirm={confirmWordbookDiscard}
      />
    </>
  );
}
