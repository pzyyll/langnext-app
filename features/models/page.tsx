import { cleanup, setAccessibilityFocus, signal, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import type { NavigationLeaveGuard } from "../../components/layout/navigation-leave-guard";
import type { ProviderTypeId } from "../../modules/ai/contracts/channel";
import { AddChannelDialog } from "./add-channel-dialog";
import { createChannelDraft, type ChannelDraft } from "./channel-draft";
import { ChannelsRail } from "./channels-rail";
import { ChannelEditor } from "./editor/channel-editor";
import {
  loadModelsState,
  modelsStore,
  moveChannel,
  selectChannel,
  setEnabledFilter,
} from "./store";

interface ModelsPageProps {
  onRegisterLeaveGuard?: (guard: NavigationLeaveGuard) => () => void;
}

function focusTarget(node: ViewRef | null) {
  if (!node) return;
  node.focus();
  setAccessibilityFocus(node);
}

/** Models workspace using a Channels master rail and Provider detail editor. */
export function ModelsPage(props: ModelsPageProps) {
  const addChannelOpen = signal(false);
  const draft = signal<ChannelDraft | null>(null);
  const pendingDiscardAction = signal<{ run: () => void; onDiscardFocus?: () => void } | null>(
    null,
  );
  let abortDraftWork: (() => void) | null = null;
  let focusDraftName: (() => void) | null = null;
  let emptyAddNode: ViewRef | null = null;
  let railAddNode: ViewRef | null = null;
  let discardCancelNode: ViewRef | null = null;
  let pickerReturnTarget: (() => ViewRef | null) | null = null;
  let pendingPostDiscardFocus: (() => void) | null = null;
  let discardedJustConfirmed = false;
  const channelNodes = new Map<string, ViewRef>();

  if (props.onRegisterLeaveGuard) {
    const unregister = props.onRegisterLeaveGuard((proceed) => {
      if (draft() === null) {
        return true;
      }
      pendingDiscardAction.set({ run: proceed });
      return false;
    });
    cleanup(unregister);
  }

  const registerDraftAbort = (abort: () => void) => {
    abortDraftWork = abort;
    return () => {
      if (abortDraftWork === abort) {
        abortDraftWork = null;
      }
    };
  };

  const registerDraftFocus = (focus: () => void) => {
    focusDraftName = focus;
    return () => {
      if (focusDraftName === focus) {
        focusDraftName = null;
      }
    };
  };

  const guardDraftLeave = (action: () => void, onDiscardFocus?: () => void) => {
    if (draft() === null) {
      action();
      return;
    }
    pendingDiscardAction.set({ run: action, onDiscardFocus });
  };

  const confirmDiscardDraft = () => {
    const pending = pendingDiscardAction();
    discardedJustConfirmed = true;
    pendingPostDiscardFocus = pending?.onDiscardFocus ?? null;
    pendingDiscardAction.set(null);
    abortDraftWork?.();
    draft()?.dispose();
    draft.set(null);
    pending?.run();
  };

  const handleSelectPreset = (providerTypeId: ProviderTypeId) => {
    pickerReturnTarget = null;
    pendingDiscardAction.set(null);
    draft.set(createChannelDraft(providerTypeId));
    addChannelOpen.set(false);
  };

  const handleSelectChannel = (id: string) => {
    guardDraftLeave(
      () => selectChannel(id),
      () => focusTarget(channelNodes.get(id) ?? railAddNode),
    );
  };

  const handleCancelDraft = () => {
    guardDraftLeave(
      () => {},
      () => {
        const selectedId = modelsStore.selectedChannelId();
        focusTarget(
          (selectedId ? channelNodes.get(selectedId) : null) ?? emptyAddNode ?? railAddNode,
        );
      },
    );
  };

  const handleOpenAddChannel = (source: "rail" | "empty") => {
    const getTrigger = () => (source === "empty" ? emptyAddNode : railAddNode);
    guardDraftLeave(() => {
      pickerReturnTarget = getTrigger;
      addChannelOpen.set(true);
    });
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
        onAdd={() => handleOpenAddChannel("rail")}
        onRetry={() => void loadModelsState()}
        addButtonRef={(node) => {
          railAddNode = node;
        }}
        onChannelItemRef={(id, node) => {
          channelNodes.set(id, node);
        }}
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
                  ref={(node) => {
                    emptyAddNode = node;
                  }}
                  variant="primary"
                  size="md"
                  accessibilityLabel={t("models.channel.add")}
                  onPress={() => handleOpenAddChannel("empty")}
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
              // Native inputs and editor state belong to one channel, not the shared detail pane.
              <Each of={[channel()]} key={(item) => item.id}>
                {(activeChannel) => (
                  <ChannelEditor
                    mode="saved"
                    channel={activeChannel()}
                    models={modelsStore.modelsForSelectedChannel()}
                    enabledFilter={modelsStore.enabledFilter()}
                    onEnabledFilterChange={(filter) => void setEnabledFilter(filter)}
                  />
                )}
              </Each>
            )}
          </If>
        }
      >
        {(activeDraft) => (
          <ChannelEditor
            mode="draft"
            draft={activeDraft()}
            enabledFilter={modelsStore.enabledFilter()}
            onEnabledFilterChange={(filter) => void setEnabledFilter(filter)}
            onDraftSaved={() => {
              pendingDiscardAction.set(null);
              draft()?.dispose();
              draft.set(null);
            }}
            onCancelDraft={handleCancelDraft}
            onRegisterAbort={registerDraftAbort}
            onRegisterDraftFocus={registerDraftFocus}
          />
        )}
      </If>

      <AddChannelDialog
        open={addChannelOpen()}
        onOpenChange={(open) => addChannelOpen.set(open)}
        onSelect={handleSelectPreset}
        onClose={() => {
          if (pickerReturnTarget && draft() === null) {
            const target = pickerReturnTarget();
            pickerReturnTarget = null;
            focusTarget(target);
          } else {
            pickerReturnTarget = null;
          }
        }}
      />

      <ConfirmDialog
        testID="discard-draft-dialog"
        open={pendingDiscardAction() !== null}
        title={t("models.draft.discardTitle")}
        description={t("models.draft.discardDescription")}
        confirmLabel={t("models.draft.discardConfirm")}
        cancelRef={(node) => {
          discardCancelNode = node;
        }}
        onOpen={() => {
          discardedJustConfirmed = false;
          focusTarget(discardCancelNode);
        }}
        onClose={() => {
          if (discardedJustConfirmed) {
            discardedJustConfirmed = false;
            const fn = pendingPostDiscardFocus;
            pendingPostDiscardFocus = null;
            fn?.();
            return;
          }
          if (draft() !== null) {
            focusDraftName?.();
          }
        }}
        onOpenChange={(open) => {
          if (!open) pendingDiscardAction.set(null);
        }}
        onConfirm={confirmDiscardDraft}
      />
    </>
  );
}
