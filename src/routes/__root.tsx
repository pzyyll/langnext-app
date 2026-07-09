// ABOUTME: Root layout route for TanStack Router with nav and outlet.
// ABOUTME: Hosts app chrome and optional router devtools in development.
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

export const Route = createRootRoute({
	component: RootLayout,
});

const navLinkClassName =
	"inline-flex h-8 items-center justify-center border border-transparent px-3 text-sm leading-none font-normal text-neutral-600 select-none hover:bg-neutral-100 hover:text-neutral-950 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white dark:focus-visible:outline-white";

const navLinkActiveClassName =
	"inline-flex h-8 items-center justify-center border border-neutral-950 bg-white px-3 text-sm leading-none font-normal text-neutral-950 shadow-[0.25rem_0.25rem_0] shadow-black/12 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-neutral-950 dark:border-white dark:bg-neutral-950 dark:text-white dark:shadow-none dark:focus-visible:outline-white";

function RootLayout() {
	return (
		<div className="root flex min-h-full flex-col">
			<header className="border-b border-neutral-950 bg-white dark:border-white dark:bg-neutral-950">
				<div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
					<div className="text-sm leading-5 font-bold text-neutral-950 dark:text-white">langnext-app</div>
					<nav className="flex items-center gap-1">
						<Link
							to="/"
							className={navLinkClassName}
							activeProps={{ className: navLinkActiveClassName }}
							activeOptions={{ exact: true }}
						>
							Home
						</Link>
						<Link to="/about" className={navLinkClassName} activeProps={{ className: navLinkActiveClassName }}>
							About
						</Link>
					</nav>
				</div>
			</header>

			<main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
				<Outlet />
			</main>

			{import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
		</div>
	);
}
