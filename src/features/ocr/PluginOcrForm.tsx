// ABOUTME: Generic plugin OCR binding and preference editor backed by the selected capability schema.
// ABOUTME: Keeps instance selection host-owned while SchemaForm renders only sanitized preferences.
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../components/SelectField";
import { resolveLocalizedText, resolvePluginDisplayName } from "../plugins/pluginPresentation";
import { SchemaForm } from "../plugins/schema/SchemaForm";
import type { SchemaTextResolver } from "../plugins/schema/SchemaField";
import { createSchemaHostOptionResolver } from "../plugins/schema/schemaHostOptions";
import { setSchemaDraftValue, type SchemaDraft } from "../plugins/schema/schemaDraft";
import { preferenceSchemaForBinding } from "../plugins/schema/capabilitySchema";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
import { listCompatibleOcrRebindCandidates } from "./ocrProviderOptions";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

export type PluginOcrFormProps = {
  integrationInstanceId: string;
  ocrCapabilityId: string;
  preferences: SchemaDraft;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationDefinitionDto[];
  disabled?: boolean;
  onIntegrationInstanceIdChange: (instanceId: string, capabilityId: string) => void;
  onPreferencesChange: (preferences: SchemaDraft) => void;
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

export function PluginOcrForm({
  integrationInstanceId,
  ocrCapabilityId,
  preferences,
  instances,
  definitions,
  disabled = false,
  onIntegrationInstanceIdChange,
  onPreferencesChange,
}: PluginOcrFormProps) {
  const { t } = useTranslation();
  const schemaText = useCallback<SchemaTextResolver>(
    (key, fallback) => resolveLocalizedText((translationKey, options) => t(translationKey, options), key, fallback),
    [t],
  );
  const hostOptions = useMemo(() => createSchemaHostOptionResolver(schemaText), [schemaText]);
  const binding = useMemo(
    () => preferenceSchemaForBinding(instances, definitions, integrationInstanceId, ocrCapabilityId),
    [definitions, instances, integrationInstanceId, ocrCapabilityId],
  );
  const candidates = useMemo(
    () =>
      listCompatibleOcrRebindCandidates({
        currentInstanceId: integrationInstanceId,
        ocrCapabilityId,
        instances,
        definitions,
        labels: {
          integrationLabel: t("ocr.vision.integrationLabel"),
          resolvePluginLabel: (definition) => resolvePluginDisplayName(definition, (key, options) => t(key, options)),
        },
      }),
    [definitions, instances, integrationInstanceId, ocrCapabilityId, t],
  );
  const selectedInstance = instances.find((instance) => instance.id === integrationInstanceId) ?? null;
  const selectedMissing = !selectedInstance && integrationInstanceId.length > 0;
  const instanceOptions = useMemo(() => {
    const options = candidates
      .filter((candidate) => candidate.ready || candidate.id === integrationInstanceId)
      .map((candidate) => ({
        value: candidate.id,
        label: candidate.ready ? candidate.label : `${candidate.label} (${t("ocr.vision.instanceNotReady")})`,
        disabled: !candidate.ready && candidate.id !== integrationInstanceId,
      }));
    if (selectedMissing) {
      options.unshift({ value: integrationInstanceId, label: t("ocr.vision.missingInstance"), disabled: true });
    }
    return options;
  }, [candidates, integrationInstanceId, selectedMissing, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="ocr-plugin-instance">
          {t("ocr.vision.integration")}
        </label>
        <SelectField
          id="ocr-plugin-instance"
          value={integrationInstanceId}
          disabled={disabled || instanceOptions.length === 0}
          onValueChange={(value) => {
            const candidate = candidates.find((item) => item.id === value);
            if (candidate) {
              onIntegrationInstanceIdChange(candidate.id, candidate.ocrCapabilityId);
            }
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

      {binding ? (
        <SchemaForm
          schema={binding.schema}
          values={preferences.values}
          idPrefix={`ocr-preferences-${integrationInstanceId}`}
          disabled={disabled}
          resolveText={schemaText}
          resolveOptions={hostOptions}
          onValueChange={(fieldId, value) => onPreferencesChange(setSchemaDraftValue(preferences, fieldId, value))}
        />
      ) : (
        <p className="text-body-tight text-neutral" role="status">
          {t("plugins.unsupportedInstance")}
        </p>
      )}
    </div>
  );
}
