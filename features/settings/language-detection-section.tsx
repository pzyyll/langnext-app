import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Select, type SelectItem } from "../../components/ui/select";
import { FormField } from "../../modules/ai/ui/form-field";
import {
  languageDetectionStore,
  type LanguageDetectionMode,
  type LanguageDetectionSettings,
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

/** Detection modes in display order; each value is stored unchanged. */
const MODE_CHOICES: readonly LanguageDetectionMode[] = ["off", "ai", "google"];

function modeItems(): SelectItem[] {
  return MODE_CHOICES.map((mode) => ({
    value: mode,
    title: t(`settings.languageDetection.${mode}`),
  }));
}

function languageItems(): SelectItem[] {
  return [
    { value: UNSET_LANGUAGE_CHOICE, title: t("settings.languageDetection.preferenceUnset") },
    ...LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) })),
  ];
}

interface LanguageDetectionSectionProps {
  compact: boolean;
  onManageModels?: () => void;
}

/** Settings section for the saved detector mode, model chain, and language preferences. */
export function LanguageDetectionSection(props: LanguageDetectionSectionProps) {
  const initial = languageDetectionStore.settings();
  const draft = signal<LanguageDetectionSettings>({
    mode: initial.mode,
    modelIds: [...initial.modelIds],
    nativeLanguage: initial.nativeLanguage,
    preferredTranslationLanguage: initial.preferredTranslationLanguage,
  });
  const error = signal<string | null>(null);
  const saving = signal(false);

  const modelChoices = () => readAvailableModelChoices();
  const showCatalogBanner = () =>
    modelsStore.channelsError() !== null || modelChoices().length === 0;
  const primaryId = () => draft().modelIds[0] ?? null;
  const backupIds = () => draft().modelIds.slice(1);

  const updateModelIds = (modelIds: string[]) => {
    draft.set({ ...draft(), modelIds });
  };

  const setMode = (mode: LanguageDetectionMode) => {
    if (saving()) return;
    error.set(null);
    draft.set({ ...draft(), mode });
  };

  const setPrimary = (modelId: string | null) => {
    if (!modelId) return;
    const backups = backupIds();
    updateModelIds([modelId, ...backups]);
  };

  const nextBackup = () => {
    if (saving() || primaryId() === null) return undefined;
    const assigned = new Set(draft().modelIds);
    return modelChoices().find((choice) => !assigned.has(choice.id));
  };

  const addBackup = () => {
    const candidate = nextBackup();
    if (!candidate) return;
    updateModelIds([...draft().modelIds, candidate.id]);
  };

  const setBackup = (index: number, modelId: string | null) => {
    if (!modelId) return;
    const modelIds = [...draft().modelIds];
    modelIds[index + 1] = modelId;
    updateModelIds(modelIds);
  };

  const moveBackup = (index: number, direction: "up" | "down") => {
    const modelIds = [...draft().modelIds];
    const target = index + 1;
    const swapWith = direction === "up" ? target - 1 : target + 1;
    if (swapWith < 1 || swapWith >= modelIds.length) return;
    const moving = modelIds[target]!;
    modelIds[target] = modelIds[swapWith]!;
    modelIds[swapWith] = moving;
    updateModelIds(modelIds);
  };

  const removeBackup = (index: number) => {
    const modelIds = [...draft().modelIds];
    modelIds.splice(index + 1, 1);
    updateModelIds(modelIds);
  };

  const primaryItems = (): SelectItem[] => {
    const usedByBackups = new Set(backupIds().filter((id) => id.length > 0));
    const items: SelectItem[] = modelChoices()
      .filter((choice) => !usedByBackups.has(choice.id))
      .map((choice) => ({ value: choice.id, title: choice.label }));
    const currentId = primaryId();
    if (currentId && !modelChoices().some((choice) => choice.id === currentId)) {
      items.unshift({ value: currentId, title: resolveModelBindingInfo(currentId).label });
    }
    return items;
  };

  const backupItems = (rowIndex: number): SelectItem[] => {
    const usedElsewhere = new Set<string>();
    const currentId = draft().modelIds[rowIndex + 1] ?? "";
    if (primaryId()) usedElsewhere.add(primaryId()!);
    draft().modelIds.forEach((id, index) => {
      if (index !== 0 && index !== rowIndex + 1 && id.length > 0) usedElsewhere.add(id);
    });

    const items: SelectItem[] = modelChoices()
      .filter((choice) => !usedElsewhere.has(choice.id))
      .map((choice) => ({ value: choice.id, title: choice.label }));
    if (currentId && !modelChoices().some((choice) => choice.id === currentId)) {
      items.unshift({ value: currentId, title: resolveModelBindingInfo(currentId).label });
    }
    return items;
  };

  const hasUnavailableBinding = () =>
    draft()
      .modelIds.filter((id) => id.length > 0)
      .some((id) => !resolveModelBindingInfo(id).available);

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
      const result = await languageDetectionStore.save({
        ...draft(),
        modelIds: [...draft().modelIds],
      });
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      draft.set({ ...result.settings, modelIds: [...result.settings.modelIds] });
    } finally {
      saving.set(false);
    }
  };

  const cardClass = () => (props.compact ? "gap-4 p-4" : "gap-5 p-6");

  return (
    <Card testID="settings-detection-card" class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("settings.languageDetection.title")} />
        <If when={!showCatalogBanner() && hasUnavailableBinding()}>
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

      <If when={languageDetectionStore.loadError() !== null}>
        <Text testID="settings-detection-load-error" role="alert" class="text-sm text-destructive">
          {languageDetectionStore.loadError()!.message}
        </Text>
      </If>

      <View class="gap-2">
        <FormField label={t("settings.languageDetection.detection")}>
          <Select
            testID="settings-detection-mode"
            items={modeItems()}
            value={draft().mode}
            disabled={saving()}
            accessibilityLabel={t("settings.languageDetection.detection")}
            onChange={(value) => {
              if (value === null || !MODE_CHOICES.includes(value as LanguageDetectionMode)) return;
              setMode(value as LanguageDetectionMode);
            }}
          />
        </FormField>
      </View>

      <If when={draft().mode === "ai"}>
        <View class="gap-5">
          <If when={showCatalogBanner()}>
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

          <FormField label={t("settings.languageDetection.primary")}>
            <Select
              testID="settings-detection-primary"
              items={primaryItems()}
              value={primaryId()}
              placeholder={t("presets.model.selectPlaceholder")}
              disabled={saving() || primaryItems().length === 0}
              accessibilityLabel={t("settings.languageDetection.primary")}
              onChange={setPrimary}
            />
            <If when={primaryId() !== null && !resolveModelBindingInfo(primaryId()!).available}>
              <Text testID="settings-detection-primary-unavailable" class="text-xs text-warning">
                {resolveModelBindingInfo(primaryId()!).reason}
              </Text>
            </If>
          </FormField>

          <View class="gap-2">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-xs font-medium text-foreground">
                {t("settings.languageDetection.backups")}
              </Text>
              <Button
                testID="settings-detection-add-backup"
                variant="outline"
                size="xs"
                label={t("settings.languageDetection.addBackup")}
                disabled={nextBackup() === undefined}
                onPress={addBackup}
              />
            </View>

            <If when={backupIds().length > 0}>
              <View class="gap-2">
                <Each of={backupIds()} key="index">
                  {(modelId, index) => {
                    const binding = () => resolveModelBindingInfo(modelId());
                    return (
                      <View testID={`settings-detection-backup-row-${index()}`} class="gap-1">
                        <View class="flex-row items-center gap-2">
                          <View class="min-w-0 flex-1">
                            <Select
                              testID={`settings-detection-backup-${index()}`}
                              items={backupItems(index())}
                              value={modelId()}
                              placeholder={t("presets.model.selectPlaceholder")}
                              disabled={saving() || backupItems(index()).length === 0}
                              accessibilityLabel={t("presets.model.fallbackItemLabel", {
                                index: index() + 1,
                              })}
                              onChange={(value) => setBackup(index(), value)}
                            />
                          </View>
                          <Button
                            testID={`settings-detection-backup-up-${index()}`}
                            variant="ghost"
                            size="icon-sm"
                            tooltip={t("settings.languageDetection.moveUp", { index: index() + 1 })}
                            accessibilityLabel={t("settings.languageDetection.moveUp", {
                              index: index() + 1,
                            })}
                            disabled={saving() || index() === 0}
                            onPress={() => moveBackup(index(), "up")}
                          >
                            <Icon name="arrow-up" tone="muted-foreground" class="size-3.5" />
                          </Button>
                          <Button
                            testID={`settings-detection-backup-down-${index()}`}
                            variant="ghost"
                            size="icon-sm"
                            tooltip={t("settings.languageDetection.moveDown", {
                              index: index() + 1,
                            })}
                            accessibilityLabel={t("settings.languageDetection.moveDown", {
                              index: index() + 1,
                            })}
                            disabled={saving() || index() === backupIds().length - 1}
                            onPress={() => moveBackup(index(), "down")}
                          >
                            <Icon name="arrow-down" tone="muted-foreground" class="size-3.5" />
                          </Button>
                          <Button
                            testID={`settings-detection-backup-remove-${index()}`}
                            variant="ghost"
                            size="icon-sm"
                            tooltip={t("settings.languageDetection.removeBackup", {
                              index: index() + 1,
                            })}
                            accessibilityLabel={t("settings.languageDetection.removeBackup", {
                              index: index() + 1,
                            })}
                            disabled={saving()}
                            onPress={() => removeBackup(index())}
                          >
                            <Icon name="close" tone="muted-foreground" class="size-3.5" />
                          </Button>
                        </View>
                        <If when={!binding().available}>
                          <Text
                            testID={`settings-detection-backup-unavailable-${index()}`}
                            class="text-xs text-warning"
                          >
                            {binding().reason}
                          </Text>
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </If>
          </View>
        </View>
      </If>

      <View class={props.compact ? "gap-4" : "flex-row gap-4"}>
        <FormField
          class={props.compact ? "" : "min-w-0 flex-1"}
          label={t("settings.languageDetection.nativeLanguage")}
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

      <Text testID="settings-detection-help" class="text-xs text-muted-foreground">
        {t("settings.languageDetection.help")}
      </Text>

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
