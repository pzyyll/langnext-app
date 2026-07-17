// ABOUTME: Selectable history table with row actions (view, copy, delete).
// ABOUTME: Selection is current-page only; failed rows show fixed error copy in the target cell.
import { Checkbox } from "@base-ui/react/checkbox";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightDelete from "~icons/material-symbols-light/delete";
import IconMaterialSymbolsLightVisibility from "~icons/material-symbols-light/visibility";
import { checkboxClassName, checkboxIndicatorClassName, iconButtonClassName } from "../../components/ui";
import type { TranslationHistoryListItemDto } from "../../storage/types";
import { formatHistoryLocalDateTime } from "./historyTime";

export type HistoryTableProps = {
	items: TranslationHistoryListItemDto[];
	selectedIds: ReadonlySet<string>;
	onToggleSelect: (id: string) => void;
	onToggleSelectAll: (checked: boolean, visibleIds: readonly string[]) => void;
	onView: (id: string) => void;
	onCopy: (item: TranslationHistoryListItemDto) => void;
	onDelete: (id: string) => void;
};

export function HistoryTable({
	items,
	selectedIds,
	onToggleSelect,
	onToggleSelectAll,
	onView,
	onCopy,
	onDelete,
}: HistoryTableProps) {
	const { t } = useTranslation();
	const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-3xl text-left">
				<thead>
					<tr className="border-b border-line text-table-header font-semibold text-neutral uppercase">
						<th className="w-10 pb-2 font-semibold">
							<Checkbox.Root
								className={checkboxClassName}
								checked={allSelected}
								aria-label={t("history.table.selectAll")}
								onCheckedChange={(checked) => {
									onToggleSelectAll(
										checked,
										items.map((item) => item.id),
									);
								}}
							>
								<Checkbox.Indicator className={checkboxIndicatorClassName}>
									<IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
								</Checkbox.Indicator>
							</Checkbox.Root>
						</th>
						<th className="w-36 pb-2 font-semibold">{t("history.table.time")}</th>
						<th className="pb-2 font-semibold">{t("history.table.source")}</th>
						<th className="pb-2 font-semibold">{t("history.table.target")}</th>
						<th className="w-40 pb-2 font-semibold">{t("history.table.model")}</th>
						<th className="w-24 pb-2 font-semibold">{t("history.table.status")}</th>
						<th className="w-32 pb-2 text-right font-semibold">{t("history.table.actions")}</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-line/30">
					{items.map((item) => {
						const isSelected = selectedIds.has(item.id);
						const canCopy = item.status === "complete" && item.translatedTextPreview.length > 0;
						return (
							<tr key={item.id} className={isSelected ? "bg-surface-2" : undefined}>
								<td className="py-3">
									<Checkbox.Root
										className={checkboxClassName}
										checked={isSelected}
										aria-label={t("history.table.selectRow")}
										onCheckedChange={() => onToggleSelect(item.id)}
									>
										<Checkbox.Indicator className={checkboxIndicatorClassName}>
											<IconMaterialSymbolsLightCheck className="size-3" aria-hidden />
										</Checkbox.Indicator>
									</Checkbox.Root>
								</td>
								<td className="py-3 text-body-tight text-neutral">{formatHistoryLocalDateTime(item.createdAt)}</td>
								<td className="max-w-xs py-3 text-body-tight text-on-surface">
									<span className="line-clamp-2 whitespace-pre-wrap break-words">{item.sourceTextPreview}</span>
								</td>
								<td className="max-w-xs py-3 text-body-tight text-on-surface">
									{item.status === "complete" ? (
										<span className="line-clamp-2 whitespace-pre-wrap break-words">{item.translatedTextPreview}</span>
									) : (
										<span className="text-error">{t("history.status.failedCell")}</span>
									)}
								</td>
								<td className="py-3 text-body-tight text-neutral">{item.modelDisplayName}</td>
								<td className="py-3 text-body-tight text-neutral">{t(`history.status.${item.status}`)}</td>
								<td className="py-3">
									<div className="flex justify-end gap-0.5">
										<button
											type="button"
											className={iconButtonClassName}
											aria-label={t("history.actions.view")}
											onClick={() => onView(item.id)}
										>
											<IconMaterialSymbolsLightVisibility className="size-4" aria-hidden />
										</button>
										<button
											type="button"
											className={iconButtonClassName}
											aria-label={t("history.actions.copy")}
											disabled={!canCopy}
											onClick={() => onCopy(item)}
										>
											<IconMaterialSymbolsLightContentCopy className="size-4" aria-hidden />
										</button>
										<button
											type="button"
											className={iconButtonClassName}
											aria-label={t("history.actions.delete")}
											onClick={() => onDelete(item.id)}
										>
											<IconMaterialSymbolsLightDelete className="size-4" aria-hidden />
										</button>
									</div>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
