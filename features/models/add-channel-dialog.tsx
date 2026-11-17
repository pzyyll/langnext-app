import { setAccessibilityFocus, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { AppDialog } from "../../components/ui/dialog";
import type { ProviderTypeId } from "../../modules/ai/contracts/channel";
import { aiRegistry } from "../../modules/ai/runtime/registry";
import { getProviderLabel } from "../../modules/ai/ui/labels";
import { ProviderMark } from "../../modules/ai/ui/provider-mark";
import { providerSettingsRegistry } from "../../modules/ai/ui/registry";

interface AddChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (providerTypeId: ProviderTypeId) => void;
  onClose?: () => void;
}

/** Modal picker for choosing a registered provider before configuring the channel draft. */
export function AddChannelDialog(props: AddChannelDialogProps) {
  let firstCardNode: ViewRef | null = null;
  const providers = [...aiRegistry.listProviders()];
  const firstProviderId = providers[0]?.id;

  return (
    <AppDialog
      testID="add-channel-dialog"
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpen={() => {
        if (firstCardNode) {
          firstCardNode.focus();
          setAccessibilityFocus(firstCardNode);
        }
      }}
      onClose={() => props.onClose?.()}
      title={t("models.channel.add")}
      size="md"
      footer={
        <Button
          variant="outline"
          size="sm"
          label={t("common.cancel")}
          onPress={() => props.onOpenChange(false)}
        />
      }
    >
      <View class="grid grid-cols-2 gap-3">
        <Each of={providers} key={(provider) => provider.id}>
          {(provider) => {
            const presentation = () => providerSettingsRegistry.find(provider().id);
            return (
              <Button
                testID={`provider-preset-${provider().id}`}
                ref={(node) => {
                  if (provider().id === firstProviderId) {
                    firstCardNode = node;
                  }
                }}
                variant="outline"
                size="card"
                accessibilityLabel={getProviderLabel(provider())}
                onPress={() => props.onSelect(provider().id)}
                class="w-full"
              >
                <If when={presentation() !== null}>
                  <Avatar
                    size="md"
                    fallback={<ProviderMark icon={presentation()!.icon} class="size-4" />}
                    accessibilityLabel=""
                  />
                </If>
                <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {getProviderLabel(provider())}
                </Text>
              </Button>
            );
          }}
        </Each>
      </View>
    </AppDialog>
  );
}
