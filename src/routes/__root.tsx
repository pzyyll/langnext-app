// ABOUTME: Root layout: titlebar, collapsible left sidebar, and outlet.
// ABOUTME: Main content uses View Transitions; same-route clicks are ignored.
import { useState } from "react";
import { Link, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useTranslation } from "react-i18next";
import { TitleBar } from "../components/Win/TitleBar";
import { isNavItemActive, primaryNavItems, settingsNavItem } from "../shell/nav";

export const Route = createRootRoute({
	component: RootLayout,
});

const SIDEBAR_WIDTH_CLASS = "w-sidebar-width";

const navLinkClassName =
	"flex h-10 w-full items-center rounded-none bg-transparent px-2 text-body-tight leading-none font-normal uppercase tracking-wide text-neutral transition-colors duration-150 select-none hover:bg-surface-2 hover:text-on-surface focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";

const navLinkActiveClassName =
	"flex h-10 w-full items-center rounded-none border border-line bg-surface-2 px-2 text-body-tight leading-none font-normal uppercase tracking-wide text-on-surface transition-colors duration-150 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface";

function RootLayout() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const { t } = useTranslation();

	return (
		<div className="root flex h-full min-h-0 flex-col bg-surface text-on-surface">
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
					className={`flex shrink-0 flex-col overflow-hidden border-line bg-surface transition-[width,border-color] duration-200 ease-out ${
						sidebarOpen ? `${SIDEBAR_WIDTH_CLASS} border-r` : "w-0 border-r-0"
					}`}
				>
					<nav className="flex min-w-sidebar-width flex-1 flex-col gap-1 p-3" aria-label={t("nav.mainAria")}>
						{primaryNavItems.map((item) => (
							<Link
								draggable={false}
								key={item.to}
								to={item.to}
								// Do not set viewTransition={true} here — it overrides
								// defaultViewTransition.types (scroll-up / scroll-down).
								tabIndex={sidebarOpen ? undefined : -1}
								className={navLinkClassName}
								activeProps={{ className: navLinkActiveClassName }}
								activeOptions={{ exact: item.exact }}
								onClick={(event) => {
									// Already on this page: skip navigation and view transition.
									if (isNavItemActive(item, pathname)) {
										event.preventDefault();
									}
								}}
							>
								{t(item.labelKey)}
							</Link>
						))}
					</nav>

					<div className="min-w-sidebar-width border-t border-line p-2">
						<Link
							draggable={false}
							to={settingsNavItem.to}
							tabIndex={sidebarOpen ? undefined : -1}
							className={navLinkClassName}
							activeProps={{ className: navLinkActiveClassName }}
							activeOptions={{ exact: settingsNavItem.exact }}
							onClick={(event) => {
								if (isNavItemActive(settingsNavItem, pathname)) {
									event.preventDefault();
								}
							}}
						>
							{t(settingsNavItem.labelKey)}
						</Link>
					</div>
				</aside>

				<main className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface p-gutter">
					{/* Named VT snapshot: only this region scrolls between routes */}
					<div className="page-transition">
						<Outlet />
					</div>
				</main>
			</div>

			{import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
		</div>
	);
}
