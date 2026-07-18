// ABOUTME: Small non-interactive status chip for compact status labels.
// ABOUTME: Uses outline/frame tokens; extend via className or tone without new deps.
import type { ComponentProps } from "react";

const baseClassName =
  "inline-flex shrink-0 items-center justify-center rounded-none border border-line bg-surface-2 px-1.5 py-0.5 text-label-sm leading-none text-on-surface select-none";

const toneClassName = {
  default: "",
  accent: "border-tertiary bg-tertiary text-on-tertiary",
} as const;

export type BadgeTone = keyof typeof toneClassName;

export type BadgeProps = ComponentProps<"span"> & {
  /** Visual emphasis; default is outline surface chip. */
  tone?: BadgeTone;
};

/** Pure display badge — use span semantics, not buttons or links. */
export function Badge({ className, tone = "default", children, ...props }: BadgeProps) {
  const toneClasses = toneClassName[tone];
  const merged = [baseClassName, toneClasses, className].filter(Boolean).join(" ");

  return (
    <span className={merged} {...props}>
      {children}
    </span>
  );
}
