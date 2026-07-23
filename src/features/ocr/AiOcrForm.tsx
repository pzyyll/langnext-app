// ABOUTME: AI OCR form fields for model, temperature, and multi prompt templates.
// ABOUTME: Template UX follows Profiles (collapsible cards, default radio, min one).
import { useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useTranslation } from "react-i18next";
import ExpandCircleDownOutlineIcon from "~icons/material-symbols/expand-circle-down-outline";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import { SelectField } from "../../components/SelectField";
import {
  dangerIconButtonClassName,
  iconButtonClassName,
  inputClassName,
  outlineButtonClassName,
  radioClassName,
  radioIndicatorClassName,
} from "../../components/ui";
import type { OcrPromptTemplate, ProviderInstanceDto, ProviderModelDto } from "../../storage/types";
import {
  DEFAULT_AI_OCR_SYSTEM_TEMPLATE,
  DEFAULT_AI_OCR_TEMPERATURE,
  DEFAULT_AI_OCR_USER_TEMPLATE,
} from "./defaultAiOcrPrompt";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

const templateTextareaClassName =
  "min-h-28 w-full resize-y rounded-none border border-line bg-surface p-3 font-mono text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

const promptTemplateCardClassName = "shadow-frame border border-line bg-surface";

const promptTemplateCardHeaderClassName =
  "group flex flex-wrap items-center justify-between gap-3 p-4 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-panel-open:border-b data-panel-open:border-outline-variant";

const promptTemplateCardPanelClassName =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden";

const promptTemplateCardBodyClassName = "space-y-4 p-4";

const promptTemplateTitleClassName = "min-w-0 truncate text-title-dialog font-bold text-on-surface";

const promptTemplateRenameInputClassName =
  "h-control-height min-w-0 flex-1 max-w-md rounded-none border border-line bg-surface px-2 text-title-dialog font-bold text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

function modelLabel(model: ProviderModelDto, providers: readonly ProviderInstanceDto[]): string {
  const providerName = providers.find((provider) => provider.id === model.providerInstanceId)?.displayName ?? "—";
  const modelName = model.displayNameOverride ?? model.remoteDisplayName ?? model.modelKey;
  return `${providerName} / ${modelName}`;
}

export type AiOcrFormProps = {
  providerModelId: string;
  temperature: string;
  defaultPromptTemplateId: string;
  promptTemplates: OcrPromptTemplate[];
  models: readonly ProviderModelDto[];
  providers: readonly ProviderInstanceDto[];
  disabled?: boolean;
  onProviderModelIdChange: (value: string) => void;
  onTemperatureChange: (value: string) => void;
  onDefaultPromptTemplateIdChange: (value: string) => void;
  onPromptTemplatesChange: (templates: OcrPromptTemplate[]) => void;
};

export function AiOcrForm({
  providerModelId,
  temperature,
  defaultPromptTemplateId,
  promptTemplates,
  models,
  providers,
  disabled = false,
  onProviderModelIdChange,
  onTemperatureChange,
  onDefaultPromptTemplateIdChange,
  onPromptTemplatesChange,
}: AiOcrFormProps) {
  const { t } = useTranslation();
  const [collapsedTemplateIds, setCollapsedTemplateIds] = useState<Set<string>>(() => new Set());
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const imageModels = useMemo(
    () => models.filter((model) => model.capabilityOverridesJson?.imageAnalysis === true),
    [models],
  );

  const modelOptions = useMemo(
    () =>
      imageModels
        .filter((model) => model.enabled || model.id === providerModelId)
        .map((model) => ({
          value: model.id,
          label: modelLabel(model, providers),
          disabled: !model.enabled && model.id !== providerModelId,
        })),
    [imageModels, providers, providerModelId],
  );

  const modelExists = imageModels.some((model) => model.id === providerModelId);

  function setTemplateOpen(templateId: string, open: boolean) {
    setCollapsedTemplateIds((current) => {
      const next = new Set(current);
      if (open) {
        next.delete(templateId);
      } else {
        next.add(templateId);
      }
      return next;
    });
  }

  function updateTemplate(templateId: string, patch: Partial<OcrPromptTemplate>) {
    onPromptTemplatesChange(
      promptTemplates.map((template) => (template.id === templateId ? { ...template, ...patch } : template)),
    );
  }

  function addTemplate() {
    const id = crypto.randomUUID();
    const nextIndex = promptTemplates.length + 1;
    onPromptTemplatesChange([
      ...promptTemplates,
      {
        id,
        name: t("ocr.ai.templateCardTitle", { index: nextIndex }),
        systemTemplate: DEFAULT_AI_OCR_SYSTEM_TEMPLATE,
        userTemplate: DEFAULT_AI_OCR_USER_TEMPLATE,
      },
    ]);
    setCollapsedTemplateIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function removeTemplate(templateId: string) {
    if (promptTemplates.length <= 1) {
      return;
    }
    const remaining = promptTemplates.filter((template) => template.id !== templateId);
    onPromptTemplatesChange(remaining);
    if (defaultPromptTemplateId === templateId) {
      onDefaultPromptTemplateIdChange(remaining[0]!.id);
    }
    setCollapsedTemplateIds((current) => {
      if (!current.has(templateId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(templateId);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <span className={fieldLabelClassName}>{t("ocr.ai.model")}</span>
        <SelectField
          value={providerModelId}
          onValueChange={(value) => {
            if (value) {
              onProviderModelIdChange(value);
            }
          }}
          options={modelOptions}
          extraOptions={
            providerModelId && !modelExists
              ? [{ value: providerModelId, label: t("ocr.ai.missingModel"), disabled: true }]
              : undefined
          }
          disabled={disabled}
          placeholder={t("ocr.ai.modelPlaceholder")}
          aria-label={t("ocr.ai.model")}
        />
        {!modelExists && providerModelId ? (
          <p className="text-body-tight text-error" role="alert">
            {t("ocr.ai.missingModelHint")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="ocr-ai-temperature">
          {t("ocr.ai.temperature")}
        </label>
        <Input
          id="ocr-ai-temperature"
          className={inputClassName}
          inputMode="decimal"
          value={temperature}
          disabled={disabled}
          placeholder={String(DEFAULT_AI_OCR_TEMPERATURE)}
          onChange={(event) => {
            onTemperatureChange(event.currentTarget.value);
          }}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className={fieldLabelClassName}>{t("ocr.ai.promptTemplates")}</span>
          <Button type="button" className={outlineButtonClassName} disabled={disabled} onClick={addTemplate}>
            {t("ocr.ai.addTemplate")}
          </Button>
        </div>

        <RadioGroup
          value={defaultPromptTemplateId}
          onValueChange={(value) => {
            if (value) {
              onDefaultPromptTemplateIdChange(value);
            }
          }}
          className="space-y-4"
          disabled={disabled}
        >
          {promptTemplates.map((template) => {
            const canRemove = promptTemplates.length > 1;
            const isRenaming = renamingTemplateId === template.id;
            const isOpen = !collapsedTemplateIds.has(template.id);
            return (
              <Collapsible.Root
                key={template.id}
                open={isOpen}
                onOpenChange={(open) => {
                  setTemplateOpen(template.id, open);
                }}
                className={promptTemplateCardClassName}
              >
                <Collapsible.Trigger
                  nativeButton={false}
                  render={<div />}
                  className={promptTemplateCardHeaderClassName}
                  aria-label={isOpen ? t("ocr.ai.collapseTemplate") : t("ocr.ai.expandTemplate")}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <ExpandCircleDownOutlineIcon
                      className={`
                        size-5 shrink-0 text-on-surface transition-transform
                        ${isOpen ? "rotate-180" : ""}
                      `}
                      aria-hidden
                    />
                    {isRenaming ? (
                      <div
                        className="flex min-w-0 flex-1 items-center gap-1"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <Input
                          className={promptTemplateRenameInputClassName}
                          value={renameValue}
                          disabled={disabled}
                          onChange={(event) => {
                            setRenameValue(event.currentTarget.value);
                          }}
                          aria-label={t("ocr.ai.renameTemplate")}
                        />
                        <Button
                          type="button"
                          className={iconButtonClassName}
                          disabled={disabled || renameValue.trim().length === 0}
                          aria-label={t("common.confirm")}
                          onClick={(event) => {
                            event.stopPropagation();
                            updateTemplate(template.id, { name: renameValue.trim() });
                            setRenamingTemplateId(null);
                          }}
                        >
                          <IconMaterialSymbolsLightCheck className="size-5" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          className={iconButtonClassName}
                          disabled={disabled}
                          aria-label={t("common.cancel")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setRenamingTemplateId(null);
                          }}
                        >
                          <IconMaterialSymbolsLightClose className="size-5" aria-hidden />
                        </Button>
                      </div>
                    ) : (
                      <span className={promptTemplateTitleClassName}>{template.name}</span>
                    )}
                  </div>

                  <div
                    className="flex items-center gap-2"
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <label className="flex items-center gap-1.5 text-body-tight text-on-surface">
                      <Radio.Root value={template.id} className={radioClassName}>
                        <Radio.Indicator className={radioIndicatorClassName} />
                      </Radio.Root>
                      {t("ocr.ai.setDefault")}
                    </label>
                    {!isRenaming ? (
                      <Button
                        type="button"
                        className={iconButtonClassName}
                        disabled={disabled}
                        aria-label={t("ocr.ai.renameTemplate")}
                        onClick={() => {
                          setRenamingTemplateId(template.id);
                          setRenameValue(template.name);
                        }}
                      >
                        <IconMaterialSymbolsLightEditSquareOutlineSharp className="size-5" aria-hidden />
                      </Button>
                    ) : null}
                    {canRemove ? (
                      <Button
                        type="button"
                        className={dangerIconButtonClassName}
                        disabled={disabled}
                        aria-label={t("ocr.ai.deleteTemplate")}
                        onClick={() => {
                          removeTemplate(template.id);
                        }}
                      >
                        <IconMaterialSymbolsLightDeleteOutlineSharp className="size-5" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </Collapsible.Trigger>

                <Collapsible.Panel className={promptTemplateCardPanelClassName}>
                  <div className={promptTemplateCardBodyClassName}>
                    <div className="flex flex-col gap-1">
                      <label className={fieldLabelClassName} htmlFor={`ocr-template-system-${template.id}`}>
                        {t("ocr.ai.systemTemplate")}
                      </label>
                      <textarea
                        id={`ocr-template-system-${template.id}`}
                        className={templateTextareaClassName}
                        value={template.systemTemplate}
                        disabled={disabled}
                        onChange={(event) => {
                          updateTemplate(template.id, { systemTemplate: event.currentTarget.value });
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={fieldLabelClassName} htmlFor={`ocr-template-user-${template.id}`}>
                        {t("ocr.ai.userTemplate")}
                      </label>
                      <textarea
                        id={`ocr-template-user-${template.id}`}
                        className={templateTextareaClassName}
                        value={template.userTemplate}
                        disabled={disabled}
                        onChange={(event) => {
                          updateTemplate(template.id, { userTemplate: event.currentTarget.value });
                        }}
                      />
                    </div>
                  </div>
                </Collapsible.Panel>
              </Collapsible.Root>
            );
          })}
        </RadioGroup>
      </div>
    </div>
  );
}
