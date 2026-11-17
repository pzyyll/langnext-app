import { cleanup, effect, signal, Scroll, Text, View, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { getAdapterDefaultBaseUrl, getAdapterLabel } from "../../services/protocols/adapters";
import { getProviderPreset, getProviderPresetLabel } from "../../services/protocols/presets";
import type { AdapterId } from "../../services/protocols/types";
import { AddModelDialog, type AddModelSubmission } from "./add-model-dialog";
import type { ChannelDraft } from "./channel-draft";
import { inspectBaseUrl } from "./connection";
import { EditModelDialog, type EditModelSubmission } from "./edit-model-dialog";
import { FormField } from "./form-field";
import { ModelsTable } from "./models-table";
import {
  createManualModel,
  deleteChannel,
  deleteModelsBulk,
  renameChannel,
  RevisionConflictError,
  saveChannelDraft,
  setModelEnabled,
  syncChannelModels,
  testChannelConnection,
  toggleChannelEnabled,
  updateChannel,
  updateModelConfig,
} from "./store";
import type {
  CredentialUpdate,
  ModelsEnabledFilter,
  ProviderChannel,
  ProviderModel,
} from "./types";

type CredentialDraftMode = "keep" | "replace" | "clear";

type ProviderEditorProps =
  | {
      mode: "draft";
      draft: ChannelDraft;
      enabledFilter: ModelsEnabledFilter;
      onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
      onDraftSaved: (channel: ProviderChannel) => void;
      onCancelDraft: () => void;
    }
  | {
      mode: "saved";
      channel: ProviderChannel;
      models: ProviderModel[];
      enabledFilter: ModelsEnabledFilter;
      onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
    };

/** Right detail pane for configuring a new channel draft or an existing provider channel. */
export function ProviderEditor(props: ProviderEditorProps) {
  const isDraftMode = () => props.mode === "draft";

  const savedAdapterId = signal<AdapterId>(
    props.mode === "saved" ? props.channel.adapterId : props.draft.adapterId(),
  );
  const savedBaseUrl = signal(props.mode === "saved" ? (props.channel.baseUrl ?? "") : "");
  const credentialMode = signal<CredentialDraftMode>("keep");
  const savedCredential = signal("");
  const savedAllowInsecureHttp = signal(
    props.mode === "saved"
      ? inspectBaseUrl(props.channel.baseUrl ?? "").isInsecureHttp &&
          props.channel.insecureHttpConfirmedAt !== null
      : false,
  );

  const renaming = signal(false);
  const renameDraft = signal("");
  const renameSaving = signal(false);

  const saving = signal(false);
  const nameError = signal<string | null>(null);
  const saveError = signal<string | null>(null);
  const conflictDetected = signal(false);

  const syncAdapterId = signal<AdapterId>(
    props.mode === "saved" ? props.channel.adapterId : props.draft.adapterId(),
  );
  const testing = signal(false);
  const syncing = signal(false);
  const connectionMessage = signal<{ ok: boolean; text: string } | null>(null);

  const addModelOpen = signal(false);
  const editingModel = signal<ProviderModel | null>(null);
  const deleteDialogOpen = signal(false);
  const deletingChannel = signal(false);

  let activeController: AbortController | null = null;
  let syncedId = "";
  let syncedRevision = -1;

  const abortInFlight = () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  };

  cleanup(() => abortInFlight());

  const loadFromChannel = (ch: ProviderChannel) => {
    savedAdapterId.set(ch.adapterId);
    savedBaseUrl.set(ch.baseUrl ?? "");
    credentialMode.set("keep");
    savedCredential.set("");
    savedAllowInsecureHttp.set(
      inspectBaseUrl(ch.baseUrl ?? "").isInsecureHttp && ch.insecureHttpConfirmedAt !== null,
    );
    renaming.set(false);
    renameDraft.set(ch.displayName);
    nameError.set(null);
    saveError.set(null);
    conflictDetected.set(false);
  };

  const currentPresetId = () =>
    props.mode === "draft" ? props.draft.presetId : props.channel.presetId;
  const currentPreset = () => getProviderPreset(currentPresetId());
  const allowedAdapterItems = (): SelectItem[] =>
    currentPreset().allowedAdapterIds.map((id) => ({
      value: id,
      title: getAdapterLabel(id),
    }));
  const hasFixedApiType = () => currentPreset().allowedAdapterIds.length <= 1;
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
      if (d.id !== syncedId) {
        syncedId = d.id;
        syncedRevision = -1;
        abortInFlight();
        testing.set(false);
        syncing.set(false);
        syncAdapterId.set(d.adapterId());
        connectionMessage.set(null);
        nameError.set(null);
        saveError.set(null);
        conflictDetected.set(false);
      }
      return;
    }

    const ch = props.channel;
    if (ch.id !== syncedId) {
      syncedId = ch.id;
      syncedRevision = ch.revision;
      abortInFlight();
      testing.set(false);
      syncing.set(false);
      syncAdapterId.set(ch.adapterId);
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
      });
      toast.success(t("models.channel.added", { name: saved.displayName }));
      props.onDraftSaved(saved);
    } catch (error) {
      saveError.set(error instanceof Error ? error.message : t("models.error.saveChannel"));
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

    const previousAdapterId = props.channel.adapterId;

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
      if (syncAdapterId() === previousAdapterId) {
        syncAdapterId.set(updated.adapterId);
      }
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

  const handleTest = async () => {
    if (props.mode !== "saved" || testing() || syncing() || isSavedDirty()) return;
    abortInFlight();
    activeController = new AbortController();
    testing.set(true);
    connectionMessage.set(null);
    try {
      const result = await testChannelConnection(
        props.channel.id,
        props.channel.adapterId,
        activeController.signal,
      );
      const text =
        result.modelCount === 1
          ? t("models.connection.connectedOne", { count: result.modelCount })
          : t("models.connection.connected", { count: result.modelCount });
      connectionMessage.set({ ok: true, text });
      toast.success(text);
    } catch (error) {
      const text = error instanceof Error ? error.message : t("models.error.connectionTest");
      if ((error as { kind?: string } | null)?.kind !== "cancelled") {
        connectionMessage.set({ ok: false, text });
        toast.error(text);
      }
    } finally {
      testing.set(false);
      activeController = null;
    }
  };

  const handleGetModels = async () => {
    if (props.mode !== "saved" || syncing() || testing() || isSavedDirty()) return;
    abortInFlight();
    activeController = new AbortController();
    syncing.set(true);
    connectionMessage.set(null);
    try {
      const summary = await syncChannelModels(
        props.channel.id,
        syncAdapterId(),
        activeController.signal,
      );
      toast.success(
        t("models.connection.synced", {
          count: summary.discoveredCount,
          added: summary.addedCount,
        }),
      );
    } catch (error) {
      if ((error as { kind?: string } | null)?.kind !== "cancelled") {
        toast.error(error instanceof Error ? error.message : t("models.error.fetchModels"));
      }
    } finally {
      syncing.set(false);
      activeController = null;
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
    if (props.mode === "draft") {
      props.draft.addManualModel(input);
      return;
    }
    await createManualModel({
      providerId: props.channel.id,
      ...input,
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

  const tokenPlaceholder = () => {
    if (props.mode === "saved") {
      if (credentialMode() === "clear") return t("models.connection.tokenWillClear");
      if (props.channel.hasCredential) return t("models.connection.tokenRetained");
    }
    return t("models.connection.apiKeyPlaceholder");
  };

  const urlPlaceholder = () =>
    currentPreset().defaultBaseUrl ??
    getAdapterDefaultBaseUrl(currentAdapterId()) ??
    t("models.connection.baseUrlPlaceholder");

  const tableChannelView = (): ProviderChannel => {
    if (props.mode === "saved") return props.channel;
    const d = props.draft;
    return {
      id: d.id,
      presetId: d.presetId,
      displayName: d.displayName().trim() || getProviderPresetLabel(d.presetId),
      adapterId: d.adapterId(),
      baseUrl: inspectBaseUrl(d.baseUrl()).normalizedBaseUrl,
      hasCredential: d.credential().trim().length > 0,
      enabled: d.enabled(),
      sortOrder: 0,
      revision: 0,
      insecureHttpConfirmedAt: null,
      modelsLastSyncedAt: null,
      modelsLastSyncError: null,
      createdAt: "",
      updatedAt: "",
    };
  };

  const compactLayout = () => windowSize().width < 860;

  return (
    <View testID="provider-editor" class="min-w-0 flex-1 bg-background">
      <View
        class={`h-12 shrink-0 flex-row items-center justify-between gap-3 border-b border-border ${compactLayout() ? "px-4" : "px-6"}`}
      >
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Icon name={currentPreset().icon} tone="foreground" class="size-4 shrink-0" />
          <If
            when={!isDraftMode() && renaming()}
            else={
              <>
                <Text role="header" class="truncate text-base font-semibold text-foreground">
                  {currentDisplayName().trim() || getProviderPresetLabel(currentPresetId())}
                </Text>
                <If when={isDraftMode()}>
                  <Badge label={t("models.channel.unsaved")} tone="warning" />
                </If>
                <If when={!isDraftMode()}>
                  <Button
                    testID="rename-channel-button"
                    size="icon-sm"
                    variant="ghost"
                    tooltip={t("models.channel.rename")}
                    accessibilityLabel={t("models.channel.renameLabel")}
                    onPress={startRename}
                  >
                    <Icon name="edit" tone="muted-foreground" class="size-3.5" />
                  </Button>
                </If>
              </>
            }
          >
            <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
              <Input
                testID="rename-channel-input"
                size="sm"
                autoFocus
                accessibilityLabel={t("models.channel.nameLabel")}
                value={renameDraft()}
                onChange={(v) => renameDraft.set(v)}
                onSubmit={() => void submitRename()}
                onKeyPress={(key) => {
                  if (key === "Escape") renaming.set(false);
                }}
                class="min-w-0 max-w-52 flex-1"
              />
              <Button
                testID="confirm-rename-channel"
                variant="primary"
                size="sm"
                label={renameSaving() ? t("common.saving") : t("common.save")}
                disabled={renameDraft().trim().length === 0 || renameSaving()}
                onPress={() => void submitRename()}
              />
              <Button
                variant="outline"
                size="sm"
                label={t("common.cancel")}
                disabled={renameSaving()}
                onPress={() => renaming.set(false)}
              />
            </View>
          </If>
        </View>

        <View class="shrink-0 flex-row items-center gap-2.5">
          <Switch
            testID="channel-enabled-switch"
            label={t("models.channel.enabled")}
            variant="inline"
            accessibilityLabel={t("models.channel.enabledLabel")}
            checked={currentEnabled()}
            onChange={(checked) => void handleToggleChannelEnabled(checked)}
          />
          <View class="h-4 w-px bg-border" />
          <If
            when={isDraftMode()}
            else={
              <Button
                testID="delete-channel-button"
                variant="destructive-ghost"
                size="icon-sm"
                tooltip={t("models.channel.delete")}
                accessibilityLabel={t("models.channel.delete")}
                disabled={deletingChannel()}
                onPress={() => deleteDialogOpen.set(true)}
              >
                <Icon name="delete" tone="muted-foreground" class="size-3.5" />
              </Button>
            }
          >
            <View class="flex-row items-center gap-2">
              <Button
                testID="cancel-channel-button"
                variant="ghost"
                size="sm"
                label={t("common.cancel")}
                disabled={saving()}
                onPress={() => {
                  if (props.mode === "draft") props.onCancelDraft();
                }}
              />
              <Button
                testID="save-channel-button"
                variant="primary"
                size="sm"
                label={saving() ? t("common.saving") : t("common.save")}
                disabled={saving()}
                onPress={() => void handleSaveDraft()}
              />
            </View>
          </If>
        </View>
      </View>

      <If when={!isDraftMode() && conflictDetected()}>
        <View
          class={`flex-row items-center justify-between gap-3 border-b border-border bg-warning/15 py-2.5 ${compactLayout() ? "px-4" : "px-6"}`}
        >
          <Text class="text-xs font-medium text-warning">{t("models.channel.conflict")}</Text>
          <Button
            size="sm"
            variant="outline"
            label={t("common.reload")}
            onPress={() => {
              if (props.mode === "saved") {
                syncedRevision = props.channel.revision;
                loadFromChannel(props.channel);
              }
            }}
          />
        </View>
      </If>

      <Scroll class="min-h-0 flex-1">
        <View
          class={
            compactLayout()
              ? "mx-auto w-full max-w-4xl gap-4 p-4"
              : "mx-auto w-full max-w-4xl gap-5 p-5"
          }
        >
          <If when={isDraftMode()}>
            <Card testID="draft-channel-card" class={compactLayout() ? "gap-3.5 p-4" : "gap-4 p-5"}>
              <View class={compactLayout() ? "gap-3.5" : "flex-row items-start gap-4"}>
                <FormField
                  label={t("models.channel.provider")}
                  class={compactLayout() ? undefined : "w-56 shrink-0"}
                >
                  <View class="h-9 flex-row items-center gap-2 rounded-lg border border-border bg-muted px-3">
                    <Icon name={currentPreset().icon} tone="foreground" class="size-4 shrink-0" />
                    <Text class="truncate text-sm font-medium text-foreground">
                      {getProviderPresetLabel(currentPresetId())}
                    </Text>
                  </View>
                </FormField>

                <FormField
                  label={t("common.displayName")}
                  error={nameError()}
                  class={compactLayout() ? undefined : "min-w-0 flex-1"}
                >
                  <Input
                    testID="channel-name-input"
                    accessibilityLabel={t("common.displayName")}
                    placeholder={t("models.channel.displayNamePlaceholder")}
                    value={currentDisplayName()}
                    onChange={(v) => {
                      if (props.mode === "draft") {
                        props.draft.setDisplayName(v);
                        nameError.set(null);
                        saveError.set(null);
                      }
                    }}
                  />
                </FormField>
              </View>
            </Card>
          </If>

          <Card testID="connection-card" class={compactLayout() ? "gap-3.5 p-4" : "gap-4 p-5"}>
            <View class="min-h-8 flex-row flex-wrap items-center justify-between gap-2">
              <View class="flex-row items-center gap-2">
                <SectionHeading title={t("models.connection.heading")} />
                <If when={!isDraftMode() && isSavedDirty()}>
                  <Badge label={t("models.channel.unsaved")} tone="warning" />
                </If>
              </View>

              <View class="flex-row flex-wrap items-center gap-2">
                <If when={!isDraftMode() && isSavedDirty()}>
                  <Button
                    testID="cancel-channel-button"
                    variant="ghost"
                    size="sm"
                    label={t("common.cancel")}
                    disabled={saving()}
                    onPress={() => {
                      if (props.mode === "saved") {
                        connectionMessage.set(null);
                        loadFromChannel(props.channel);
                      }
                    }}
                  />
                  <Button
                    testID="save-channel-button"
                    variant="primary"
                    size="sm"
                    label={saving() ? t("common.saving") : t("common.save")}
                    disabled={saving() || !canSaveSaved()}
                    onPress={() => void handleSaveSaved()}
                  />
                </If>
                <Button
                  testID="test-connection-button"
                  variant="outline"
                  size="sm"
                  label={testing() ? t("models.connection.testing") : t("models.connection.test")}
                  disabled={testing() || syncing() || isDraftMode() || isSavedDirty()}
                  onPress={() => void handleTest()}
                />
              </View>
            </View>

            <View class={compactLayout() ? "gap-3.5" : "flex-row items-start gap-4"}>
              <FormField
                label={t("models.connection.apiType")}
                class={compactLayout() ? undefined : "w-56 shrink-0"}
              >
                <If
                  when={hasFixedApiType()}
                  else={
                    <Select
                      testID="connection-adapter-select"
                      accessibilityLabel={t("models.connection.apiType")}
                      items={allowedAdapterItems()}
                      value={currentAdapterId()}
                      onChange={(v) => {
                        if (!v) return;
                        const next = v as AdapterId;
                        if (props.mode === "draft") {
                          props.draft.setAdapterId(next);
                        } else {
                          savedAdapterId.set(next);
                        }
                        connectionMessage.set(null);
                      }}
                    />
                  }
                >
                  <View
                    testID="connection-fixed-api-type"
                    class="h-9 flex-row items-center rounded-lg border border-border bg-muted px-3"
                  >
                    <Text class="truncate text-sm text-foreground">
                      {getAdapterLabel(currentAdapterId())}
                    </Text>
                  </View>
                </If>
              </FormField>

              <FormField
                label={t("models.connection.baseUrl")}
                error={urlCheck().error}
                class={compactLayout() ? undefined : "min-w-0 flex-1"}
              >
                <Input
                  testID="connection-url-input"
                  accessibilityLabel={t("models.connection.baseUrl")}
                  placeholder={urlPlaceholder()}
                  value={currentBaseUrl()}
                  onChange={(v) => {
                    if (props.mode === "draft") {
                      props.draft.setBaseUrl(v);
                    } else {
                      savedBaseUrl.set(v);
                      if (!inspectBaseUrl(v).isInsecureHttp) {
                        savedAllowInsecureHttp.set(false);
                      }
                    }
                    saveError.set(null);
                    connectionMessage.set(null);
                  }}
                />
              </FormField>
            </View>

            <If when={urlCheck().isInsecureHttp}>
              <Checkbox
                testID="connection-insecure-checkbox"
                checked={currentAllowInsecureHttp()}
                onChange={(checked) => {
                  if (props.mode === "draft") {
                    props.draft.setAllowInsecureHttp(checked);
                  } else {
                    savedAllowInsecureHttp.set(checked);
                  }
                  saveError.set(null);
                }}
                label={t("models.connection.insecureHttp")}
              />
            </If>

            <FormField
              label={t("models.connection.apiKey")}
              labelAction={
                <If when={props.mode === "saved" && props.channel.hasCredential}>
                  <If
                    when={credentialMode() === "clear"}
                    else={
                      <Button
                        testID="clear-token-button"
                        size="xs"
                        variant="ghost"
                        label={t("models.connection.resetToken")}
                        onPress={() => {
                          credentialMode.set("clear");
                          savedCredential.set("");
                          connectionMessage.set(null);
                        }}
                      />
                    }
                  >
                    <Button
                      testID="keep-token-button"
                      size="xs"
                      variant="ghost"
                      label={t("models.connection.keepToken")}
                      onPress={() => {
                        credentialMode.set("keep");
                        savedCredential.set("");
                        connectionMessage.set(null);
                      }}
                    />
                  </If>
                </If>
              }
            >
              <Input
                testID="connection-token-input"
                accessibilityLabel={t("models.connection.apiKey")}
                masked
                readonly={!isDraftMode() && credentialMode() === "clear"}
                placeholder={tokenPlaceholder()}
                value={currentCredential()}
                onChange={(v) => {
                  if (props.mode === "draft") {
                    props.draft.setCredential(v);
                  } else {
                    savedCredential.set(v);
                    if (v.length > 0) {
                      credentialMode.set("replace");
                    } else if (credentialMode() === "replace") {
                      credentialMode.set("keep");
                    }
                  }
                  connectionMessage.set(null);
                }}
              />
            </FormField>

            <If when={saveError() !== null}>
              <Text role="alert" class="text-xs text-destructive">
                {saveError()}
              </Text>
            </If>
            <If when={!isDraftMode() && isSavedDirty()}>
              <Text class="text-xs text-warning">{t("models.connection.dirtyHint")}</Text>
            </If>
            <If when={!isDraftMode() && !isSavedDirty() && connectionMessage() !== null}>
              <If when={connectionMessage()}>
                {(msg) => (
                  <Text class={msg().ok ? "text-xs text-success" : "text-xs text-destructive"}>
                    {msg().text}
                  </Text>
                )}
              </If>
            </If>
          </Card>

          <Card testID="models-card" class={compactLayout() ? "gap-3.5 p-4" : "gap-4 p-5"}>
            <ModelsTable
              channel={tableChannelView()}
              models={props.mode === "draft" ? props.draft.models() : props.models}
              enabledFilter={props.enabledFilter}
              isDirty={isDraftMode() || isSavedDirty()}
              syncAdapterId={syncAdapterId()}
              testing={testing()}
              syncing={syncing()}
              onSyncAdapterChange={(adapterId) => syncAdapterId.set(adapterId)}
              onGetModels={() => void handleGetModels()}
              onEnabledFilterChange={(f) => props.onEnabledFilterChange(f)}
              onAddModel={() => addModelOpen.set(true)}
              onConfigureModel={(model) => editingModel.set(model)}
              onToggleModelEnabled={handleToggleModelEnabled}
              onDeleteModels={handleDeleteModels}
            />
          </Card>
        </View>
      </Scroll>

      <AddModelDialog
        open={addModelOpen()}
        presetId={currentPresetId()}
        onOpenChange={(open) => addModelOpen.set(open)}
        onSubmit={handleAddModelSubmit}
      />

      <EditModelDialog
        open={editingModel() !== null}
        presetId={currentPresetId()}
        model={editingModel()}
        onOpenChange={(open) => {
          if (!open) editingModel.set(null);
        }}
        onSubmit={handleEditModelSubmit}
      />

      <If when={props.mode === "saved"}>
        <ConfirmDialog
          testID="delete-channel-dialog"
          open={deleteDialogOpen()}
          onOpenChange={(open) => deleteDialogOpen.set(open)}
          title={t("models.channel.delete")}
          description={t("models.channel.deleteDescription", {
            name: props.mode === "saved" ? props.channel.displayName : "",
          })}
          confirmLabel={t("common.delete")}
          confirmVariant="destructive"
          busy={deletingChannel()}
          onConfirm={() => void handleConfirmDeleteChannel()}
        />
      </If>
    </View>
  );
}
