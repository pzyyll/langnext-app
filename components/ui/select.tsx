import { Text, View, type ViewRef } from "nsh";
import { Select as BaseSelect, type SelectItem } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../motion";
import { Icon } from "./icon";
import { buildTooltip } from "./tooltip";

export type { SelectItem };

export type SelectSize = "sm" | "md";

interface SelectProps {
  items: SelectItem[];
  value: string | null;
  placeholder?: string;
  prefix?: string;
  tooltip?: string;
  size?: SelectSize;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  ref?: (node: ViewRef) => void;
  placement?: "bottom" | "top";
  align?: "start" | "end";
  class?: string;
  triggerClass?: string;
  onChange: (value: string | null) => void;
}

/** Single-choice dropdown built over nsh/base Select with theme tokens. */
export function Select(props: SelectProps) {
  const selectedTitle = () => {
    const match = props.items.find((item) => item.value === props.value);
    return match ? match.title : null;
  };
  const heightClass = () => (props.size === "sm" ? "h-8" : "h-9");
  const textSizeClass = () => (props.size === "sm" ? "text-xs" : "text-sm");

  return (
    <BaseSelect
      accessibilityLabel={props.accessibilityLabel}
      items={props.items}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={4}
      onChange={({ value }) => props.onChange(value)}
      class={props.class}
      popupClass={`min-w-44 rounded-xl border border-border bg-popover p-1 shadow-lg ${motion.popup}`}
      listClass="max-h-60"
      itemClass={`group flex-row items-center justify-between gap-2 rounded-lg px-3 py-1.5 focus:bg-accent selected:bg-accent/60 disabled:opacity-50 ${motion.navigationFeedback}`}
      renderItem={(entry) => (
        <View class="flex-1 flex-row items-center justify-between gap-2">
          <Text class="min-w-0 flex-1 text-sm text-popover-foreground group-selected:font-medium">
            {entry.title}
          </Text>
          <Icon
            name="check"
            tone="foreground"
            class="size-3.5 shrink-0 opacity-0 group-selected:opacity-100"
          />
        </View>
      )}
      trigger={
        <View
          testID={props.testID}
          ref={(node) => props.ref?.(node)}
          tooltip={props.tooltip ? buildTooltip(props.tooltip, "top") : undefined}
          class={`flex-row items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${heightClass()} ${motion.navigationFeedback} ${props.triggerClass ?? ""}`}
        >
          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
            <If when={props.prefix !== undefined}>
              <Text class="shrink-0 text-xs text-muted-foreground">{props.prefix}</Text>
            </If>
            <Text
              class={
                selectedTitle() !== null
                  ? `min-w-0 flex-1 truncate text-foreground ${textSizeClass()}`
                  : `min-w-0 flex-1 truncate text-muted-foreground ${textSizeClass()}`
              }
            >
              {selectedTitle() ?? props.placeholder ?? t("common.selectPlaceholder")}
            </Text>
          </View>
          <Icon name="chevron-down" tone="muted-foreground" class="size-3.5 shrink-0" />
        </View>
      }
    />
  );
}
