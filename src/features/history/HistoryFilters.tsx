// ABOUTME: History filter bar: search, model (facets), language, date, Apply + Clear.
// ABOUTME: Draft state is owned by the parent; Apply commits drafts to the query.
import { useTranslation } from "react-i18next";
import { Input } from "@base-ui/react/input";
import { SelectField } from "../../components/SelectField";
import { inputClassName, outlineButtonClassName, primaryButtonClassName } from "../../components/ui";
import { LANGUAGE_IDS } from "../../routes/translate/-languages";
import type { TranslationHistoryModelFacet } from "../../storage/types";

export type HistoryFilterDraft = {
	search: string;
	modelId: string; // "" = any
	language: string; // "" = any
	date: string; // "" = none
};

export type HistoryFiltersProps = {
	draft: HistoryFilterDraft;
	onDraftChange: (patch: Partial<HistoryFilterDraft>) => void;
	modelFacets: TranslationHistoryModelFacet[];
	onApply: () => void;
	onClear: () => void;
	disabled?: boolean;
};

export function HistoryFilters({ draft, onDraftChange, modelFacets, onApply, onClear, disabled }: HistoryFiltersProps) {
	const { t } = useTranslation();

	const modelOptions = [
		{ value: "", label: t("history.filters.modelAny") },
		...modelFacets.map((facet) => ({
			value: facet.modelId ?? facet.modelDisplayName,
			label: facet.modelDisplayName,
		})),
	];

	const languageOptions = [
		{ value: "", label: t("history.filters.languageAny") },
		...LANGUAGE_IDS.map((id) => ({ value: id, label: t(`translate.languages.${id}`) })),
	];

	return (
		<form
			className="flex flex-wrap items-end gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				onApply();
			}}
		>
			<div className="flex min-w-48 flex-1 flex-col gap-1">
				<label className="text-label-sm text-neutral uppercase" htmlFor="history-filter-search">
					{t("history.filters.search")}
				</label>
				<Input
					id="history-filter-search"
					className={inputClassName}
					type="search"
					maxLength={200}
					placeholder={t("history.filters.search")}
					value={draft.search}
					onChange={(event) => onDraftChange({ search: event.currentTarget.value })}
					disabled={disabled}
				/>
			</div>

			<div className="flex w-44 flex-col gap-1">
				<label className="text-label-sm text-neutral uppercase" htmlFor="history-filter-model">
					{t("history.filters.model")}
				</label>
				<SelectField
					id="history-filter-model"
					value={draft.modelId}
					onValueChange={(value) => onDraftChange({ modelId: value ?? "" })}
					options={modelOptions}
					disabled={disabled}
					aria-label={t("history.filters.model")}
					compact
				/>
			</div>

			<div className="flex w-36 flex-col gap-1">
				<label className="text-label-sm text-neutral uppercase" htmlFor="history-filter-language">
					{t("history.filters.language")}
				</label>
				<SelectField
					id="history-filter-language"
					value={draft.language}
					onValueChange={(value) => onDraftChange({ language: value ?? "" })}
					options={languageOptions}
					disabled={disabled}
					aria-label={t("history.filters.language")}
					compact
				/>
			</div>

			<div className="flex w-40 flex-col gap-1">
				<label className="text-label-sm text-neutral uppercase" htmlFor="history-filter-date">
					{t("history.filters.date")}
				</label>
				<input
					id="history-filter-date"
					type="date"
					className={inputClassName}
					value={draft.date}
					onChange={(event) => onDraftChange({ date: event.currentTarget.value })}
					disabled={disabled}
				/>
			</div>

			<button type="submit" className={primaryButtonClassName} disabled={disabled}>
				{t("history.filters.apply")}
			</button>
			<button type="button" className={outlineButtonClassName} onClick={onClear} disabled={disabled}>
				{t("history.filters.clear")}
			</button>
		</form>
	);
}
