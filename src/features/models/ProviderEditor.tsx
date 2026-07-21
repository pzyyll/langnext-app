// ABOUTME: Selected provider editor for connection settings and model management.
// ABOUTME: Coordinates local form state with Query-backed provider and model data.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import i18n from "../../i18n";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ConfigEditorLayout, configEditorRenameInputClassName } from "../../components/layouts/ConfigEditorLayout";
import { useToast } from "../../components/toast/useToast";
import {
  checkboxClassName,
  checkboxIndicatorClassName,
  dangerButtonClassName,
  iconButtonClassName,
  inputClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  switchRootClassName,
  switchThumbClassName,
  dangerIconButtonClassName,
} from "../../components/ui";
import { SelectField } from "../../components/SelectField";
import { modelKeys, profileKeys, providerKeys } from "../../query/keys";
import { ocrListOptions, profileListOptions, providerListOptions, providerModelsOptions } from "../../query/options";
import {
  deleteProviderInstance,
  deleteProviderModels,
  saveProviderInstance,
  setModelEnabled,
  syncProviderModels,
  testProviderConnection,
} from "../../storage/client";
import { getIpcErrorMessage, isConflictError } from "../../storage/errors";
import type { CredentialUpdate, ProviderInstanceDto, ProviderModelDto } from "../../storage/types";
import { ADAPTER_OPTIONS, getDefaultBaseUrl } from "./adapterOptions";
import { AddManualModelDialog } from "./AddManualModelDialog";
import { EditModelConfigDialog } from "./EditModelConfigDialog";
import { useModelsContext } from "./ModelsContext";
import { ModelsTable } from "./ModelsTable";
import { hasRemoteProviderConflict, shouldShowConflictBanner } from "./providerFormConflict";

export type ProviderEditorProps = {
  providerId: string;
};

type CredentialAction = "keep" | "replace" | "clear";

/** True when URL is non-loopback HTTP and needs insecure-HTTP acknowledgment. */
function needsInsecureHttpAck(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") {
      return false;
    }
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return false;
    }
    return true;
  } catch {
    // Invalid URLs are left to backend validation.
    return false;
  }
}

function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatSyncTimestamp(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

function syncStatusLabel(provider: ProviderInstanceDto, syncPending: boolean): string {
  if (syncPending) {
    return i18n.t("models.syncingModels");
  }
  switch (provider.modelsSyncStatus) {
    case "never":
      return i18n.t("models.syncNever");
    case "ok": {
      const at = formatSyncTimestamp(provider.modelsSyncedAt);
      return at ? i18n.t("models.syncOkAt", { at }) : i18n.t("models.syncOk");
    }
    case "error": {
      const code = provider.modelsSyncErrorCode ? ` (${provider.modelsSyncErrorCode})` : "";
      const at = formatSyncTimestamp(provider.modelsSyncedAt);
      const lastOk = at ? i18n.t("models.syncErrorLastOk", { at }) : "";
      return i18n.t("models.syncError", { code, lastOk });
    }
    default:
      return i18n.t("models.syncUnknown");
  }
}

export function ProviderEditor({ providerId }: ProviderEditorProps) {
  const { t } = useTranslation();
  const providersQuery = useQuery(providerListOptions());
  const provider = (providersQuery.data ?? []).find((item) => item.id === providerId) ?? null;
  const providersLoading = providersQuery.isLoading;
  const providersError =
    providersQuery.error != null ? getIpcErrorMessage(providersQuery.error, t("models.loadChannelsFailed")) : null;

  if (providersLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-body-tight text-neutral" aria-live="polite">
          {t("models.loadingChannel")}
        </p>
      </div>
    );
  }

  if (providersError) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <p className="text-body-tight text-error" role="alert">
          {providersError}
        </p>
        <Button
          type="button"
          className={outlineButtonClassName}
          onClick={() => {
            void providersQuery.refetch();
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="flex flex-1 flex-col items-start gap-2 p-8">
        <h1 className="text-headline-md font-bold text-on-surface">{t("models.channelNotFound")}</h1>
        <p className="text-body-tight text-neutral">{t("models.channelNotFoundHint")}</p>
      </div>
    );
  }

  // Remount connection form when the selected channel changes so local state re-inits cleanly.
  return <ProviderEditorLoaded key={provider.id} provider={provider} />;
}

type ProviderEditorLoadedProps = {
  provider: ProviderInstanceDto;
};

function ProviderEditorLoaded({ provider }: ProviderEditorLoadedProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { beginProviderExit } = useModelsContext();
  const [adapterId, setAdapterId] = useState(provider.adapterId);
  const [baseUrlOverride, setBaseUrlOverride] = useState(provider.baseUrlOverride ?? "");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [token, setToken] = useState("");
  const [credentialAction, setCredentialAction] = useState<CredentialAction>("keep");
  const [insecureHttpAcknowledged, setInsecureHttpAcknowledged] = useState(false);
  /** True only after a local user edit; not derived from server field comparison. */
  const [formDirty, setFormDirty] = useState(false);
  /** Provider.updatedAt last applied into local form fields while clean (OCC baseline). */
  const [syncedUpdatedAt, setSyncedUpdatedAt] = useState(provider.updatedAt);
  /**
   * Remote updatedAt for which the user chose "keep local draft".
   * Banner reappears if remote advances again past this value.
   */
  const [dismissedConflictUpdatedAt, setDismissedConflictUpdatedAt] = useState<string | null>(null);

  const [savePending, setSavePending] = useState(false);
  const [, setSaveError] = useState<string | null>(null);
  const [, setSaveSuccess] = useState(false);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLElement | null>(null);

  const [pendingModelIds, setPendingModelIds] = useState<Set<string>>(() => new Set());
  const [modelMutationError, setModelMutationError] = useState<string | null>(null);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [editingConfigModel, setEditingConfigModel] = useState<ProviderModelDto | null>(null);
  /** Single confirm target so channel/model delete cannot share the wrong handler. */
  const [deleteConfirm, setDeleteConfirm] = useState<"channel" | "models" | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(() => new Set());
  const [deleteModelsPending, setDeleteModelsPending] = useState(false);

  const [connectionTestPending, setConnectionTestPending] = useState(false);
  /** Bumped on form edits / new tests so stale in-flight results are discarded. */
  const connectionTestGeneration = useRef(0);
  /** Latest provider.updatedAt for post-await version checks (avoid stale render closures). */
  const providerUpdatedAtRef = useRef(provider.updatedAt);

  useEffect(() => {
    providerUpdatedAtRef.current = provider.updatedAt;
  }, [provider.updatedAt]);

  // Focus and select the rename input when inline editing starts.
  useEffect(() => {
    if (!renaming) return;
    const node = renameInputRef.current;
    if (node instanceof HTMLInputElement) {
      node.focus();
      node.select();
    }
  }, [renaming]);

  const [syncPending, setSyncPending] = useState(false);

  const providerId = provider.id;

  const modelsQuery = useQuery(providerModelsOptions(providerId));
  const models = modelsQuery.data ?? [];
  const modelsLoading = modelsQuery.isLoading;
  const modelsError =
    modelsQuery.error != null ? getIpcErrorMessage(modelsQuery.error, t("models.loadModelsFailed")) : null;

  // Used only to warn before deleting models that profiles or OCR services still reference.
  const profilesQuery = useQuery(profileListOptions());
  const ocrServicesQuery = useQuery(ocrListOptions());
  const selectedModelsInUse = useMemo(() => {
    if (selectedModelIds.size === 0) {
      return false;
    }
    for (const profile of profilesQuery.data ?? []) {
      if (profile.targets.some((target) => selectedModelIds.has(target.providerModelId))) {
        return true;
      }
      const detectorModelId = profile.languageDetection?.modelId;
      if (detectorModelId && selectedModelIds.has(detectorModelId)) {
        return true;
      }
    }
    for (const service of ocrServicesQuery.data ?? []) {
      if (service.providerModelId && selectedModelIds.has(service.providerModelId)) {
        return true;
      }
    }
    return false;
  }, [ocrServicesQuery.data, profilesQuery.data, selectedModelIds]);

  const seedProvider = useCallback(
    (next: ProviderInstanceDto) => {
      queryClient.setQueryData<ProviderInstanceDto[]>(providerKeys.list(), (current) => {
        if (!current) {
          return [next];
        }
        const index = current.findIndex((item) => item.id === next.id);
        if (index < 0) {
          return [...current, next];
        }
        const copy = current.slice();
        copy[index] = next;
        return copy;
      });
    },
    [queryClient],
  );

  const invalidateProviderAndModels = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    void queryClient.invalidateQueries({ queryKey: modelKeys.all });
  }, [queryClient]);

  const setModelsCache = useCallback(
    (updater: (current: ProviderModelDto[]) => ProviderModelDto[]) => {
      queryClient.setQueryData<ProviderModelDto[]>(modelKeys.byProvider(providerId), (current) =>
        updater(current ?? []),
      );
    },
    [queryClient, providerId],
  );

  const clearConnectionTestResult = useCallback(() => {
    connectionTestGeneration.current += 1;
  }, []);

  const savedBaseUrl = provider.baseUrlOverride ?? null;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrlOverride);
  const endpointChanged = normalizedBaseUrl !== savedBaseUrl;
  const requiresInsecureAck = normalizedBaseUrl !== null && needsInsecureHttpAck(normalizedBaseUrl);
  const endpointUnchangedInsecure =
    !endpointChanged && requiresInsecureAck && Boolean(provider.insecureHttpConfirmedAt);

  // Connection-relevant dirty state: unsaved API type, Base URL, or credential replace/clear.
  // Used to gate remote actions (test/sync) that require a saved connection identity.
  const connectionDirty =
    adapterId !== provider.adapterId ||
    normalizedBaseUrl !== savedBaseUrl ||
    credentialAction === "replace" ||
    credentialAction === "clear";

  const remoteConflict = hasRemoteProviderConflict(formDirty, syncedUpdatedAt, provider.updatedAt);
  const showConflictBanner = shouldShowConflictBanner(remoteConflict, provider.updatedAt, dismissedConflictUpdatedAt);

  // When the server row changes and the user has no local edits, resync form fields
  // during render (React-recommended prop→state adjustment; not an effect).
  // While formDirty, keep local values so remote refresh cannot clobber in-progress edits.
  // formDirty is an explicit user-edit flag — never derive it from provider field diffs,
  // or a remote update would look "dirty" and block resync permanently.
  if (!formDirty && !savePending && provider.updatedAt !== syncedUpdatedAt) {
    setSyncedUpdatedAt(provider.updatedAt);
    setDismissedConflictUpdatedAt(null);
    setAdapterId(provider.adapterId);
    setBaseUrlOverride(provider.baseUrlOverride ?? "");
    setEnabled(provider.enabled);
    setToken("");
    setCredentialAction("keep");
    setInsecureHttpAcknowledged(false);
  }

  function reloadRemoteProviderForm() {
    setAdapterId(provider.adapterId);
    setBaseUrlOverride(provider.baseUrlOverride ?? "");
    setEnabled(provider.enabled);
    setToken("");
    setCredentialAction("keep");
    setInsecureHttpAcknowledged(false);
    setFormDirty(false);
    setSyncedUpdatedAt(provider.updatedAt);
    setDismissedConflictUpdatedAt(null);
    setSaveError(null);
    setSaveSuccess(false);
    clearConnectionTestResult();
  }

  function keepLocalDraftDespiteConflict() {
    setDismissedConflictUpdatedAt(provider.updatedAt);
  }

  // Disable connection form + Save while test/sync is in flight so mid-flight
  // edits cannot race results (backend still re-checks connection identity on sync).
  const connectionFormDisabled = savePending || syncPending || connectionTestPending;

  const remoteActionsDisabled = connectionDirty || connectionTestPending || syncPending || savePending || modelsLoading;

  const buildCredential = useCallback((): CredentialUpdate => {
    if (provider.credentialKind === "none") {
      return { action: "clear" };
    }
    if (credentialAction === "clear") {
      return { action: "clear" };
    }
    if (credentialAction === "replace" && token.trim()) {
      return { action: "replace", value: token.trim() };
    }
    return { action: "keep" };
  }, [credentialAction, provider.credentialKind, token]);

  const formValid = useMemo(() => {
    if (credentialAction === "replace" && !token.trim()) {
      return false;
    }
    if (requiresInsecureAck && !endpointUnchangedInsecure && !insecureHttpAcknowledged) {
      return false;
    }
    return true;
  }, [credentialAction, endpointUnchangedInsecure, insecureHttpAcknowledged, requiresInsecureAck, token]);

  function resetConnectionForm() {
    reloadRemoteProviderForm();
  }

  // Block rename while a connection save / sync / test is in flight to avoid
  // racing provider.updatedAt and stale-result discard logic.
  const renameDisabled = savePending || syncPending || connectionTestPending;

  function startRename() {
    setRenameValue(provider.displayName);
    setRenameError(null);
    setRenaming(true);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameValue("");
    setRenameError(null);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || renamePending) {
      return;
    }
    if (trimmed === provider.displayName) {
      cancelRename();
      return;
    }
    setRenamePending(true);
    setRenameError(null);
    try {
      const saved = await saveProviderInstance({
        id: provider.id,
        adapterId: provider.adapterId,
        displayName: trimmed,
        baseUrlOverride: provider.baseUrlOverride,
        credentialKind: provider.credentialKind,
        credential: { action: "keep" },
        enabled: provider.enabled,
        proxyMode: provider.proxyMode,
        insecureHttpConfirmedAt: provider.insecureHttpConfirmedAt,
        expectedUpdatedAt: provider.updatedAt,
      });
      seedProvider(saved);
      invalidateProviderAndModels();
      // Advance OCC baseline only when the form already matched the pre-rename remote
      // version (clean form, or dirty form without remote drift). If the form was
      // already behind remote, keep the old baseline so the conflict UI remains.
      if (!formDirty || syncedUpdatedAt === provider.updatedAt) {
        setSyncedUpdatedAt(saved.updatedAt);
      }
      setRenaming(false);
      setRenameValue("");
    } catch (error: unknown) {
      if (isConflictError(error)) {
        setRenameError(t("models.conflict.renameConflict"));
        void queryClient.invalidateQueries({ queryKey: providerKeys.all });
      } else {
        setRenameError(getIpcErrorMessage(error, t("models.toast.renameChannelFailed")));
      }
    } finally {
      setRenamePending(false);
    }
  }

  async function handleSave() {
    if (!formValid || savePending || syncPending) {
      return;
    }

    let insecureHttpConfirmedAt: string | null = null;
    if (normalizedBaseUrl !== null && needsInsecureHttpAck(normalizedBaseUrl)) {
      if (!endpointChanged && provider.insecureHttpConfirmedAt) {
        insecureHttpConfirmedAt = provider.insecureHttpConfirmedAt;
      } else if (insecureHttpAcknowledged) {
        insecureHttpConfirmedAt = new Date().toISOString();
      }
    }

    const credential = buildCredential();

    setSavePending(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      // Always send the form baseline; even "keep local draft" must not silent-overwrite.
      const saved = await saveProviderInstance({
        id: provider.id,
        adapterId,
        displayName: provider.displayName,
        baseUrlOverride: normalizedBaseUrl,
        credentialKind: provider.credentialKind,
        credential,
        enabled,
        proxyMode: provider.proxyMode,
        insecureHttpConfirmedAt,
        expectedUpdatedAt: syncedUpdatedAt,
      });
      seedProvider(saved);
      invalidateProviderAndModels();
      setToken("");
      setCredentialAction("keep");
      setInsecureHttpAcknowledged(false);
      setAdapterId(saved.adapterId);
      setBaseUrlOverride(saved.baseUrlOverride ?? "");
      setEnabled(saved.enabled);
      setFormDirty(false);
      setSyncedUpdatedAt(saved.updatedAt);
      setDismissedConflictUpdatedAt(null);
      setSaveSuccess(true);
      // Clear stale connection-test result after a successful save.
      clearConnectionTestResult();
      toast.success({ title: t("models.toast.channelSaved"), description: t("models.toast.channelSavedDesc") });
    } catch (error: unknown) {
      if (isConflictError(error)) {
        // Refresh so the banner sees the latest remote version; keep local draft.
        void queryClient.invalidateQueries({ queryKey: providerKeys.all });
        setDismissedConflictUpdatedAt(null);
        const message = t("models.conflict.saveRejected");
        setSaveError(message);
        toast.error({ title: t("models.toast.saveFailed"), description: message });
      } else {
        const message = getIpcErrorMessage(error, t("models.toast.saveChannelFailed"));
        setSaveError(message);
        toast.error({ title: t("models.toast.saveFailed"), description: message });
      }
    } finally {
      setSavePending(false);
    }
  }

  async function handleTestConnection() {
    if (remoteActionsDisabled || connectionTestPending) {
      return;
    }
    const generation = connectionTestGeneration.current + 1;
    connectionTestGeneration.current = generation;
    const testedProviderId = provider.id;
    // Capture version at click time; backend also returns providerUpdatedAt for compare.
    const testedUpdatedAt = provider.updatedAt;
    setConnectionTestPending(true);
    try {
      const result = await testProviderConnection(testedProviderId);
      // Discard if a newer test started, form was edited, selection changed, or
      // the provider connection version no longer matches (save / remote refresh).
      const versionStillCurrent =
        result.providerUpdatedAt === testedUpdatedAt && providerUpdatedAtRef.current === testedUpdatedAt;
      if (connectionTestGeneration.current !== generation || testedProviderId !== providerId || !versionStillCurrent) {
        return;
      }
      if (result.ok) {
        toast.success({ title: t("models.toast.connectionOk"), description: result.message });
      } else {
        toast.error({ title: t("models.toast.connectionFailed"), description: result.message });
      }
    } catch (error: unknown) {
      if (
        connectionTestGeneration.current !== generation ||
        testedProviderId !== providerId ||
        providerUpdatedAtRef.current !== testedUpdatedAt
      ) {
        return;
      }
      const message = getIpcErrorMessage(error, t("models.toast.connectionTestFailedDesc"));
      toast.error({ title: t("models.toast.connectionTestFailed"), description: message });
    } finally {
      if (connectionTestGeneration.current === generation) {
        setConnectionTestPending(false);
      }
    }
  }

  async function handleSyncModels() {
    if (remoteActionsDisabled || syncPending || modelsLoading) {
      return;
    }
    setSyncPending(true);
    try {
      const result = await syncProviderModels(provider.id);
      // Always apply returned snapshot on successful IPC, regardless of result.ok.
      queryClient.setQueryData(modelKeys.byProvider(providerId), result.models);
      seedProvider(result.provider);
      if (result.ok) {
        invalidateProviderAndModels();
        toast.success({ title: t("models.toast.syncedModels"), description: result.message });
      } else {
        // Soft failure may still update provider sync status fields.
        void queryClient.invalidateQueries({ queryKey: providerKeys.all });
        toast.error({
          title: t("models.toast.syncFailed"),
          description: result.errorCode ? `${result.message} (${result.errorCode})` : result.message,
        });
      }
    } catch (error: unknown) {
      // Preserve displayed models only when IPC itself fails.
      const message = getIpcErrorMessage(error, t("models.toast.syncFailedDesc"));
      toast.error({ title: t("models.toast.syncFailed"), description: message });
    } finally {
      setSyncPending(false);
    }
  }

  async function handleModelEnabledChange(modelId: string, nextEnabled: boolean) {
    if (pendingModelIds.has(modelId)) {
      return;
    }

    const previous = models.find((model) => model.id === modelId);
    if (!previous) {
      return;
    }

    setModelMutationError(null);
    setPendingModelIds((current) => new Set(current).add(modelId));
    setModelsCache((current) =>
      current.map((model) => (model.id === modelId ? { ...model, enabled: nextEnabled } : model)),
    );

    try {
      const updated = await setModelEnabled(modelId, nextEnabled);
      setModelsCache((current) => current.map((model) => (model.id === modelId ? updated : model)));
      void queryClient.invalidateQueries({ queryKey: modelKeys.all });
    } catch (error: unknown) {
      setModelsCache((current) => current.map((model) => (model.id === modelId ? previous : model)));
      const message = getIpcErrorMessage(error, t("models.toast.updateModelFailed"));
      setModelMutationError(message);
      toast.error({ title: t("models.toast.updateFailed"), description: message });
    } finally {
      setPendingModelIds((current) => {
        const next = new Set(current);
        next.delete(modelId);
        return next;
      });
    }
  }

  function enterSelectionMode() {
    setSelectedModelIds(new Set());
    setSelectionMode(true);
  }

  function exitSelectionMode() {
    setSelectedModelIds(new Set());
    setSelectionMode(false);
  }

  function handleToggleSelect(modelId: string) {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }

  function handleToggleSelectAll(checked: boolean, visibleModelIds: readonly string[]) {
    if (checked) {
      setSelectedModelIds(new Set(visibleModelIds));
    } else {
      setSelectedModelIds(new Set());
    }
  }

  async function handleDeleteModels() {
    const ids = Array.from(selectedModelIds);
    if (ids.length === 0 || deleteModelsPending) {
      return;
    }

    const idSet = new Set(ids);
    const previousModels = models;
    setModelMutationError(null);
    setDeleteModelsPending(true);
    setPendingModelIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.add(id);
      }
      return next;
    });
    // Optimistic remove; single IPC is all-or-nothing so failure restores the prior cache.
    setModelsCache((current) => current.filter((model) => !idSet.has(model.id)));

    try {
      await deleteProviderModels(ids);
      // Model delete must never remove the channel; re-seed so a concurrent providers
      // cache race cannot drop the open channel from the sidebar.
      seedProvider(provider);
      void queryClient.invalidateQueries({ queryKey: modelKeys.all });
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
      setSelectedModelIds(new Set());
      setSelectionMode(false);
      const count = ids.length;
      toast.success({
        title: count === 1 ? t("models.toast.modelDeleted") : t("models.toast.modelsDeleted"),
        description: count === 1 ? t("models.toast.removedOne") : t("models.toast.removedMany", { count }),
      });
    } catch (error: unknown) {
      setModelsCache(() => previousModels);
      const message = getIpcErrorMessage(error, t("models.toast.deleteSomeModelsFailed"));
      setModelMutationError(message);
      toast.error({ title: t("models.toast.deleteFailed"), description: message });
      // Authoritative resync in case partial event noise or cache drift.
      void modelsQuery.refetch();
    } finally {
      setPendingModelIds((current) => {
        const next = new Set(current);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
      setDeleteModelsPending(false);
    }
  }

  async function handleDelete() {
    try {
      await deleteProviderInstance(provider.id);
    } catch (err: unknown) {
      const error = new Error(getIpcErrorMessage(err, t("models.toast.deleteChannelFailed")));
      throw Object.assign(error, { cause: err });
    }
    beginProviderExit(provider);
    void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    void queryClient.invalidateQueries({ queryKey: modelKeys.all });
    void navigate({ to: "/models" });
  }

  const defaultBaseUrl = getDefaultBaseUrl(adapterId);
  const tokenDisabled = provider.credentialKind === "none" || credentialAction === "clear";
  const tokenPlaceholder =
    credentialAction === "clear"
      ? t("models.tokenRemovedOnSave")
      : provider.hasCredential
        ? t("models.tokenStored")
        : t("models.tokenEnter");

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
                    cancelRename();
                  }
                }}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                disabled={renamePending}
              />
              <Button
                type="submit"
                className={iconButtonClassName}
                aria-label={t("models.saveChannelName")}
                disabled={renamePending || !renameValue.trim()}
              >
                <IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
              </Button>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("models.cancelRename")}
                disabled={renamePending}
                onClick={cancelRename}
              >
                <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-headline-display font-bold text-on-surface">{provider.displayName}</h1>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("models.renameChannel")}
                title={t("models.renameChannel")}
                disabled={renameDisabled}
                onClick={startRename}
              >
                <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
              </Button>
            </div>
          )
        }
        titleTrailing={
          <label className="flex shrink-0 items-center gap-2 text-body-tight text-on-surface">
            <Switch.Root
              checked={enabled}
              onCheckedChange={(checked) => {
                setEnabled(checked);
                setFormDirty(true);
                setSaveSuccess(false);
                clearConnectionTestResult();
              }}
              disabled={connectionFormDisabled}
              className={switchRootClassName}
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
              className={`
              ${dangerIconButtonClassName}
              mr-auto
            `}
              aria-label={t("models.deleteChannel")}
              title={t("models.deleteChannel")}
              disabled={connectionFormDisabled}
              onClick={() => {
                setDeleteConfirm("channel");
              }}
            >
              <IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
            </Button>

            <Button
              type="button"
              className={outlineButtonClassName}
              disabled={connectionFormDisabled}
              onClick={resetConnectionForm}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={`
              ${primaryButtonClassName}
              relative
            `}
              disabled={connectionFormDisabled || !formValid}
              focusableWhenDisabled
              aria-busy={connectionFormDisabled}
              aria-label={connectionFormDisabled ? t("common.saving") : t("common.save")}
              onClick={() => {
                void handleSave();
              }}
            >
              <span className={connectionFormDisabled ? "invisible" : undefined} aria-hidden="true">
                {t("common.save")}
              </span>
              {connectionFormDisabled ? (
                <span
                  className="absolute size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          </>
        }
      >
        <section className="shadow-frame relative mb-10 border border-line p-6">
          <h3 className="mb-6 text-headline-sm font-bold text-on-surface">{t("models.connection")}</h3>
          {showConflictBanner ? (
            <div className="mb-6 border border-error bg-surface-2 p-4 text-body-tight text-on-surface" role="alert">
              <p className="font-medium text-error">{t("models.conflict.title")}</p>
              <p className="mt-1 text-neutral">{t("models.conflict.description")}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className={outlineButtonClassName}
                  disabled={savePending}
                  onClick={reloadRemoteProviderForm}
                >
                  {t("models.conflict.reloadRemote")}
                </Button>
                <Button
                  type="button"
                  className={primaryButtonClassName}
                  disabled={savePending}
                  onClick={keepLocalDraftDespiteConflict}
                >
                  {t("models.conflict.keepLocal")}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="space-y-6">
            <div>
              <label className="mb-1 block text-body-tight font-medium text-on-surface" id="provider-api-type-label">
                {t("models.apiTypeLabel")}
              </label>
              <SelectField
                value={adapterId}
                onValueChange={(value) => {
                  setAdapterId(value ?? ADAPTER_OPTIONS[0]?.id ?? "");
                  setFormDirty(true);
                  setSaveSuccess(false);
                  clearConnectionTestResult();
                }}
                options={ADAPTER_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
                extraOptions={
                  adapterId && !ADAPTER_OPTIONS.some((o) => o.id === adapterId)
                    ? [{ value: adapterId, label: adapterId }]
                    : undefined
                }
                disabled={connectionFormDisabled}
                aria-labelledby="provider-api-type-label"
              />
            </div>

            <div>
              <label className="mb-1 block text-body-tight font-medium text-on-surface" htmlFor="provider-base-url">
                {t("models.baseUrl")}
              </label>
              <Input
                id="provider-base-url"
                className={inputClassName}
                type="text"
                value={baseUrlOverride}
                onChange={(event) => {
                  setBaseUrlOverride(event.currentTarget.value);
                  setFormDirty(true);
                  setSaveSuccess(false);
                  setInsecureHttpAcknowledged(false);
                  clearConnectionTestResult();
                }}
                placeholder={defaultBaseUrl ?? "https://…"}
                spellCheck={false}
                disabled={connectionFormDisabled}
              />
              {defaultBaseUrl ? (
                <p className="mt-1 text-xs text-neutral">{t("common.default", { value: defaultBaseUrl })}</p>
              ) : null}
            </div>

            <div>
              <label className="mb-1 block text-body-tight font-medium text-on-surface" htmlFor="provider-api-token">
                {t("models.apiToken")}
              </label>
              <Input
                id="provider-api-token"
                className={`
                  ${inputClassName}
                  tracking-widest
                `}
                type="password"
                value={token}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setToken(value);
                  setFormDirty(true);
                  setSaveSuccess(false);
                  clearConnectionTestResult();
                  if (credentialAction === "clear") {
                    return;
                  }
                  if (value.trim()) {
                    setCredentialAction("replace");
                  } else {
                    setCredentialAction("keep");
                  }
                }}
                placeholder={tokenPlaceholder}
                spellCheck={false}
                autoComplete="off"
                disabled={connectionFormDisabled || tokenDisabled}
              />
            </div>

            {requiresInsecureAck && !endpointUnchangedInsecure ? (
              <label className="flex items-start gap-2 text-body-tight text-on-surface">
                <Checkbox.Root
                  className={`
                    ${checkboxClassName}
                    mt-0.5
                  `}
                  checked={insecureHttpAcknowledged}
                  onCheckedChange={(checked) => {
                    setInsecureHttpAcknowledged(checked);
                    setFormDirty(true);
                    setSaveSuccess(false);
                  }}
                  disabled={connectionFormDisabled}
                >
                  <Checkbox.Indicator className={checkboxIndicatorClassName}>
                    <IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span>{t("models.insecureHttpAck")}</span>
              </label>
            ) : null}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="inline-flex"
                  title={
                    connectionDirty
                      ? t("models.saveBeforeRemote")
                      : connectionTestPending
                        ? t("models.testingConnection")
                        : t("models.testConnectionTitle")
                  }
                >
                  <Button
                    type="button"
                    className={outlineButtonClassName}
                    disabled={remoteActionsDisabled}
                    focusableWhenDisabled
                    onClick={() => {
                      void handleTestConnection();
                    }}
                  >
                    {connectionTestPending ? t("common.testing") : t("models.testConnection")}
                  </Button>
                </span>
                {provider.credentialKind !== "none" && provider.hasCredential ? (
                  credentialAction !== "clear" ? (
                    <Button
                      type="button"
                      className={outlineButtonClassName}
                      disabled={connectionFormDisabled}
                      onClick={() => {
                        setCredentialAction("clear");
                        setToken("");
                        setFormDirty(true);
                        setSaveSuccess(false);
                        clearConnectionTestResult();
                      }}
                    >
                      {t("models.resetToken")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      className={outlineButtonClassName}
                      disabled={connectionFormDisabled}
                      onClick={() => {
                        setCredentialAction("keep");
                        setToken("");
                        setFormDirty(true);
                        setSaveSuccess(false);
                        clearConnectionTestResult();
                      }}
                    >
                      {t("models.keepStoredToken")}
                    </Button>
                  )
                ) : null}
              </div>
              {connectionDirty ? (
                <p className="text-xs text-neutral" id="connection-dirty-help">
                  {t("models.saveBeforeRemote")}
                </p>
              ) : null}
              {credentialAction === "clear" ? (
                <p className="text-xs text-neutral">{t("models.tokenRemovedOnSavePeriod")}</p>
              ) : null}
              {credentialAction === "replace" && token.trim() ? (
                <p className="text-xs text-neutral">{t("models.tokenReplaceHint")}</p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="shadow-frame border border-line p-6">
          <div
            className="
              mb-6 flex flex-col justify-between gap-4
              sm:flex-row sm:items-start
            "
          >
            <div>
              <h3 className="text-headline-sm font-bold text-on-surface">{t("models.listTitle")}</h3>
              <p className="mt-1 text-xs text-neutral" aria-live="polite">
                {syncStatusLabel(provider, syncPending)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {selectionMode ? (
                <>
                  <Button
                    type="button"
                    className={dangerButtonClassName}
                    disabled={selectedModelIds.size === 0 || syncPending || deleteModelsPending}
                    onClick={() => {
                      setDeleteConfirm("models");
                    }}
                  >
                    {t("models.deleteSelected", { count: selectedModelIds.size })}
                  </Button>
                  <Button
                    type="button"
                    className={outlineButtonClassName}
                    disabled={deleteModelsPending}
                    onClick={exitSelectionMode}
                  >
                    {t("common.done")}
                  </Button>
                </>
              ) : (
                <>
                  <span
                    className="inline-flex"
                    title={
                      connectionDirty
                        ? t("models.saveBeforeRemote")
                        : syncPending
                          ? t("models.syncingModels")
                          : t("models.getModelsTitle")
                    }
                  >
                    <Button
                      type="button"
                      className={outlineButtonClassName}
                      disabled={remoteActionsDisabled}
                      focusableWhenDisabled
                      onClick={() => {
                        void handleSyncModels();
                      }}
                    >
                      {syncPending ? t("common.syncing") : t("models.getModels")}
                    </Button>
                  </span>
                  <Button
                    type="button"
                    className={outlineButtonClassName}
                    onClick={() => {
                      setAddModelOpen(true);
                    }}
                  >
                    {t("models.addModel")}
                  </Button>
                  <Button
                    type="button"
                    className={outlineButtonClassName}
                    disabled={models.length === 0 || modelsLoading || Boolean(modelsError) || syncPending}
                    onClick={enterSelectionMode}
                  >
                    {t("common.select")}
                  </Button>
                </>
              )}
            </div>
          </div>

          {modelsLoading ? (
            <p className="text-body-tight text-neutral" aria-live="polite">
              {t("models.loadingModels")}
            </p>
          ) : null}

          {modelsError ? (
            <div className="mb-4 flex flex-col gap-2" role="alert">
              <p className="text-body-tight text-error">{modelsError}</p>
              <Button
                type="button"
                className={outlineButtonClassName}
                onClick={() => {
                  void modelsQuery.refetch();
                }}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : null}

          {modelMutationError ? (
            <p className="mb-4 text-body-tight text-error" role="alert">
              {modelMutationError}
            </p>
          ) : null}

          {!modelsLoading && !modelsError ? (
            <ModelsTable
              models={models}
              pendingModelIds={pendingModelIds}
              onEnabledChange={(modelId, nextEnabled) => {
                void handleModelEnabledChange(modelId, nextEnabled);
              }}
              onEditModel={(model) => {
                setEditingConfigModel(model);
              }}
              selectionMode={selectionMode}
              selectedModelIds={selectedModelIds}
              onToggleSelect={handleToggleSelect}
              onToggleSelectAll={handleToggleSelectAll}
            />
          ) : null}
        </section>
      </ConfigEditorLayout>

      <AddManualModelDialog
        open={addModelOpen}
        providerId={providerId}
        onOpenChange={setAddModelOpen}
        onCreated={(model) => {
          setModelsCache((current) => {
            if (current.some((item) => item.id === model.id)) {
              return current.map((item) => (item.id === model.id ? model : item));
            }
            return [...current, model];
          });
          void queryClient.invalidateQueries({ queryKey: modelKeys.all });
        }}
      />

      <EditModelConfigDialog
        open={editingConfigModel !== null}
        model={editingConfigModel}
        onOpenChange={(open) => {
          if (!open) {
            setEditingConfigModel(null);
          }
        }}
        onSaved={(updated) => {
          setModelsCache((current) => current.map((item) => (item.id === updated.id ? updated : item)));
          void queryClient.invalidateQueries({ queryKey: modelKeys.all });
          setEditingConfigModel(null);
        }}
      />

      <ConfirmDialog
        open={deleteConfirm != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirm(null);
          }
        }}
        title={deleteConfirm === "channel" ? t("models.deleteChannel") : t("models.deleteModels")}
        description={
          deleteConfirm === "channel"
            ? t("models.deleteChannelConfirm", { name: provider.displayName })
            : selectedModelsInUse
              ? t("models.deleteModelsConfirmInUse")
              : t("models.deleteModelsConfirm", { count: selectedModelIds.size })
        }
        confirmText={t("common.delete")}
        pendingText={t("common.deleting")}
        danger
        onConfirm={async () => {
          if (deleteConfirm === "channel") {
            await handleDelete();
            return;
          }
          if (deleteConfirm === "models") {
            await handleDeleteModels();
          }
        }}
      />
    </>
  );
}
