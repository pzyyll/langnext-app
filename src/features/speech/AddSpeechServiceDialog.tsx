// ABOUTME: Dialog for creating Speech services from ready speech.synthesize@1 integrations.
// ABOUTME: Seeds Google or Edge TTS schema-v1 defaults; credentials stay on the integration instance.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { dialogBackdropClassName, dialogPopupClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { integrationDefinitionListOptions, integrationListOptions } from "../../query/options";
import { saveSpeechService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { SpeechServiceDto, SpeechServiceWrite } from "../../storage/types";
import { EDGE_TTS_PLUGIN_ID } from "../../storage/types";
import {
  EDGE_TTS_PREFERENCES_SCHEMA_VERSION,
  GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
  SPEECH_SYNTHESIZE_CAPABILITY_ID,
  buildSpeechProviderCreateOptions,
  defaultEdgeTtsPreferences,
  defaultGoogleTtsPreferences,
  type SpeechProviderCreateOption,
} from "./speechProviderOptions";

const PROVIDER_GRID_MAX_COLUMNS = 3;

export type AddSpeechServiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (service: SpeechServiceDto) => void;
};

export function AddSpeechServiceDialog({ open, onOpenChange, onCreated }: AddSpeechServiceDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup
          className={`
            ${dialogPopupClassName}
            w-md
          `}
        >
          <div className="flex flex-col gap-1">
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">{t("speech.add.title")}</Dialog.Title>
          </div>
          {open ? (
            <AddSpeechServiceForm
              onCreated={(service) => {
                onCreated(service);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddSpeechServiceFormProps = {
  onCreated: (service: SpeechServiceDto) => void;
};

function AddSpeechServiceForm({ onCreated }: AddSpeechServiceFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const integrationsQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());

  const createOptions = useMemo(
    () =>
      buildSpeechProviderCreateOptions({
        instances: integrationsQuery.data ?? [],
        definitions: definitionsQuery.data ?? [],
        labels: {
          integrationLabel: t("speech.tts.integrationLabel"),
        },
      }),
    [definitionsQuery.data, integrationsQuery.data, t],
  );

  const createMutation = useMutation({
    mutationFn: saveSpeechService,
    onSuccess: (created) => {
      toast.success({ title: t("speech.toast.created"), description: created.displayName });
      onCreated(created);
    },
    onError: (err: unknown) => {
      const message = getIpcErrorMessage(err, t("speech.toast.createFailed"));
      setError(message);
      toast.error({ title: t("speech.toast.createFailed"), description: message });
    },
  });

  const pending = createMutation.isPending;
  const providerColumnCount = Math.min(Math.max(createOptions.length, 1), PROVIDER_GRID_MAX_COLUMNS);

  function handleCreate(option: SpeechProviderCreateOption) {
    if (pending || option.disabled) {
      return;
    }
    if (!option.integrationInstanceId || !option.capabilityId) {
      setError(t("speech.add.needIntegration"));
      return;
    }
    const isEdge = option.pluginId === EDGE_TTS_PLUGIN_ID;
    const write: SpeechServiceWrite = {
      id: null,
      displayName: isEdge ? t("speech.defaults.edgeTtsName") : t("speech.defaults.googleTtsName"),
      enabled: true,
      integrationInstanceId: option.integrationInstanceId,
      capabilityId: option.capabilityId || SPEECH_SYNTHESIZE_CAPABILITY_ID,
      preferencesSchemaVersion: isEdge ? EDGE_TTS_PREFERENCES_SCHEMA_VERSION : GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
      preferences: isEdge ? defaultEdgeTtsPreferences() : defaultGoogleTtsPreferences(),
    };
    setError(null);
    createMutation.mutate(write);
  }

  return (
    <div className="flex flex-col gap-3">
      {createOptions.length === 0 ? (
        <p className="text-body-tight text-neutral">{t("speech.add.empty")}</p>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${providerColumnCount}, minmax(0, 1fr))` }}>
          {createOptions.map((option) => {
            const Icon = option.Icon;
            const disabled = pending || option.disabled;
            return (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  handleCreate(option);
                }}
                className={`
                  flex min-w-0 items-center gap-2 border border-line bg-surface p-3 text-left text-on-surface
                  transition-colors
                  hover:bg-surface-container-highest
                  disabled:cursor-default disabled:opacity-60
                  disabled:hover:bg-surface
                `}
              >
                <Icon className="size-5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate text-body-md font-bold">{option.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {error ? (
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Dialog.Close className={outlineButtonClassName} disabled={pending}>
          {t("common.cancel")}
        </Dialog.Close>
      </div>
    </div>
  );
}
