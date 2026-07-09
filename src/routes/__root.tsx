// ABOUTME: Root layout: titlebar, left sidebar nav, theme toggle, and outlet.
// ABOUTME: Main content uses View Transitions; same-route clicks are ignored.
import { Link, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { TitleBar } from "../components/Win/TitleBar";
import { ThemeToggle } from "../components/ThemeToggle";

export const Route = createRootRoute({
	component: RootLayout,
});

const navItems = [
	{ to: "/", label: "Home", exact: true },
	{ to: "/about", label: "About", exact: false },
] as const;

type NavItem = (typeof navItems)[number];

const navLinkClassName =
	"flex h-10 w-full items-center rounded-none bg-transparent px-3 text-sm leading-none font-normal text-muted transition-colors duration-150 select-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink";

const navLinkActiveClassName =
	"flex h-10 w-full items-center rounded-none border border-line bg-surface-2 px-3 text-sm leading-none font-normal text-ink transition-colors duration-150 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink";

function isNavItemActive(item: NavItem, pathname: string): boolean {
	if (item.exact) {
		return pathname === item.to;
	}
	return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function RootLayout() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	return (
		<div className="root flex h-full min-h-0 flex-col bg-surface text-ink">
			<TitleBar minimize maximized close />

			<div className="flex min-h-0 flex-1">
				<aside className="flex w-44 shrink-0 flex-col border-r border-line bg-surface">
					<nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main">
						{navItems.map((item) => (
							<Link
								key={item.to}
								to={item.to}
								viewTransition
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
								{item.label}
							</Link>
						))}
					</nav>

					<div className="border-t border-line p-2">
						<ThemeToggle />
					</div>
				</aside>

				<main className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface p-4">
					{/* Named VT snapshot: only this region fades between routes */}
					<div className="page-transition">
						<Outlet />
					</div>
				</main>
			</div>

			{import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
		</div>
	);
}
