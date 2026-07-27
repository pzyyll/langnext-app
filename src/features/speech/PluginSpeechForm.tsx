// ABOUTME: Generic plugin Speech binding and preference editor backed by capability schema metadata.
// ABOUTME: Keeps rebind and health UI host-owned while SchemaForm renders sanitized preferences.
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
import { listCompatibleSpeechRebindCandidates } from "./speechProviderOptions";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

export type PluginSpeechFormProps = {
  integrationInstanceId: string;
  capabilityId: string;
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

export function PluginSpeechForm({
  integrationInstanceId,
  capabilityId,
  preferences,
  instances,
  definitions,
  disabled = false,
  onIntegrationInstanceIdChange,
  onPreferencesChange,
}: PluginSpeechFormProps) {
  const { t } = useTranslation();
  const schemaText = useCallback<SchemaTextResolver>(
    (key, fallback) => resolveLocalizedText((translationKey, options) => t(translationKey, options), key, fallback),
    [t],
  );
  const hostOptions = useMemo(() => createSchemaHostOptionResolver(schemaText), [schemaText]);
  const binding = useMemo(
    () => preferenceSchemaForBinding(instances, definitions, integrationInstanceId, capabilityId),
    [capabilityId, definitions, instances, integrationInstanceId],
  );
  const candidates = useMemo(
    () =>
      listCompatibleSpeechRebindCandidates({
        currentInstanceId: integrationInstanceId,
        capabilityId,
        instances,
        definitions,
        labels: {
          integrationLabel: t("speech.tts.integrationLabel"),
          resolvePluginLabel: (definition) => resolvePluginDisplayName(definition, (key, options) => t(key, options)),
        },
      }),
    [capabilityId, definitions, instances, integrationInstanceId, t],
  );
  const selectedInstance = instances.find((instance) => instance.id === integrationInstanceId) ?? null;
  const selectedMissing = !selectedInstance && integrationInstanceId.length > 0;
  const instanceOptions = useMemo(() => {
    const options = candidates
      .filter((candidate) => candidate.ready || candidate.id === integrationInstanceId)
      .map((candidate) => ({
        value: candidate.id,
        label: candidate.ready ? candidate.label : `${candidate.label} (${t("speech.tts.instanceNotReady")})`,
        disabled: !candidate.ready && candidate.id !== integrationInstanceId,
      }));
    if (selectedMissing) {
      options.unshift({ value: integrationInstanceId, label: t("speech.tts.missingInstance"), disabled: true });
    }
    return options;
  }, [candidates, integrationInstanceId, selectedMissing, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="speech-plugin-instance">
          {t("speech.tts.integration")}
        </label>
        <SelectField
          id="speech-plugin-instance"
          value={integrationInstanceId}
          disabled={disabled || instanceOptions.length === 0}
          onValueChange={(value) => {
            const candidate = candidates.find((item) => item.id === value);
            if (candidate) {
              onIntegrationInstanceIdChange(candidate.id, candidate.capabilityId);
            }
          }}
          options={instanceOptions}
          placeholder={t("speech.tts.integrationPlaceholder")}
        />
        <p className="text-body-tight text-neutral">{t("speech.tts.rebindHint")}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className={fieldLabelClassName}>{t("speech.tts.health")}</span>
        <p className="text-body-md text-on-surface">
          {selectedInstance
            ? t(statusLabelKey(selectedInstance.effectiveStatus))
            : selectedMissing
              ? t("speech.tts.missingInstance")
              : t("speech.tts.healthUnknown")}
        </p>
      </div>

      {binding ? (
        <SchemaForm
          schema={binding.schema}
          values={preferences.values}
          idPrefix={`speech-preferences-${integrationInstanceId}`}
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
