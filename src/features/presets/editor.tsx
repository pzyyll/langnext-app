import { Scroll, Text, View, windowSize, type InputRef, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { FormField } from "../../modules/ai/ui/form-field";
import { DeepLUsageSection } from "./deepl-usage-section";
import type { PresetDraft } from "./draft";
import { ModelsSection } from "./models-section";
import { PromptTemplates, type TemplateEditableField } from "./prompt-templates";
import type { ModelChoice, PresetValidationField, PromptTemplate } from "./types";

export type FocusableEditorField =
  | { kind: "name" | "temperature" | "maxOutputTokens" | "deeplKey" | "googleCloudKey" }
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
  onDeepLKeyRef: (node: InputRef) => void;
  onGoogleCloudKeyRef: (node: InputRef) => void;
  onPrimaryModelRef: (node: ViewRef) => void;
  onFallbackRef: (index: number, node: ViewRef | null) => void;
  onTemperatureRef: (node: InputRef) => void;
  onMaxTokensRef: (node: InputRef) => void;
  onDeleteRef: (node: ViewRef) => void;
  onTemplateFieldRef: (templateId: string, field: TemplateEditableField, node: InputRef) => void;
  onClearTemplateRefs: (templateId: string) => void;
  onFieldFocus: (target: FocusableEditorField) => void;
}

/** Detail-pane editor for creating or editing a translation preset. */
export function PresetEditor(props: PresetEditorProps) {
  const compact = () => windowSize().width < 860;
  const bodyPaddingClass = () => (compact() ? "px-4 pb-4 pt-1" : "px-6 pb-6 pt-2");
  const cardClass = () => (compact() ? "gap-4 p-4" : "gap-5 p-6");

  const fieldError = (field: PresetValidationField): string | null =>
    props.errorField === field ? props.errorMessage : null;

  const canSave = () => {
    if (props.saving) return false;
    if (props.draft.sourceId === null) {
      if (props.draft.engineKind === "deepl" || props.draft.engineKind === "google-cloud") {
        return true;
      }
      return props.modelChoices.length > 0 && props.modelsError === null;
    }
    return props.dirty;
  };

  const isDeepL = () => props.draft.engineKind === "deepl";
  const isGoogleCloud = () => props.draft.engineKind === "google-cloud";
  const isCredentialEngine = () => isDeepL() || isGoogleCloud();

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
    <View testID="preset-editor" class="min-w-0 flex-1 bg-background">
      <View class="shrink-0">
        <View
          class={`mx-auto h-14 w-full max-w-4xl flex-row items-center justify-between gap-3 ${compact() ? "px-4" : "px-6"}`}
        >
          <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
            <Text role="header" class="min-w-0 truncate text-lg font-semibold text-foreground">
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
            <If when={props.draft.sourceId !== null}>
              <View class="h-4 w-px bg-border" />
              <Button
                testID="preset-delete"
                ref={(node) => props.onDeleteRef(node)}
                variant="destructive-ghost"
                size="icon-sm"
                tooltip={t("presets.action.delete")}
                accessibilityLabel={t("presets.action.delete")}
                disabled={props.saving}
                onPress={() => props.onDelete()}
              >
                <Icon name="delete" tone="muted-foreground" class="size-3.5" />
              </Button>
            </If>
          </View>
        </View>
      </View>

      <Scroll class="min-h-0 flex-1">
        <View class={`${bodyPaddingClass()} mx-auto w-full max-w-4xl gap-5`}>
          <If when={Boolean(props.errorMessage) && props.errorField === null}>
            <View
              testID="preset-error-banner"
              class="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3"
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

          <If when={!isCredentialEngine()}>
            <ModelsSection
              primaryModelId={props.draft.primaryModelId}
              fallbackModelIds={props.draft.fallbackModelIds}
              temperatureText={props.draft.temperatureText}
              maxOutputTokensText={props.draft.maxOutputTokensText}
              disableReasoning={props.draft.disableReasoning}
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
              onChangeDisableReasoning={(disableReasoning) => props.onChange({ disableReasoning })}
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
          </If>

          <If when={isGoogleCloud()}>
            <Card class={cardClass()}>
              <FormField
                label={t("presets.googleCloud.keyLabel")}
                error={fieldError("googleCloudKey")}
              >
                <Input
                  testID="preset-google-cloud-api-key"
                  ref={(node) => props.onGoogleCloudKeyRef(node)}
                  masked
                  value={props.draft.googleCloudApiKey}
                  placeholder={
                    props.draft.googleCloudApiKeyStored
                      ? t("presets.googleCloud.keyStored")
                      : t("presets.googleCloud.keyPlaceholder")
                  }
                  accessibilityLabel={t("presets.googleCloud.keyLabel")}
                  disabled={props.saving}
                  onFocus={() => props.onFieldFocus({ kind: "googleCloudKey" })}
                  onChange={(googleCloudApiKey) => props.onChange({ googleCloudApiKey })}
                />
              </FormField>
              <Text class="text-xs text-muted-foreground">
                {t("presets.googleCloud.storageNotice")}
              </Text>
            </Card>
          </If>

          <If when={isDeepL()}>
            <Card class={cardClass()}>
              <FormField label={t("presets.deepl.keyLabel")} error={fieldError("deeplKey")}>
                <Input
                  testID="preset-deepl-api-key"
                  ref={(node) => props.onDeepLKeyRef(node)}
                  masked
                  value={props.draft.deepLApiKey}
                  placeholder={
                    props.draft.deepLApiKeyStored
                      ? t("presets.deepl.keyStored")
                      : t("presets.deepl.keyPlaceholder")
                  }
                  accessibilityLabel={t("presets.deepl.keyLabel")}
                  disabled={props.saving}
                  onFocus={() => props.onFieldFocus({ kind: "deeplKey" })}
                  onChange={(deepLApiKey) => props.onChange({ deepLApiKey })}
                />
              </FormField>
            </Card>

            <If when={props.draft.sourceId !== null}>
              <DeepLUsageSection presetId={props.draft.sourceId!} />
            </If>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
