import { Text, type JSX, type ViewRef } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { motion } from "../motion";
import { buildTooltip } from "./tooltip";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "destructive-outline"
  | "destructive-ghost";

export type ButtonSize = "xs" | "sm" | "md" | "icon" | "icon-sm" | "row" | "card";

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  label?: string;
  accessibilityLabel?: string;
  tooltip?: string;
  testID?: string;
  ref?: (node: ViewRef) => void;
  disabled?: boolean;
  selected?: boolean;
  class?: string;
  onPress?: () => void;
  children?: JSX.Element;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "border border-primary bg-primary hover:bg-primary/90 active:bg-primary/80 focus-visible:ring-2 focus-visible:ring-ring",
  secondary:
    "border border-border bg-secondary hover:bg-accent active:bg-border focus-visible:ring-2 focus-visible:ring-ring",
  outline:
    "border border-input bg-background hover:bg-accent active:bg-border focus-visible:ring-2 focus-visible:ring-ring",
  ghost: "hover:bg-accent active:bg-border focus-visible:ring-2 focus-visible:ring-ring",
  destructive:
    "border border-destructive bg-destructive hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-2 focus-visible:ring-ring",
  "destructive-outline":
    "border border-destructive/40 bg-background hover:bg-destructive/10 active:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring",
  "destructive-ghost":
    "hover:bg-destructive/10 active:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring",
};

const TEXT_COLOR_CLASSES: Record<ButtonVariant, string> = {
  primary: "font-medium text-primary-foreground",
  secondary: "font-medium text-secondary-foreground",
  outline: "font-medium text-foreground",
  ghost: "font-medium text-foreground",
  destructive: "font-medium text-destructive-foreground",
  "destructive-outline": "font-medium text-destructive",
  "destructive-ghost": "font-medium text-destructive",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "h-9 flex-row items-center justify-center gap-2 rounded-lg px-4",
  sm: "h-8 flex-row items-center justify-center gap-1.5 rounded-lg px-3",
  xs: "h-6 flex-row items-center justify-center gap-1 rounded-md px-2",
  icon: "size-8 items-center justify-center rounded-lg",
  "icon-sm": "size-7 items-center justify-center rounded-md",
  row: "min-h-11 flex-row items-center justify-start gap-2.5 rounded-lg px-2 py-1.5",
  card: "min-h-14 flex-row items-center justify-start gap-3 rounded-xl px-4 py-3",
};

function resolveButtonClass(
  variant: ButtonVariant | undefined,
  size: ButtonSize | undefined,
  extra: string | undefined,
) {
  const v = variant ?? "outline";
  const s = size ?? "md";
  const feedback = s === "row" ? motion.navigationFeedback : motion.pressScale;
  return `${SIZE_CLASSES[s]} ${VARIANT_CLASSES[v]} disabled:opacity-50 ${feedback} ${extra ?? ""}`;
}

function resolveTextClass(variant: ButtonVariant | undefined, size: ButtonSize | undefined) {
  const v = variant ?? "outline";
  const textSize = size === "xs" ? "text-xs" : "text-sm";
  return `${textSize} ${TEXT_COLOR_CLASSES[v]}`;
}

/** Styled push button sharing the app's border, hover, focus, and press tokens. */
export function Button(props: ButtonProps) {
  return (
    <BaseButton
      testID={props.testID}
      ref={(node) => props.ref?.(node)}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={() => props.onPress?.()}
      class={resolveButtonClass(props.variant, props.size, props.class)}
      tooltip={props.tooltip ? buildTooltip(props.tooltip, "top") : undefined}
    >
      <If when={props.label !== undefined}>
        <Text class={resolveTextClass(props.variant, props.size)}>{props.label}</Text>
      </If>
      {props.children}
    </BaseButton>
  );
}
