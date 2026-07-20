// ABOUTME: Ghost icon button built on Base UI Button with shared outline styling.
// ABOUTME: Applies default icon size and hover scale so call sites only pass the icon child.

import type { ComponentProps } from "react";
import { Button } from "@base-ui/react/button";
import { cn } from "../lib/cn";
import {
  dangerIconButtonClassName,
  iconButtonCircleClassName,
  iconButtonCircleLargeClassName,
  iconButtonClassName,
} from "./ui";

const variantClassName = {
  default: iconButtonClassName,
  danger: dangerIconButtonClassName,
  circle: iconButtonCircleClassName,
  "circle-large": iconButtonCircleLargeClassName,
} as const;

/** Target direct SVG icons (unplugin-icons) without forcing className on each child. */
const iconSlotClassName =
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-150 [&_svg]:group-hover/icon-btn:scale-110";

export type IconButtonVariant = keyof typeof variantClassName;

export type IconButtonProps = Omit<ComponentProps<typeof Button>, "type"> & {
  type?: ComponentProps<typeof Button>["type"];
  /** Visual tone / shape. Default is the ghost square icon control. */
  variant?: IconButtonVariant;
};

/**
 * Icon-only control. Prefer an `aria-label` (or visible text via `aria-labelledby`).
 *
 * @example
 * <IconButton aria-label="Copy" onClick={...}>
 *   <IconCopy />
 * </IconButton>
 */
export function IconButton({ className, variant = "default", type = "button", children, ...props }: IconButtonProps) {
  return (
    <Button type={type} className={cn(variantClassName[variant], iconSlotClassName, className)} {...props}>
      {children}
    </Button>
  );
}
