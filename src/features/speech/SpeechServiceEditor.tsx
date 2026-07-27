// ABOUTME: Schema-driven editor for Speech services bound to speech.synthesize capabilities.
// ABOUTME: Preserves rename, enable, save, reset, and delete while removing provider identity inference.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ConfigEditorLayout, configEditorRenameInputClassName } from "../../components/layouts/ConfigEditorLayout";
import { useToast } from "../../components/toast/useToast";
import {
  dangerIconButtonClassName,
  iconButtonClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  switchRootClassName,
  switchThumbClassName,
} from "../../components/ui";
import { settingsKeys, speechKeys } from "../../query/keys";
import { integrationDefinitionListOptions, integrationListOptions, speechListOptions } from "../../query/options";
import { deleteSpeechService, saveSpeechService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto, SpeechServiceDto, SpeechServiceWrite } from "../../storage/types";
import { PluginSpeechForm } from "./PluginSpeechForm";
import { preferenceSchemaForBinding } from "../plugins/schema/capabilitySchema";
import {
  buildSchemaConfig,
  createSchemaDraft,
  isSchemaDraftDirty,
  type SchemaDraft,
} from "../plugins/schema/schemaDraft";

export type SpeechServiceEditorProps = {
  speechServiceId: string;
};

const deleteButtonClassName = [dangerIconButtonClassName, "mr-auto"].join(" ");
const saveButtonClassName = [primaryButtonClassName, "relative"].join(" ");

type SpeechDraft = {
  enabled: boolean;
  integrationInstanceId: string;
  capabilityId: string;
  preferencesSchemaVersion: number;
  preferences: SchemaDraft;
  schemaKey: string;
  expectedUpdatedAt: string;
};

function schemaKey(instanceId: string, capabilityId: string, schemaVersion: number): string {
  return `${instanceId}:${capabilityId}:${schemaVersion}`;
}

function draftFromDto(
  service: SpeechServiceDto,
  instances: readonly IntegrationInstanceDto[],
  definitions: Parameters<typeof preferenceSchemaForBinding>[1],
): SpeechDraft {
  const binding = preferenceSchemaForBinding(
    instances,
    definitions,
    service.integrationInstanceId,
    service.capabilityId,
  );
  const preferencesSchemaVersion = binding?.descriptor.preferencesSchemaVersion ?? service.preferencesSchemaVersion;
  return {
    enabled: service.enabled,
    integrationInstanceId: service.integrationInstanceId,
    capabilityId: service.capabilityId,
    preferencesSchemaVersion,
    preferences: binding
      ? createSchemaDraft(binding.schema, { config: service.preferences })
      : createSchemaDraft({ version: 1, fields: [], groups: [] }),
    schemaKey: binding ? schemaKey(service.integrationInstanceId, service.capabilityId, preferencesSchemaVersion) : "",
    expectedUpdatedAt: service.updatedAt,
  };
}

function isDraftFieldsClean(
  draft: SpeechDraft,
  service: SpeechServiceDto,
  instances: readonly IntegrationInstanceDto[],
  definitions: Parameters<typeof preferenceSchemaForBinding>[1],
): boolean {
  const baseline = draftFromDto(service, instances, definitions);
  if (
    draft.enabled !== baseline.enabled ||
    draft.integrationInstanceId !== baseline.integrationInstanceId ||
    draft.capabilityId !== baseline.capabilityId ||
    draft.preferencesSchemaVersion !== baseline.preferencesSchemaVersion ||
    draft.schemaKey !== baseline.schemaKey
  ) {
    return false;
  }
  const binding = preferenceSchemaForBinding(instances, definitions, draft.integrationInstanceId, draft.capabilityId);
  return binding ? !isSchemaDraftDirty(binding.schema, draft.preferences, baseline.preferences) : true;
}

/** Persist a rename without changing the current binding or opaque stored preference JSON. */
function renameWrite(service: SpeechServiceDto, displayName: string): SpeechServiceWrite {
  return {
    id: service.id,
    displayName,
    enabled: service.enabled,
    integrationInstanceId: service.integrationInstanceId,
    capabilityId: service.capabilityId,
    preferencesSchemaVersion: service.preferencesSchemaVersion,
    preferences: service.preferences,
    expectedUpdatedAt: service.updatedAt,
  };
}

export function SpeechServiceEditor({ speechServiceId }: SpeechServiceEditorProps) {
  const { t } = useTranslation();
  const servicesQuery = useQuery(speechListOptions());
  const service = (servicesQuery.data ?? []).find((item) => item.id === speechServiceId) ?? null;
  const loading = servicesQuery.isLoading;
  const error = servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("speech.loadFailed")) : null;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-body-tight text-neutral" aria-live="polite">
          {t("speech.loadingService")}
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
        <Button type="button" className={outlineButtonClassName} onClick={() => void servicesQuery.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (!service) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <h1 className="text-headline-md font-bold text-on-surface">{t("speech.notFound")}</h1>
        <p className="text-body-tight text-neutral">{t("speech.notFoundHint")}</p>
        <Link to="/speech" className={outlineButtonClassName}>
          {t("speech.backToList")}
        </Link>
      </div>
    );
  }
  return <SpeechServiceEditorLoaded key={service.id} service={service} />;
}

function SpeechServiceEditorLoaded({ service }: { service: SpeechServiceDto }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const integrationsQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());
  const instances = useMemo(() => integrationsQuery.data ?? [], [integrationsQuery.data]);
  const definitions = useMemo(() => definitionsQuery.data ?? [], [definitionsQuery.data]);
  const currentBinding = preferenceSchemaForBinding(
    instances,
    definitions,
    service.integrationInstanceId,
    service.capabilityId,
  );
  const currentSchemaKey = currentBinding
    ? schemaKey(service.integrationInstanceId, service.capabilityId, currentBinding.descriptor.preferencesSchemaVersion)
    : "";

  const [draft, setDraft] = useState<SpeechDraft>(() => draftFromDto(service, instances, definitions));
  const [trackedService, setTrackedService] = useState(service);
  const [savePending, setSavePending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLElement | null>(null);

  if (
    service.updatedAt !== trackedService.updatedAt ||
    service.id !== trackedService.id ||
    draft.schemaKey !== currentSchemaKey
  ) {
    const shouldReset =
      service.id !== trackedService.id ||
      draft.schemaKey !== currentSchemaKey ||
      isDraftFieldsClean(draft, trackedService, instances, definitions);
    setTrackedService(service);
    if (shouldReset) {
      setDraft(draftFromDto(service, instances, definitions));
    }
  }

  useEffect(() => {
    if (!renaming || !renameInputRef.current) {
      return;
    }
    renameInputRef.current.focus();
    if (renameInputRef.current instanceof HTMLInputElement) {
      renameInputRef.current.select();
    }
  }, [renaming]);

  const isDirty = useMemo(
    () => isDraftFieldsClean(draft, service, instances, definitions) === false,
    [definitions, draft, instances, service],
  );
  const formDisabled = savePending || deletePending || renamePending;
  const draftBinding = preferenceSchemaForBinding(
    instances,
    definitions,
    draft.integrationInstanceId,
    draft.capabilityId,
  );

  function seedService(next: SpeechServiceDto) {
    queryClient.setQueryData<SpeechServiceDto[]>(speechKeys.list(), (current) => {
      if (!current) return [next];
      return current.map((item) => (item.id === next.id ? next : item));
    });
    queryClient.setQueryData(speechKeys.detail(next.id), next);
  }

  function updateDraft(patch: Partial<SpeechDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
  }

  async function commitRename() {
    const displayName = renameValue.trim();
    if (!displayName || renamePending) return;
    if (displayName === service.displayName) {
      setRenaming(false);
      return;
    }
    setRenamePending(true);
    try {
      const saved = await saveSpeechService(renameWrite(service, displayName));
      seedService(saved);
      setDraft((current) => ({ ...current, expectedUpdatedAt: saved.updatedAt }));
      setRenaming(false);
      setRenameValue("");
      void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    } catch (error) {
      setRenameError(getIpcErrorMessage(error, t("speech.toast.renameFailed")));
    } finally {
      setRenamePending(false);
    }
  }

  async function handleSave() {
    if (savePending || !isDirty) return;
    const binding = preferenceSchemaForBinding(instances, definitions, draft.integrationInstanceId, draft.capabilityId);
    if (!binding) {
      setValidationError(t("plugins.unsupportedInstance"));
      return;
    }
    const write: SpeechServiceWrite = {
      id: service.id,
      displayName: service.displayName,
      enabled: draft.enabled,
      integrationInstanceId: draft.integrationInstanceId,
      capabilityId: draft.capabilityId,
      preferencesSchemaVersion: binding.descriptor.preferencesSchemaVersion,
      preferences: buildSchemaConfig(binding.schema, draft.preferences),
      expectedUpdatedAt: draft.expectedUpdatedAt,
    };
    setSavePending(true);
    setValidationError(null);
    try {
      const saved = await saveSpeechService(write);
      seedService(saved);
      setDraft(draftFromDto(saved, instances, definitions));
      toast.success({ title: t("speech.toast.saved"), description: saved.displayName });
      void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    } catch (error) {
      const message = getIpcErrorMessage(error, t("speech.toast.saveFailed"));
      setValidationError(message);
      toast.error({ title: t("speech.toast.saveFailed"), description: message });
      void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    } finally {
      setSavePending(false);
    }
  }

  async function handleDelete() {
    if (deletePending) return;
    setDeletePending(true);
    try {
      await deleteSpeechService(service.id);
    } catch (error) {
      const message = getIpcErrorMessage(error, t("speech.toast.deleteFailed"));
      toast.error({ title: t("speech.toast.deleteFailed"), description: message });
      throw Object.assign(new Error(message), { cause: error });
    } finally {
      setDeletePending(false);
    }
    queryClient.setQueryData<SpeechServiceDto[]>(speechKeys.list(), (current) =>
      (current ?? []).filter((item) => item.id !== service.id),
    );
    queryClient.removeQueries({ queryKey: speechKeys.detail(service.id) });
    toast.success({ title: t("speech.toast.deleted"), description: service.displayName });
    void navigate({ to: "/speech" });
    void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
  }

  return (
    <>
      <ConfigEditorLayout
        title={
          renaming ? (
            <form
              className="flex min-w-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void commitRename();
              }}
            >
              <Input
                ref={renameInputRef}
                className={configEditorRenameInputClassName}
                value={renameValue}
                onChange={(event) => {
                  setRenameValue(event.currentTarget.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !renamePending) {
                    event.preventDefault();
                    setRenaming(false);
                  }
                }}
                maxLength={128}
                spellCheck={false}
                autoComplete="off"
                disabled={renamePending}
              />
              <Button
                type="submit"
                className={iconButtonClassName}
                aria-label={t("speech.saveServiceName")}
                disabled={renamePending || !renameValue.trim()}
              >
                <IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
              </Button>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("speech.cancelRename")}
                disabled={renamePending}
                onClick={() => setRenaming(false)}
              >
                <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-headline-display font-bold text-on-surface">{service.displayName}</h1>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("speech.renameService")}
                title={t("speech.renameService")}
                disabled={formDisabled}
                onClick={() => {
                  setRenameValue(service.displayName);
                  setRenameError(null);
                  setRenaming(true);
                }}
              >
                <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
              </Button>
            </div>
          )
        }
        titleTrailing={
          <label className="flex shrink-0 items-center gap-2 text-body-tight text-on-surface">
            <Switch.Root
              checked={draft.enabled}
              disabled={formDisabled}
              className={switchRootClassName}
              aria-label={t("speech.enabledAria")}
              onCheckedChange={(enabled) => updateDraft({ enabled })}
            >
              <Switch.Thumb className={switchThumbClassName} />
            </Switch.Root>
          </label>
        }
        titleMeta={
          renameError ? (
            <p className="mb-2 text-body-tight text-error" role="alert">
              {renameError}
            </p>
          ) : null
        }
        footer={
          <>
            <Button
              type="button"
              className={deleteButtonClassName}
              aria-label={t("speech.deleteConfirmTitle")}
              title={t("speech.deleteConfirmTitle")}
              disabled={formDisabled}
              onClick={() => setDeleteOpen(true)}
            >
              <IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
            </Button>
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={formDisabled}
              onClick={() => {
                setDraft(draftFromDto(service, instances, definitions));
                setValidationError(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={saveButtonClassName}
              disabled={formDisabled || !isDirty || !draftBinding}
              focusableWhenDisabled
              aria-busy={savePending}
              aria-label={savePending ? t("common.saving") : t("common.save")}
              onClick={() => void handleSave()}
            >
              <span className={savePending ? "invisible" : undefined} aria-hidden="true">
                {t("common.save")}
              </span>
              {savePending ? (
                <span
                  className="absolute size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          </>
        }
      >
        <PluginSpeechForm
          integrationInstanceId={draft.integrationInstanceId}
          capabilityId={draft.capabilityId}
          preferences={draft.preferences}
          instances={instances}
          definitions={definitions}
          disabled={formDisabled}
          onIntegrationInstanceIdChange={(integrationInstanceId, capabilityId) => {
            const binding = preferenceSchemaForBinding(instances, definitions, integrationInstanceId, capabilityId);
            if (!binding) {
              setValidationError(t("plugins.unsupportedInstance"));
              return;
            }
            updateDraft({
              integrationInstanceId,
              capabilityId,
              preferencesSchemaVersion: binding.descriptor.preferencesSchemaVersion,
              preferences: createSchemaDraft(binding.schema),
              schemaKey: schemaKey(integrationInstanceId, capabilityId, binding.descriptor.preferencesSchemaVersion),
            });
          }}
          onPreferencesChange={(preferences) => updateDraft({ preferences })}
        />
        {validationError ? (
          <p className="mt-6 text-body-tight text-error" role="alert">
            {validationError}
          </p>
        ) : null}
      </ConfigEditorLayout>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("speech.deleteConfirmTitle")}
        description={t("speech.deleteConfirm", { name: service.displayName })}
        confirmText={t("common.delete")}
        pendingText={t("common.deleting")}
        danger
        onConfirm={handleDelete}
      />
    </>
  );
}
