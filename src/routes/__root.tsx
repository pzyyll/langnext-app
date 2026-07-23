// ABOUTME: Root layout: titlebar, collapsible left sidebar, and outlet.
// ABOUTME: Quick Translate uses a minimal shell; main content uses View Transitions.
import { useState, type ComponentType, type SVGProps } from "react";
import { Link, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightBook from "~icons/material-symbols-light/book";
import IconMaterialSymbolsLightDocumentScannerOutline from "~icons/material-symbols-light/document-scanner-outline";
import IconMaterialSymbolsLightHistory from "~icons/material-symbols-light/history";
import IconMaterialSymbolsLightNeurology from "~icons/material-symbols-light/neurology";
import IconMaterialSymbolsLightSettings from "~icons/material-symbols-light/settings";
import IconMaterialSymbolsLightTranslate from "~icons/material-symbols-light/translate";
import { iconButtonClassName } from "../components/ui";
import { TitleBar } from "../components/win/TitleBar";
import { cn } from "../lib/cn";
import { isNavItemActive, primaryNavItems, settingsNavItem, type NavIconId, type NavItem } from "../shell/nav";
import {
  getSidebarOpen as loadSidebarOpenPreference,
  setSidebarOpen as saveSidebarOpenPreference,
} from "../shell/sidebarPreference";

export const Route = createRootRoute({
  component: RootLayout,
});

const SIDEBAR_WIDTH_CLASS = "w-sidebar-width";
const SIDEBAR_COLLAPSED_WIDTH_CLASS = "w-sidebar-collapsed";

const navColorTransitionClassName = "transition-[background-color,color,transform] duration-100";

/** Idle nav row — text-on-surface-variant, hover surface-container-highest. Selected uses primary fill only. */
const navLinkClassName = cn(
  `
    flex w-full items-center gap-2 rounded-none bg-transparent px-gutter py-2 text-label-sm leading-none font-normal
    tracking-wide text-on-surface-variant uppercase select-none
    hover:bg-surface-container-highest hover:text-on-surface
    focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface
    active:scale-[0.98]
  `,
  navColorTransitionClassName,
);

/** Active nav row — solid primary fill + on-primary label (no left rail). */
const navLinkActiveClassName = cn(
  `
    flex w-full items-center gap-2 rounded-none bg-primary px-gutter py-2 text-label-sm leading-none font-normal
    tracking-wide text-on-primary uppercase select-none
    focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-primary
    active:scale-[0.98]
  `,
  navColorTransitionClassName,
);

/** Footer settings idle — denser label. */
const footerNavLinkClassName = cn(
  `
    flex w-full items-center gap-2 rounded-none bg-transparent px-gutter py-1.5 text-[11px] leading-none font-normal
    tracking-wide text-on-surface-variant uppercase select-none
    hover:text-primary
    focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface
    active:scale-[0.98]
  `,
  navColorTransitionClassName,
);

const footerNavLinkActiveClassName = cn(
  `
    flex w-full items-center gap-2 rounded-none bg-primary px-gutter py-1.5 text-[11px] leading-none font-normal
    tracking-wide text-on-primary uppercase select-none
    focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-primary
    active:scale-[0.98]
  `,
  navColorTransitionClassName,
);

/** Collapsed rail: reuse IconButton ghost styles on router Links. */
const navIconLinkClassName = cn(
  iconButtonClassName,
  `
    [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-150
    [&_svg]:group-hover/icon-btn:scale-110
  `,
);

const navIconLinkActiveClassName = cn(
  navIconLinkClassName,
  `
    bg-primary text-on-primary
    hover:bg-primary hover:text-on-primary
    active:bg-primary active:text-on-primary
  `,
);

const navIconById: Record<NavIconId, ComponentType<SVGProps<SVGSVGElement>>> = {
  translate: IconMaterialSymbolsLightTranslate,
  book: IconMaterialSymbolsLightBook,
  history: IconMaterialSymbolsLightHistory,
  neurology: IconMaterialSymbolsLightNeurology,
  document_scanner: IconMaterialSymbolsLightDocumentScannerOutline,
  settings: IconMaterialSymbolsLightSettings,
};

function isQuickTranslatePath(pathname: string): boolean {
  return pathname === "/quick-translate" || pathname.startsWith("/quick-translate/");
}

function isScreenshotOverlayPath(pathname: string): boolean {
  return pathname === "/screenshot-overlay" || pathname.startsWith("/screenshot-overlay/");
}

function isSecondaryWindowPath(pathname: string): boolean {
  return isQuickTranslatePath(pathname) || isScreenshotOverlayPath(pathname);
}

function NavLinkLabel({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useTranslation();
  const Icon = navIconById[item.icon];
  return (
    <>
      <Icon className={cn("pointer-events-none shrink-0", collapsed ? "size-4" : "size-5")} aria-hidden />
      {collapsed ? null : <span className="min-w-0 truncate">{t(item.labelKey)}</span>}
    </>
  );
}

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSidebarOpenPreference());
  const { t } = useTranslation();
  const sidebarCollapsed = !sidebarOpen;

  // Secondary windows (Quick Translate, screenshot overlay): no main sidebar chrome.
  // Do not mount router devtools here — FloatingTanStackRouterDevtools injects
  // padding-bottom (~500px) on its parent, which leaves a large empty band in this
  // content-sized popup and fights the height-resize observer.
  if (isSecondaryWindowPath(pathname)) {
    return (
      <div
        className={`
          root flex h-full min-h-0 flex-col text-on-background
          ${isScreenshotOverlayPath(pathname) ? `bg-transparent` : `bg-background`}
        `}
      >
        <Outlet />
      </div>
    );
  }

  return (
    <div className="root flex h-full min-h-0 flex-col bg-background text-on-background">
      <TitleBar
        minimize
        maximized
        close
        sidebarOpen={sidebarOpen}
        onSidebarToggle={() => {
          setSidebarOpen((open) => {
            const next = !open;
            saveSidebarOpenPreference(next);
            return next;
          });
        }}
      />

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            `
              flex shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container transition-[width]
              duration-200 ease-out
            `,
            sidebarOpen ? SIDEBAR_WIDTH_CLASS : SIDEBAR_COLLAPSED_WIDTH_CLASS,
          )}
        >
          <nav
            className={cn(
              "flex flex-1 flex-col",
              sidebarCollapsed ? "items-center gap-1 p-1.5" : "min-w-sidebar-width gap-0.5",
            )}
            aria-label={t("nav.mainAria")}
          >
            {primaryNavItems.map((item) => {
              const active = isNavItemActive(item, pathname);
              const label = t(item.labelKey);
              return (
                <Link
                  draggable={false}
                  key={item.to}
                  to={item.to}
                  // Do not set viewTransition={true} here — it overrides
                  // defaultViewTransition.types (scroll-up / scroll-down).
                  title={sidebarCollapsed ? label : undefined}
                  aria-label={sidebarCollapsed ? label : undefined}
                  className={
                    sidebarCollapsed
                      ? active
                        ? navIconLinkActiveClassName
                        : navIconLinkClassName
                      : active
                        ? navLinkActiveClassName
                        : navLinkClassName
                  }
                  activeOptions={{ exact: item.exact }}
                  onClick={(event) => {
                    // Already on this page: skip navigation and view transition.
                    if (active) {
                      event.preventDefault();
                    }
                  }}
                >
                  <NavLinkLabel item={item} collapsed={sidebarCollapsed} />
                </Link>
              );
            })}
          </nav>

          <div
            className={cn(
              "border-t border-outline/20",
              sidebarCollapsed ? "flex justify-center p-1.5" : "min-w-sidebar-width",
            )}
          >
            <Link
              draggable={false}
              to={settingsNavItem.to}
              title={sidebarCollapsed ? t(settingsNavItem.labelKey) : undefined}
              aria-label={sidebarCollapsed ? t(settingsNavItem.labelKey) : undefined}
              className={
                sidebarCollapsed
                  ? isNavItemActive(settingsNavItem, pathname)
                    ? navIconLinkActiveClassName
                    : navIconLinkClassName
                  : isNavItemActive(settingsNavItem, pathname)
                    ? footerNavLinkActiveClassName
                    : footerNavLinkClassName
              }
              activeOptions={{ exact: settingsNavItem.exact }}
              onClick={(event) => {
                if (isNavItemActive(settingsNavItem, pathname)) {
                  event.preventDefault();
                }
              }}
            >
              <NavLinkLabel item={settingsNavItem} collapsed={sidebarCollapsed} />
            </Link>
          </div>
        </aside>

        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
          {/* Named VT snapshot: only this region scrolls between routes */}
          <div className="page-transition h-full min-h-0">
            <Outlet />
          </div>
        </main>
      </div>

      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </div>
  );
}
