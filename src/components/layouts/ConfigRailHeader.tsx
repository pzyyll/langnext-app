// ABOUTME: Shared list-rail header strip for Models, OCR, and Profiles sidebars.
// ABOUTME: Keeps title height, border, and uppercase label styling aligned.
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type ConfigRailHeaderProps = {
  children: ReactNode;
  className?: string;
};

/** Fixed-height rail title bar used above config list rails. */
export function ConfigRailHeader({ children, className }: ConfigRailHeaderProps) {
  return (
    <div
      className={cn("flex h-12 shrink-0 items-center border-b border-outline bg-surface-container-low px-1", className)}
    >
      <span className="min-w-0 flex-1 truncate pl-1 text-label-sm font-bold tracking-wide text-on-surface uppercase">
        {children}
      </span>
    </div>
  );
}
