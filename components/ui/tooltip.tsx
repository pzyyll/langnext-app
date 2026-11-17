import { Text } from "nsh";
import { Tooltip } from "nsh/base";
import { motion } from "../motion";

/** Builds a theme-styled tooltip bubble matching SidebarItem's tooltip appearance. */
export function buildTooltip(
  label: string,
  placement: "top" | "bottom" | "left" | "right" = "top",
) {
  return (
    <Tooltip
      placement={placement}
      class={`flex-row items-center rounded-xl border border-border bg-sidebar-primary px-3 py-1.5 ${motion.tooltip}`}
      startingClass="opacity-0"
      endingClass="opacity-0"
    >
      <Text class="text-xs text-sidebar-primary-foreground">{label}</Text>
    </Tooltip>
  );
}
