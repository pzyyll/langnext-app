import { Text } from "nsh";
import { Tooltip, type Align, type Placement } from "nsh/base";
import { motion } from "../motion";

interface TooltipLayout {
  /** How it lines up with the trigger along the placement side (default center). */
  align?: Align;
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
