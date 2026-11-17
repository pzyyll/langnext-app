import { setAccessibilityFocus, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { AppDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import { PROVIDER_PRESETS, type ProviderPresetId } from "../../services/protocols/presets";

interface AddChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (presetId: ProviderPresetId) => void;
  onClose?: () => void;
}

/** Modal picker for choosing a provider preset before configuring the channel draft. */
export function AddChannelDialog(props: AddChannelDialogProps) {
  let firstCardNode: ViewRef | null = null;
  const firstPresetId = PROVIDER_PRESETS[0]?.id;

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
        <Each of={[...PROVIDER_PRESETS]} key={(preset) => preset.id}>
          {(preset) => (
            <Button
              testID={`provider-preset-${preset().id}`}
              ref={(node) => {
                if (preset().id === firstPresetId) {
                  firstCardNode = node;
                }
              }}
              variant="outline"
              size="card"
              accessibilityLabel={t(preset().labelKey)}
              onPress={() => props.onSelect(preset().id)}
              class="w-full"
            >
              <View class="size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon name={preset().icon} tone="foreground" class="size-4" />
              </View>
              <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {t(preset().labelKey)}
              </Text>
            </Button>
          )}
        </Each>
      </View>
    </AppDialog>
  );
}
