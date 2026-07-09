// ABOUTME: Root layout route for TanStack Router with nav and outlet.
// ABOUTME: Hosts app chrome and optional router devtools in development.
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="root flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <div className="text-sm font-semibold tracking-tight">tauri-app</div>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/"
              className="rounded-md px-3 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
              activeProps={{
                className:
                  "rounded-md px-3 py-1.5 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900",
              }}
              activeOptions={{ exact: true }}
            >
              Home
            </Link>
            <Link
              to="/about"
              className="rounded-md px-3 py-1.5 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
              activeProps={{
                className:
                  "rounded-md px-3 py-1.5 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900",
              }}
            >
              About
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      {import.meta.env.DEV ? (
        <TanStackRouterDevtools position="bottom-right" />
      ) : null}
    </div>
  );
}
