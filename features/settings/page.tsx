import { platform, Scroll, signal, Text, View, windowSize } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { t } from "nsh/i18n";
import { SplitPane } from "../../components/layout/split-pane";
import { motion } from "../../components/motion";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { appearance, appearanceError, selectAppearance, type Appearance } from "./appearance";
import { language, languageError, selectLanguage, type LanguagePreference } from "./language";
import { LanguageDetectionSection } from "./language-detection-section";
import { OcrSection } from "./ocr-section";
import { ShortcutsSection } from "./shortcuts-section";
import type { TranslationShortcutId, TranslationShortcutSetting } from "./shortcuts";
import { selectTransparency, transparency, transparencyError } from "./transparency";

export type SettingsSection = "general" | "appearance" | "shortcuts" | "language-detection" | "ocr";

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
    ],
  },
  {
    id: "integrations",
    labelKey: "settings.groups.integrations",
    sections: [
      { id: "language-detection", labelKey: "settings.sections.languageDetection" },
      { id: "ocr", labelKey: "settings.sections.ocr" },
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
      class={`flex-1 rounded-lg border border-border p-4 checked:border-primary checked:bg-accent hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${motion.navigationFeedback}`}
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

function GeneralSection(props: { compact: boolean }) {
  return (
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
  );
}

function AppearanceSection(props: { compact: boolean }) {
  return (
    <>
      <Card testID="settings-theme-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <SectionHeading title={t("settings.theme.title")} />
        <RadioGroup accessibilityLabel={t("settings.theme.title")} class="flex-row gap-3">
          <ThemeOption value="light" label={t("settings.appearance.light")} />
          <ThemeOption value="dark" label={t("settings.appearance.dark")} />
          <ThemeOption value="system" label={t("settings.appearance.system")} />
        </RadioGroup>
        <If when={appearanceError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {appearanceError()}
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

/** Master-detail Settings workspace with resizable category rail and scrollable detail pane. */
export function SettingsPage(props: {
  platformOs?: string;
  onNavigateToModels?: () => void;
  shortcuts?: Record<TranslationShortcutId, TranslationShortcutSetting>;
}) {
  const compact = () => windowSize().width < 860;
  const currentOs = () => props.platformOs ?? platform.os;
  const activeSectionLabelKey = () => sectionLabelKey(selectedSection());

  return (
    <SplitPane
      page="settings"
      handleAccessibilityLabel={t("settings.resizeLabel")}
      rail={
        <View testID="settings-rail" class="min-w-0 flex-1 bg-background">
          <View class="h-14 shrink-0 flex-row items-center justify-between gap-2 px-4">
            <Text role="header" class="min-w-0 truncate text-sm font-semibold text-foreground">
              {t("settings.title")}
            </Text>
          </View>
          <Scroll class="min-h-0 flex-1">
            <View
              role="navigation"
              accessibilityLabel={t("settings.navLabel")}
              class="gap-5 px-2 pb-4 pt-1"
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
                              onPress={() => selectedSection.set(item().id)}
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
              class={`mx-auto h-14 w-full max-w-4xl flex-row items-center justify-between gap-3 ${compact() ? "px-4" : "px-6"}`}
            >
              <Text role="header" class="min-w-0 truncate text-lg font-semibold text-foreground">
                {t(activeSectionLabelKey())}
              </Text>
            </View>
          </View>
          <Scroll class="min-h-0 flex-1">
            <View
              class={`mx-auto w-full max-w-4xl ${compact() ? "gap-4 px-4 pb-4 pt-1" : "gap-5 px-6 pb-6 pt-2"}`}
            >
              <If when={selectedSection() === "general"}>
                <GeneralSection compact={compact()} />
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
              <If when={selectedSection() === "language-detection"}>
                <LanguageDetectionSection
                  compact={compact()}
                  onManageModels={props.onNavigateToModels}
                />
              </If>
              <If when={selectedSection() === "ocr"}>
                <OcrSection
                  compact={compact()}
                  platformOs={currentOs()}
                  onManageModels={props.onNavigateToModels}
                />
              </If>
            </View>
          </Scroll>
        </View>
      }
    />
  );
}
