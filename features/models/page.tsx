import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
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

  const handleSelectPreset = (presetId: ProviderPresetId) => {
    draft.set(createChannelDraft(presetId));
    addChannelOpen.set(false);
  };

  const handleSelectChannel = (id: string) => {
    draft.set(null);
    selectChannel(id);
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
            onDraftSaved={() => draft.set(null)}
            onCancelDraft={() => draft.set(null)}
          />
        )}
      </If>

      <AddChannelDialog
        open={addChannelOpen()}
        onOpenChange={(open) => addChannelOpen.set(open)}
        onSelect={handleSelectPreset}
      />
    </>
  );
}
