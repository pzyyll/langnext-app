// ABOUTME: Shared semantic class-name constants for outline controls and dialogs.
// ABOUTME: Keeps Base UI frame styling consistent without wrapping its primitives.

/** Outline button using semantic theme colors */
export const outlineButtonClassName =
	"inline-flex h-control-height items-center justify-center gap-2 rounded-none border border-line bg-surface px-3 text-body-tight leading-none whitespace-nowrap font-normal text-on-surface select-none hover:not-data-disabled:bg-surface-2 active:not-data-disabled:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:border-disabled data-disabled:text-disabled disabled:border-disabled disabled:text-disabled";

/** Primary solid button (Save) */
export const primaryButtonClassName =
	"inline-flex h-control-height items-center justify-center gap-2 rounded-none border border-line bg-on-surface px-4 text-body-tight leading-none whitespace-nowrap font-bold text-surface select-none hover:not-data-disabled:opacity-90 active:not-data-disabled:opacity-80 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:border-disabled data-disabled:bg-surface-3 data-disabled:text-disabled disabled:border-disabled disabled:bg-surface-3 disabled:text-disabled";

/** Danger solid button (destructive confirm) */
export const dangerButtonClassName =
	"inline-flex h-control-height items-center justify-center gap-2 rounded-none border border-error bg-error px-4 text-body-tight leading-none whitespace-nowrap font-bold text-on-error select-none hover:not-data-disabled:opacity-90 active:not-data-disabled:opacity-80 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:border-disabled data-disabled:bg-surface-3 data-disabled:text-disabled disabled:border-disabled disabled:bg-surface-3 disabled:text-disabled";

/** Ghost icon button for inline actions such as renaming */
export const iconButtonClassName =
	"inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-none border-0 bg-transparent text-neutral hover:bg-surface-2 hover:text-on-surface active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:text-disabled disabled:text-disabled";

/** Base UI Input (text / password / search / number) */
export const inputClassName =
	"h-control-height w-full rounded-none border border-line bg-surface px-3 text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

/** Base UI Checkbox.Root (outline/frame style, square) */
export const checkboxClassName =
	"flex size-4 shrink-0 items-center justify-center rounded-none border border-line bg-surface p-0 text-on-surface data-checked:border-on-surface data-checked:bg-on-surface data-checked:text-surface data-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-on-surface";

/** Base UI Checkbox.Indicator */
export const checkboxIndicatorClassName = "flex items-center justify-center data-unchecked:hidden";

/** Base UI Radio.Root (outline/frame style, square) */
export const radioClassName =
	"flex size-4 shrink-0 items-center justify-center rounded-none border border-line bg-surface p-0 text-on-surface data-checked:border-on-surface data-checked:bg-on-surface data-checked:text-surface data-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-on-surface";

/** Base UI Radio.Indicator (filled square when checked) */
export const radioIndicatorClassName =
	"flex items-center justify-center data-unchecked:hidden before:block before:size-2 before:bg-current";

/** Base UI Switch track (outline/frame style, square) */
export const switchRootClassName =
	"relative block h-5 w-9 shrink-0 cursor-default rounded-none border border-line bg-surface transition-[background-color,border-color] duration-150 data-checked:border-tertiary data-checked:bg-tertiary data-disabled:opacity-50 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";

/** Base UI Switch thumb (sliding knob) */
export const switchThumbClassName =
	"absolute top-1/2 left-0.5 size-3.5 -translate-y-1/2 rounded-none bg-on-surface transition-[left,background-color] duration-150 data-checked:left-5 data-checked:bg-surface";

/** Dialog backdrop overlay */
export const dialogBackdropClassName =
	"fixed inset-0 min-h-dvh bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute";

/** Dialog popup panel */
export const dialogPopupClassName =
	"shadow-frame fixed top-1/2 left-1/2 -mt-8 flex w-96 max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 border border-line bg-surface p-gutter text-on-surface transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";
