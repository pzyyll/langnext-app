// ABOUTME: Reusable Base UI ScrollArea with theme-token scrollbar styling.
// ABOUTME: Vertical auto-hide scrollbar for flex-fill scroll regions.
import type { ComponentProps } from "react";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";

const viewportClassNameDefault =
	"h-full focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";

const scrollbarClassName =
	"pointer-events-none m-px flex w-2 justify-center bg-on-surface-variant/10 opacity-0 transition-opacity duration-150 data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-0";

const thumbClassName = "w-full bg-on-surface-variant hover:bg-outline";

export type ScrollAreaProps = ComponentProps<typeof BaseScrollArea.Root> & {
	viewportClassName?: string;
	contentClassName?: string;
};

export function ScrollArea({ className, viewportClassName, contentClassName, children, ...props }: ScrollAreaProps) {
	return (
		<BaseScrollArea.Root className={className} {...props}>
			<BaseScrollArea.Viewport
				className={viewportClassName ? `${viewportClassNameDefault} ${viewportClassName}` : viewportClassNameDefault}
			>
				<BaseScrollArea.Content className={contentClassName}>{children}</BaseScrollArea.Content>
			</BaseScrollArea.Viewport>
			<BaseScrollArea.Scrollbar className={scrollbarClassName}>
				<BaseScrollArea.Thumb className={thumbClassName} />
			</BaseScrollArea.Scrollbar>
		</BaseScrollArea.Root>
	);
}
