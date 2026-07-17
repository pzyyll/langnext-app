// ABOUTME: Full-text review dialog for a single translation history row.
// ABOUTME: Fetches the full DTO via get_translation_history when opened.
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import { historyDetailOptions } from "../../query/options";
import type { TranslationHistoryDto } from "../../storage/types";
import { dialogBackdropClassName, dialogPopupClassName, iconButtonClassName } from "../../components/ui";
import { formatHistoryLocalDateTime } from "./historyTime";

export type HistoryDetailDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	id: string | null;
};

export function HistoryDetailDialog({ open, onOpenChange, id }: HistoryDetailDialogProps) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const query = useQuery({
		...historyDetailOptions(id ?? ""),
		enabled: open && !!id,
	});

	const dto = query.data;
	const canCopy = dto?.status === "complete" && dto.translatedText.length > 0;

	async function handleCopy() {
		if (!dto?.translatedText) {
			return;
		}
		try {
			await navigator.clipboard.writeText(dto.translatedText);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard may be unavailable outside a secure context.
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={dialogBackdropClassName} />
				<Dialog.Popup
					className={`${dialogPopupClassName} max-w-(--available-width) w-[42rem] max-w-[calc(100vw-3rem)]`}
				>
					<Dialog.Title className="text-title-dialog font-bold text-on-surface">
						{t("history.detail.title")}
					</Dialog.Title>

					{query.isLoading ? (
						<p className="text-body-tight text-neutral" role="status">
							{t("history.loading")}
						</p>
					) : query.error ? (
						<p className="text-body-tight text-error" role="alert">
							{t("history.loadFailed")}
						</p>
					) : dto ? (
						<div className="flex flex-col gap-3">
							<DetailGrid dto={dto} />
							<Field label={t("history.detail.source")}>
								<p className="whitespace-pre-wrap break-words text-body-md text-on-surface">{dto.sourceText}</p>
							</Field>
							<Field label={t("history.detail.translation")}>
								{dto.status === "complete" ? (
									<p className="whitespace-pre-wrap break-words text-body-md text-on-surface">{dto.translatedText}</p>
								) : (
									<p className="whitespace-pre-wrap break-words text-body-md text-error">
										{dto.errorMessage || t("history.status.failedCell")}
									</p>
								)}
							</Field>
						</div>
					) : null}

					<div className="flex justify-end gap-3 pt-1">
						{dto ? (
							<Button
								type="button"
								className={iconButtonClassName}
								aria-label={copied ? t("history.detail.copied") : t("history.detail.copy")}
								disabled={!canCopy}
								onClick={() => {
									void handleCopy();
								}}
							>
								{copied ? (
									<IconMaterialSymbolsLightCheck className="size-4 text-tertiary" aria-hidden />
								) : (
									<IconMaterialSymbolsLightContentCopy className="size-4" aria-hidden />
								)}
							</Button>
						) : null}
						<Dialog.Close className={`${iconButtonClassName} h-control-height px-4 font-bold`}>
							{t("common.close")}
						</Dialog.Close>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function DetailGrid({ dto }: { dto: TranslationHistoryDto }) {
	const { t } = useTranslation();
	const rows: Array<[string, string]> = [
		[t("history.detail.time"), formatHistoryLocalDateTime(dto.createdAt)],
		[t("history.detail.status"), t(`history.status.${dto.status}`)],
		[t("history.detail.model"), dto.modelDisplayName],
		[t("history.detail.provider"), dto.providerDisplayName ?? "-"],
		[t("history.detail.profile"), dto.profileName ?? "-"],
		[
			t("history.detail.sourceLang"),
			`${dto.sourceLang}${dto.effectiveSourceLang ? ` (${dto.effectiveSourceLang})` : ""}`,
		],
		[
			t("history.detail.targetLang"),
			`${dto.targetLang}${dto.effectiveTargetLang ? ` (${dto.effectiveTargetLang})` : ""}`,
		],
		[t("history.detail.latency"), `${dto.latencyMs} ms`],
	];
	if (dto.errorCode) {
		rows.push([t("history.detail.errorCode"), dto.errorCode]);
	}

	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-tight">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-neutral">{label}</dt>
					<dd className="text-on-surface">{value}</dd>
				</div>
			))}
		</dl>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-label-sm text-neutral uppercase">{label}</span>
			{children}
		</div>
	);
}
