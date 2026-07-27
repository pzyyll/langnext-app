// ABOUTME: Dialog to create schema-backed service-integration instances from bundled definitions.
// ABOUTME: Creates configuration data only; it never installs executable plugin code or reads secrets.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import { dialogBackdropClassName, dialogPopupClassName, outlineButtonClassName } from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { integrationDefinitionListOptions } from "../../query/options";
import { saveIntegrationInstance } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
import { resolvePluginDisplayName } from "./pluginPresentation";
import { buildIntegrationWrite, createIntegrationDraft } from "./integrationDraft";

const integrationOptionMaxColumns = 3;

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

function supportsCreate(definition: ServiceIntegrationDefinitionDto): boolean {
  return definition.configSchema.version === definition.configSchemaVersion;
}

function AddIntegrationForm({ onCreated }: AddIntegrationFormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const definitionsQuery = useQuery(integrationDefinitionListOptions());

  const createMutation = useMutation({
    mutationFn: saveIntegrationInstance,
    onSuccess: (created) => onCreated(created),
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
  const pending = createMutation.isPending;
  const columnCount = Math.min(definitions.length || 1, integrationOptionMaxColumns);

  function definitionLabel(definition: ServiceIntegrationDefinitionDto): string {
    return resolvePluginDisplayName(definition, (key, options) => t(key, options));
  }

  function createWrite(definition: ServiceIntegrationDefinitionDto) {
    const displayName = definitionLabel(definition);
    return buildIntegrationWrite(definition, createIntegrationDraft(definition, displayName));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
        {loading
          ? null
          : definitions.map((definition) => {
              const supported = supportsCreate(definition);
              return (
                <button
                  key={definition.id}
                  type="button"
                  disabled={pending || !supported}
                  onClick={() => {
                    if (!supported) {
                      return;
                    }
                    setError(null);
                    createMutation.mutate(createWrite(definition));
                  }}
                  className={`
                    flex min-w-0 items-center gap-2 border border-line bg-surface p-3 text-left text-on-surface
                    transition-colors
                    hover:bg-surface-container-highest
                    disabled:cursor-default disabled:opacity-60
                    disabled:hover:bg-surface
                  `}
                >
                  <span className="min-w-0 truncate text-body-md font-bold">{definitionLabel(definition)}</span>
                </button>
              );
            })}
      </div>

      {loading ? <p className="text-body-tight text-neutral">{t("plugins.loading")}</p> : null}
      {loadError ? (
        <p className="text-body-tight text-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {!loading && !loadError && definitions.length === 0 ? (
        <p className="text-body-tight text-neutral">{t("plugins.add.empty")}</p>
      ) : null}
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
