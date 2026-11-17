import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { AddChannelDialog } from "./add-channel-dialog";
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

  return (
    <>
      <ChannelsRail
        channels={modelsStore.channels()}
        selectedId={modelsStore.selectedChannelId()}
        loading={modelsStore.channelsLoading()}
        error={modelsStore.channelsError()}
        onSelect={(id) => selectChannel(id)}
        onMove={(id, dir) => void moveChannel(id, dir)}
        onAdd={() => addChannelOpen.set(true)}
        onRetry={() => void loadModelsState()}
      />

      <If
        when={modelsStore.selectedChannel()}
        else={
          <View class="min-w-0 flex-1 items-center justify-center gap-4 p-8">
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
            channel={channel()}
            models={modelsStore.modelsForSelectedChannel()}
            enabledFilter={modelsStore.enabledFilter()}
            onEnabledFilterChange={(filter) => void setEnabledFilter(filter)}
          />
        )}
      </If>

      <AddChannelDialog open={addChannelOpen()} onOpenChange={(open) => addChannelOpen.set(open)} />
    </>
  );
}
