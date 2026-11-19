import { Scroll, signal, Text, View, windowSize } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { t } from "nsh/i18n";
import { SplitPane } from "../../components/layout/split-pane";
import { motion } from "../../components/motion";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { appearance, appearanceError, selectAppearance, type Appearance } from "./appearance";
import { language, languageError, selectLanguage, type LanguagePreference } from "./language";
import { selectTransparency, transparency, transparencyError } from "./transparency";

export type SettingsSection = "general" | "appearance";

const SETTINGS_SECTIONS: readonly { id: SettingsSection; labelKey: string }[] = [
  { id: "general", labelKey: "settings.sections.general" },
  { id: "appearance", labelKey: "settings.sections.appearance" },
];

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
export function SettingsPage() {
  const compact = () => windowSize().width < 860;
  const activeSectionLabelKey = () =>
    selectedSection() === "general" ? "settings.sections.general" : "settings.sections.appearance";

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
              class="gap-1 px-2 pb-2"
            >
              <Each of={SETTINGS_SECTIONS} key={(item) => item.id}>
                {(item) => {
                  const isSelected = () => selectedSection() === item().id;
                  return (
                    <View
                      class={`rounded-lg border ${motion.navigationFeedback}`}
                      classList={{
                        "border-border bg-accent": isSelected(),
                        "border-transparent hover:bg-accent/50 active:bg-accent": !isSelected(),
                      }}
                    >
                      <Button
                        testID={`settings-nav-${item().id}`}
                        variant="ghost"
                        size="row"
                        selected={isSelected()}
                        accessibilityLabel={t(item().labelKey)}
                        onPress={() => selectedSection.set(item().id)}
                        class="w-full min-w-0 flex-1 hover:bg-transparent active:bg-transparent"
                      >
                        <Text
                          class={
                            isSelected()
                              ? "min-w-0 flex-1 truncate text-sm font-medium text-accent-foreground"
                              : "min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                          }
                        >
                          {t(item().labelKey)}
                        </Text>
                      </Button>
                    </View>
                  );
                }}
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
              <If
                when={selectedSection() === "general"}
                else={<AppearanceSection compact={compact()} />}
              >
                <GeneralSection compact={compact()} />
              </If>
            </View>
          </Scroll>
        </View>
      }
    />
  );
}
