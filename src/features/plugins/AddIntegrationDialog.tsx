// ABOUTME: Dialog to create a service-integration configuration instance from bundled definitions.
// ABOUTME: Describes creating a configuration instance, not installing executable code.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { dialogBackdropClassName, dialogPopupClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { integrationDefinitionListOptions } from "../../query/options";
import { saveIntegrationInstance } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto, ServiceIntegrationManifest } from "../../storage/types";
import { GOOGLE_CLOUD_PLUGIN_ID } from "../../storage/types";
import { buildGoogleCloudWrite, emptyGoogleCloudDraft } from "./integrationDraft";

export type AddIntegrationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (instance: IntegrationInstanceDto) => void;
};

export function AddIntegrationDialog({ open, onOpenChange, onCreated }: AddIntegrationDialogProps) {
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
            <Dialog.Title className="text-title-dialog font-bold text-on-surface">
              {t("plugins.add.title")}
            </Dialog.Title>
            <Dialog.Description className="text-body-tight text-neutral">
              {t("plugins.add.description")}
            </Dialog.Description>
          </div>
          {open ? (
            <AddIntegrationForm
              onCreated={(instance) => {
                onCreated(instance);
                onOpenChange(false);
              }}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddIntegrationFormProps = {
  onCreated: (instance: IntegrationInstanceDto) => void;
};

function AddIntegrationForm({ onCreated }: AddIntegrationFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const definitionsQuery = useQuery(integrationDefinitionListOptions());

  const createMutation = useMutation({
    mutationFn: saveIntegrationInstance,
    onSuccess: (created) => {
      onCreated(created);
    },
    onError: (mutationError) => {
      const message = getIpcErrorMessage(mutationError, t("plugins.toast.createFailed"));
      setError(message);
      toast.error({ title: t("plugins.toast.createFailed"), description: message });
    },
  });

  const definitions = definitionsQuery.data ?? [];
  const loading = definitionsQuery.isLoading;
  const loadError = definitionsQuery.isError
    ? getIpcErrorMessage(definitionsQuery.error, t("plugins.add.loadFailed"))
    : null;

  function definitionLabel(definition: ServiceIntegrationManifest): string {
    if (definition.id === GOOGLE_CLOUD_PLUGIN_ID) {
      return t("plugins.googleCloud.name");
    }
    return definition.id;
  }

  return (
    <div className="flex flex-col gap-3">
      {loading ? <p className="text-body-tight text-neutral">{t("plugins.loading")}</p> : null}
      {loadError ? (
        <p className="text-body-tight text-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {error ? (
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && !loadError && definitions.length === 0 ? (
        <p className="text-body-tight text-neutral">{t("plugins.add.empty")}</p>
      ) : null}

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {definitions.map((definition) => (
          <li key={definition.id}>
            <button
              type="button"
              className={`
                ${outlineButtonClassName}
                w-full justify-start bg-surface-2 p-3 text-left
                hover:not-data-disabled:bg-surface-3
              `}
              disabled={createMutation.isPending}
              onClick={() => {
                setError(null);
                if (definition.id !== GOOGLE_CLOUD_PLUGIN_ID) {
                  setError(t("plugins.add.unsupported"));
                  return;
                }
                const draft = emptyGoogleCloudDraft(t("plugins.googleCloud.defaultName"));
                createMutation.mutate(buildGoogleCloudWrite(draft));
              }}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-label-sm font-bold text-on-surface">{definitionLabel(definition)}</span>
                <span className="text-body-tight text-neutral">{t("plugins.add.createInstanceHint")}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
