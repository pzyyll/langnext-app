import { cleanup, Text, View, windowSize, type InputRef } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { FormField } from "../../modules/ai/ui/form-field";
import type { PresetValidationField, PromptTemplate } from "./types";

export type TemplateEditableField = "templateName" | "systemTemplate" | "userTemplate";

interface PromptTemplatesProps {
  templates: readonly PromptTemplate[];
  defaultTemplateId: string;
  selectedTemplateId: string | null;
  saving: boolean;
  errorMessage: string | null;
  errorField: PresetValidationField | null;
  errorTemplateId: string | null;
  onSelectTemplate: (templateId: string) => void;
  onAddTemplate: () => void;
  onUpdateTemplate: (templateId: string, patch: Partial<PromptTemplate>) => void;
  onSetDefault: (templateId: string) => void;
  onRemoveTemplate: (templateId: string) => void;
  onTemplateFieldRef: (templateId: string, field: TemplateEditableField, node: InputRef) => void;
  onTemplateFieldFocus: (templateId: string, field: TemplateEditableField) => void;
  onClearTemplateRefs: (templateId: string) => void;
}

const TEMPLATE_VARIABLES = "{{source_language}}, {{target_language}}, {{text}}";

/** Editor card for managing multiple named prompt templates and the preset's default template. */
export function PromptTemplates(props: PromptTemplatesProps) {
  const compact = () => windowSize().width < 860;
  const cardClass = () => (compact() ? "gap-4 p-4" : "gap-5 p-5");

  const activeTemplate = (): PromptTemplate | null =>
    props.templates.find((tpl) => tpl.id === props.selectedTemplateId) ??
    props.templates[0] ??
    null;

  const selectedList = (): PromptTemplate[] => {
    const current = activeTemplate();
    return current ? [current] : [];
  };

  const templateFieldError = (templateId: string, field: TemplateEditableField): string | null => {
    if (props.errorField !== field) return null;
    if (props.errorTemplateId && props.errorTemplateId !== templateId) return null;
    return props.errorMessage;
  };

  const sectionError = () =>
    props.errorField === "templates" || props.errorField === "defaultTemplate"
      ? props.errorMessage
      : null;

  return (
    <Card class={cardClass()}>
      <View class="flex-row items-center justify-between gap-2">
        <SectionHeading title={t("presets.section.prompts")} />
        <Button
          testID="preset-add-template"
          variant="outline"
          size="xs"
          label={t("presets.prompt.add")}
          disabled={props.saving}
          onPress={() => props.onAddTemplate()}
        />
      </View>

      <If when={sectionError() !== null}>
        <Text role="alert" class="text-xs text-destructive">
          {sectionError()}
        </Text>
      </If>

      <View class={compact() ? "gap-4" : "flex-row items-start gap-4"}>
        <View class={compact() ? "gap-1" : "w-52 shrink-0 gap-1"}>
          <Each of={props.templates} key={(tpl) => tpl.id}>
            {(tpl, index) => {
              const isSelected = () => activeTemplate()?.id === tpl().id;
              const isDefault = () => tpl().id === props.defaultTemplateId;
              const label = () =>
                tpl().name.trim() || t("presets.prompt.numberedName", { index: index() + 1 });
              return (
                <View
                  class={`rounded-lg border ${motion.navigationFeedback}`}
                  classList={{
                    "border-border bg-accent": isSelected(),
                    "border-transparent hover:bg-accent/50 active:bg-accent": !isSelected(),
                  }}
                >
                  <Button
                    testID={`preset-template-item-${index()}`}
                    variant="ghost"
                    size="row"
                    selected={isSelected()}
                    accessibilityLabel={label()}
                    onPress={() => props.onSelectTemplate(tpl().id)}
                    class="w-full min-w-0 flex-1 hover:bg-transparent active:bg-transparent"
                  >
                    <View class="min-w-0 flex-1 flex-row items-center justify-between gap-2">
                      <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                        {label()}
                      </Text>
                      <If when={isDefault()}>
                        <Badge
                          testID="preset-template-default-badge"
                          tone="primary"
                          label={t("presets.prompt.defaultBadge")}
                        />
                      </If>
                    </View>
                  </Button>
                </View>
              );
            }}
          </Each>
        </View>

        <View class={compact() ? "gap-4" : "min-w-0 flex-1 gap-4"}>
          <Each of={selectedList()} key={(tpl) => tpl.id}>
            {(tpl) => {
              const templateId = tpl().id;
              cleanup(() => props.onClearTemplateRefs(templateId));
              const isDefault = () => tpl().id === props.defaultTemplateId;
              const canRemove = () => !props.saving && props.templates.length > 1 && !isDefault();
              return (
                <View class="gap-4 rounded-xl border border-border bg-background/60 p-4">
                  <View class="flex-row flex-wrap items-center justify-end gap-2">
                    <Button
                      testID="preset-template-set-default"
                      variant="outline"
                      size="xs"
                      label={t("presets.prompt.setDefault")}
                      disabled={props.saving || isDefault()}
                      onPress={() => props.onSetDefault(tpl().id)}
                    />
                    <Button
                      testID="preset-template-remove"
                      variant="destructive-outline"
                      size="xs"
                      label={t("presets.prompt.remove")}
                      accessibilityLabel={t("presets.prompt.removeLabel", {
                        name: tpl().name.trim() || t("presets.prompt.defaultName"),
                      })}
                      disabled={!canRemove()}
                      onPress={() => props.onRemoveTemplate(tpl().id)}
                    />
                  </View>

                  <FormField
                    label={t("presets.prompt.nameLabel")}
                    error={templateFieldError(tpl().id, "templateName")}
                  >
                    <Input
                      testID="preset-template-name"
                      ref={(node) => props.onTemplateFieldRef(tpl().id, "templateName", node)}
                      value={tpl().name}
                      placeholder={t("presets.prompt.namePlaceholder")}
                      accessibilityLabel={t("presets.prompt.nameLabel")}
                      disabled={props.saving}
                      onFocus={() => props.onTemplateFieldFocus(tpl().id, "templateName")}
                      onChange={(name) => props.onUpdateTemplate(tpl().id, { name })}
                    />
                  </FormField>

                  <FormField
                    label={t("presets.prompt.systemLabel")}
                    error={templateFieldError(tpl().id, "systemTemplate")}
                  >
                    <Textarea
                      testID="preset-template-system"
                      ref={(node) => props.onTemplateFieldRef(tpl().id, "systemTemplate", node)}
                      value={tpl().systemTemplate}
                      accessibilityLabel={t("presets.prompt.systemLabel")}
                      disabled={props.saving}
                      onFocus={() => props.onTemplateFieldFocus(tpl().id, "systemTemplate")}
                      onChange={(systemTemplate) =>
                        props.onUpdateTemplate(tpl().id, { systemTemplate })
                      }
                    />
                  </FormField>

                  <FormField
                    label={t("presets.prompt.userLabel")}
                    hint={t("presets.prompt.variablesHint", { vars: TEMPLATE_VARIABLES })}
                    error={templateFieldError(tpl().id, "userTemplate")}
                  >
                    <Textarea
                      testID="preset-template-user"
                      ref={(node) => props.onTemplateFieldRef(tpl().id, "userTemplate", node)}
                      value={tpl().userTemplate}
                      accessibilityLabel={t("presets.prompt.userLabel")}
                      disabled={props.saving}
                      onFocus={() => props.onTemplateFieldFocus(tpl().id, "userTemplate")}
                      onChange={(userTemplate) =>
                        props.onUpdateTemplate(tpl().id, { userTemplate })
                      }
                    />
                  </FormField>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </Card>
  );
}
