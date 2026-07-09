// ABOUTME: About route describing the project stack and structure.
// ABOUTME: Pure frontend page used to verify TanStack file-based routing.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
	component: AboutPage,
});

const stack = [
	{ name: "Tauri 2", detail: "Native shell, Rust backend, secure IPC" },
	{ name: "React 19", detail: "UI runtime with modern concurrent features" },
	{ name: "TanStack Router", detail: "Type-safe file-based client routing" },
	{ name: "Base UI", detail: "Accessible unstyled primitives" },
	{ name: "Tailwind CSS v4", detail: "Utility styling via Vite plugin" },
	{ name: "ESLint + Prettier", detail: "Linting and consistent formatting" },
];

function AboutPage() {
	return (
		<div className="space-y-6">
			<section className="space-y-2">
				<h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">About</h1>
				<p className="max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
					Starter desktop app scaffolded for local product work. Frontend lives in <code className="text-xs">src/</code>
					, native shell and Rust commands live in <code className="text-xs">src-tauri/</code>.
				</p>
			</section>

			<ul className="grid gap-3 sm:grid-cols-2">
				{stack.map((item) => (
					<li
						key={item.name}
						className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
					>
						<div className="text-sm font-semibold text-slate-900 dark:text-white">{item.name}</div>
						<p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.detail}</p>
					</li>
				))}
			</ul>
		</div>
	);
}
