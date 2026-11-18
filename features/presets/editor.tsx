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
import { ModelsSection } from "./models-section";
import { PromptTemplates, type TemplateEditableField } from "./prompt-templates";
import type { ModelChoice, PresetValidationField, PromptTemplate } from "./types";

export type FocusableEditorField =
  | { kind: "name" | "temperature" | "maxOutputTokens" }
  | { kind: "template"; templateId: string; field: TemplateEditableField };

interface PresetEditorProps {
  draft: PresetDraft;
  dirty: boolean;
  saving: boolean;
  selectedTemplateId: string | null;
  modelChoices: readonly ModelChoice[];
  modelsError: string | null;
  errorMessage: string | null;
  errorField: PresetValidationField | null;
  errorFallbackIndex: number | null;
  errorTemplateId: string | null;
  autoFocusName: boolean;
  onChange: (patch: Partial<PresetDraft>) => void;
  onSelectTemplate: (templateId: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onManageModels: () => void;
  onNameRef: (node: InputRef) => void;
  onPrimaryModelRef: (node: ViewRef) => void;
  onFallbackRef: (index: number, node: ViewRef | null) => void;
  onTemperatureRef: (node: InputRef) => void;
  onMaxTokensRef: (node: InputRef) => void;
  onDeleteRef: (node: ViewRef) => void;
  onTemplateFieldRef: (templateId: string, field: TemplateEditableField, node: InputRef) => void;
  onClearTemplateRefs: (templateId: string) => void;
  onFieldFocus: (target: FocusableEditorField) => void;
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

  const addFallback = () => {
    props.onChange({ fallbackModelIds: [...props.draft.fallbackModelIds, ""] });
  };

  const changeFallback = (index: number, modelId: string) => {
    const next = [...props.draft.fallbackModelIds];
    next[index] = modelId;
    props.onChange({ fallbackModelIds: next });
  };

  const moveFallback = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= props.draft.fallbackModelIds.length) return;
    const next = [...props.draft.fallbackModelIds];
    const moving = next[index]!;
    next[index] = next[targetIndex]!;
    next[targetIndex] = moving;
    props.onChange({ fallbackModelIds: next });
  };

  const removeFallback = (index: number) => {
    const next = props.draft.fallbackModelIds.filter((_, i) => i !== index);
    props.onChange({ fallbackModelIds: next });
  };

  const addTemplate = () => {
    const usedNames = new Set(props.draft.templates.map((tpl) => tpl.name.trim()));
    let num = props.draft.templates.length + 1;
    let name = t("presets.prompt.numberedName", { index: num });
    while (usedNames.has(name)) {
      num += 1;
      name = t("presets.prompt.numberedName", { index: num });
    }
    const created: PromptTemplate = {
      id: crypto.randomUUID(),
      name,
      systemTemplate: t("presets.prompt.defaultSystem"),
      userTemplate: t("presets.prompt.defaultUser"),
    };
    props.onChange({ templates: [...props.draft.templates, created] });
    props.onSelectTemplate(created.id);
  };

  const updateTemplate = (templateId: string, patch: Partial<PromptTemplate>) => {
    const next = props.draft.templates.map((tpl) =>
      tpl.id === templateId ? { ...tpl, ...patch } : tpl,
    );
    props.onChange({ templates: next });
  };

  const setDefaultTemplate = (templateId: string) => {
    props.onChange({ defaultTemplateId: templateId });
  };

  const removeTemplate = (templateId: string) => {
    if (props.draft.templates.length <= 1 || templateId === props.draft.defaultTemplateId) {
      return;
    }
    const index = props.draft.templates.findIndex((tpl) => tpl.id === templateId);
    if (index === -1) return;
    const next = props.draft.templates.filter((tpl) => tpl.id !== templateId);
    const nextSelected = next[Math.min(index, next.length - 1)]?.id ?? null;
    props.onChange({ templates: next });
    if (nextSelected) {
      props.onSelectTemplate(nextSelected);
    }
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
                onFocus={() => props.onFieldFocus({ kind: "name" })}
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

          <ModelsSection
            primaryModelId={props.draft.primaryModelId}
            fallbackModelIds={props.draft.fallbackModelIds}
            temperatureText={props.draft.temperatureText}
            maxOutputTokensText={props.draft.maxOutputTokensText}
            saving={props.saving}
            modelChoices={props.modelChoices}
            modelsError={props.modelsError}
            errorMessage={props.errorMessage}
            errorField={props.errorField}
            errorFallbackIndex={props.errorFallbackIndex}
            onChangePrimary={(primaryModelId) => props.onChange({ primaryModelId })}
            onAddFallback={() => addFallback()}
            onChangeFallback={(index, id) => changeFallback(index, id)}
            onMoveFallback={(index, direction) => moveFallback(index, direction)}
            onRemoveFallback={(index) => removeFallback(index)}
            onChangeTemperature={(temperatureText) => props.onChange({ temperatureText })}
            onChangeMaxOutputTokens={(maxOutputTokensText) =>
              props.onChange({ maxOutputTokensText })
            }
            onManageModels={() => props.onManageModels()}
            onPrimaryModelRef={(node) => props.onPrimaryModelRef(node)}
            onFallbackRef={(index, node) => props.onFallbackRef(index, node)}
            onTemperatureRef={(node) => props.onTemperatureRef(node)}
            onMaxTokensRef={(node) => props.onMaxTokensRef(node)}
            onFieldFocus={(field) => props.onFieldFocus({ kind: field })}
          />

          <PromptTemplates
            templates={props.draft.templates}
            defaultTemplateId={props.draft.defaultTemplateId}
            selectedTemplateId={props.selectedTemplateId}
            saving={props.saving}
            errorMessage={props.errorMessage}
            errorField={props.errorField}
            errorTemplateId={props.errorTemplateId}
            onSelectTemplate={(id) => props.onSelectTemplate(id)}
            onAddTemplate={() => addTemplate()}
            onUpdateTemplate={(id, patch) => updateTemplate(id, patch)}
            onSetDefault={(id) => setDefaultTemplate(id)}
            onRemoveTemplate={(id) => removeTemplate(id)}
            onTemplateFieldRef={(tplId, field, node) =>
              props.onTemplateFieldRef(tplId, field, node)
            }
            onTemplateFieldFocus={(templateId, field) =>
              props.onFieldFocus({ kind: "template", templateId, field })
            }
            onClearTemplateRefs={(tplId) => props.onClearTemplateRefs(tplId)}
          />

          <If when={props.draft.sourceId !== null}>
            <View class="flex-row justify-end">
              <Button
                testID="preset-delete"
                ref={(node) => props.onDeleteRef(node)}
                variant="destructive-outline"
                size="sm"
                label={t("presets.action.delete")}
                disabled={props.saving}
                onPress={() => props.onDelete()}
              />
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
