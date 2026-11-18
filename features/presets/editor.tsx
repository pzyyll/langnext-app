import { Scroll, Text, View, windowSize, type InputRef, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { FormField } from "../../modules/ai/ui/form-field";
import type { PresetDraft, TargetLanguageValue } from "./draft";
import {
  AUTO_LANGUAGE,
  getLanguageLabel,
  LANGUAGE_IDS,
  NO_PREFERENCE_TARGET,
  type SourceLanguageId,
} from "./languages";
import { resolveModelBindingInfo } from "./model-choices";
import type { ModelChoice, PresetValidationField } from "./types";

interface PresetEditorProps {
  draft: PresetDraft;
  dirty: boolean;
  saving: boolean;
  modelChoices: readonly ModelChoice[];
  modelsError: string | null;
  errorMessage: string | null;
  errorField: PresetValidationField | null;
  autoFocusName: boolean;
  onChange: (patch: Partial<PresetDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
  onManageModels: () => void;
  onNameRef: (node: InputRef) => void;
  onPrimaryModelRef: (node: ViewRef) => void;
}

const SOURCE_LANGUAGE_ITEMS: SelectItem[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS].map((id) => ({
  value: id,
  title: getLanguageLabel(id),
}));

function buildTargetLanguageItems(): SelectItem[] {
  return [
    { value: NO_PREFERENCE_TARGET, title: t("presets.language.noPreference") },
    ...LANGUAGE_IDS.map((id) => ({
      value: id,
      title: getLanguageLabel(id),
    })),
  ];
}

/** Detail-pane editor for creating or editing a translation preset. */
export function PresetEditor(props: PresetEditorProps) {
  const compact = () => windowSize().width < 860;
  const bodyPaddingClass = () => (compact() ? "p-4" : "p-6");
  const cardClass = () => (compact() ? "gap-4 p-4" : "gap-5 p-5");
  const targetLanguageItems = () => buildTargetLanguageItems();

  const fieldError = (field: PresetValidationField): string | null =>
    props.errorField === field ? props.errorMessage : null;

  const canSave = () => {
    if (props.saving) return false;
    if (props.draft.sourceId === null) {
      return props.modelChoices.length > 0 && props.modelsError === null;
    }
    return props.dirty;
  };

  const canCancel = () => {
    if (props.saving) return false;
    return props.draft.sourceId === null || props.dirty;
  };

  const primaryItems = (): SelectItem[] => {
    const items: SelectItem[] = props.modelChoices.map((choice) => ({
      value: choice.id,
      title: choice.label,
    }));
    const currentId = props.draft.primaryModelId;
    if (currentId && !props.modelChoices.some((choice) => choice.id === currentId)) {
      const resolved = resolveModelBindingInfo(currentId);
      items.unshift({ value: currentId, title: resolved.label });
    }
    return items;
  };

  return (
    <View testID="preset-editor" class="min-w-0 flex-1">
      <View class="h-12 shrink-0 flex-row items-center justify-between gap-3 border-b border-border px-6">
        <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
          <Text role="header" class="min-w-0 truncate text-base font-semibold text-foreground">
            {props.draft.name.trim() || t("presets.editor.untitled")}
          </Text>
          <If when={props.dirty || props.draft.sourceId === null}>
            <Badge tone="warning" label={t("presets.editor.unsaved")} />
          </If>
        </View>

        <View class="shrink-0 flex-row items-center gap-2">
          <Switch
            testID="preset-enabled"
            variant="inline"
            label={t("presets.editor.enabled")}
            accessibilityLabel={t("presets.editor.enabledLabel")}
            checked={props.draft.enabled}
            disabled={props.saving}
            onChange={(checked) => props.onChange({ enabled: checked })}
          />
          <Button
            testID="preset-cancel"
            variant="outline"
            size="sm"
            label={t("common.cancel")}
            disabled={!canCancel()}
            onPress={() => props.onCancel()}
          />
          <Button
            testID="preset-save"
            variant="primary"
            size="sm"
            label={props.saving ? t("common.saving") : t("common.save")}
            disabled={!canSave()}
            onPress={() => props.onSave()}
          />
        </View>
      </View>

      <Scroll class="min-h-0 flex-1">
        <View class={`${bodyPaddingClass()} mx-auto w-full max-w-4xl gap-5`}>
          <If when={Boolean(props.errorMessage) && props.errorField === null}>
            <View
              testID="preset-error-banner"
              class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
            >
              <Text role="alert" class="text-sm text-destructive">
                {props.errorMessage}
              </Text>
            </View>
          </If>

          <Card class={cardClass()}>
            <FormField label={t("presets.field.name")} error={fieldError("name")}>
              <Input
                testID="preset-name"
                ref={(node) => props.onNameRef(node)}
                value={props.draft.name}
                placeholder={t("presets.field.namePlaceholder")}
                accessibilityLabel={t("presets.field.name")}
                autoFocus={props.autoFocusName}
                disabled={props.saving}
                onChange={(name) => props.onChange({ name })}
              />
            </FormField>
          </Card>

          <Card class={cardClass()}>
            <SectionHeading title={t("presets.section.languages")} />
            <View class={compact() ? "gap-4" : "flex-row gap-4"}>
              <FormField
                class={compact() ? "" : "min-w-0 flex-1"}
                label={t("presets.field.sourceLanguage")}
                error={fieldError("sourceLanguage")}
              >
                <Select
                  testID="preset-source-language"
                  items={SOURCE_LANGUAGE_ITEMS}
                  value={props.draft.sourceLanguage}
                  disabled={props.saving}
                  accessibilityLabel={t("presets.field.sourceLanguage")}
                  onChange={(value) => {
                    if (value) {
                      props.onChange({ sourceLanguage: value as SourceLanguageId });
                    }
                  }}
                />
              </FormField>

              <FormField
                class={compact() ? "" : "min-w-0 flex-1"}
                label={t("presets.field.targetLanguage")}
                error={fieldError("targetLanguage")}
              >
                <Select
                  testID="preset-target-language"
                  items={targetLanguageItems()}
                  value={props.draft.targetLanguage}
                  disabled={props.saving}
                  accessibilityLabel={t("presets.field.targetLanguage")}
                  onChange={(value) => {
                    if (value) {
                      props.onChange({ targetLanguage: value as TargetLanguageValue });
                    }
                  }}
                />
              </FormField>
            </View>
          </Card>

          <Card class={cardClass()}>
            <SectionHeading title={t("presets.section.models")} />

            <If when={props.modelsError !== null || props.modelChoices.length === 0}>
              <View class="gap-2 rounded-lg border border-border bg-muted/50 p-3">
                <Text role="alert" class="text-xs text-muted-foreground">
                  {props.modelsError !== null
                    ? t("presets.model.catalogLoadError")
                    : t("presets.model.noEligible")}
                </Text>
                <View class="flex-row">
                  <Button
                    testID="preset-manage-models"
                    variant="outline"
                    size="sm"
                    label={t("presets.action.manageModels")}
                    disabled={props.saving}
                    onPress={() => props.onManageModels()}
                  />
                </View>
              </View>
            </If>

            <FormField label={t("presets.model.primary")} error={fieldError("primaryModel")}>
              <Select
                testID="preset-primary-model"
                ref={(node) => props.onPrimaryModelRef(node)}
                items={primaryItems()}
                value={props.draft.primaryModelId}
                placeholder={t("presets.model.selectPlaceholder")}
                disabled={props.saving || primaryItems().length === 0}
                accessibilityLabel={t("presets.model.primary")}
                onChange={(value) => props.onChange({ primaryModelId: value })}
              />
            </FormField>
          </Card>
        </View>
      </Scroll>
    </View>
  );
}
