import { Text, View } from "nsh";
import { buildTooltip } from "./tooltip";

export type BadgeTone = "neutral" | "muted" | "primary" | "success" | "warning" | "destructive";

interface BadgeProps {
  testID?: string;
  label: string;
  tone?: BadgeTone;
  dot?: boolean;
  pill?: boolean;
  /** Lets a long label shrink and ellipsize inside a bounded flex row; give the full label as `tooltip`. */
  truncate?: boolean;
  tooltip?: string;
  class?: string;
}

const CONTAINER_CLASSES: Record<BadgeTone, string> = {
  neutral: "border border-border bg-secondary",
  muted: "border border-transparent bg-muted",
  primary: "border border-primary/30 bg-primary/10",
  success: "border border-success/40 bg-success/15",
  warning: "border border-warning/40 bg-warning/15",
  destructive: "border border-destructive/40 bg-destructive/15",
};

const TEXT_CLASSES: Record<BadgeTone, string> = {
  neutral: "text-xs font-medium text-secondary-foreground",
  muted: "text-xs font-medium text-muted-foreground",
  primary: "text-xs font-medium text-foreground",
  success: "text-xs font-medium text-success",
  warning: "text-xs font-medium text-warning",
  destructive: "text-xs font-medium text-destructive",
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-muted-foreground",
  muted: "bg-muted-foreground",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/** Compact status pill. */
export function Badge(props: BadgeProps) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View
      testID={props.testID}
      tooltip={props.tooltip ? buildTooltip(props.tooltip, "top") : undefined}
      class={`${props.truncate ? "min-w-0 shrink" : "shrink-0"} flex-row items-center gap-1.5 ${props.pill ? "rounded-full px-2" : "rounded-md px-1.5"} py-0.5 ${CONTAINER_CLASSES[tone()]} ${props.class ?? ""}`}
    >
      <If when={props.dot}>
        <View class={`size-1.5 shrink-0 rounded-full ${DOT_CLASSES[tone()]}`} />
      </If>
      <Text class={`${TEXT_CLASSES[tone()]} ${props.truncate ? "truncate" : ""}`}>
        {props.label}
      </Text>
    </View>
  );
}
