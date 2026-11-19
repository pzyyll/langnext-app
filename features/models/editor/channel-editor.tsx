import { Scroll, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, SectionHeading } from "../../../components/ui/card";
import { ConfirmDialog } from "../../../components/ui/dialog";
import { Icon } from "../../../components/ui/icon";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { FormField } from "../../../modules/ai/ui/form-field";
import { ProviderMark } from "../../../modules/ai/ui/provider-mark";
import { AddModelDialog } from "../add-model-dialog";
import { EditModelDialog } from "../edit-model-dialog";
import { ModelsTable } from "../models-table";
import { createChannelEditorController, type ChannelEditorProps } from "./controller";
import { ProviderSettingsHost } from "./provider-settings";

/** Right detail pane for configuring a new channel draft or an existing provider channel. */
export function ChannelEditor(props: ChannelEditorProps) {
  const editor = createChannelEditorController(props);
  const {
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
    renaming,
    setRenaming,
    renameDraft,
    setRenameDraft,
    nameError,
    setNameError,
    saveError,
    setSaveError,
    connectionMessage,
    setConnectionMessage,
    addModelOpen,
    setAddModelOpen,
    editingModel,
    setEditingModel,
    deleteDialogOpen,
    setDeleteDialogOpen,
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
  } = editor;

  return (
    <View testID="provider-editor" class="min-w-0 flex-1 bg-background">
      <View class="shrink-0">
        <View
          class={`mx-auto h-14 w-full max-w-4xl flex-row items-center justify-between gap-3 ${compactLayout() ? "px-4" : "px-6"}`}
        >
          <View class="min-w-0 flex-1 flex-row items-center gap-2">
            <If
              when={providerPresentation() !== null}
              else={<Icon name="cube-outline" tone="muted-foreground" class="size-5 shrink-0" />}
            >
              <ProviderMark icon={providerPresentation()!.icon} class="size-5 shrink-0" />
            </If>
            <If
              when={!isDraftMode() && renaming()}
              else={
                <>
                  <Text role="header" class="truncate text-lg font-semibold text-foreground">
                    {currentDisplayName().trim() || providerLabel()}
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
                  onChange={(v) => setRenameDraft(v)}
                  onSubmit={() => void submitRename()}
                  onKeyPress={(key) => {
                    if (key === "Escape") setRenaming(false);
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
                  onPress={() => setRenaming(false)}
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
                  onPress={() => setDeleteDialogOpen(true)}
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
      </View>

      <If when={!isDraftMode() && conflictDetected()}>
        <View class={`mx-auto w-full max-w-4xl pb-2 ${compactLayout() ? "px-4" : "px-6"}`}>
          <View class="flex-row items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/15 px-4 py-2.5">
            <Text class="text-xs font-medium text-warning">{t("models.channel.conflict")}</Text>
            <Button
              size="sm"
              variant="outline"
              label={t("common.reload")}
              onPress={() => {
                reloadFromChannel();
              }}
            />
          </View>
        </View>
      </If>

      <If when={hasUnsupportedConfiguration()}>
        <View class={`mx-auto w-full max-w-4xl pb-2 ${compactLayout() ? "px-4" : "px-6"}`}>
          <View
            testID="unsupported-configuration-alert"
            class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5"
          >
            <Text role="alert" class="text-xs font-medium text-destructive">
              {t("ai.error.unsupportedConfiguration")}
            </Text>
          </View>
        </View>
      </If>

      <Scroll class="min-h-0 flex-1">
        <View
          class={
            compactLayout()
              ? "mx-auto w-full max-w-4xl gap-4 px-4 pb-4 pt-1"
              : "mx-auto w-full max-w-4xl gap-5 px-6 pb-6 pt-2"
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
                    <If when={providerPresentation() !== null}>
                      <ProviderMark icon={providerPresentation()!.icon} class="size-4 shrink-0" />
                    </If>
                    <Text class="truncate text-sm font-medium text-foreground">
                      {providerLabel()}
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
                    ref={(node) => {
                      setDraftNameInput(node);
                    }}
                    autoFocus
                    accessibilityLabel={t("common.displayName")}
                    placeholder={t("models.channel.displayNamePlaceholder")}
                    value={currentDisplayName()}
                    onChange={(v) => {
                      if (props.mode === "draft") {
                        props.draft.setDisplayName(v);
                        setNameError(null);
                        setSaveError(null);
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
                        setConnectionMessage(null);
                        reloadFromChannel();
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
                  disabled={testing() || syncing() || connectionBlocked()}
                  onPress={() => void handleTest()}
                />
              </View>
            </View>

            <If when={providerSupported()}>
              <ProviderSettingsHost
                providerTypeId={currentPresetId()}
                mode={isDraftMode() ? "draft" : "saved"}
                protocolId={currentAdapterId()}
                baseUrl={currentBaseUrl()}
                credential={currentCredential()}
                hasSavedCredential={props.mode === "saved" && props.channel.hasCredential}
                credentialMode={isDraftMode() ? "keep" : credentialMode()}
                urlError={urlCheck().error}
                isInsecureHttp={urlCheck().isInsecureHttp}
                allowInsecureHttp={currentAllowInsecureHttp()}
                compact={compactLayout()}
                disabled={saving()}
                onProtocolChange={handleProtocolChange}
                onBaseUrlChange={handleBaseUrlChange}
                onCredentialChange={handleCredentialChange}
                onCredentialModeChange={handleCredentialModeChange}
                onInsecureHttpChange={handleInsecureHttpChange}
              />
            </If>

            <If when={saveError() !== null}>
              <Text role="alert" class="text-xs text-destructive">
                {saveError()}
              </Text>
            </If>
            <If when={connectionMessage() !== null}>
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
              testing={testing()}
              syncing={syncing()}
              disabled={!providerSupported()}
              connectionBlocked={connectionBlocked()}
              onGetModels={() => void handleGetModels()}
              onEnabledFilterChange={(f) => props.onEnabledFilterChange(f)}
              onAddModel={() => setAddModelOpen(true)}
              onConfigureModel={(model) => setEditingModel(model)}
              onToggleModelEnabled={handleToggleModelEnabled}
              onDeleteModels={handleDeleteModels}
            />
          </Card>
        </View>
      </Scroll>

      <AddModelDialog
        open={addModelOpen()}
        presetId={currentPresetId()}
        onOpenChange={(open) => setAddModelOpen(open)}
        onSubmit={handleAddModelSubmit}
      />

      <EditModelDialog
        open={editingModel() !== null}
        presetId={currentPresetId()}
        model={editingModel()}
        onOpenChange={(open) => {
          if (!open) setEditingModel(null);
        }}
        onSubmit={handleEditModelSubmit}
      />

      <If when={props.mode === "saved"}>
        <ConfirmDialog
          testID="delete-channel-dialog"
          open={deleteDialogOpen()}
          onOpenChange={(open) => setDeleteDialogOpen(open)}
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
