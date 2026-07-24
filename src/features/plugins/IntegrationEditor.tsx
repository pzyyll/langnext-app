// ABOUTME: Selected plugin instance editor shell with status, form, and dependencies.
// ABOUTME: Hosts typed Google Cloud and Google Web forms; secrets stay write-only until save.
import { useMemo, useRef, useState } from "react";
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
import type { IntegrationInstanceDto, IntegrationInstanceWrite } from "../../storage/types";
import { GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID } from "../../storage/types";
import { GoogleCloudIntegrationForm } from "./GoogleCloudIntegrationForm";
import { GoogleTranslateWebIntegrationForm } from "./GoogleTranslateWebIntegrationForm";
import {
  buildGoogleCloudWrite,
  buildGoogleTranslateWebWrite,
  draftFromGoogleTranslateWebDto,
  draftFromIntegrationDto,
  hasGoogleTranslateWebConfigMutation,
  hasRemoteRelevantMutation,
  isGoogleCloudDraftClean,
  isGoogleTranslateWebDraftClean,
  type GoogleCloudIntegrationDraft,
  type GoogleTranslateWebIntegrationDraft,
} from "./integrationDraft";

export type IntegrationEditorProps = {
  integrationInstanceId: string;
};

type EditorDraft = GoogleCloudIntegrationDraft | GoogleTranslateWebIntegrationDraft;

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

function isSupportedPlugin(pluginId: string): boolean {
  return pluginId === GOOGLE_CLOUD_PLUGIN_ID || pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID;
}

function draftFromInstance(instance: IntegrationInstanceDto): EditorDraft {
  if (instance.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID) {
    return draftFromGoogleTranslateWebDto(instance);
  }
  return draftFromIntegrationDto(instance);
}

function isDraftClean(draft: EditorDraft, instance: IntegrationInstanceDto): boolean {
  if (draft.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID) {
    return isGoogleTranslateWebDraftClean(draft, instance);
  }
  return isGoogleCloudDraftClean(draft, instance);
}

function patchDraft(
  current: EditorDraft | null,
  patch: Partial<GoogleCloudIntegrationDraft> & Partial<GoogleTranslateWebIntegrationDraft>,
): EditorDraft | null {
  return current ? ({ ...current, ...patch } as EditorDraft) : current;
}

function buildWrite(draft: EditorDraft, instanceId: string, expectedUpdatedAt: string): IntegrationInstanceWrite {
  // Always stamp the server revision at save time so a stale/null draft field cannot
  // omit expectedUpdatedAt (backend requires it on update).
  if (draft.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID) {
    return {
      ...buildGoogleTranslateWebWrite(draft, { id: instanceId }),
      expectedUpdatedAt,
    };
  }
  return {
    ...buildGoogleCloudWrite(draft, { id: instanceId }),
    expectedUpdatedAt,
  };
}

function needsRemoteRelevantSave(draft: EditorDraft, instance: IntegrationInstanceDto): boolean {
  if (draft.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID) {
    return hasGoogleTranslateWebConfigMutation(draft, instance);
  }
  return hasRemoteRelevantMutation(draft, instance);
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

  // null until the loaded instance is applied — avoids a Cloud empty draft bleeding into Web.
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [trackedInstance, setTrackedInstance] = useState<IntegrationInstanceDto | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Route id change: drop previous plugin draft entirely (plugin isolation).
  if (trackedInstance && trackedInstance.id !== integrationInstanceId) {
    setTrackedInstance(null);
    setDraft(null);
    setRenaming(false);
    setRenameValue("");
  }

  // Accept remote instance updates into the draft only while the form is clean.
  // Always reset when instance id or plugin kind changes so Cloud/Web never share draft state.
  if (instance) {
    const pluginChanged = trackedInstance != null && trackedInstance.pluginId !== instance.pluginId;
    const idChanged = trackedInstance == null || trackedInstance.id !== instance.id;
    const revisionChanged = trackedInstance != null && trackedInstance.updatedAt !== instance.updatedAt;
    const draftKindMismatch = draft != null && draft.pluginId !== instance.pluginId;
    if (idChanged || pluginChanged || draftKindMismatch || revisionChanged) {
      const shouldResetDraft =
        idChanged ||
        pluginChanged ||
        draftKindMismatch ||
        draft == null ||
        (trackedInstance != null && isDraftClean(draft, trackedInstance));
      setTrackedInstance(instance);
      if (shouldResetDraft) {
        setDraft(draftFromInstance(instance));
        setRenameValue(instance.displayName);
        setRenaming(false);
      } else if (draft != null && draft.expectedUpdatedAt !== instance.updatedAt) {
        // Keep user edits, but refresh the CAS token so save cannot send a null/stale empty field.
        setDraft({ ...draft, expectedUpdatedAt: instance.updatedAt });
      }
    }
  }

  const dirty = useMemo(() => {
    if (!instance || !draft) return false;
    if (draft.pluginId !== instance.pluginId) return false;
    return !isDraftClean(draft, instance);
  }, [draft, instance]);

  const capabilityIds = useMemo(() => {
    if (!instance) return [];
    const definition = definitionsQuery.data?.find((entry) => entry.id === instance.pluginId);
    return definition?.capabilities.map((capability) => capability.id) ?? [];
  }, [definitionsQuery.data, instance]);

  // Tracks whether the most recent save mutated credentials or config, so
  // onSuccess can trigger remote validation only when a re-check is meaningful (not name-only).
  const remoteRelevantSaveRef = useRef(false);

  const saveMutation = useMutation({
    mutationFn: saveIntegrationInstance,
    onSuccess: (saved) => {
      queryClient.setQueryData(integrationKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      // Clear pending secret after successful replacement.
      setDraft(draftFromInstance(saved));
      setTrackedInstance(saved);
      toast.success({ title: t("plugins.toast.saved") });
      // Remote validation is re-checked after credential or config mutation;
      // name-only saves leave auth/config valid and do not need a network round-trip.
      const remoteRelevant = remoteRelevantSaveRef.current;
      remoteRelevantSaveRef.current = false;
      if (remoteRelevant && !pluginMissing) {
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

  // Enable/disable is a dedicated IPC so missing-plugin instances can still be disabled
  // without a full save (save requires the manifest for config/credential validation).
  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) => setIntegrationInstanceEnabled(integrationInstanceId, enabled),
    onSuccess: (saved) => {
      queryClient.setQueryData(integrationKeys.detail(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
      setDraft((current) =>
        current ? { ...current, enabled: saved.enabled, expectedUpdatedAt: saved.updatedAt } : draftFromInstance(saved),
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
      const isWeb = instance?.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID;
      if (result.healthStatus === "ready" && (result.remoteChecked || isWeb)) {
        toast.success({
          title: t("plugins.toast.validated"),
          description:
            description ?? (isWeb ? t("plugins.googleTranslateWeb.readyHint") : t("plugins.status.authReadyHint")),
        });
        return;
      }
      if (result.healthStatus === "degraded") {
        toast.warning({
          title: t("plugins.toast.validateDegraded"),
          description,
        });
        return;
      }
      // unconfigured / missing plugin / local-only incomplete checks
      toast.error({
        title: t("plugins.toast.validateFailed"),
        description,
      });
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

  if (detailQuery.isLoading) {
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

  if (!isSupportedPlugin(instance.pluginId)) {
    return (
      <div className="flex flex-1 items-center p-8">
        <p className="text-body-md text-neutral">{t("plugins.unsupportedInstance")}</p>
      </div>
    );
  }

  // Wait until draft is bound to this instance/plugin before rendering the editor shell.
  if (!draft || draft.pluginId !== instance.pluginId || trackedInstance?.id !== instance.id) {
    return (
      <div className="flex flex-1 items-center p-8">
        <p className="text-body-md text-neutral">{t("plugins.loading")}</p>
      </div>
    );
  }

  const pluginMissing = instance.effectiveStatus === "plugin_missing";
  const isWeb = instance.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID;
  const pending =
    saveMutation.isPending || deleteMutation.isPending || validateMutation.isPending || enabledMutation.isPending;
  const dependencies = depsQuery.data ?? [];
  // Prefer draft CAS token; fall back to loaded instance revision (never null on update).
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
                onChange={(event) => {
                  setRenameValue(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setDraft((current) =>
                      patchDraft(current, {
                        displayName: renameValue.trim() || current?.displayName || "",
                      }),
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
                    patchDraft(current, {
                      displayName: renameValue.trim() || current?.displayName || "",
                    }),
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
                  // Optimistic local mirror; mutation is authoritative.
                  setDraft((current) => patchDraft(current, { enabled: checked }));
                  enabledMutation.mutate(checked, {
                    onError: () => {
                      setDraft((current) => patchDraft(current, { enabled: !checked }));
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
              onClick={() => {
                setDeleteOpen(true);
              }}
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
              onClick={() => {
                validateMutation.mutate();
              }}
            >
              {t("plugins.validate")}
            </Button>
            <Button
              type="button"
              className={primaryButtonClassName}
              disabled={!canSave}
              onClick={() => {
                if (!canSave) return;
                // Enabled is persisted via setIntegrationInstanceEnabled; keep write in sync.
                remoteRelevantSaveRef.current = needsRemoteRelevantSave(draft, instance);
                saveMutation.mutate(buildWrite(draft, instance.id, saveExpectedUpdatedAt));
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
            <p className="text-body-md text-on-surface">
              {isWeb && instance.effectiveStatus === "ready"
                ? t("plugins.googleTranslateWeb.statusReady")
                : t(statusLabelKey(instance.effectiveStatus))}
            </p>
            {instance.lastErrorCode ? (
              <p className="text-body-tight text-error">
                {t("plugins.status.lastError", { code: instance.lastErrorCode })}
              </p>
            ) : null}
            <p className="text-body-tight text-neutral">
              {isWeb
                ? instance.effectiveStatus === "ready"
                  ? t("plugins.googleTranslateWeb.readyHint")
                  : instance.effectiveStatus === "disabled"
                    ? t("plugins.googleTranslateWeb.disabledHint")
                    : instance.effectiveStatus === "plugin_missing"
                      ? t("plugins.googleTranslateWeb.pluginMissingHint")
                      : instance.effectiveStatus === "unconfigured"
                        ? t("plugins.googleTranslateWeb.unconfiguredHint")
                        : t("plugins.googleTranslateWeb.privacyNote")
                : instance.healthStatus === "ready"
                  ? t("plugins.status.authReadyHint")
                  : instance.healthStatus === "degraded"
                    ? t("plugins.status.authDegradedHint")
                    : t("plugins.status.localOnlyHint")}
            </p>
          </section>

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
            {/* Form kind is driven by instance.pluginId (authoritative), not residual draft state. */}
            {instance.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID &&
            draft.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID ? (
              <GoogleTranslateWebIntegrationForm
                key={instance.id}
                draft={draft}
                disabled={pending || pluginMissing}
                onChange={setDraft}
              />
            ) : instance.pluginId === GOOGLE_CLOUD_PLUGIN_ID && draft.pluginId === GOOGLE_CLOUD_PLUGIN_ID ? (
              <GoogleCloudIntegrationForm
                key={instance.id}
                draft={draft}
                disabled={pending || pluginMissing}
                onChange={setDraft}
              />
            ) : (
              <p className="text-body-tight text-neutral">{t("plugins.unsupportedInstance")}</p>
            )}
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
                {dependencies.map((dep) => (
                  <li key={`${dep.kind}:${dep.id}`}>
                    {dep.displayName} ({dep.kind})
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
