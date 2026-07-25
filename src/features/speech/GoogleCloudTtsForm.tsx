// ABOUTME: Google Cloud TTS editor form for instance rebind, health, rate, and pitch.
// ABOUTME: Never shows project, service-account, token, language, voice, or endpoint fields.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NumberField } from "@base-ui/react/number-field";
import { SelectField } from "../../components/SelectField";
import { inputClassName } from "../../components/ui";
import type { IntegrationInstanceDto, ServiceIntegrationManifest } from "../../storage/types";
import {
  SPEECH_PITCH_MAX,
  SPEECH_PITCH_MIN,
  SPEECH_PITCH_STEP,
  SPEECH_SPEAKING_RATE_MAX,
  SPEECH_SPEAKING_RATE_MIN,
  SPEECH_SPEAKING_RATE_STEP,
  listCompatibleSpeechRebindCandidates,
} from "./speechProviderOptions";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconMaterialSymbolsLightRemove from "~icons/material-symbols-light/remove";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

const stepperButtonClassName = `
  flex h-control-height w-8 shrink-0 items-center justify-center border border-line bg-surface text-on-surface
  select-none
  hover:not-data-disabled:bg-surface-2
  active:not-data-disabled:bg-surface-3
  data-disabled:border-disabled data-disabled:text-disabled
`;

export type GoogleCloudTtsFormProps = {
  integrationInstanceId: string;
  capabilityId: string;
  speakingRate: number;
  pitch: number;
  instances: readonly IntegrationInstanceDto[];
  definitions: readonly ServiceIntegrationManifest[];
  disabled?: boolean;
  onIntegrationInstanceIdChange: (instanceId: string, capabilityId: string) => void;
  onSpeakingRateChange: (value: number) => void;
  onPitchChange: (value: number) => void;
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

export function GoogleCloudTtsForm({
  integrationInstanceId,
  capabilityId,
  speakingRate,
  pitch,
  instances,
  definitions,
  disabled = false,
  onIntegrationInstanceIdChange,
  onSpeakingRateChange,
  onPitchChange,
}: GoogleCloudTtsFormProps) {
  const { t } = useTranslation();

  const rebindCandidates = useMemo(
    () =>
      listCompatibleSpeechRebindCandidates({
        currentInstanceId: integrationInstanceId,
        capabilityId,
        instances,
        definitions,
        labels: {
          integrationLabel: t("speech.tts.integrationLabel"),
        },
      }),
    [capabilityId, definitions, instances, integrationInstanceId, t],
  );

  const selectedInstance = instances.find((item) => item.id === integrationInstanceId) ?? null;
  const selectedMissing = !selectedInstance && integrationInstanceId.length > 0;

  const instanceOptions = useMemo(() => {
    const options = rebindCandidates
      .filter((candidate) => candidate.ready || candidate.id === integrationInstanceId)
      .map((candidate) => ({
        value: candidate.id,
        label: candidate.ready ? candidate.label : `${candidate.label} (${t("speech.tts.instanceNotReady")})`,
        disabled: !candidate.ready && candidate.id !== integrationInstanceId,
      }));
    if (selectedMissing) {
      options.unshift({
        value: integrationInstanceId,
        label: t("speech.tts.missingInstance"),
        disabled: true,
      });
    }
    return options;
  }, [integrationInstanceId, rebindCandidates, selectedMissing, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="speech-tts-instance">
          {t("speech.tts.integration")}
        </label>
        <SelectField
          id="speech-tts-instance"
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
            onIntegrationInstanceIdChange(candidate.id, candidate.capabilityId);
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

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="speech-tts-speaking-rate">
          {t("speech.tts.speakingRate")}
        </label>
        <NumberField.Root
          id="speech-tts-speaking-rate"
          value={speakingRate}
          min={SPEECH_SPEAKING_RATE_MIN}
          max={SPEECH_SPEAKING_RATE_MAX}
          step={SPEECH_SPEAKING_RATE_STEP}
          disabled={disabled}
          onValueChange={(value) => {
            if (value == null || !Number.isFinite(value)) {
              return;
            }
            onSpeakingRateChange(value);
          }}
        >
          <NumberField.Group className="flex">
            <NumberField.Decrement
              className={`
                ${stepperButtonClassName}
                border-r-0
              `}
              aria-label={t("speech.tts.decrease")}
            >
              <IconMaterialSymbolsLightRemove className="size-4" aria-hidden />
            </NumberField.Decrement>
            <NumberField.Input
              className={`
                ${inputClassName}
                w-24 border-x-0 text-center tabular-nums
              `}
            />
            <NumberField.Increment
              className={`
                ${stepperButtonClassName}
                border-l-0
              `}
              aria-label={t("speech.tts.increase")}
            >
              <IconMaterialSymbolsLightAdd className="size-4" aria-hidden />
            </NumberField.Increment>
          </NumberField.Group>
        </NumberField.Root>
        <p className="text-body-tight text-neutral">
          {t("speech.tts.speakingRateHint", {
            min: SPEECH_SPEAKING_RATE_MIN,
            max: SPEECH_SPEAKING_RATE_MAX,
          })}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="speech-tts-pitch">
          {t("speech.tts.pitch")}
        </label>
        <NumberField.Root
          id="speech-tts-pitch"
          value={pitch}
          min={SPEECH_PITCH_MIN}
          max={SPEECH_PITCH_MAX}
          step={SPEECH_PITCH_STEP}
          disabled={disabled}
          onValueChange={(value) => {
            if (value == null || !Number.isFinite(value)) {
              return;
            }
            onPitchChange(value);
          }}
        >
          <NumberField.Group className="flex">
            <NumberField.Decrement
              className={`
                ${stepperButtonClassName}
                border-r-0
              `}
              aria-label={t("speech.tts.decrease")}
            >
              <IconMaterialSymbolsLightRemove className="size-4" aria-hidden />
            </NumberField.Decrement>
            <NumberField.Input
              className={`
                ${inputClassName}
                w-24 border-x-0 text-center tabular-nums
              `}
            />
            <NumberField.Increment
              className={`
                ${stepperButtonClassName}
                border-l-0
              `}
              aria-label={t("speech.tts.increase")}
            >
              <IconMaterialSymbolsLightAdd className="size-4" aria-hidden />
            </NumberField.Increment>
          </NumberField.Group>
        </NumberField.Root>
        <p className="text-body-tight text-neutral">
          {t("speech.tts.pitchHint", { min: SPEECH_PITCH_MIN, max: SPEECH_PITCH_MAX })}
        </p>
      </div>
    </div>
  );
}
