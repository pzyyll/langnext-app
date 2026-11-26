// ABOUTME: Automatic language-detection preferences card, mounted inside the detection capability host.
import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Card, SectionHeading } from "../../components/ui/card";
import { Select, type SelectItem } from "../../components/ui/select";
import { getLanguageLabel, isLanguageId, LANGUAGE_IDS } from "../../framework/languages";
import { FormField } from "../../modules/ai/ui/form-field";
import { languageDetectionPreferences } from "../language-detection/preferences";

/** Select value for an unset language preference (`null` in storage). */
const UNSET_LANGUAGE_CHOICE = "__unset__";

type PreferenceField = "nativeLanguage" | "preferredTranslationLanguage";

function languageItems(): SelectItem[] {
  return [
    { value: UNSET_LANGUAGE_CHOICE, title: t("settings.languageDetection.preferenceUnset") },
    ...LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) })),
  ];
}

/** Native and preferred translation language used by an Automatic target. */
export function DetectionPreferencesCard(props: { compact: boolean }) {
  const error = signal<string | null>(null);
  const loadError = () => languageDetectionPreferences.loadError();

  const preferenceValue = (field: PreferenceField): string =>
    languageDetectionPreferences.preferences()[field] ?? UNSET_LANGUAGE_CHOICE;

  const selectPreference = async (field: PreferenceField, value: string | null) => {
    if (value === null || loadError() !== null) return;
    if (value !== UNSET_LANGUAGE_CHOICE && !isLanguageId(value)) return;
    error.set(null);
    const result = await languageDetectionPreferences.setPreference(
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
            disabled={loadError() !== null}
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
            disabled={loadError() !== null}
            accessibilityLabel={t("settings.languageDetection.preferredTranslation")}
            onChange={(value) => void selectPreference("preferredTranslationLanguage", value)}
          />
        </FormField>
      </View>

      <If when={loadError() !== null}>
        <Text
          testID="settings-detection-preferences-error"
          role="alert"
          class="text-sm text-destructive"
        >
          {loadError()!.message}
        </Text>
      </If>
      <If when={loadError() === null && error() !== null}>
        <Text testID="settings-detection-error" role="alert" class="text-sm text-destructive">
          {error()}
        </Text>
      </If>
    </Card>
  );
}
