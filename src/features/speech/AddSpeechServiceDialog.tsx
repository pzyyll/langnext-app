// ABOUTME: Dialog for creating Speech services from ready schema-backed speech.synthesize integrations.
// ABOUTME: Seeds preference defaults from the selected capability descriptor rather than plugin identity.
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
import { resolvePluginDisplayName } from "../plugins/pluginPresentation";
import { preferenceSchemaForBinding } from "../plugins/schema/capabilitySchema";
import { buildSchemaConfig, createSchemaDraft } from "../plugins/schema/schemaDraft";
import { buildSpeechProviderCreateOptions, type SpeechProviderCreateOption } from "./speechProviderOptions";

const providerGridMaxColumns = 3;
const dialogPopupWidthClassName = `${dialogPopupClassName} w-md`;
const providerOptionClassName = `
  flex min-w-0 items-center gap-2 border border-line bg-surface p-3 text-left text-on-surface
  transition-colors
  hover:bg-surface-container-highest
  disabled:cursor-default disabled:opacity-60
  disabled:hover:bg-surface
`;

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
        <Dialog.Popup className={dialogPopupWidthClassName}>
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

function AddSpeechServiceForm({ onCreated }: { onCreated: (service: SpeechServiceDto) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const integrationsQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());
  const instances = useMemo(() => integrationsQuery.data ?? [], [integrationsQuery.data]);
  const definitions = useMemo(() => definitionsQuery.data ?? [], [definitionsQuery.data]);
  const createOptions = useMemo(
    () =>
      buildSpeechProviderCreateOptions({
        instances,
        definitions,
        labels: {
          integrationLabel: t("speech.tts.integrationLabel"),
          resolvePluginLabel: (definition) => resolvePluginDisplayName(definition, (key, options) => t(key, options)),
        },
      }),
    [definitions, instances, t],
  );
  const createMutation = useMutation({
    mutationFn: saveSpeechService,
    onSuccess: (created) => {
      toast.success({ title: t("speech.toast.created"), description: created.displayName });
      onCreated(created);
    },
    onError: (mutationError: unknown) => {
      const message = getIpcErrorMessage(mutationError, t("speech.toast.createFailed"));
      setError(message);
      toast.error({ title: t("speech.toast.createFailed"), description: message });
    },
  });
  const pending = createMutation.isPending;
  const providerColumnCount = Math.min(Math.max(createOptions.length, 1), providerGridMaxColumns);

  function handleCreate(option: SpeechProviderCreateOption) {
    if (pending || option.disabled) return;
    const binding = preferenceSchemaForBinding(
      instances,
      definitions,
      option.integrationInstanceId,
      option.capabilityId,
    );
    if (!binding) {
      setError(t("plugins.unsupportedInstance"));
      return;
    }
    const preferences = createSchemaDraft(binding.schema);
    const write: SpeechServiceWrite = {
      id: null,
      displayName: option.label,
      enabled: true,
      integrationInstanceId: option.integrationInstanceId,
      capabilityId: option.capabilityId,
      preferencesSchemaVersion: binding.descriptor.preferencesSchemaVersion,
      preferences: buildSchemaConfig(binding.schema, preferences),
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
            return (
              <button
                key={option.id}
                type="button"
                disabled={pending || option.disabled}
                onClick={() => handleCreate(option)}
                className={providerOptionClassName}
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
