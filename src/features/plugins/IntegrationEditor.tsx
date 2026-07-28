// ABOUTME: Schema-driven integration instance editor with status, validation, and dependencies.
// ABOUTME: Keeps credentials write-only and preserves CAS, enable, validate, and delete workflows.
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { integrationKeys } from "../../query/keys";
import {
  integrationDefinitionListOptions,
  integrationDependencyListOptions,
  integrationDetailOptions,
} from "../../query/options";
import {
  deleteIntegrationInstance,
  saveIntegrationInstance,
  setIntegrationInstanceEnabled,
  validateIntegrationInstance,
} from "../../storage/client";
import { getIpcErrorCode, getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
import { resolveLocalizedText } from "./pluginPresentation";
import { SchemaForm } from "./schema/SchemaForm";
import type { SchemaTextResolver } from "./schema/SchemaField";
import { createSchemaHostOptionResolver } from "./schema/schemaHostOptions";
import { setSchemaCredentialAction, setSchemaCredentialValue, setSchemaDraftValue } from "./schema/schemaDraft";
import {
  buildIntegrationWrite,
  draftFromIntegrationDto,
  hasIntegrationRemoteRelevantMutation,
  isIntegrationDraftClean,
  type IntegrationSchemaDraft,
} from "./integrationDraft";
import { isRuntimeUnresolved } from "./runtimeLifecyclePresentation";
import { RuntimeLifecyclePanel } from "./RuntimeLifecyclePanel";

export type IntegrationEditorProps = {
  integrationInstanceId: string;
};

const STATUS_LABEL_KEYS = {
  unconfigured: "plugins.status.unconfigured",
  unvalidated: "plugins.status.unvalidated",
  ready: "plugins.status.ready",
  degraded: "plugins.status.degraded",
  disabled: "plugins.status.disabled",
  plugin_missing: "plugins.status.pluginMissing",
} as const satisfies Record<IntegrationInstanceDto["effectiveStatus"], string>;

function statusLabelKey(
  status: IntegrationInstanceDto["effectiveStatus"],
): (typeof STATUS_LABEL_KEYS)[keyof typeof STATUS_LABEL_KEYS] {
  return STATUS_LABEL_KEYS[status];
}

function isSupportedSchema(definition: ServiceIntegrationDefinitionDto, instance: IntegrationInstanceDto): boolean {
  return (
    definition.configSchema.version === definition.configSchemaVersion &&
    instance.configSchemaVersion === definition.configSchemaVersion
  );
}

function requiresCredential(definition: ServiceIntegrationDefinitionDto): boolean {
  return definition.credentialSlots.some((slot) => slot.required);
}

export function IntegrationEditor({ integrationInstanceId }: IntegrationEditorProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const detailQuery = useQuery(integrationDetailOptions(integrationInstanceId));
  const depsQuery = useQuery(integrationDependencyListOptions(integrationInstanceId));
  const definitionsQuery = useQuery(integrationDefinitionListOptions());
  const instance = detailQuery.data;
  const definition = useMemo(
    () => definitionsQuery.data?.find((entry) => entry.id === instance?.pluginId),
    [definitionsQuery.data, instance?.pluginId],
  );
  const schemaSupported = Boolean(definition && instance && isSupportedSchema(definition, instance));

  const schemaText = useCallback<SchemaTextResolver>(
    (key, fallback) => resolveLocalizedText((translationKey, options) => t(translationKey, options), key, fallback),
    [t],
  );
  const schemaHostOptions = useMemo(() => createSchemaHostOptionResolver(schemaText), [schemaText]);

  // null until a compatible definition is applied; prevents a prior instance's values leaking into another editor.
  const [draft, setDraft] = useState<IntegrationSchemaDraft | null>(null);
  const [trackedInstance, setTrackedInstance] = useState<IntegrationInstanceDto | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (trackedInstance && trackedInstance.id !== integrationInstanceId) {
    setTrackedInstance(null);
    setDraft(null);
    setRenaming(false);
    setRenameValue("");
  }

  if (instance && definition && schemaSupported) {
    const pluginChanged = trackedInstance != null && trackedInstance.pluginId !== instance.pluginId;
    const idChanged = trackedInstance == null || trackedInstance.id !== instance.id;
    const revisionChanged = trackedInstance != null && trackedInstance.updatedAt !== instance.updatedAt;
    const definitionChanged = draft != null && draft.schemaVersion !== definition.configSchemaVersion;
    const draftPluginMismatch = draft != null && draft.pluginId !== instance.pluginId;
    if (idChanged || pluginChanged || draftPluginMismatch || definitionChanged || revisionChanged) {
      const shouldResetDraft =
        idChanged ||
        pluginChanged ||
        draftPluginMismatch ||
        definitionChanged ||
        draft == null ||
        (trackedInstance != null && isIntegrationDraftClean(definition, draft, trackedInstance));
      setTrackedInstance(instance);
      if (shouldResetDraft) {
        setDraft(draftFromIntegrationDto(instance, definition));
        setRenameValue(instance.displayName);
        setRenaming(false);
      } else if (draft.expectedUpdatedAt !== instance.updatedAt) {
        setDraft({ ...draft, expectedUpdatedAt: instance.updatedAt });
      }
    }
  }

  const dirty = useMemo(() => {
    if (!instance || !definition || !draft || !schemaSupported) {
      return false;
    }
    return !isIntegrationDraftClean(definition, draft, instance);
  }, [definition, draft, instance, schemaSupported]);

  const remoteRelevantSaveRef = useRef(false);

  const saveMutation = useMutation({
    mutationFn: saveIntegrationInstance,
    onSuccess: (saved) => {
      queryClient.setQueryData(integrationKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      if (definition && saved.pluginId === definition.id) {
        setDraft(draftFromIntegrationDto(saved, definition));
        setTrackedInstance(saved);
      }
      toast.success({ title: t("plugins.toast.saved") });
      const remoteRelevant = remoteRelevantSaveRef.current;
      remoteRelevantSaveRef.current = false;
      if (remoteRelevant && saved.effectiveStatus !== "plugin_missing") {
        validateMutation.mutate();
      }
    },
    onError: (error) => {
      const message =
        getIpcErrorCode(error) === "credential_unavailable"
          ? t("plugins.toast.credentialUnavailable")
          : getIpcErrorMessage(error, t("plugins.toast.saveFailed"));
      toast.error({ title: t("plugins.toast.saveFailed"), description: message });
    },
  });

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setIntegrationInstanceEnabled(integrationInstanceId, enabled),
    onSuccess: (saved) => {
      queryClient.setQueryData(integrationKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      setDraft((current) =>
        current ? { ...current, enabled: saved.enabled, expectedUpdatedAt: saved.updatedAt } : current,
      );
      setTrackedInstance(saved);
    },
    onError: (error) => {
      const message = getIpcErrorMessage(error, t("plugins.toast.saveFailed"));
      toast.error({ title: t("plugins.toast.saveFailed"), description: message });
    },
  });

  const validateMutation = useMutation({
    mutationFn: () => validateIntegrationInstance(integrationInstanceId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      const description = result.message ?? undefined;
      if (result.healthStatus === "ready") {
        toast.success({
          title: t("plugins.toast.validated"),
          description:
            description ??
            (definition && requiresCredential(definition)
              ? t("plugins.status.authReadyHint")
              : t("plugins.status.localOnlyHint")),
        });
        return;
      }
      if (result.healthStatus === "degraded") {
        toast.warning({ title: t("plugins.toast.validateDegraded"), description });
        return;
      }
      toast.error({ title: t("plugins.toast.validateFailed"), description });
    },
    onError: (error) => {
      const message = getIpcErrorMessage(error, t("plugins.toast.validateFailed"));
      toast.error({ title: t("plugins.toast.validateFailed"), description: message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteIntegrationInstance(integrationInstanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      setDeleteOpen(false);
      void navigate({ to: "/plugins" });
      toast.success({ title: t("plugins.toast.deleted") });
    },
    onError: (error) => {
      const message = getIpcErrorMessage(error, t("plugins.toast.deleteFailed"));
      toast.error({ title: t("plugins.toast.deleteFailed"), description: message });
    },
  });

  if (detailQuery.isLoading || definitionsQuery.isLoading) {
    return (
      <div className="flex flex-1 items-center p-8">
        <p className="text-body-md text-neutral">{t("plugins.loading")}</p>
      </div>
    );
  }

  if (detailQuery.isError || !instance) {
    const message = detailQuery.error
      ? getIpcErrorMessage(detailQuery.error, t("plugins.loadFailed"))
      : t("plugins.loadFailed");
    return (
      <div className="flex flex-1 flex-col items-start gap-2 p-8" role="alert">
        <p className="text-body-md text-error">{message}</p>
        <Button type="button" className={outlineButtonClassName} onClick={() => void detailQuery.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!definition || !schemaSupported) {
    return (
      <div className="flex flex-1 flex-col items-start justify-center gap-2 p-8" role="status">
        <h2 className="text-headline-display font-bold text-on-surface">{instance.displayName}</h2>
        <p className="text-body-md text-neutral">{t("plugins.unsupportedInstance")}</p>
      </div>
    );
  }

  if (
    !draft ||
    draft.pluginId !== instance.pluginId ||
    draft.schemaVersion !== definition.configSchemaVersion ||
    trackedInstance?.id !== instance.id
  ) {
    return (
      <div className="flex flex-1 items-center p-8">
        <p className="text-body-md text-neutral">{t("plugins.loading")}</p>
      </div>
    );
  }

  const pluginMissing = instance.effectiveStatus === "plugin_missing";
  const runtimeUnavailable = isRuntimeUnresolved(instance);
  const pending =
    saveMutation.isPending || deleteMutation.isPending || validateMutation.isPending || enabledMutation.isPending;
  const dependencies = depsQuery.data ?? [];
  const capabilityIds = definition.capabilities.map((capability) => capability.id);
  const hasRequiredCredential = requiresCredential(definition);
  const statusHint =
    instance.healthStatus === "ready"
      ? hasRequiredCredential
        ? t("plugins.status.authReadyHint")
        : t("plugins.status.localOnlyHint")
      : instance.healthStatus === "degraded"
        ? t("plugins.status.authDegradedHint")
        : t("plugins.status.localOnlyHint");
  const saveExpectedUpdatedAt = draft.expectedUpdatedAt?.trim() || instance.updatedAt;
  const canSave = dirty && !pluginMissing && !pending && Boolean(saveExpectedUpdatedAt);

  return (
    <>
      <ConfigEditorLayout
        title={
          renaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <Input
                autoFocus
                className={configEditorRenameInputClassName}
                value={renameValue}
                disabled={pending}
                onChange={(event) => setRenameValue(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setDraft((current) =>
                      current ? { ...current, displayName: renameValue.trim() || current.displayName } : current,
                    );
                    setRenaming(false);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setRenameValue(draft.displayName);
                    setRenaming(false);
                  }
                }}
              />
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("common.done")}
                disabled={pending}
                onClick={() => {
                  setDraft((current) =>
                    current ? { ...current, displayName: renameValue.trim() || current.displayName } : current,
                  );
                  setRenaming(false);
                }}
              >
                <IconMaterialSymbolsLightCheck className="size-4" />
              </Button>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("common.cancel")}
                disabled={pending}
                onClick={() => {
                  setRenameValue(draft.displayName);
                  setRenaming(false);
                }}
              >
                <IconMaterialSymbolsLightClose className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h2 className="min-w-0 truncate text-headline-display font-bold text-on-surface">{draft.displayName}</h2>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("plugins.renameAria")}
                disabled={pending || pluginMissing}
                onClick={() => {
                  setRenameValue(draft.displayName);
                  setRenaming(true);
                }}
              >
                <IconMaterialSymbolsLightEditSquareOutlineSharp className="size-4" />
              </Button>
            </div>
          )
        }
        titleTrailing={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-label-sm text-on-surface">
              <span>{t("common.enabled")}</span>
              <Switch.Root
                className={switchRootClassName}
                checked={draft.enabled}
                disabled={pending}
                onCheckedChange={(checked) => {
                  setDraft((current) => (current ? { ...current, enabled: checked } : current));
                  enabledMutation.mutate(checked, {
                    onError: () => {
                      setDraft((current) => (current ? { ...current, enabled: !checked } : current));
                    },
                  });
                }}
              >
                <Switch.Thumb className={switchThumbClassName} />
              </Switch.Root>
            </label>
            <Button
              type="button"
              className={dangerIconButtonClassName}
              aria-label={t("plugins.deleteAria")}
              disabled={pending}
              onClick={() => setDeleteOpen(true)}
            >
              <IconMaterialSymbolsLightDeleteOutlineSharp className="size-4" />
            </Button>
          </div>
        }
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={pending || dirty || pluginMissing}
              onClick={() => validateMutation.mutate()}
            >
              {t("plugins.validate")}
            </Button>
            <Button
              type="button"
              className={primaryButtonClassName}
              disabled={!canSave}
              onClick={() => {
                if (!canSave) {
                  return;
                }
                remoteRelevantSaveRef.current = hasIntegrationRemoteRelevantMutation(definition, draft, instance);
                saveMutation.mutate(
                  buildIntegrationWrite(definition, draft, {
                    id: instance.id,
                    expectedUpdatedAt: saveExpectedUpdatedAt,
                  }),
                );
              }}
            >
              {saveMutation.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <section className="space-y-2">
            <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">
              {t("plugins.status.label")}
            </h3>
            <p className="text-body-md text-on-surface">{t(statusLabelKey(instance.effectiveStatus))}</p>
            {instance.lastErrorCode ? (
              <p className="text-body-tight text-error">
                {t("plugins.status.lastError", { code: instance.lastErrorCode })}
              </p>
            ) : null}
            <p className="text-body-tight text-neutral">{statusHint}</p>
          </section>

          <section className="space-y-2">
            <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">Runtime</h3>
            <p className="text-body-md text-on-surface">{instance.runtimeKind}</p>
            <p className="text-body-tight text-neutral">{instance.runtimeState}</p>
            {instance.packageDigest ? (
              <p className="font-mono text-body-tight wrap-break-word text-neutral">{instance.packageDigest}</p>
            ) : null}
            {instance.executionGrantSetRevision != null ? (
              <p className="text-body-tight text-neutral">grant rev {instance.executionGrantSetRevision}</p>
            ) : null}
            {runtimeUnavailable && instance.runtimeErrorMessage ? (
              <p className="text-body-tight text-error">{instance.runtimeErrorMessage}</p>
            ) : null}
            {instance.runtimeRequirement?.packageDigest ? (
              <p className="font-mono text-body-tight wrap-break-word text-neutral">
                required {instance.runtimeRequirement.packageDigest}
              </p>
            ) : null}
          </section>

          <RuntimeLifecyclePanel instance={instance} />

          <section className="space-y-2">
            <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">
              {t("plugins.capabilities")}
            </h3>
            {capabilityIds.length === 0 ? (
              <p className="text-body-tight text-neutral">{t("plugins.unsupportedInstance")}</p>
            ) : (
              <ul className="m-0 list-disc space-y-1 pl-5 text-body-tight text-on-surface">
                {capabilityIds.map((capabilityId) => (
                  <li key={capabilityId}>{capabilityId}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">
              {t("plugins.configuration")}
            </h3>
            <SchemaForm
              schema={definition.configSchema}
              values={draft.schema.values}
              credentials={draft.schema.credentials}
              idPrefix={`integration-${instance.id}`}
              disabled={pending || pluginMissing}
              resolveText={schemaText}
              resolveOptions={schemaHostOptions}
              onValueChange={(fieldId, value) => {
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        schema: setSchemaDraftValue(current.schema, fieldId, value),
                      }
                    : current,
                );
              }}
              onCredentialChange={(slotId, credential) => {
                setDraft((current) => {
                  if (!current) {
                    return current;
                  }
                  const currentValue = current.schema.credentials[slotId]?.value ?? "";
                  const nextSchema =
                    credential.action === "replace" && credential.value !== currentValue
                      ? setSchemaCredentialValue(current.schema, slotId, credential.value)
                      : setSchemaCredentialAction(current.schema, slotId, credential.action);
                  return { ...current, schema: nextSchema };
                });
              }}
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-label-sm font-bold tracking-wide text-neutral uppercase">
              {t("plugins.dependencies.title")}
            </h3>
            {depsQuery.isLoading ? (
              <p className="text-body-tight text-neutral">{t("plugins.loading")}</p>
            ) : dependencies.length === 0 ? (
              <p className="text-body-tight text-neutral">{t("plugins.dependencies.empty")}</p>
            ) : (
              <ul className="m-0 list-disc space-y-1 pl-5 text-body-tight text-on-surface">
                {dependencies.map((dependency) => (
                  <li key={`${dependency.kind}:${dependency.id}`}>
                    {dependency.displayName} ({dependency.kind})
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </ConfigEditorLayout>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("plugins.deleteConfirm.title")}
        description={t("plugins.deleteConfirm.description", { name: instance.displayName })}
        confirmText={t("common.delete")}
        pendingText={t("common.deleting")}
        danger
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync();
          } catch (error) {
            const message = getIpcErrorMessage(error, t("plugins.toast.deleteFailed"));
            throw Object.assign(new Error(message), { cause: error });
          }
        }}
      />
    </>
  );
}
