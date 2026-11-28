import { createMotion, Overlay, Text, View, type Bounds } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
import { Icon } from "../../components/ui/icon";

export interface DictionarySelectionPillProps {
  anchor: Bounds | null;
  onPressDown?: () => void;
  onEndPress?: () => void;
  onPress: () => void;
  onDismiss: () => void;
}

function DictionarySelectionPillSurface(
  props: Omit<DictionarySelectionPillProps, "anchor"> & { anchor: Bounds },
) {
  const enterMotion = createMotion({ enter: motion.popupEnter });

  return (
    <Overlay
      anchor={props.anchor}
      placement="top"
      align="center"
      offset={6}
      margin={8}
      onPressOutside={props.onDismiss}
      onCancel={props.onDismiss}
    >
      <View
        testID="quick-translate-dictionary-pill-surface"
        // Runtime entrance animation from shared motion tokens.
        style={enterMotion.style}
      >
        <View
          testID="quick-translate-dictionary-pill"
          role="button"
          focusable={false}
          accessibilityLabel={t("dictionary.lookUp")}
          class={`h-7 cursor-pointer flex-row items-center gap-1 rounded-full border border-border bg-popover px-2.5 shadow-card dark:shadow-card-dark hover:bg-accent active:bg-border ${motion.pressScale}`}
          onPressDown={props.onPressDown}
          onMouseLeave={props.onEndPress}
          onPress={props.onPress}
        >
          <Icon
            name="mdi:book-open-variant-outline"
            tone="muted-foreground"
            class="size-3.5 shrink-0"
          />
          <Text class="text-xs font-medium text-popover-foreground">{t("dictionary.lookUp")}</Text>
        </View>
      </View>
    </Overlay>
  );
}

/** Floating selection lookup pill anchored near highlighted text without taking keyboard focus. */
export function DictionarySelectionPill(props: DictionarySelectionPillProps) {
  return (
    <If when={props.anchor !== null}>
      <DictionarySelectionPillSurface
        anchor={props.anchor!}
        onPressDown={props.onPressDown}
        onEndPress={props.onEndPress}
        onPress={props.onPress}
        onDismiss={props.onDismiss}
      />
    </If>
  );
}
