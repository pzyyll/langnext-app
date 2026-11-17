import { effect, signal, Scroll, Text, View, windowSize } from "nsh";
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
import {
  ADAPTER_SPECS,
  getAdapterDefaultBaseUrl,
  getAdapterLabel,
} from "../../services/protocols/adapters";
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

  const addModelOpen = signal(false);
  const editingModel = signal<ProviderModel | null>(null);
  const deleteDialogOpen = signal(false);
  const deletingChannel = signal(false);

  let syncedId = "";
  let syncedRevision = -1;

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
    if ((urlCheck().normalizedBaseUrl ?? "") !== (ch.baseUrl ?? "")) return true;
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
      toast.error(error instanceof Error ? error.message : "Could not update channel status.");
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
      toast.success(`Renamed channel to ${updated.displayName}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename channel.");
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
      loadFromChannel(updated);
      toast.success("Channel saved");
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        conflictDetected.set(true);
      }
      saveError.set(error instanceof Error ? error.message : "Could not save channel.");
    } finally {
      saving.set(false);
    }
  };

  const handleConfirmDeleteChannel = async () => {
    if (deletingChannel()) return;
    deletingChannel.set(true);
    const name = props.channel.displayName;
    try {
      await deleteChannel(props.channel.id);
      deleteDialogOpen.set(false);
      toast.success(`Deleted channel ${name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete channel.");
    } finally {
      deletingChannel.set(false);
    }
  };

  const tokenPlaceholder = () => {
    if (credentialMode() === "clear") return "Stored token will be cleared on Save";
    if (props.channel.hasCredential) return "Stored token retained (type to replace)";
    return "Paste API key";
  };

  const compactLayout = () => windowSize().width < 860;

  return (
    <View testID="provider-editor" class="min-w-0 flex-1 bg-background">
      <View class="flex-row flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
          <If
            when={renaming()}
            else={
              <>
                <Text role="header" class="truncate text-xl font-semibold text-foreground">
                  {props.channel.displayName}
                </Text>
                <Button
                  testID="rename-channel-button"
                  size="icon-sm"
                  variant="ghost"
                  tooltip="Rename"
                  accessibilityLabel="Rename channel"
                  onPress={startRename}
                >
                  <Icon name="edit" tone="muted-foreground" class="size-3.5" />
                </Button>
                <Badge label={getAdapterLabel(props.channel.adapterId)} tone="neutral" />
              </>
            }
          >
            <View class="flex-row flex-wrap items-center gap-2">
              <Input
                testID="rename-channel-input"
                size="sm"
                autoFocus
                accessibilityLabel="Channel Name"
                value={renameDraft()}
                onChange={(v) => renameDraft.set(v)}
                onSubmit={() => void submitRename()}
                onKeyPress={(key) => {
                  if (key === "Escape") renaming.set(false);
                }}
                class="w-48"
              />
              <Button
                testID="confirm-rename-channel"
                variant="primary"
                size="sm"
                label={renameSaving() ? "Saving…" : "Save"}
                disabled={renameDraft().trim().length === 0 || renameSaving()}
                onPress={() => void submitRename()}
              />
              <Button
                variant="outline"
                size="sm"
                label="Cancel"
                disabled={renameSaving()}
                onPress={() => renaming.set(false)}
              />
            </View>
          </If>
        </View>

        <Switch
          testID="channel-enabled-switch"
          label="Enabled"
          variant="inline"
          accessibilityLabel="Channel enabled"
          checked={props.channel.enabled}
          onChange={(checked) => void handleToggleChannelEnabled(checked)}
        />
      </View>

      <If when={conflictDetected()}>
        <View class="flex-row items-center justify-between gap-3 border-b border-border bg-warning/15 px-6 py-2.5">
          <Text class="text-xs font-medium text-warning">
            Channel updated elsewhere. Reload to apply latest saved configuration.
          </Text>
          <Button
            size="sm"
            variant="outline"
            label="Reload"
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
              ? "mx-auto w-full max-w-4xl gap-5 p-4"
              : "mx-auto w-full max-w-4xl gap-6 p-6"
          }
        >
          <Card testID="connection-card" class={compactLayout() ? "p-4" : undefined}>
            <SectionHeading title="Connection" />

            <FormField label="API Type">
              <Select
                testID="connection-adapter-select"
                accessibilityLabel="API Type"
                items={ADAPTER_ITEMS}
                value={draftAdapterId()}
                onChange={(v) => {
                  if (v) draftAdapterId.set(v as AdapterId);
                }}
              />
            </FormField>

            <FormField label="Base URL" error={urlCheck().error}>
              <Input
                testID="connection-url-input"
                accessibilityLabel="Base URL"
                placeholder={getAdapterDefaultBaseUrl(draftAdapterId())}
                value={draftBaseUrl()}
                onChange={(v) => {
                  draftBaseUrl.set(v);
                  if (!inspectBaseUrl(v).isInsecureHttp) {
                    draftAllowInsecureHttp.set(false);
                  }
                }}
              />
            </FormField>

            <If when={urlCheck().isInsecureHttp}>
              <Checkbox
                testID="connection-insecure-checkbox"
                checked={draftAllowInsecureHttp()}
                onChange={(checked) => draftAllowInsecureHttp.set(checked)}
                label="Allow unencrypted http:// for non-local host"
              />
            </If>

            <View class="gap-1.5">
              <View class="flex-row items-center justify-between">
                <Text class="text-xs font-medium text-foreground">API Key</Text>
                <If when={props.channel.hasCredential}>
                  <If
                    when={credentialMode() === "clear"}
                    else={
                      <Button
                        testID="clear-token-button"
                        size="sm"
                        variant="ghost"
                        label="Reset token"
                        onPress={() => {
                          credentialMode.set("clear");
                          draftCredential.set("");
                        }}
                      />
                    }
                  >
                    <Button
                      testID="keep-token-button"
                      size="sm"
                      variant="ghost"
                      label="Keep stored token"
                      onPress={() => {
                        credentialMode.set("keep");
                        draftCredential.set("");
                      }}
                    />
                  </If>
                </If>
              </View>
              <Input
                testID="connection-token-input"
                accessibilityLabel="API Key"
                masked
                readonly={credentialMode() === "clear"}
                placeholder={tokenPlaceholder()}
                value={draftCredential()}
                onChange={(v) => {
                  draftCredential.set(v);
                  if (v.length > 0) {
                    credentialMode.set("replace");
                  } else if (credentialMode() === "replace") {
                    credentialMode.set("keep");
                  }
                }}
              />
            </View>

            <If when={saveError() !== null}>
              <Text role="alert" class="text-xs text-destructive">
                {saveError()}
              </Text>
            </If>
          </Card>

          <Card testID="models-card" class={compactLayout() ? "p-4" : undefined}>
            <ModelsTable
              channel={props.channel}
              models={props.models}
              enabledFilter={props.enabledFilter}
              isDirty={isDirty()}
              onEnabledFilterChange={(f) => props.onEnabledFilterChange(f)}
              onAddModel={() => addModelOpen.set(true)}
              onConfigureModel={(model) => editingModel.set(model)}
            />
          </Card>
        </View>
      </Scroll>

      <View class="flex-row items-center justify-between gap-3 border-t border-border bg-muted/40 px-6 py-3">
        <Button
          testID="delete-channel-button"
          variant="destructive-outline"
          size="sm"
          label="Delete Channel"
          disabled={deletingChannel()}
          onPress={() => deleteDialogOpen.set(true)}
        />

        <View class="flex-row items-center gap-2">
          <If when={isDirty()}>
            <Badge label="Unsaved" tone="warning" />
          </If>
          <Button
            testID="cancel-channel-button"
            variant="outline"
            size="sm"
            label="Cancel"
            disabled={!isDirty() || saving()}
            onPress={() => loadFromChannel(props.channel)}
          />
          <Button
            testID="save-channel-button"
            variant="primary"
            size="sm"
            label={saving() ? "Saving…" : "Save"}
            disabled={!isDirty() || saving() || !canSave()}
            onPress={() => void handleSave()}
          />
        </View>
      </View>

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
        title="Delete Channel"
        description={`Delete channel "${props.channel.displayName}" and all of its models?`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        busy={deletingChannel()}
        onConfirm={() => void handleConfirmDeleteChannel()}
      />
    </View>
  );
}
