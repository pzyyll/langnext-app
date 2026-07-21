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
import { TitleBar } from "../components/win/TitleBar";
import { isNavItemActive, primaryNavItems, settingsNavItem, type NavIconId, type NavItem } from "../shell/nav";

export const Route = createRootRoute({
  component: RootLayout,
});

const SIDEBAR_WIDTH_CLASS = "w-sidebar-width";

/** Idle nav row — design: text-on-surface-variant, hover surface-container-highest. */
const navLinkClassName =
  "flex w-full items-center gap-2 rounded-none border-l-4 border-transparent bg-transparent px-gutter py-2 text-label-sm leading-none font-normal tracking-wide text-on-surface-variant uppercase transition-colors duration-100 select-none hover:bg-surface-container-highest hover:text-on-surface focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface active:scale-[0.98]";

/** Active nav row — design: solid primary (black) fill + on-primary label. */
const navLinkActiveClassName =
  "flex w-full items-center gap-2 rounded-none border-l-4 border-primary bg-primary px-gutter py-2 text-label-sm leading-none font-normal tracking-wide text-on-primary uppercase transition-colors duration-100 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-primary active:scale-[0.98]";

/** Footer settings idle — denser label, no full-height bar until selected. */
const footerNavLinkClassName =
  "flex w-full items-center gap-2 rounded-none border-l-4 border-transparent bg-transparent px-gutter py-1.5 text-[11px] leading-none font-normal tracking-wide text-on-surface-variant uppercase transition-colors duration-100 select-none hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface active:scale-[0.98]";

const footerNavLinkActiveClassName =
  "flex w-full items-center gap-2 rounded-none border-l-4 border-primary bg-primary px-gutter py-1.5 text-[11px] leading-none font-normal tracking-wide text-on-primary uppercase transition-colors duration-100 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-primary active:scale-[0.98]";

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

function NavLinkLabel({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  const Icon = navIconById[item.icon];
  return (
    <>
      <Icon className="pointer-events-none size-5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{t(item.labelKey)}</span>
    </>
  );
}

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { t } = useTranslation();

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
          setSidebarOpen((open) => !open);
        }}
      />

      <div className="flex min-h-0 flex-1">
        <aside
          aria-hidden={!sidebarOpen}
          className={`
            flex shrink-0 flex-col overflow-hidden border-outline bg-surface-container transition-[width,border-color]
            duration-200 ease-out
            ${
              sidebarOpen
                ? `
                  ${SIDEBAR_WIDTH_CLASS}
                  border-r
                `
                : "w-0 border-r-0"
            }
          `}
        >
          <nav className="flex min-w-sidebar-width flex-1 flex-col gap-0.5" aria-label={t("nav.mainAria")}>
            {primaryNavItems.map((item) => {
              const active = isNavItemActive(item, pathname);
              return (
                <Link
                  draggable={false}
                  key={item.to}
                  to={item.to}
                  // Do not set viewTransition={true} here — it overrides
                  // defaultViewTransition.types (scroll-up / scroll-down).
                  tabIndex={sidebarOpen ? undefined : -1}
                  className={active ? navLinkActiveClassName : navLinkClassName}
                  activeOptions={{ exact: item.exact }}
                  onClick={(event) => {
                    // Already on this page: skip navigation and view transition.
                    if (active) {
                      event.preventDefault();
                    }
                  }}
                >
                  <NavLinkLabel item={item} />
                </Link>
              );
            })}
          </nav>

          <div className="min-w-sidebar-width border-t border-outline/20">
            <Link
              draggable={false}
              to={settingsNavItem.to}
              tabIndex={sidebarOpen ? undefined : -1}
              className={
                isNavItemActive(settingsNavItem, pathname) ? footerNavLinkActiveClassName : footerNavLinkClassName
              }
              activeOptions={{ exact: settingsNavItem.exact }}
              onClick={(event) => {
                if (isNavItemActive(settingsNavItem, pathname)) {
                  event.preventDefault();
                }
              }}
            >
              <NavLinkLabel item={settingsNavItem} />
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
