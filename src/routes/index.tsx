// ABOUTME: Home route demonstrating Tauri invoke plus Base UI controls.
// ABOUTME: Greets from Rust and opens a Base UI dialog with the response.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";

export const Route = createFileRoute("/")({
	component: HomePage,
});

/** Base UI official demo outline button style */
const buttonClassName =
	"inline-flex h-8 items-center justify-center gap-2 rounded-none border border-neutral-950 bg-white px-3 text-sm leading-none whitespace-nowrap font-normal text-neutral-950 select-none hover:not-data-disabled:bg-neutral-100 active:not-data-disabled:bg-neutral-200 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-neutral-950 data-disabled:border-neutral-500 data-disabled:text-neutral-500 disabled:border-neutral-500 disabled:text-neutral-500 dark:border-white dark:bg-neutral-950 dark:text-white dark:hover:not-data-disabled:bg-neutral-800 dark:active:not-data-disabled:bg-neutral-700 dark:data-disabled:border-neutral-400 dark:data-disabled:text-neutral-400 dark:focus-visible:outline-white";

function HomePage() {
	const [name, setName] = useState("");
	const [greetMsg, setGreetMsg] = useState("");
	const [loading, setLoading] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);

	async function greet() {
		if (!name.trim()) {
			return;
		}

		setLoading(true);
		try {
			const message = await invoke<string>("greet", { name: name.trim() });
			setGreetMsg(message);
			setDialogOpen(true);
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="flex flex-col gap-8">
			<section className="flex flex-col gap-3">
				<p className="text-xs leading-4 font-normal tracking-[0.12em] text-neutral-600 uppercase dark:text-neutral-400">
					Tauri 2 + React 19
				</p>
				<h1 className="text-2xl leading-8 font-bold text-neutral-950 dark:text-white">
					Desktop shell, modern web stack
				</h1>
				<p className="max-w-2xl text-sm leading-6 text-neutral-600 dark:text-neutral-400">
					This starter wires Tauri 2, TanStack Router, Base UI, and Tailwind CSS in the official Base UI outline style.
					Call into Rust with{" "}
					<code className="border border-neutral-950 bg-neutral-100 px-1.5 py-0.5 font-mono text-xs dark:border-white dark:bg-neutral-800">
						invoke
					</code>
					, then show the result in a Base UI dialog.
				</p>
			</section>

			<section className="border border-neutral-950 bg-white p-4 shadow-[0.25rem_0.25rem_0] shadow-black/12 dark:border-white dark:bg-neutral-950 dark:shadow-none">
				<form
					className="flex flex-col gap-3 sm:flex-row"
					onSubmit={(event) => {
						event.preventDefault();
						void greet();
					}}
				>
					<label className="sr-only" htmlFor="greet-input">
						Name
					</label>
					<input
						id="greet-input"
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder="Enter a name..."
						className="h-8 flex-1 rounded-none border border-neutral-950 bg-white px-3 text-sm font-normal text-neutral-950 placeholder:text-neutral-500 focus:outline-2 focus:-outline-offset-1 focus:outline-neutral-950 dark:border-white dark:bg-neutral-950 dark:text-white dark:placeholder:text-neutral-400 dark:focus:outline-white"
					/>
					<Button type="submit" className={buttonClassName} disabled={loading || !name.trim()} focusableWhenDisabled>
						{loading ? "Greeting..." : "Greet from Rust"}
					</Button>
				</form>

				{greetMsg ? (
					<p className="mt-4 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
						Last message: <span className="font-bold text-neutral-950 dark:text-white">{greetMsg}</span>
					</p>
				) : null}
			</section>

			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog.Portal>
					<Dialog.Backdrop className="fixed inset-0 min-h-dvh bg-black opacity-20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute dark:opacity-50" />
					<Dialog.Popup className="fixed top-1/2 left-1/2 -mt-8 flex w-96 max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 border border-neutral-950 bg-white p-4 text-neutral-950 shadow-[0.25rem_0.25rem_0] shadow-black/12 transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 dark:border-white dark:bg-neutral-950 dark:text-white dark:shadow-none">
						<div className="flex flex-col gap-1">
							<Dialog.Title className="text-base leading-6 font-bold">Message from Rust</Dialog.Title>
							<Dialog.Description className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
								{greetMsg || "No message yet."}
							</Dialog.Description>
						</div>
						<div className="flex justify-end gap-3">
							<Dialog.Close className={buttonClassName}>Close</Dialog.Close>
						</div>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</div>
	);
}
