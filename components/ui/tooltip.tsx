import { Text, type Accessor } from "nsh";
import { Tooltip, type Align, type Placement } from "nsh/base";
import { motion } from "../motion";

interface TooltipLayout {
  /** How it lines up with the trigger along the placement side (default center). */
  align?: Align;
}

interface HoverTooltipOptions extends TooltipLayout {
  /** What it says; read again whenever the app changes it. */
  label: Accessor<string>;
  /** Whether it shows: the app follows the pointer, so the keyboard focus never opens it. */
  open: Accessor<boolean>;
  placement?: Placement;
  testID?: string;
}

/** Builds a theme-styled tooltip bubble matching SidebarItem's tooltip appearance. */
export function buildTooltip(
  label: string,
  placement: Placement = "top",
  layout: TooltipLayout = {},
) {
  return (
    <Tooltip
      placement={placement}
      align={layout.align}
      class={`rounded-xl border border-border bg-sidebar-primary px-3 py-1.5 ${motion.tooltip}`}
      startingClass="opacity-0"
      endingClass="opacity-0"
    >
      <Text class="max-w-64 text-xs text-sidebar-primary-foreground">{label}</Text>
    </Tooltip>
  );
}

/**
 * Builds a tooltip the app opens from the pointer alone, for a trigger whose visible label
 * may truncate. Unlike `buildTooltip`, moving the keyboard focus to the trigger leaves it
 * closed, so `Escape` keeps reaching whatever closes next (a dropdown, then its window).
 */
export function buildHoverTooltip(options: HoverTooltipOptions) {
  return (
    <Tooltip
      testID={options.testID}
      placement={options.placement ?? "top"}
      align={options.align}
      delay={Infinity}
      open={options.open()}
      class={`rounded-xl border border-border bg-sidebar-primary px-3 py-1.5 ${motion.tooltip}`}
      startingClass="opacity-0"
      endingClass="opacity-0"
    >
      <Text class="max-w-64 text-xs text-sidebar-primary-foreground">{options.label()}</Text>
    </Tooltip>
  );
}
