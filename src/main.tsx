// ABOUTME: Frontend entry point that mounts the TanStack Router app tree.
// ABOUTME: Completes storage bootstrap and i18n init before mounting React.
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { getScrollTransitionType } from "./shell/nav";
import { initTheme } from "./theme/theme";
import { bootstrapStorage } from "./storage/bootstrap";
import { ToastProvider } from "./components/toast/ToastProvider";
import { queryClient } from "./query/client";
import { QueryEventSync } from "./query/QueryEventSync";
import { initLogger } from "./logger";
import "./styles.css";

// Immediate pre-paint cache application (index.html may already have set this).
initTheme();

const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	scrollRestoration: true,
	// Directional scroll transitions based on sidebar item order.
	defaultViewTransition: {
		types: ({ fromLocation, toLocation }) => {
			const type = getScrollTransitionType(fromLocation?.pathname, toLocation.pathname);
			return type ? [type] : false;
		},
	},
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

async function mount() {
	// Attach Rust log streaming before UI work so early setup logs appear in webview console.
	await initLogger();
	// Authoritative SQLite reconciliation in Tauri; cache-only in browser dev.
	// Also initializes i18n from AppSettings.uiLanguage / local cache.
	await bootstrapStorage();

	const rootElement = document.getElementById("root")!;

	if (!rootElement.innerHTML) {
		const root = ReactDOM.createRoot(rootElement);
		root.render(
			<React.StrictMode>
				<QueryClientProvider client={queryClient}>
					<QueryEventSync />
					<ToastProvider>
						<RouterProvider router={router} />
					</ToastProvider>
				</QueryClientProvider>
			</React.StrictMode>,
		);
	}
}

void mount();
