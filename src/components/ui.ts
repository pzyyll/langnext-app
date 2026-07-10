// ABOUTME: Shared semantic class-name constants for outline controls and dialogs.
// ABOUTME: Keeps Base UI frame styling consistent without wrapping its primitives.

/** Outline button using semantic theme colors */
export const outlineButtonClassName =
	"inline-flex h-8 items-center justify-center gap-2 rounded-none border border-line bg-surface px-3 text-sm leading-none whitespace-nowrap font-normal text-ink select-none hover:not-data-disabled:bg-surface-2 active:not-data-disabled:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink data-disabled:border-disabled data-disabled:text-disabled disabled:border-disabled disabled:text-disabled";

/** Primary solid button (Save) */
export const primaryButtonClassName =
	"inline-flex h-8 items-center justify-center gap-2 rounded-none border border-line bg-ink px-4 text-sm leading-none whitespace-nowrap font-bold text-surface select-none hover:not-data-disabled:opacity-90 active:not-data-disabled:opacity-80 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink data-disabled:border-disabled data-disabled:bg-surface-3 data-disabled:text-disabled disabled:border-disabled disabled:bg-surface-3 disabled:text-disabled";

/** Danger solid button (destructive confirm) */
export const dangerButtonClassName =
	"inline-flex h-8 items-center justify-center gap-2 rounded-none border border-danger bg-danger px-4 text-sm leading-none whitespace-nowrap font-bold text-danger-ink select-none hover:not-data-disabled:opacity-90 active:not-data-disabled:opacity-80 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink data-disabled:border-disabled data-disabled:bg-surface-3 data-disabled:text-disabled disabled:border-disabled disabled:bg-surface-3 disabled:text-disabled";

/** Text / password inputs */
export const inputClassName =
	"h-8 w-full rounded-none border border-line bg-surface px-3 text-sm font-normal text-ink placeholder:text-muted focus:outline-2 focus:-outline-offset-1 focus:outline-ink disabled:border-disabled disabled:text-disabled";

/** Native select controls */
export const selectClassName =
	"h-8 w-full rounded-none border border-line bg-surface px-3 text-sm font-normal text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-ink disabled:border-disabled disabled:text-disabled";

/** Native checkboxes */
export const checkboxClassName =
	"size-4 shrink-0 rounded-none border border-line bg-surface text-ink accent-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink disabled:border-disabled disabled:opacity-50";

/** Dialog backdrop overlay */
export const dialogBackdropClassName =
	"fixed inset-0 min-h-dvh bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute";

/** Dialog popup panel */
export const dialogPopupClassName =
	"shadow-frame fixed top-1/2 left-1/2 -mt-8 flex w-96 max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 border border-line bg-surface p-4 text-ink transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";
