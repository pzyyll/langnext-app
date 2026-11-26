// ABOUTME: The available-channel picker shared by every capability settings section.
import { Image, setAccessibilityFocus, View, Text, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { AppDialog } from "../../components/ui/dialog";
import type { CapabilityChannelContribution } from "../../framework/contributions";

type ErasedContribution = CapabilityChannelContribution<unknown, unknown, unknown>;

export interface CapabilitySectionAddDialogProps {
  testIdPrefix: string;
  open: boolean;
  available: readonly ErasedContribution[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onClose?: () => void;
}

function focusTarget(node: ViewRef | null | undefined) {
  if (!node) return;
  node.focus();
  setAccessibilityFocus(node);
}

/** Lists the channels this build has not added yet and returns the chosen id. */
export function CapabilitySectionAddDialog(props: CapabilitySectionAddDialogProps) {
  const cardRefs: Record<string, ViewRef> = {};

  const firstId = () => props.available[0]?.id;

  return (
    <AppDialog
      testID={`${props.testIdPrefix}-add-dialog`}
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy) props.onOpenChange(open);
      }}
      onOpen={() => {
        const first = firstId();
        if (first !== undefined) focusTarget(cardRefs[first]);
      }}
      onClose={() => props.onClose?.()}
      title={t("settings.capabilities.addChannel")}
      size="md"
      closeOnEscape={!props.busy}
      closeOnBackdropPress={!props.busy}
      footer={
        <Button
          testID={`${props.testIdPrefix}-add-cancel`}
          variant="outline"
          size="sm"
          label={t("common.cancel")}
          disabled={props.busy}
          onPress={() => props.onOpenChange(false)}
        />
      }
    >
      <View class="grid grid-cols-2 gap-3">
        <Each of={props.available} key={(contribution) => contribution.id}>
          {(contribution) => (
            <Button
              testID={`${props.testIdPrefix}-option-${contribution().id}`}
              ref={(node) => {
                cardRefs[contribution().id] = node;
              }}
              variant="outline"
              size="card"
              disabled={props.busy}
              accessibilityLabel={t(contribution().labelKey)}
              onPress={() => props.onSelect(contribution().id)}
              class="w-full"
            >
              <Avatar
                size="md"
                accessibilityLabel=""
                fallback={
                  <Image
                    src={contribution().icon}
                    accessibilityElementsHidden={true}
                    class="size-4 overflow-hidden"
                  />
                }
              />
              <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {t(contribution().labelKey)}
              </Text>
            </Button>
          )}
        </Each>
      </View>
    </AppDialog>
  );
}
