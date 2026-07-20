// ABOUTME: Shared full-height page shell with titlebar-offset height and header bar.
// ABOUTME: Used by History, Models, and Profiles for consistent page chrome.
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Viewport minus titlebar only — main shell is edge-to-edge (no outer gutter). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-var(--spacing-titlebar-height))]";

type PageLayoutProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Optional right-side header controls (e.g. destructive page action). */
  actions?: ReactNode;
  /** Extra classes for the body under the header (base: flex min-h-0 flex-1). */
  contentClassName?: string;
  children: ReactNode;
};

/**
 * Full-viewport page chrome: fixed header strip with bottom border, body below.
 * Body classes are page-specific (scrollable form vs split rail/editor).
 */
export function PageLayout({ title, description, actions, contentClassName, children }: PageLayoutProps) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden bg-background ${LAYOUT_HEIGHT_CLASS}`}>
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-2">
        <div className="min-w-0">
          <h1 className="text-headline-sm font-bold tracking-tight text-on-surface uppercase">{title}</h1>
          {description != null ? <p className="text-label-sm text-neutral uppercase">{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className={cn("flex min-h-0 flex-1", contentClassName)}>{children}</div>
    </div>
  );
}
