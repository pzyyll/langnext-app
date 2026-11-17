import { Text, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { motion } from "../motion";
import { buildTooltip } from "./tooltip";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "destructive-outline";

export type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  label?: string;
  accessibilityLabel?: string;
  tooltip?: string;
  testID?: string;
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
};

const TEXT_CLASSES: Record<ButtonVariant, string> = {
  primary: "text-sm font-medium text-primary-foreground",
  secondary: "text-sm font-medium text-secondary-foreground",
  outline: "text-sm font-medium text-foreground",
  ghost: "text-sm font-medium text-foreground",
  destructive: "text-sm font-medium text-destructive-foreground",
  "destructive-outline": "text-sm font-medium text-destructive",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "h-9 flex-row items-center justify-center gap-2 rounded-lg px-4",
  sm: "h-8 flex-row items-center justify-center gap-1.5 rounded-lg px-3",
  icon: "size-8 items-center justify-center rounded-lg",
  "icon-sm": "size-7 items-center justify-center rounded-md",
};

function resolveButtonClass(
  variant: ButtonVariant | undefined,
  size: ButtonSize | undefined,
  extra: string | undefined,
) {
  const v = variant ?? "outline";
  const s = size ?? "md";
  return `${SIZE_CLASSES[s]} ${VARIANT_CLASSES[v]} disabled:opacity-50 ${motion.pressScale} ${extra ?? ""}`;
}

/** Styled push button sharing the app's border, hover, focus, and press tokens. */
export function Button(props: ButtonProps) {
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={() => props.onPress?.()}
      class={resolveButtonClass(props.variant, props.size, props.class)}
      tooltip={props.tooltip ? buildTooltip(props.tooltip, "top") : undefined}
    >
      <If when={props.label !== undefined}>
        <Text class={TEXT_CLASSES[props.variant ?? "outline"]}>{props.label}</Text>
      </If>
      {props.children}
    </BaseButton>
  );
}
