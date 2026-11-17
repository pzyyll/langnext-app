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
import { ADAPTER_SPECS, getAdapterDefaultBaseUrl } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import { AddModelDialog } from "./add-model-dialog";
import { inspectBaseUrl } from "./connection";
import { EditModelDialog } from "./edit-model-dialog";
import { FormField } from "./form-field";
import { ModelsTable } from "./models-table";
import {
  deleteChannel,
  renameChannel,
  RevisionConflictError,
  syncChannelModels,
  testChannelConnection,
  toggleChannelEnabled,
  updateChannel,
} from "./store";
import type {
  CredentialUpdate,
  ModelsEnabledFilter,
  ProviderChannel,
  ProviderModel,
} from "./types";

const ADAPTER_ITEMS: SelectItem[] = ADAPTER_SPECS.map((spec) => ({
  value: spec.id,
  title: spec.label,
}));

type CredentialDraftMode = "keep" | "replace" | "clear";

interface ProviderEditorProps {
  channel: ProviderChannel;
  models: ProviderModel[];
  enabledFilter: ModelsEnabledFilter;
  onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
}

/** Right detail pane for inspecting and editing the selected provider channel and its models. */
export function ProviderEditor(props: ProviderEditorProps) {
  const draftAdapterId = signal<AdapterId>(props.channel.adapterId);
  const draftBaseUrl = signal(props.channel.baseUrl ?? "");
  const credentialMode = signal<CredentialDraftMode>("keep");
  const draftCredential = signal("");
  const draftAllowInsecureHttp = signal(
    inspectBaseUrl(props.channel.baseUrl ?? "").isInsecureHttp &&
      props.channel.insecureHttpConfirmedAt !== null,
  );

  const renaming = signal(false);
  const renameDraft = signal("");
  const renameSaving = signal(false);

  const saving = signal(false);
  const saveError = signal<string | null>(null);
  const conflictDetected = signal(false);

  const syncAdapterId = signal<AdapterId>(props.channel.adapterId);
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
    draftAdapterId.set(ch.adapterId);
    draftBaseUrl.set(ch.baseUrl ?? "");
    credentialMode.set("keep");
    draftCredential.set("");
    draftAllowInsecureHttp.set(
      inspectBaseUrl(ch.baseUrl ?? "").isInsecureHttp && ch.insecureHttpConfirmedAt !== null,
    );
    renaming.set(false);
    renameDraft.set(ch.displayName);
    saveError.set(null);
    conflictDetected.set(false);
  };

  const urlCheck = () => inspectBaseUrl(draftBaseUrl());

  const isDirty = () => {
    const ch = props.channel;
    if (draftAdapterId() !== ch.adapterId) return true;
    const check = urlCheck();
    const savedUrl = ch.baseUrl ?? "";
    if (!check.ok) {
      if (draftBaseUrl().trim() !== savedUrl) return true;
    } else if ((check.normalizedBaseUrl ?? "") !== savedUrl) {
      return true;
    }
    if (credentialMode() === "clear" && ch.hasCredential) return true;
    if (credentialMode() === "replace" && draftCredential().trim().length > 0) return true;
    const savedInsecure =
      inspectBaseUrl(ch.baseUrl ?? "").isInsecureHttp && ch.insecureHttpConfirmedAt !== null;
    if (draftAllowInsecureHttp() !== savedInsecure) return true;
    return false;
  };

  effect(() => {
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
      if (isDirty()) {
        conflictDetected.set(true);
      } else {
        syncedRevision = ch.revision;
        loadFromChannel(ch);
      }
    }
  });

  const canSave = () => {
    const check = urlCheck();
    if (!check.ok) return false;
    if (check.isInsecureHttp && !draftAllowInsecureHttp()) return false;
    if (credentialMode() === "replace" && draftCredential().trim().length === 0) {
      return false;
    }
    return true;
  };

  const handleToggleChannelEnabled = async (enabled: boolean) => {
    try {
      const updated = await toggleChannelEnabled(props.channel.id, enabled);
      syncedRevision = updated.revision;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("models.error.channelStatus"));
    }
  };

  const startRename = () => {
    renameDraft.set(props.channel.displayName);
    renaming.set(true);
  };

  const submitRename = async () => {
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

  const handleSave = async () => {
    if (saving() || !isDirty() || !canSave()) return;
    saving.set(true);
    saveError.set(null);

    let credentialUpdate: CredentialUpdate = { mode: "keep" };
    if (credentialMode() === "clear") {
      credentialUpdate = { mode: "clear" };
    } else if (credentialMode() === "replace") {
      credentialUpdate = { mode: "replace", value: draftCredential().trim() };
    }

    const previousAdapterId = props.channel.adapterId;

    try {
      const updated = await updateChannel({
        id: props.channel.id,
        expectedRevision: props.channel.revision,
        displayName: props.channel.displayName,
        adapterId: draftAdapterId(),
        baseUrl: urlCheck().normalizedBaseUrl,
        credentialUpdate,
        enabled: props.channel.enabled,
        allowInsecureHttp: draftAllowInsecureHttp(),
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
    if (testing() || syncing() || isDirty()) return;
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
    if (syncing() || testing() || isDirty()) return;
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
    if (deletingChannel()) return;
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

  const tokenPlaceholder = () => {
    if (credentialMode() === "clear") return t("models.connection.tokenWillClear");
    if (props.channel.hasCredential) return t("models.connection.tokenRetained");
    return t("models.connection.apiKeyPlaceholder");
  };

  const compactLayout = () => windowSize().width < 860;

  return (
    <View testID="provider-editor" class="min-w-0 flex-1 bg-background">
      <View
        class={`h-12 shrink-0 flex-row items-center justify-between gap-3 border-b border-border ${compactLayout() ? "px-4" : "px-6"}`}
      >
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <If
            when={renaming()}
            else={
              <>
                <Text role="header" class="truncate text-base font-semibold text-foreground">
                  {props.channel.displayName}
                </Text>
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
            checked={props.channel.enabled}
            onChange={(checked) => void handleToggleChannelEnabled(checked)}
          />
          <View class="h-4 w-px bg-border" />
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
        </View>
      </View>

      <If when={conflictDetected()}>
        <View
          class={`flex-row items-center justify-between gap-3 border-b border-border bg-warning/15 py-2.5 ${compactLayout() ? "px-4" : "px-6"}`}
        >
          <Text class="text-xs font-medium text-warning">{t("models.channel.conflict")}</Text>
          <Button
            size="sm"
            variant="outline"
            label={t("common.reload")}
            onPress={() => {
              syncedRevision = props.channel.revision;
              loadFromChannel(props.channel);
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
          <Card testID="connection-card" class={compactLayout() ? "gap-3.5 p-4" : "gap-4 p-5"}>
            <View class="min-h-8 flex-row flex-wrap items-center justify-between gap-2">
              <View class="flex-row items-center gap-2">
                <SectionHeading title={t("models.connection.heading")} />
                <If when={isDirty()}>
                  <Badge label={t("models.channel.unsaved")} tone="warning" />
                </If>
              </View>

              <View class="flex-row flex-wrap items-center gap-2">
                <If when={isDirty()}>
                  <Button
                    testID="cancel-channel-button"
                    variant="ghost"
                    size="sm"
                    label={t("common.cancel")}
                    disabled={saving()}
                    onPress={() => {
                      connectionMessage.set(null);
                      loadFromChannel(props.channel);
                    }}
                  />
                  <Button
                    testID="save-channel-button"
                    variant="primary"
                    size="sm"
                    label={saving() ? t("common.saving") : t("common.save")}
                    disabled={saving() || !canSave()}
                    onPress={() => void handleSave()}
                  />
                </If>
                <Button
                  testID="test-connection-button"
                  variant="outline"
                  size="sm"
                  label={testing() ? t("models.connection.testing") : t("models.connection.test")}
                  disabled={testing() || syncing() || isDirty()}
                  onPress={() => void handleTest()}
                />
              </View>
            </View>

            <View class={compactLayout() ? "gap-3.5" : "flex-row items-start gap-4"}>
              <FormField
                label={t("models.connection.apiType")}
                class={compactLayout() ? undefined : "w-56 shrink-0"}
              >
                <Select
                  testID="connection-adapter-select"
                  accessibilityLabel={t("models.connection.apiType")}
                  items={ADAPTER_ITEMS}
                  value={draftAdapterId()}
                  onChange={(v) => {
                    if (v) {
                      draftAdapterId.set(v as AdapterId);
                      connectionMessage.set(null);
                    }
                  }}
                />
              </FormField>

              <FormField
                label={t("models.connection.baseUrl")}
                error={urlCheck().error}
                class={compactLayout() ? undefined : "min-w-0 flex-1"}
              >
                <Input
                  testID="connection-url-input"
                  accessibilityLabel={t("models.connection.baseUrl")}
                  placeholder={getAdapterDefaultBaseUrl(draftAdapterId())}
                  value={draftBaseUrl()}
                  onChange={(v) => {
                    draftBaseUrl.set(v);
                    connectionMessage.set(null);
                    if (!inspectBaseUrl(v).isInsecureHttp) {
                      draftAllowInsecureHttp.set(false);
                    }
                  }}
                />
              </FormField>
            </View>

            <If when={urlCheck().isInsecureHttp}>
              <Checkbox
                testID="connection-insecure-checkbox"
                checked={draftAllowInsecureHttp()}
                onChange={(checked) => draftAllowInsecureHttp.set(checked)}
                label={t("models.connection.insecureHttp")}
              />
            </If>

            <FormField
              label={t("models.connection.apiKey")}
              labelAction={
                <If when={props.channel.hasCredential}>
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
                          draftCredential.set("");
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
                        draftCredential.set("");
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
                readonly={credentialMode() === "clear"}
                placeholder={tokenPlaceholder()}
                value={draftCredential()}
                onChange={(v) => {
                  draftCredential.set(v);
                  connectionMessage.set(null);
                  if (v.length > 0) {
                    credentialMode.set("replace");
                  } else if (credentialMode() === "replace") {
                    credentialMode.set("keep");
                  }
                }}
              />
            </FormField>

            <If when={saveError() !== null}>
              <Text role="alert" class="text-xs text-destructive">
                {saveError()}
              </Text>
            </If>
            <If when={isDirty()}>
              <Text class="text-xs text-warning">{t("models.connection.dirtyHint")}</Text>
            </If>
            <If when={!isDirty() && connectionMessage() !== null}>
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
              channel={props.channel}
              models={props.models}
              enabledFilter={props.enabledFilter}
              isDirty={isDirty()}
              syncAdapterId={syncAdapterId()}
              testing={testing()}
              syncing={syncing()}
              onSyncAdapterChange={(adapterId) => syncAdapterId.set(adapterId)}
              onGetModels={() => void handleGetModels()}
              onEnabledFilterChange={(f) => props.onEnabledFilterChange(f)}
              onAddModel={() => addModelOpen.set(true)}
              onConfigureModel={(model) => editingModel.set(model)}
            />
          </Card>
        </View>
      </Scroll>

      <AddModelDialog
        open={addModelOpen()}
        providerId={props.channel.id}
        onOpenChange={(open) => addModelOpen.set(open)}
      />

      <EditModelDialog
        open={editingModel() !== null}
        model={editingModel()}
        onOpenChange={(open) => {
          if (!open) editingModel.set(null);
        }}
      />

      <ConfirmDialog
        testID="delete-channel-dialog"
        open={deleteDialogOpen()}
        onOpenChange={(open) => deleteDialogOpen.set(open)}
        title={t("models.channel.delete")}
        description={t("models.channel.deleteDescription", {
          name: props.channel.displayName,
        })}
        confirmLabel={t("common.delete")}
        confirmVariant="destructive"
        busy={deletingChannel()}
        onConfirm={() => void handleConfirmDeleteChannel()}
      />
    </View>
  );
}
