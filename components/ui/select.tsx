import { Text, View } from "nsh";
import { Select as BaseSelect, type SelectItem } from "nsh/base";
import { motion } from "../motion";
import { Icon } from "./icon";

export type { SelectItem };

interface SelectProps {
  items: SelectItem[];
  value: string | null;
  placeholder?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
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
          class={`h-9 flex-row items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${motion.navigationFeedback} ${props.triggerClass ?? ""}`}
        >
          <Text
            class={
              selectedTitle() !== null
                ? "min-w-0 flex-1 truncate text-sm text-foreground"
                : "min-w-0 flex-1 truncate text-sm text-muted-foreground"
            }
          >
            {selectedTitle() ?? props.placeholder ?? "Select…"}
          </Text>
          <Icon name="chevron-down" tone="muted-foreground" class="size-3.5 shrink-0" />
        </View>
      }
    />
  );
}
