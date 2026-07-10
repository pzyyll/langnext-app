// ABOUTME: Frontend entry point that mounts the TanStack Router app tree.
// ABOUTME: Completes storage bootstrap before mounting React in Tauri.
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { getScrollTransitionType } from "./shell/nav";
import { initTheme } from "./theme/theme";
import { bootstrapStorage } from "./storage/bootstrap";
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
	// Authoritative SQLite reconciliation in Tauri; cache-only in browser dev.
	await bootstrapStorage();

	const rootElement = document.getElementById("root")!;

	if (!rootElement.innerHTML) {
		const root = ReactDOM.createRoot(rootElement);
		root.render(
			<React.StrictMode>
				<RouterProvider router={router} />
			</React.StrictMode>,
		);
	}
}

void mount();
