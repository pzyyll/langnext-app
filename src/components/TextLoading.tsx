// ABOUTME: Translation-style text block with trailing loading dots or stream scramble.
// ABOUTME: Waiting states keep dots; active stream output swaps dots for a rolling glyph tail.
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { StreamScrambleTail } from "./StreamScrambleTail";

export type TextLoadingProps = Omit<ComponentProps<"p">, "children"> & {
  /** Current output text; may grow while streaming or be the previous result while re-running. */
  text: string;
  /** When true, render a trailing loading indicator (dots or stream scramble). */
  isLoading: boolean;
  /**
   * Label used when loading with no text yet (e.g. "Translating…").
   * Trailing ellipsis characters are stripped so the animated dots act as the ellipsis.
   */
  loadingLabel: string;
  /**
   * Classes applied only in the empty-loading state (label + dots).
   * Defaults keep the existing neutral italic status look.
   */
  emptyLoadingClassName?: string;
  /**
   * When true with non-empty text, replace loading dots with a rolling scramble tail.
   * Intended for active stream output after the first chunk — not for retained prior text.
   */
  scramble?: boolean;
};

/** Drop trailing "…" / "..." so dots are not doubled after the label. */
function stripTrailingEllipsis(label: string): string {
  return label.replace(/(?:\u2026|\.{2,}|…)+$/u, "").trimEnd();
}

/**
 * Output text with a DaisyUI-style trailing loading-dots indicator, or a stream scramble tail.
 * Empty loading: label + dots. Waiting with prior text: prior text + dots.
 * Active stream output (`scramble`): full text as-is + rolling glyphs, no dots.
 * Idle empty: render nothing — callers handle placeholders.
 */
export function TextLoading({
  text,
  isLoading,
  loadingLabel,
  className,
  emptyLoadingClassName = "text-neutral italic select-none",
  scramble = false,
  role,
  ...props
}: TextLoadingProps) {
  const isEmptyLoading = isLoading && text.length === 0;
  const useScramble = Boolean(scramble && isLoading && text.length > 0);
  const showDots = isLoading && !useScramble;
  const displayText = text.length > 0 ? text : isLoading ? stripTrailingEllipsis(loadingLabel) : "";

  if (!displayText) {
    return null;
  }

  return (
    <p
      className={cn(
        // break-words: keep long unbroken tokens inside the pane (matches TextAutosize measure dummy).
        "min-w-0 wrap-break-word whitespace-pre-wrap",
        isEmptyLoading ? emptyLoadingClassName : "select-text",
        className,
      )}
      role={role ?? (isLoading ? "status" : undefined)}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {displayText}
      {showDots ? <span className="loading-dots" aria-hidden /> : null}
      <StreamScrambleTail active={useScramble} />
    </p>
  );
}
