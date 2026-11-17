import { Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { t } from "nsh/i18n";
import { Switch } from "../../components/ui/switch";
import { appearance, appearanceError, selectAppearance, type Appearance } from "./appearance";
import { language, languageError, selectLanguage, type LanguagePreference } from "./language";
import { selectTransparency, transparency, transparencyError } from "./transparency";

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
      class="flex-1 rounded-lg border border-border p-4 checked:border-primary checked:bg-accent hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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

/** Settings owns its controls only; the shell's PageSurface owns the page's
 * scrolling, width and padding. */
export function SettingsPage() {
  return (
    <>
      <Text role="header" class="text-2xl font-semibold text-foreground">
        {t("settings.title")}
      </Text>
      <View class="gap-5 rounded-xl border border-border bg-card p-6">
        <Text role="header" class="text-base font-semibold text-card-foreground">
          {t("settings.appearance.title")}
        </Text>
        <RadioGroup class="flex-row gap-3">
          <ThemeOption value="light" label={t("settings.appearance.light")} />
          <ThemeOption value="dark" label={t("settings.appearance.dark")} />
          <ThemeOption value="system" label={t("settings.appearance.system")} />
        </RadioGroup>
        <If when={appearanceError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {appearanceError()}
          </Text>
        </If>
        <Switch
          label={t("settings.transparency.label")}
          checked={transparency()}
          onChange={(checked) => void selectTransparency(checked)}
        />
        <If when={transparencyError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {transparencyError()}
          </Text>
        </If>
      </View>
      <View class="gap-5 rounded-xl border border-border bg-card p-6">
        <Text role="header" class="text-base font-semibold text-card-foreground">
          {t("settings.language.title")}
        </Text>
        <RadioGroup class="flex-row gap-3">
          <LanguageOption value="system" label={t("settings.language.system")} />
          <LanguageOption value="en" label={t("settings.language.en")} />
          <LanguageOption value="zh-CN" label={t("settings.language.zh-CN")} />
        </RadioGroup>
        <If when={languageError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {languageError()}
          </Text>
        </If>
      </View>
    </>
  );
}
