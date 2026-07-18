// ABOUTME: Reusable Base UI ScrollArea with theme-token scrollbar styling.
// ABOUTME: Vertical auto-hide scrollbar for flex-fill scroll regions.
import type { ComponentProps } from "react";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { cn } from "../lib/cn";

const viewportClassNameDefault =
	"h-full min-h-0 overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";

/** Shared track styles; visibility modifiers are composed via props. */
const scrollbarBaseClassName =
	"pointer-events-none m-px flex w-2 justify-center bg-on-surface-variant/10 opacity-0 transition-opacity duration-150 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-0";

/** Show the track while the pointer is over the scroll area (default auto-hide). */
const scrollbarHoverClassName = "data-hovering:pointer-events-auto data-hovering:opacity-100";

/** Force-hide even when Base UI sets data-scrolling / data-hovering. */
const scrollbarForcedHiddenClassName = "pointer-events-none! opacity-0!";

const thumbClassName = "w-full bg-on-surface-variant hover:bg-outline";

export type ScrollAreaProps = ComponentProps<typeof BaseScrollArea.Root> & {
	viewportClassName?: string;
	contentClassName?: string;
	/**
	 * Force-hide the custom scrollbar without disabling overflow scrolling.
	 * Useful while content-driven layout is settling (avoids brief flash).
	 */
	hideScrollbar?: boolean;
	/**
	 * When true (default), also show the scrollbar while hovering the area.
	 * Set false to show only while scrolling — better for content-driven window height.
	 */
	showScrollbarOnHover?: boolean;
};

export function ScrollArea({
	className,
	viewportClassName,
	contentClassName,
	hideScrollbar = false,
	showScrollbarOnHover = true,
	children,
	...props
}: ScrollAreaProps) {
	return (
		<BaseScrollArea.Root className={className} {...props}>
			<BaseScrollArea.Viewport className={cn(viewportClassNameDefault, viewportClassName)}>
				<BaseScrollArea.Content className={contentClassName}>{children}</BaseScrollArea.Content>
			</BaseScrollArea.Viewport>
			<BaseScrollArea.Scrollbar
				className={cn(
					scrollbarBaseClassName,
					showScrollbarOnHover && !hideScrollbar && scrollbarHoverClassName,
					hideScrollbar && scrollbarForcedHiddenClassName,
				)}
			>
				<BaseScrollArea.Thumb className={thumbClassName} />
			</BaseScrollArea.Scrollbar>
		</BaseScrollArea.Root>
	);
}
