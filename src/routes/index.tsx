// ABOUTME: Home route demonstrating Tauri invoke plus Base UI controls.
// ABOUTME: Greets from Rust and opens a Base UI dialog with the response.
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Trans, useTranslation } from "react-i18next";

export const Route = createFileRoute("/")({
	component: HomePage,
});

/** Outline button using semantic theme colors */
const buttonClassName =
	"inline-flex h-control-height items-center justify-center gap-2 rounded-none border border-line bg-surface px-3 text-body-tight leading-none whitespace-nowrap font-normal text-ink select-none hover:not-data-disabled:bg-surface-2 active:not-data-disabled:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink data-disabled:border-disabled data-disabled:text-disabled disabled:border-disabled disabled:text-disabled";

function HomePage() {
	const { t } = useTranslation();
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
				<p className="text-label-caps font-normal text-muted uppercase">{t("home.kicker")}</p>
				<h1 className="text-headline-md font-bold text-ink">{t("home.title")}</h1>
				<p className="max-w-2xl text-body-base text-muted">
					<Trans
						i18nKey="home.description"
						components={{
							code: <code className="border border-line bg-code px-1.5 py-0.5 font-mono text-code-inline text-ink" />,
						}}
					/>
				</p>
			</section>

			<section className="shadow-frame border border-line bg-surface p-gutter">
				<form
					className="flex flex-col gap-3 sm:flex-row"
					onSubmit={(event) => {
						event.preventDefault();
						void greet();
					}}
				>
					<label className="sr-only" htmlFor="greet-input">
						{t("home.nameLabel")}
					</label>
					<input
						id="greet-input"
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder={t("home.namePlaceholder")}
						className="h-control-height flex-1 rounded-none border border-line bg-surface px-3 text-body-tight font-normal text-ink placeholder:text-muted focus:outline-2 focus:-outline-offset-1 focus:outline-ink"
					/>
					<Button type="submit" className={buttonClassName} disabled={loading || !name.trim()} focusableWhenDisabled>
						{loading ? t("home.greeting") : t("home.greet")}
					</Button>
				</form>

				{greetMsg ? (
					<p className="mt-4 text-body-tight text-muted">
						{t("home.lastMessage")} <span className="font-bold text-ink">{greetMsg}</span>
					</p>
				) : null}
			</section>

			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog.Portal>
					<Dialog.Backdrop className="fixed inset-0 min-h-dvh bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute" />
					<Dialog.Popup className="shadow-frame fixed top-1/2 left-1/2 -mt-8 flex w-96 max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 border border-line bg-surface p-gutter text-ink transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
						<div className="flex flex-col gap-1">
							<Dialog.Title className="text-title-dialog font-bold text-ink">{t("home.dialogTitle")}</Dialog.Title>
							<Dialog.Description className="text-body-tight text-muted">
								{greetMsg || t("home.noMessage")}
							</Dialog.Description>
						</div>
						<div className="flex justify-end gap-3">
							<Dialog.Close className={buttonClassName}>{t("common.close")}</Dialog.Close>
						</div>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</div>
	);
}
