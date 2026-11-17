import { cleanup, effect, type InputRef, setAccessibilityFocus, signal, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { toast } from "../../../components/ui/toast";
import type { ProtocolId } from "../../../modules/ai/contracts/protocol";
import type { ProviderDefinition } from "../../../modules/ai/contracts/provider";
import { aiClient } from "../../../modules/ai/runtime/client";
import { aiRegistry } from "../../../modules/ai/runtime/registry";
import type { ProviderCredentialMode } from "../../../modules/ai/ui/contracts";
import { getProviderTypeLabel } from "../../../modules/ai/ui/labels";
import { providerSettingsRegistry } from "../../../modules/ai/ui/registry";
import type { AddModelSubmission } from "../add-model-dialog";
import type { EditModelSubmission } from "../edit-model-dialog";
import type { ChannelDraft } from "../channel-draft";
import {
  inspectBaseUrl,
  isInsecureHttpConfirmed,
  resolveConfirmedInsecureUrl,
} from "../connection";
import {
  createManualModel,
  deleteChannel,
  deleteModelsBulk,
  discoverModelsSnapshot,
  PartialDraftSaveError,
  renameChannel,
  RevisionConflictError,
  saveChannelDraft,
  setModelEnabled,
  syncChannelModels,
  testConnectionSnapshot,
  toggleChannelEnabled,
  updateChannel,
  updateModelConfig,
} from "../store";
import type {
  ConnectionSnapshot,
  CredentialUpdate,
  ModelsEnabledFilter,
  ProviderChannel,
  ProviderModel,
} from "../types";

type CredentialDraftMode = "keep" | "replace" | "clear";

export type ChannelEditorProps =
  | {
      mode: "draft";
      draft: ChannelDraft;
      enabledFilter: ModelsEnabledFilter;
      onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
      onDraftSaved: (channel: ProviderChannel) => void;
      onCancelDraft: () => void;
      onRegisterAbort?: (abort: () => void) => () => void;
      onRegisterDraftFocus?: (focus: () => void) => () => void;
    }
  | {
      mode: "saved";
      channel: ProviderChannel;
      models: ProviderModel[];
      enabledFilter: ModelsEnabledFilter;
      onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
    };

/**
 * Owns one editor owner's connection state, request lifetimes, saves, and model
 * actions. `ChannelEditor` calls it once so NSH cleanup belongs to that owner;
 * there are no module-global editor signals.
 */
export function createChannelEditorController(props: ChannelEditorProps) {
  const isDraftMode = () => props.mode === "draft";

  const savedAdapterId = signal<ProtocolId>(
    props.mode === "saved" ? props.channel.adapterId : props.draft.adapterId(),
  );
  const savedBaseUrl = signal(props.mode === "saved" ? (props.channel.baseUrl ?? "") : "");
  const credentialMode = signal<CredentialDraftMode>("keep");
  const savedCredential = signal("");
  const savedConfirmedInsecureUrl = signal<string | null>(
    props.mode === "saved" && props.channel.insecureHttpConfirmedAt !== null
      ? resolveConfirmedInsecureUrl(props.channel.baseUrl ?? "", true)
      : null,
  );
  const savedAllowInsecureHttp = () =>
    isInsecureHttpConfirmed(savedBaseUrl(), savedConfirmedInsecureUrl());

  const renaming = signal(false);
  const renameDraft = signal("");
  const renameSaving = signal(false);

  const saving = signal(false);
  const nameError = signal<string | null>(null);
  const saveError = signal<string | null>(null);
  const conflictDetected = signal(false);

  const testing = signal(false);
  const syncing = signal(false);
  const connectionMessage = signal<{ ok: boolean; text: string } | null>(null);

  const addModelOpen = signal(false);
  const editingModel = signal<ProviderModel | null>(null);
  const deleteDialogOpen = signal(false);
  const deletingChannel = signal(false);

  let activeController: AbortController | null = null;
  let draftNameInputRef: InputRef | null = null;
  let activeRequestSeq = 0;
  let syncedMode: "draft" | "saved" | "" = "";
  let syncedId = "";
  let syncedRevision = -1;
  let lastConnectionFingerprint = "";

  const currentOwnerId = () =>
    props.mode === "draft" ? `draft:${props.draft.id}` : `saved:${props.channel.id}`;

  const connectionFingerprint = () =>
    props.mode === "draft"
      ? JSON.stringify([
          "draft",
          props.draft.id,
          props.draft.adapterId(),
          props.draft.baseUrl(),
          props.draft.credential(),
          props.draft.allowInsecureHttp(),
        ])
      : JSON.stringify([
          "saved",
          props.channel.id,
          savedAdapterId(),
          savedBaseUrl(),
          credentialMode(),
          savedCredential(),
          savedAllowInsecureHttp(),
        ]);

  const invalidateInFlight = () => {
    activeRequestSeq += 1;
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    testing.set(false);
    syncing.set(false);
  };

  cleanup(() => invalidateInFlight());

  const focusDraftNameInput = () => {
    if (draftNameInputRef) {
      draftNameInputRef.focus();
      setAccessibilityFocus(draftNameInputRef);
    }
  };

  effect(() => {
    if (props.mode === "draft" && props.onRegisterAbort) {
      return props.onRegisterAbort(invalidateInFlight);
    }
    return undefined;
  });

  effect(() => {
    if (props.mode === "draft" && props.onRegisterDraftFocus) {
      return props.onRegisterDraftFocus(focusDraftNameInput);
    }
    return undefined;
  });

  effect(() => {
    const fingerprint = connectionFingerprint();
    if (fingerprint !== lastConnectionFingerprint) {
      const initialized = lastConnectionFingerprint !== "";
      lastConnectionFingerprint = fingerprint;
      if (initialized) {
        invalidateInFlight();
      }
    }
  });

  const loadFromChannel = (ch: ProviderChannel) => {
    savedAdapterId.set(ch.adapterId);
    savedBaseUrl.set(ch.baseUrl ?? "");
    credentialMode.set("keep");
    savedCredential.set("");
    savedConfirmedInsecureUrl.set(
      ch.insecureHttpConfirmedAt !== null
        ? resolveConfirmedInsecureUrl(ch.baseUrl ?? "", true)
        : null,
    );
    renaming.set(false);
    renameDraft.set(ch.displayName);
    nameError.set(null);
    saveError.set(null);
    conflictDetected.set(false);
  };

  const currentPresetId = () =>
    props.mode === "draft" ? props.draft.presetId : props.channel.presetId;
  const savedProviderDefinition = (): ProviderDefinition | null => {
    if (props.mode !== "saved") return null;
    try {
      return aiRegistry.getProvider(props.channel.presetId);
    } catch {
      return null;
    }
  };
  const providerDefinition = (): ProviderDefinition | null =>
    props.mode === "draft"
      ? aiRegistry.getProvider(props.draft.presetId)
      : savedProviderDefinition();
  const providerLabel = () => getProviderTypeLabel(currentPresetId()) ?? currentPresetId();
  const providerPresentation = () => providerSettingsRegistry.find(currentPresetId());
  const isProtocolSupported = (provider: ProviderDefinition, protocolId: ProtocolId) => {
    if (!provider.allowedProtocolIds.includes(protocolId)) return false;
    try {
      aiRegistry.getProtocol(protocolId);
      return true;
    } catch {
      return false;
    }
  };
  const providerSupported = () => providerDefinition() !== null;
  const connectionBlocked = () => {
    const provider = providerDefinition();
    if (!provider) return true;
    return !isProtocolSupported(provider, currentAdapterId());
  };
  const unsupportedModels = () => {
    const provider = providerDefinition();
    if (!provider) return [];
    const models = props.mode === "draft" ? props.draft.models() : props.models;
    return models.filter(
      (model) =>
        model.apiTypeOverride !== null && !isProtocolSupported(provider, model.apiTypeOverride),
    );
  };
  const hasUnsupportedConfiguration = () =>
    !providerSupported() || connectionBlocked() || unsupportedModels().length > 0;
  const currentDisplayName = () =>
    props.mode === "draft" ? props.draft.displayName() : props.channel.displayName;
  const currentEnabled = () =>
    props.mode === "draft" ? props.draft.enabled() : props.channel.enabled;
  const currentAdapterId = () =>
    props.mode === "draft" ? props.draft.adapterId() : savedAdapterId();
  const currentBaseUrl = () => (props.mode === "draft" ? props.draft.baseUrl() : savedBaseUrl());
  const currentCredential = () =>
    props.mode === "draft" ? props.draft.credential() : savedCredential();
  const currentAllowInsecureHttp = () =>
    props.mode === "draft" ? props.draft.allowInsecureHttp() : savedAllowInsecureHttp();

  const handleProtocolChange = (next: ProtocolId) => {
    if (props.mode === "draft") {
      props.draft.setAdapterId(next);
    } else {
      savedAdapterId.set(next);
    }
    connectionMessage.set(null);
  };

  const handleBaseUrlChange = (value: string) => {
    if (props.mode === "draft") {
      props.draft.setBaseUrl(value);
    } else {
      savedBaseUrl.set(value);
      if (!isInsecureHttpConfirmed(value, savedConfirmedInsecureUrl())) {
        savedConfirmedInsecureUrl.set(null);
      }
    }
    saveError.set(null);
    connectionMessage.set(null);
  };

  const handleCredentialChange = (value: string) => {
    if (props.mode === "draft") {
      props.draft.setCredential(value);
    } else {
      savedCredential.set(value);
      if (value.length > 0) {
        credentialMode.set("replace");
      } else if (credentialMode() === "replace") {
        credentialMode.set("keep");
      }
    }
    connectionMessage.set(null);
  };

  const handleCredentialModeChange = (mode: ProviderCredentialMode) => {
    if (mode === "clear") {
      credentialMode.set("clear");
    } else if (mode === "keep") {
      credentialMode.set("keep");
    } else {
      return;
    }
    savedCredential.set("");
    connectionMessage.set(null);
  };

  const handleInsecureHttpChange = (checked: boolean) => {
    if (props.mode === "draft") {
      props.draft.setAllowInsecureHttp(checked);
    } else {
      savedConfirmedInsecureUrl.set(resolveConfirmedInsecureUrl(savedBaseUrl(), checked));
    }
    saveError.set(null);
  };

  const urlCheck = () => inspectBaseUrl(currentBaseUrl());

  const isSavedDirty = () => {
    if (props.mode !== "saved") return false;
    const ch = props.channel;
    if (savedAdapterId() !== ch.adapterId) return true;
    const check = urlCheck();
    const savedUrl = ch.baseUrl ?? "";
    if (!check.ok) {
      if (savedBaseUrl().trim() !== savedUrl) return true;
    } else if ((check.normalizedBaseUrl ?? "") !== savedUrl) {
      return true;
    }
    if (credentialMode() === "clear" && ch.hasCredential) return true;
    if (credentialMode() === "replace" && savedCredential().trim().length > 0) return true;
    const savedInsecure =
      inspectBaseUrl(ch.baseUrl ?? "").isInsecureHttp && ch.insecureHttpConfirmedAt !== null;
    if (savedAllowInsecureHttp() !== savedInsecure) return true;
    return false;
  };

  effect(() => {
    if (props.mode === "draft") {
      const d = props.draft;
      if (syncedMode !== "draft" || d.id !== syncedId) {
        syncedMode = "draft";
        syncedId = d.id;
        syncedRevision = -1;
        invalidateInFlight();
        connectionMessage.set(null);
        nameError.set(null);
        saveError.set(null);
        conflictDetected.set(false);
        focusDraftNameInput();
      }
      return;
    }

    const ch = props.channel;
    if (syncedMode !== "saved" || ch.id !== syncedId) {
      syncedMode = "saved";
      syncedId = ch.id;
      syncedRevision = ch.revision;
      invalidateInFlight();
      connectionMessage.set(null);
      loadFromChannel(ch);
      return;
    }
    if (ch.revision !== syncedRevision) {
      if (isSavedDirty()) {
        conflictDetected.set(true);
      } else {
        syncedRevision = ch.revision;
        loadFromChannel(ch);
      }
    }
  });

  const canSaveSaved = () => {
    const check = urlCheck();
    if (!check.ok) return false;
    if (check.isInsecureHttp && !savedAllowInsecureHttp()) return false;
    if (credentialMode() === "replace" && savedCredential().trim().length === 0) {
      return false;
    }
    return true;
  };

  const handleToggleChannelEnabled = async (enabled: boolean) => {
    if (props.mode === "draft") {
      props.draft.setEnabled(enabled);
      return;
    }
    try {
      const updated = await toggleChannelEnabled(props.channel.id, enabled);
      syncedRevision = updated.revision;
      conflictDetected.set(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("models.error.channelStatus"));
    }
  };

  const startRename = () => {
    if (props.mode !== "saved") return;
    renameDraft.set(props.channel.displayName);
    renaming.set(true);
  };

  const submitRename = async () => {
    if (props.mode !== "saved") return;
    const nextName = renameDraft().trim();
    if (!nextName || renameSaving()) return;
    renameSaving.set(true);
    try {
      const updated = await renameChannel(props.channel.id, nextName);
      syncedRevision = updated.revision;
      conflictDetected.set(false);
      renaming.set(false);
      toast.success(t("models.channel.renamed", { name: updated.displayName }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("models.error.renameChannel"));
    } finally {
      renameSaving.set(false);
    }
  };

  const handleSaveDraft = async () => {
    if (props.mode !== "draft" || saving()) return;
    const draft = props.draft;
    nameError.set(null);
    saveError.set(null);

    const trimmedName = draft.displayName().trim();
    if (!trimmedName) {
      nameError.set(t("models.error.displayNameRequired"));
      return;
    }

    const check = urlCheck();
    if (!check.ok) {
      saveError.set(check.error ?? t("models.error.invalidBaseUrl"));
      return;
    }
    if (check.isInsecureHttp && !draft.allowInsecureHttp()) {
      saveError.set(t("models.error.confirmInsecureSave"));
      return;
    }

    invalidateInFlight();
    const draftModels = draft.models();
    const lastSyncedAt = draft.modelsLastSyncedAt();
    const lastSyncError = draft.modelsLastSyncError();
    const clearStaleCredential =
      draft.hadPersistedCredential() && draft.credential().trim().length === 0;

    saving.set(true);
    try {
      const saved = await saveChannelDraft({
        id: draft.id,
        presetId: draft.presetId,
        displayName: trimmedName,
        adapterId: draft.adapterId(),
        baseUrl: check.normalizedBaseUrl,
        credential: draft.credential(),
        enabled: draft.enabled(),
        allowInsecureHttp: draft.allowInsecureHttp(),
        models: draftModels,
        modelsLastSyncedAt: lastSyncedAt,
        modelsLastSyncError: lastSyncError,
        persistedScopes: draft.persistedScopes(),
        clearStaleCredential,
      });
      draft.markPersistedScopes({
        channel: true,
        credential: !clearStaleCredential && draft.credential().trim().length > 0,
        models: true,
      });
      toast.success(t("models.channel.added", { name: saved.displayName }));
      props.onDraftSaved(saved);
    } catch (error) {
      if (error instanceof PartialDraftSaveError) {
        draft.markPersistedScopes(error.persisted);
      }
      const message = error instanceof Error ? error.message : t("models.error.saveChannel");
      saveError.set(message);
      toast.error(message);
    } finally {
      saving.set(false);
    }
  };

  const handleSaveSaved = async () => {
    if (props.mode !== "saved" || saving() || !isSavedDirty() || !canSaveSaved()) return;
    saving.set(true);
    saveError.set(null);

    let credentialUpdate: CredentialUpdate = { mode: "keep" };
    if (credentialMode() === "clear") {
      credentialUpdate = { mode: "clear" };
    } else if (credentialMode() === "replace") {
      credentialUpdate = { mode: "replace", value: savedCredential().trim() };
    }

    try {
      const updated = await updateChannel({
        id: props.channel.id,
        expectedRevision: props.channel.revision,
        displayName: props.channel.displayName,
        adapterId: savedAdapterId(),
        baseUrl: urlCheck().normalizedBaseUrl,
        credentialUpdate,
        enabled: props.channel.enabled,
        allowInsecureHttp: savedAllowInsecureHttp(),
      });
      syncedRevision = updated.revision;
      connectionMessage.set(null);
      loadFromChannel(updated);
      toast.success(t("models.channel.saved"));
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        conflictDetected.set(true);
      }
      saveError.set(error instanceof Error ? error.message : t("models.error.saveChannel"));
    } finally {
      saving.set(false);
    }
  };

  const buildConnectionSnapshot = (): ConnectionSnapshot => {
    if (props.mode === "draft") {
      const d = props.draft;
      return {
        presetId: d.presetId,
        adapterId: d.adapterId(),
        baseUrl: d.baseUrl(),
        allowInsecureHttp: d.allowInsecureHttp(),
        credentialInput: {
          mode: "inline",
          value: d.credential(),
        },
      };
    }

    let update: CredentialUpdate = { mode: "keep" };
    if (credentialMode() === "clear") {
      update = { mode: "clear" };
    } else if (credentialMode() === "replace") {
      update = { mode: "replace", value: savedCredential() };
    }

    return {
      presetId: props.channel.presetId,
      adapterId: savedAdapterId(),
      baseUrl: savedBaseUrl(),
      allowInsecureHttp: savedAllowInsecureHttp(),
      credentialInput: {
        mode: "saved",
        channelId: props.channel.id,
        update,
      },
    };
  };

  const startConnectionRequest = () => {
    invalidateInFlight();
    const controller = new AbortController();
    activeController = controller;
    const reqSeq = activeRequestSeq;
    const reqOwner = currentOwnerId();
    const reqFingerprint = connectionFingerprint();
    return {
      signal: controller.signal,
      isCurrent: () =>
        reqSeq === activeRequestSeq &&
        currentOwnerId() === reqOwner &&
        connectionFingerprint() === reqFingerprint &&
        !controller.signal.aborted,
      isLatestSeq: () => reqSeq === activeRequestSeq,
      releaseController: () => {
        if (activeController === controller) {
          activeController = null;
        }
      },
    };
  };

  const handleTest = async () => {
    if (testing() || syncing() || connectionBlocked()) return;
    const snapshot = buildConnectionSnapshot();
    const request = startConnectionRequest();
    testing.set(true);
    connectionMessage.set(null);
    try {
      const result = await testConnectionSnapshot(snapshot, request.signal);
      if (!request.isCurrent()) return;
      const text =
        result.modelCount === 1
          ? t("models.connection.connectedOne", { count: result.modelCount })
          : t("models.connection.connected", { count: result.modelCount });
      connectionMessage.set({ ok: true, text });
      toast.success(text);
    } catch (error) {
      if (!request.isCurrent()) return;
      const text = error instanceof Error ? error.message : t("models.error.connectionTest");
      if ((error as { kind?: string } | null)?.kind !== "cancelled") {
        connectionMessage.set({ ok: false, text });
        toast.error(text);
      }
    } finally {
      if (request.isLatestSeq()) {
        testing.set(false);
        request.releaseController();
      }
    }
  };

  const handleGetModels = async () => {
    if (syncing() || testing() || connectionBlocked()) return;
    const snapshot = buildConnectionSnapshot();
    const request = startConnectionRequest();
    syncing.set(true);
    connectionMessage.set(null);
    try {
      if (props.mode === "draft") {
        const discovered = await discoverModelsSnapshot(snapshot, request.signal);
        if (!request.isCurrent()) return;
        const summary = props.draft.applyDiscoveredModels(discovered, snapshot.adapterId);
        toast.success(
          t("models.connection.synced", {
            count: summary.discoveredCount,
            added: summary.addedCount,
          }),
        );
      } else {
        const summary = await syncChannelModels(props.channel.id, snapshot, request.signal);
        if (!request.isCurrent()) return;
        toast.success(
          t("models.connection.synced", {
            count: summary.discoveredCount,
            added: summary.addedCount,
          }),
        );
      }
    } catch (error) {
      if (!request.isCurrent()) return;
      const message = error instanceof Error ? error.message : t("models.error.fetchModels");
      if ((error as { kind?: string } | null)?.kind !== "cancelled") {
        if (props.mode === "draft") {
          props.draft.setSyncError(message);
        }
        toast.error(message);
      }
    } finally {
      if (request.isLatestSeq()) {
        syncing.set(false);
        request.releaseController();
      }
    }
  };

  const handleConfirmDeleteChannel = async () => {
    if (props.mode !== "saved" || deletingChannel()) return;
    deletingChannel.set(true);
    const name = props.channel.displayName;
    try {
      await deleteChannel(props.channel.id);
      deleteDialogOpen.set(false);
      toast.success(t("models.channel.deleted", { name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("models.error.deleteChannel"));
    } finally {
      deletingChannel.set(false);
    }
  };

  const handleAddModelSubmit = async (input: AddModelSubmission) => {
    const presetId = props.mode === "draft" ? props.draft.presetId : props.channel.presetId;
    const facts = await aiClient.resolveModelFacts({
      providerTypeId: presetId,
      modelKey: input.modelKey,
    });
    if (props.mode === "draft") {
      props.draft.addManualModel({ ...input, facts });
      return;
    }
    await createManualModel({
      providerId: props.channel.id,
      ...input,
      facts,
    });
  };

  const handleEditModelSubmit = async (input: EditModelSubmission) => {
    if (props.mode === "draft") {
      props.draft.updateModel(input);
      return;
    }
    await updateModelConfig(input);
  };

  const handleToggleModelEnabled = async (model: ProviderModel, checked: boolean) => {
    if (props.mode === "draft") {
      props.draft.setModelEnabled(model.id, checked);
      return;
    }
    await setModelEnabled(model.id, checked);
  };

  const handleDeleteModels = async (modelIds: string[]) => {
    if (props.mode === "draft") {
      return props.draft.deleteModels(modelIds);
    }
    return deleteModelsBulk(props.channel.id, modelIds);
  };

  const tableChannelView = (): ProviderChannel => {
    if (props.mode === "saved") return props.channel;
    const d = props.draft;
    return {
      id: d.id,
      presetId: d.presetId,
      displayName: d.displayName().trim() || t(aiRegistry.getProvider(d.presetId).labelKey),
      adapterId: d.adapterId(),
      baseUrl: inspectBaseUrl(d.baseUrl()).normalizedBaseUrl,
      hasCredential: d.credential().trim().length > 0,
      enabled: d.enabled(),
      sortOrder: 0,
      revision: 0,
      insecureHttpConfirmedAt: null,
      modelsLastSyncedAt: d.modelsLastSyncedAt(),
      modelsLastSyncError: d.modelsLastSyncError(),
      createdAt: "",
      updatedAt: "",
    };
  };

  const compactLayout = () => windowSize().width < 860;

  const reloadFromChannel = () => {
    if (props.mode !== "saved") return;
    syncedRevision = props.channel.revision;
    loadFromChannel(props.channel);
  };

  const setDraftNameInput = (node: InputRef | null) => {
    draftNameInputRef = node;
  };

  return {
    isDraftMode,
    currentPresetId,
    providerLabel,
    providerPresentation,
    providerSupported,
    currentDisplayName,
    currentEnabled,
    currentAdapterId,
    currentBaseUrl,
    currentCredential,
    currentAllowInsecureHttp,
    urlCheck,
    isSavedDirty,
    canSaveSaved,
    compactLayout,
    tableChannelView,
    hasUnsupportedConfiguration,
    connectionBlocked,
    saving,
    testing,
    syncing,
    conflictDetected,
    renameSaving,
    deletingChannel,
    credentialMode,
    renaming: () => renaming(),
    setRenaming: (value: boolean) => renaming.set(value),
    renameDraft: () => renameDraft(),
    setRenameDraft: (value: string) => renameDraft.set(value),
    nameError: () => nameError(),
    setNameError: (value: string | null) => nameError.set(value),
    saveError: () => saveError(),
    setSaveError: (value: string | null) => saveError.set(value),
    connectionMessage: () => connectionMessage(),
    setConnectionMessage: (value: { ok: boolean; text: string } | null) =>
      connectionMessage.set(value),
    addModelOpen: () => addModelOpen(),
    setAddModelOpen: (value: boolean) => addModelOpen.set(value),
    editingModel: () => editingModel(),
    setEditingModel: (value: ProviderModel | null) => editingModel.set(value),
    deleteDialogOpen: () => deleteDialogOpen(),
    setDeleteDialogOpen: (value: boolean) => deleteDialogOpen.set(value),
    startRename,
    submitRename,
    handleToggleChannelEnabled,
    handleSaveDraft,
    handleSaveSaved,
    handleTest,
    handleGetModels,
    handleConfirmDeleteChannel,
    handleAddModelSubmit,
    handleEditModelSubmit,
    handleToggleModelEnabled,
    handleDeleteModels,
    handleProtocolChange,
    handleBaseUrlChange,
    handleCredentialChange,
    handleCredentialModeChange,
    handleInsecureHttpChange,
    reloadFromChannel,
    setDraftNameInput,
  };
}
