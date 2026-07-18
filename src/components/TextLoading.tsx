// ABOUTME: Translation-style text block with an optional trailing loading-dots indicator.
// ABOUTME: Empty+loading shows a label; partial/stream text keeps content with inline dots at the end.
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export type TextLoadingProps = Omit<ComponentProps<"p">, "children"> & {
	/** Current output text; may grow while streaming or be the previous result while re-running. */
	text: string;
	/** When true, render bouncing dots inline after the displayed content. */
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
};

/** Drop trailing "…" / "..." so dots are not doubled after the label. */
function stripTrailingEllipsis(label: string): string {
	return label.replace(/(?:\u2026|\.{2,}|…)+$/u, "").trimEnd();
}

/**
 * Output text with a DaisyUI-style trailing loading-dots indicator.
 * Dots sit inline after the last character: "Translating" + dots, or "这" + dots while streaming.
 * Renders nothing when idle with empty text — callers handle placeholders.
 */
export function TextLoading({
	text,
	isLoading,
	loadingLabel,
	className,
	emptyLoadingClassName = "text-neutral italic select-none",
	role,
	...props
}: TextLoadingProps) {
	const isEmptyLoading = isLoading && text.length === 0;
	const displayText = text.length > 0 ? text : isLoading ? stripTrailingEllipsis(loadingLabel) : "";

	if (!displayText) {
		return null;
	}

	return (
		<p
			className={cn("whitespace-pre-wrap", isEmptyLoading ? emptyLoadingClassName : "select-text", className)}
			role={role ?? (isLoading ? "status" : undefined)}
			aria-busy={isLoading || undefined}
			{...props}
		>
			{displayText}
			{isLoading ? <span className="loading-dots" aria-hidden /> : null}
		</p>
	);
}
