import { Image, setAccessibilityFocus, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { AppDialog } from "../../components/ui/dialog";
import { Icon } from "../../components/ui/icon";
import googleCloudIcon from "../../../assets/icons/google-cloud.svg";
import googleIcon from "../../../assets/icons/google.svg";
import type { PresetEngine } from "./types";

interface AddPresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (engineKind: PresetEngine["kind"]) => void;
  onClose?: () => void;
}

/** Modal picker that chooses a preset engine before any draft exists. */
export function AddPresetDialog(props: AddPresetDialogProps) {
  let firstCardNode: ViewRef | null = null;

  return (
    <AppDialog
      testID="add-preset-dialog"
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpen={() => {
        if (firstCardNode) {
          firstCardNode.focus();
          setAccessibilityFocus(firstCardNode);
        }
      }}
      onClose={() => props.onClose?.()}
      title={t("presets.action.add")}
      size="md"
      footer={
        <Button
          testID="preset-type-cancel"
          variant="outline"
          size="sm"
          label={t("common.cancel")}
          onPress={() => props.onOpenChange(false)}
        />
      }
    >
      <View class="grid grid-cols-2 gap-3">
        <Button
          testID="preset-type-ai"
          ref={(node) => {
            firstCardNode = node;
          }}
          variant="outline"
          size="card"
          accessibilityLabel={t("presets.engine.ai")}
          onPress={() => props.onSelect("ai")}
          class="w-full"
        >
          <Icon name="cube-outline" tone="foreground" class="size-4" />
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {t("presets.engine.ai")}
          </Text>
        </Button>
        <Button
          testID="preset-type-deepl"
          variant="outline"
          size="card"
          accessibilityLabel={t("presets.engine.deepl")}
          onPress={() => props.onSelect("deepl")}
          class="w-full"
        >
          <Icon name="deepl" tone="foreground" class="size-4" />
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {t("presets.engine.deepl")}
          </Text>
        </Button>
        <Button
          testID="preset-type-google-cloud"
          variant="outline"
          size="card"
          accessibilityLabel={t("presets.engine.googleCloud")}
          onPress={() => props.onSelect("google-cloud")}
          class="w-full"
        >
          <Image
            src={googleCloudIcon}
            accessibilityElementsHidden={true}
            class="size-4 overflow-hidden"
          />
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {t("presets.engine.googleCloud")}
          </Text>
        </Button>
        <Button
          testID="preset-type-google-web"
          variant="outline"
          size="card"
          accessibilityLabel={t("presets.engine.googleWeb")}
          onPress={() => props.onSelect("google-web")}
          class="w-full"
        >
          <Image
            src={googleIcon}
            accessibilityElementsHidden={true}
            class="size-4 overflow-hidden"
          />
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {t("presets.engine.googleWeb")}
          </Text>
        </Button>
      </View>
    </AppDialog>
  );
}
