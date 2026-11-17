import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import type { ProviderPresetId } from "../../services/protocols/presets";
import { AddChannelDialog } from "./add-channel-dialog";
import { createChannelDraft, type ChannelDraft } from "./channel-draft";
import { ChannelsRail } from "./channels-rail";
import { ProviderEditor } from "./provider-editor";
import {
  loadModelsState,
  modelsStore,
  moveChannel,
  selectChannel,
  setEnabledFilter,
} from "./store";

/** Models workspace using a Channels master rail and Provider detail editor. */
export function ModelsPage() {
  const addChannelOpen = signal(false);
  const draft = signal<ChannelDraft | null>(null);
  const pendingDiscardAction = signal<{ run: () => void } | null>(null);
  let abortDraftWork: (() => void) | null = null;

  const registerDraftAbort = (abort: () => void) => {
    abortDraftWork = abort;
    return () => {
      if (abortDraftWork === abort) {
        abortDraftWork = null;
      }
    };
  };

  const guardDraftLeave = (action: () => void) => {
    if (draft() === null) {
      action();
      return;
    }
    pendingDiscardAction.set({ run: action });
  };

  const confirmDiscardDraft = () => {
    const pending = pendingDiscardAction();
    pendingDiscardAction.set(null);
    abortDraftWork?.();
    draft.set(null);
    pending?.run();
  };

  const handleSelectPreset = (presetId: ProviderPresetId) => {
    pendingDiscardAction.set(null);
    draft.set(createChannelDraft(presetId));
    addChannelOpen.set(false);
  };

  const handleSelectChannel = (id: string) => {
    guardDraftLeave(() => selectChannel(id));
  };

  const handleCancelDraft = () => {
    guardDraftLeave(() => {});
  };

  return (
    <>
      <ChannelsRail
        channels={modelsStore.channels()}
        selectedId={draft() ? null : modelsStore.selectedChannelId()}
        loading={modelsStore.channelsLoading()}
        error={modelsStore.channelsError()}
        onSelect={handleSelectChannel}
        onMove={(id, dir) => void moveChannel(id, dir)}
        onAdd={() => addChannelOpen.set(true)}
        onRetry={() => void loadModelsState()}
      />

      <If
        when={draft()}
        else={
          <If
            when={modelsStore.selectedChannel()}
            else={
              <View class="min-w-0 flex-1 items-center justify-center gap-4 p-8">
                <Icon name="cube-outline" tone="muted-foreground" class="size-10 opacity-50" />
                <Text role="header" class="text-2xl font-semibold text-foreground">
                  {t("models.title")}
                </Text>
                <Button
                  testID="empty-add-channel-button"
                  variant="primary"
                  size="md"
                  accessibilityLabel={t("models.channel.add")}
                  onPress={() => addChannelOpen.set(true)}
                >
                  <Icon name="plus" tone="primary-foreground" class="size-4" />
                  <Text class="text-sm font-medium text-primary-foreground">
                    {t("models.channel.add")}
                  </Text>
                </Button>
              </View>
            }
          >
            {(channel) => (
              <ProviderEditor
                mode="saved"
                channel={channel()}
                models={modelsStore.modelsForSelectedChannel()}
                enabledFilter={modelsStore.enabledFilter()}
                onEnabledFilterChange={(filter) => void setEnabledFilter(filter)}
              />
            )}
          </If>
        }
      >
        {(activeDraft) => (
          <ProviderEditor
            mode="draft"
            draft={activeDraft()}
            enabledFilter={modelsStore.enabledFilter()}
            onEnabledFilterChange={(filter) => void setEnabledFilter(filter)}
            onDraftSaved={() => {
              pendingDiscardAction.set(null);
              draft.set(null);
            }}
            onCancelDraft={handleCancelDraft}
            onRegisterAbort={registerDraftAbort}
          />
        )}
      </If>

      <AddChannelDialog
        open={addChannelOpen()}
        onOpenChange={(open) => addChannelOpen.set(open)}
        onSelect={handleSelectPreset}
      />

      <ConfirmDialog
        testID="discard-draft-dialog"
        open={pendingDiscardAction() !== null}
        title={t("models.draft.discardTitle")}
        description={t("models.draft.discardDescription")}
        confirmLabel={t("models.draft.discardConfirm")}
        onOpenChange={(open) => {
          if (!open) pendingDiscardAction.set(null);
        }}
        onConfirm={confirmDiscardDraft}
      />
    </>
  );
}
