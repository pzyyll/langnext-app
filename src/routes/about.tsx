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
	{ name: "Tailwind CSS v4", detail: "Utility styling in Base UI outline style" },
	{ name: "ESLint + Prettier", detail: "Linting and consistent formatting" },
];

function AboutPage() {
	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h1 className="text-2xl leading-8 font-bold text-neutral-950 dark:text-white">About</h1>
				<p className="max-w-2xl text-sm leading-6 text-neutral-600 dark:text-neutral-400">
					Starter desktop app scaffolded for local product work. Frontend lives in{" "}
					<code className="border border-neutral-950 bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:border-white dark:bg-neutral-800">
						src/
					</code>
					, native shell and Rust commands live in{" "}
					<code className="border border-neutral-950 bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:border-white dark:bg-neutral-800">
						src-tauri/
					</code>
					.
				</p>
			</section>

			<ul className="grid gap-3 sm:grid-cols-2">
				{stack.map((item) => (
					<li
						key={item.name}
						className="border border-neutral-950 bg-white p-4 shadow-[0.25rem_0.25rem_0] shadow-black/12 dark:border-white dark:bg-neutral-950 dark:shadow-none"
					>
						<div className="text-sm leading-5 font-bold text-neutral-950 dark:text-white">{item.name}</div>
						<p className="mt-1 text-sm leading-5 text-neutral-600 dark:text-neutral-400">{item.detail}</p>
					</li>
				))}
			</ul>
		</div>
	);
}
