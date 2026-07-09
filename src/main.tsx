// ABOUTME: Frontend entry point that mounts the TanStack Router app tree.
// ABOUTME: Applies theme tokens, then registers the type-safe route tree.
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { initTheme } from "./theme/theme";
import "./styles.css";

initTheme();

const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	scrollRestoration: true,
	// Sidebar / programmatic navigations use View Transitions when supported.
	defaultViewTransition: true,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("root")!;

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<React.StrictMode>
			<RouterProvider router={router} />
		</React.StrictMode>,
	);
}
