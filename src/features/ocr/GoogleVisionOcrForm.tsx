// ABOUTME: Plugin OCR editor for Google Cloud Vision (instance rebind + preferences).
// ABOUTME: Never shows project, service-account, token, or endpoint fields.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@base-ui/react/checkbox";
import { SelectField } from "../../components/SelectField";
import { checkboxClassName, checkboxIndicatorClassName } from "../../components/ui";
import { LANGUAGE_IDS } from "../../routes/translate/-languages";
import type { IntegrationInstanceDto, OcrImageOperation, ServiceIntegrationManifest } from "../../storage/types";
import { OCR_LANGUAGE_HINTS_MAX, listCompatibleOcrRebindCandidates } from "./ocrProviderOptions";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

const OCR_OPERATIONS: OcrImageOperation[] = ["document_text_detection", "text_detection"];

export type GoogleVisionOcrFormProps = {
  integrationInstanceId: string;
  ocrCapabilityId: string;
  operation: OcrImageOperation;
  languageHints: string[];
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  disabled?: boolean;
  onIntegrationInstanceIdChange: (instanceId: string, ocrCapabilityId: string) => void;
  onOperationChange: (operation: OcrImageOperation) => void;
  onLanguageHintsChange: (hints: string[]) => void;
};

function statusLabelKey(
  status: IntegrationInstanceDto["effectiveStatus"],
):
  | "plugins.status.unconfigured"
  | "plugins.status.unvalidated"
  | "plugins.status.ready"
  | "plugins.status.degraded"
  | "plugins.status.disabled"
  | "plugins.status.pluginMissing" {
  switch (status) {
    case "unconfigured":
      return "plugins.status.unconfigured";
    case "unvalidated":
      return "plugins.status.unvalidated";
    case "ready":
      return "plugins.status.ready";
    case "degraded":
      return "plugins.status.degraded";
    case "disabled":
      return "plugins.status.disabled";
    case "plugin_missing":
      return "plugins.status.pluginMissing";
  }
}

export function GoogleVisionOcrForm({
  integrationInstanceId,
  ocrCapabilityId,
  operation,
  languageHints,
  instances,
  definitions,
  disabled = false,
  onIntegrationInstanceIdChange,
  onOperationChange,
  onLanguageHintsChange,
}: GoogleVisionOcrFormProps) {
  const { t } = useTranslation();

  const rebindCandidates = useMemo(
    () =>
      listCompatibleOcrRebindCandidates({
        currentInstanceId: integrationInstanceId,
        ocrCapabilityId,
        instances,
        definitions,
        labels: {
          integrationLabel: t("ocr.vision.integrationLabel"),
        },
      }),
    [definitions, instances, integrationInstanceId, ocrCapabilityId, t],
  );

  const selectedInstance = instances.find((item) => item.id === integrationInstanceId) ?? null;
  const selectedMissing = !selectedInstance && integrationInstanceId.length > 0;

  const instanceOptions = useMemo(() => {
    const options = rebindCandidates
      .filter((candidate) => candidate.ready || candidate.id === integrationInstanceId)
      .map((candidate) => ({
        value: candidate.id,
        label: candidate.ready ? candidate.label : `${candidate.label} (${t("ocr.vision.instanceNotReady")})`,
        disabled: !candidate.ready && candidate.id !== integrationInstanceId,
      }));
    if (selectedMissing) {
      options.unshift({
        value: integrationInstanceId,
        label: t("ocr.vision.missingInstance"),
        disabled: true,
      });
    }
    return options;
  }, [integrationInstanceId, rebindCandidates, selectedMissing, t]);

  const languageOptions = useMemo(
    () =>
      LANGUAGE_IDS.map((id) => ({
        id,
        label: t(`translate.languages.${id}`),
      })),
    [t],
  );

  function toggleLanguageHint(languageId: string) {
    if (disabled) {
      return;
    }
    const selected = languageHints.includes(languageId);
    if (selected) {
      onLanguageHintsChange(languageHints.filter((hint) => hint !== languageId));
      return;
    }
    if (languageHints.length >= OCR_LANGUAGE_HINTS_MAX) {
      return;
    }
    onLanguageHintsChange([...languageHints, languageId]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="ocr-vision-instance">
          {t("ocr.vision.integration")}
        </label>
        <SelectField
          id="ocr-vision-instance"
          value={integrationInstanceId}
          disabled={disabled || instanceOptions.length === 0}
          onValueChange={(value) => {
            if (!value) {
              return;
            }
            const candidate = rebindCandidates.find((item) => item.id === value);
            if (!candidate) {
              return;
            }
            onIntegrationInstanceIdChange(candidate.id, candidate.ocrCapabilityId);
          }}
          options={instanceOptions}
          placeholder={t("ocr.vision.integrationPlaceholder")}
        />
        <p className="text-body-tight text-neutral">{t("ocr.vision.rebindHint")}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className={fieldLabelClassName}>{t("ocr.vision.health")}</span>
        <p className="text-body-md text-on-surface">
          {selectedInstance
            ? t(statusLabelKey(selectedInstance.effectiveStatus))
            : selectedMissing
              ? t("ocr.vision.missingInstance")
              : t("ocr.vision.healthUnknown")}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="ocr-vision-operation">
          {t("ocr.vision.operation")}
        </label>
        <SelectField
          id="ocr-vision-operation"
          value={operation}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "text_detection" || value === "document_text_detection") {
              onOperationChange(value);
            }
          }}
          options={OCR_OPERATIONS.map((value) => ({
            value,
            label: t(`ocr.vision.operations.${value}`),
          }))}
        />
        <p className="text-body-tight text-neutral">{t("ocr.vision.operationHint")}</p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className={fieldLabelClassName}>{t("ocr.vision.languageHints")}</span>
          <span className="text-body-tight text-neutral">
            {t("ocr.vision.languageHintsCount", {
              count: languageHints.length,
              max: OCR_LANGUAGE_HINTS_MAX,
            })}
          </span>
        </div>
        <p className="text-body-tight text-neutral">{t("ocr.vision.languageHintsHint")}</p>
        <div
          className="
            grid grid-cols-2 gap-2
            sm:grid-cols-3
          "
        >
          {languageOptions.map((option) => {
            const checked = languageHints.includes(option.id);
            const atLimit = !checked && languageHints.length >= OCR_LANGUAGE_HINTS_MAX;
            return (
              <label
                key={option.id}
                className={`
                  flex min-h-9 items-center gap-2 border border-line bg-surface px-2 text-body-tight text-on-surface
                  ${disabled || atLimit ? "opacity-60" : ""}
                `}
              >
                <Checkbox.Root
                  checked={checked}
                  disabled={disabled || atLimit}
                  className={checkboxClassName}
                  onCheckedChange={(next) => {
                    if (next === checked) {
                      return;
                    }
                    toggleLanguageHint(option.id);
                  }}
                >
                  <Checkbox.Indicator className={checkboxIndicatorClassName}>
                    <IconMaterialSymbolsLightCheck className="size-3.5" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span className="min-w-0 truncate">{option.label}</span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
