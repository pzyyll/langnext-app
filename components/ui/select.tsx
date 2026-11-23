import { signal, Text, View, type JSX, type ViewRef } from "nsh";
import { Select as BaseSelect, type SelectItem } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../motion";
import { Icon } from "./icon";
import { DROPDOWN_ITEM_GEOMETRY, DROPDOWN_POPUP_SURFACE } from "./popup-surface";
import { buildHoverTooltip, buildTooltip } from "./tooltip";

export type { SelectItem };

export type SelectSize = "sm" | "md";
export type SelectVariant = "default" | "chip" | "inline";

interface SelectProps {
  items: SelectItem[];
  value: string | null;
  placeholder?: string;
  displayLabel?: string;
  prefix?: string;
  leading?: JSX.Element;
  tooltip?: string;
  /** Shows the shown label in a hover tooltip, for compact triggers whose label may truncate. */
  labelTooltip?: boolean;
  variant?: SelectVariant;
  size?: SelectSize;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  ref?: (node: ViewRef) => void;
  placement?: "bottom" | "top";
  align?: "start" | "end";
  class?: string;
  triggerClass?: string;
  labelClass?: string;
  onChange: (value: string | null) => void;
  onOpenChange?: (open: boolean) => void;
}

const TRIGGER_VARIANT_CLASSES: Record<SelectVariant, string> = {
  default:
    "justify-between gap-2 rounded-xl border border-input bg-surface-control px-3 hover:bg-accent/50",
  chip: "h-6 justify-between gap-1 rounded-md border border-border bg-surface-control px-2 hover:bg-accent/60 active:bg-accent",
  inline:
    "h-6 justify-between gap-1 rounded-full bg-transparent px-2 hover:bg-surface-control/80 active:bg-surface-control",
};

/** Single-choice dropdown built over nsh/base Select with theme tokens. */
export function Select(props: SelectProps) {
  // Label tooltips follow the pointer only: the dropdown opening clears the hover, and the
  // pointer shows it again once it comes back, so a focus tooltip never answers the next Escape.
  const hovered = signal(false);
  const listOpen = signal(false);
  const variant = () => props.variant ?? "default";
  const isCompact = () => variant() !== "default";
  const selectedTitle = () => {
    const match = props.items.find((item) => item.value === props.value);
    return match ? match.title : null;
  };
  const shownLabel = () =>
    props.displayLabel ?? selectedTitle() ?? props.placeholder ?? t("common.selectPlaceholder");
  const hasActiveValue = () => props.displayLabel !== undefined || selectedTitle() !== null;
  const heightClass = () => {
    if (isCompact()) return "";
    return props.size === "sm" ? "h-8" : "h-9";
  };
  const textSizeClass = () => (props.size === "sm" || isCompact() ? "text-xs" : "text-sm");
  const contentFlexClass = () => (isCompact() ? "min-w-0 shrink" : "min-w-0 flex-1");
  const triggerTooltip = () => {
    if (props.tooltip !== undefined) return buildTooltip(props.tooltip, "top");
    if (!props.labelTooltip) return undefined;
    return buildHoverTooltip({
      label: shownLabel,
      open: () => hovered() && !listOpen(),
      testID: props.testID ? `${props.testID}-label-tooltip` : undefined,
    });
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
      margin={8}
      onChange={({ value }) => props.onChange(value)}
      onOpenChange={({ open }) => {
        if (open) hovered.set(false);
        listOpen.set(open);
        props.onOpenChange?.(open);
      }}
      class={props.class}
      popupClass={`min-w-44 ${DROPDOWN_POPUP_SURFACE}`}
      listClass="max-h-60"
      itemClass={`group justify-center ${DROPDOWN_ITEM_GEOMETRY} focus:bg-selection/50 selected:bg-selection/70 selected:shadow-control disabled:opacity-50`}
      renderItem={(entry) => (
        <View class="flex-row items-center justify-between gap-2">
          <Text class="min-w-0 flex-1 text-sm text-popover-foreground group-selected:font-semibold">
            {entry.title}
          </Text>
          <Icon
            name="mdi:check"
            tone="foreground"
            class="size-3.5 shrink-0 opacity-0 group-selected:opacity-100"
          />
        </View>
      )}
      trigger={
        <View
          testID={props.testID}
          ref={(node) => props.ref?.(node)}
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          tooltip={triggerTooltip()}
          class={`flex-row items-center focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${TRIGGER_VARIANT_CLASSES[variant()]} ${heightClass()} ${motion.navigationFeedback} ${props.triggerClass ?? ""}`}
        >
          <View class={`${contentFlexClass()} flex-row items-center gap-1.5`}>
            <If when={props.leading !== undefined}>{props.leading}</If>
            <If when={props.prefix !== undefined}>
              <Text class="shrink-0 text-xs text-muted-foreground">{props.prefix}</Text>
            </If>
            <Text
              class={`${contentFlexClass()} truncate ${hasActiveValue() ? "text-foreground" : "text-muted-foreground"} ${textSizeClass()} ${props.labelClass ?? ""}`}
            >
              {shownLabel()}
            </Text>
          </View>
          <Icon
            name="mdi:chevron-down"
            tone="muted-foreground"
            class={isCompact() ? "size-3 shrink-0" : "size-3.5 shrink-0"}
          />
        </View>
      }
    />
  );
}
