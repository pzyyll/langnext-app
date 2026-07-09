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

const buttonClassName =
  "inline-flex h-9 items-center justify-center rounded-md bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white dark:focus-visible:outline-slate-100";

const secondaryButtonClassName =
  "inline-flex h-9 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 dark:focus-visible:outline-slate-100";

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
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="text-xs font-semibold tracking-[0.2em] text-slate-500 uppercase dark:text-slate-400">
          Tauri 2 + React 19
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
          Desktop shell, modern web stack
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
          This starter wires Tauri 2, TanStack Router, Base UI, and Tailwind CSS
          v4. Call into Rust with{" "}
          <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-slate-800">
            invoke
          </code>
          , then show the result in a Base UI dialog.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
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
            className="h-9 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <Button
            type="submit"
            className={buttonClassName}
            disabled={loading || !name.trim()}
            focusableWhenDisabled
          >
            {loading ? "Greeting..." : "Greet from Rust"}
          </Button>
        </form>

        {greetMsg ? (
          <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
            Last message: <span className="font-medium">{greetMsg}</span>
          </p>
        ) : null}
      </section>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 min-h-dvh bg-black/40 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 w-96 max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
            <div className="space-y-1">
              <Dialog.Title className="text-base font-semibold">
                Message from Rust
              </Dialog.Title>
              <Dialog.Description className="text-sm text-slate-600 dark:text-slate-300">
                {greetMsg || "No message yet."}
              </Dialog.Description>
            </div>
            <div className="mt-5 flex justify-end">
              <Dialog.Close className={secondaryButtonClassName}>
                Close
              </Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
