import { Text, View } from "nsh";
import { buildTooltip } from "./tooltip";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "destructive";

interface BadgeProps {
  testID?: string;
  label: string;
  tone?: BadgeTone;
  /** Lets a long label shrink and ellipsize inside a bounded flex row; give the full label as `tooltip`. */
  truncate?: boolean;
  tooltip?: string;
  class?: string;
}

const CONTAINER_CLASSES: Record<BadgeTone, string> = {
  neutral: "border border-border bg-secondary",
  primary: "border border-primary/30 bg-primary/10",
  success: "border border-success/40 bg-success/15",
  warning: "border border-warning/40 bg-warning/15",
  destructive: "border border-destructive/40 bg-destructive/15",
};

const TEXT_CLASSES: Record<BadgeTone, string> = {
  neutral: "text-xs font-medium text-secondary-foreground",
  primary: "text-xs font-medium text-foreground",
  success: "text-xs font-medium text-success",
  warning: "text-xs font-medium text-warning",
  destructive: "text-xs font-medium text-destructive",
};

/** Compact status pill. */
export function Badge(props: BadgeProps) {
  return (
    <View
      testID={props.testID}
      tooltip={props.tooltip ? buildTooltip(props.tooltip, "top") : undefined}
      class={`${props.truncate ? "min-w-0 shrink" : "shrink-0"} rounded-md px-1.5 py-0.5 ${CONTAINER_CLASSES[props.tone ?? "neutral"]} ${props.class ?? ""}`}
    >
      <Text class={`${TEXT_CLASSES[props.tone ?? "neutral"]} ${props.truncate ? "truncate" : ""}`}>
        {props.label}
      </Text>
    </View>
  );
}
