// ABOUTME: Provider model table with enabled switches, inline display-name editing, and selection mode.
// ABOUTME: Displays manual, remote, and built-in model DTOs without fabricating data.
import { useMemo, useEffect, useRef, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Switch } from "@base-ui/react/switch";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import {
	checkboxClassName,
	iconButtonClassName,
	inputClassName,
	selectClassName,
	switchRootClassName,
	switchThumbClassName,
} from "../../components/ui";
import type { ProviderModelDto } from "../../storage/types";
import {
	getModelEnabledFilter,
	isModelEnabledFilter,
	modelMatchesSearch,
	setModelEnabledFilter,
	type ModelEnabledFilter,
} from "./modelListPreferences";

export type ModelsTableProps = {
	models: ProviderModelDto[];
	pendingModelIds: ReadonlySet<string>;
	onEnabledChange: (modelId: string, enabled: boolean) => void;
	/** Persist a new display-name override. Resolves true on success, false on failure. */
	onRenameModel?: (model: ProviderModelDto, displayNameOverride: string | null) => Promise<boolean>;
	selectionMode?: boolean;
	selectedModelIds?: ReadonlySet<string>;
	onToggleSelect?: (modelId: string) => void;
	/** Select or clear selection for the currently visible (filtered) model ids. */
	onToggleSelectAll?: (checked: boolean, visibleModelIds: readonly string[]) => void;
};

function resolveDisplayName(model: ProviderModelDto): string {
	return model.displayNameOverride ?? model.remoteDisplayName ?? "-";
}

function filterModels(
	models: ProviderModelDto[],
	searchQuery: string,
	enabledFilter: ModelEnabledFilter,
): ProviderModelDto[] {
	return models.filter((model) => {
		if (enabledFilter === "enabled" && !model.enabled) {
			return false;
		}
		if (enabledFilter === "disabled" && model.enabled) {
			return false;
		}
		return modelMatchesSearch(model, searchQuery);
	});
}

export function ModelsTable({
	models,
	pendingModelIds,
	onEnabledChange,
	onRenameModel,
	selectionMode = false,
	selectedModelIds = new Set(),
	onToggleSelect,
	onToggleSelectAll,
}: ModelsTableProps) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingValue, setEditingValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [enabledFilter, setEnabledFilterState] = useState<ModelEnabledFilter>(() => getModelEnabledFilter());

	// Focus and select the inline rename input when editing starts.
	useEffect(() => {
		if (editingId === null) return;
		const node = inputRef.current;
		if (node) {
			node.focus();
			node.select();
		}
	}, [editingId]);

	const filteredModels = useMemo(
		() => filterModels(models, searchQuery, enabledFilter),
		[models, searchQuery, enabledFilter],
	);

	function handleEnabledFilterChange(value: string) {
		const next = isModelEnabledFilter(value) ? value : "all";
		setEnabledFilterState(next);
		setModelEnabledFilter(next);
	}

	if (models.length === 0) {
		return <p className="text-sm text-muted">No models for this channel yet.</p>;
	}

	const allSelected =
		filteredModels.length > 0 && filteredModels.every((model) => selectedModelIds.has(model.id));

	function startRename(model: ProviderModelDto) {
		setEditingId(model.id);
		setEditingValue(model.displayNameOverride ?? "");
	}

	function cancelRename() {
		setEditingId(null);
	}

	async function commitRename(model: ProviderModelDto) {
		const trimmed = editingValue.trim();
		const nextOverride = trimmed ? trimmed : null;
		if (nextOverride === model.displayNameOverride) {
			setEditingId(null);
			return;
		}
		const ok = await onRenameModel?.(model, nextOverride);
		if (ok) {
			setEditingId(null);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="min-w-0 flex-1">
					<label className="sr-only" htmlFor="models-search">
						Search models
					</label>
					<input
						id="models-search"
						type="search"
						className={inputClassName}
						placeholder="Search model ID…"
						value={searchQuery}
						spellCheck={false}
						autoComplete="off"
						onChange={(event) => {
							setSearchQuery(event.currentTarget.value);
						}}
					/>
				</div>
				<div className="w-full sm:w-40">
					<label className="sr-only" htmlFor="models-enabled-filter">
						Filter by enabled status
					</label>
					<select
						id="models-enabled-filter"
						className={selectClassName}
						value={enabledFilter}
						onChange={(event) => {
							handleEnabledFilterChange(event.currentTarget.value);
						}}
					>
						<option value="all">All</option>
						<option value="enabled">Enabled</option>
						<option value="disabled">Disabled</option>
					</select>
				</div>
			</div>

			{filteredModels.length === 0 ? (
				<p className="text-sm text-muted">No models match the current search and filters.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-md text-left">
						<thead>
							<tr className="border-b border-line text-[10px] tracking-wider text-muted uppercase">
								{selectionMode ? (
									<th className="w-10 pb-2 font-semibold">
										<input
											type="checkbox"
											className={checkboxClassName}
											checked={allSelected}
											aria-label="Select all models"
											onChange={(event) => {
												onToggleSelectAll?.(
													event.currentTarget.checked,
													filteredModels.map((model) => model.id),
												);
											}}
										/>
									</th>
								) : null}
								<th className="pb-2 font-semibold">Model ({filteredModels.length})</th>
								<th className="pb-2 text-center font-semibold">Display Name</th>
								<th className="pb-2 text-right font-semibold">Enabled</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-line/30">
							{filteredModels.map((model) => {
								const pending = pendingModelIds.has(model.id);
								const editing = editingId === model.id;
								const canRename = model.source === "manual" && onRenameModel !== undefined;
								return (
									<tr key={model.id}>
										{selectionMode ? (
											<td className="py-4">
												<input
													type="checkbox"
													className={checkboxClassName}
													checked={selectedModelIds.has(model.id)}
													disabled={pending}
													aria-label={`Select ${model.modelKey}`}
													onChange={() => {
														onToggleSelect?.(model.id);
													}}
												/>
											</td>
										) : null}
										<td className="py-4">
											<span className="font-mono text-sm font-bold text-ink">{model.modelKey}</span>
										</td>
										<td className="py-4 text-center text-sm text-muted">
											{editing ? (
												<form
													className="flex items-center justify-center gap-1"
													onSubmit={(event) => {
														event.preventDefault();
														void commitRename(model);
													}}
												>
													<input
														ref={inputRef}
														className="h-7 w-40 rounded-none border border-line bg-surface px-2 text-sm font-normal text-ink placeholder:text-muted focus:outline-2 focus:-outline-offset-1 focus:outline-ink disabled:border-disabled disabled:text-disabled"
														value={editingValue}
														onChange={(event) => {
															setEditingValue(event.currentTarget.value);
														}}
														onKeyDown={(event) => {
															if (event.key === "Escape" && !pending) {
																event.preventDefault();
																cancelRename();
															}
														}}
														maxLength={200}
														spellCheck={false}
														placeholder="Display name"
														disabled={pending}
													/>
													<Button
														type="submit"
														className={iconButtonClassName}
														aria-label="Save display name"
														disabled={pending}
													>
														<IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
													</Button>
													<Button
														type="button"
														className={iconButtonClassName}
														aria-label="Cancel rename"
														disabled={pending}
														onClick={cancelRename}
													>
														<IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
													</Button>
												</form>
											) : (
												<div className="flex items-center justify-center gap-1">
													<span>{resolveDisplayName(model)}</span>
													{canRename ? (
														<Button
															type="button"
															className={iconButtonClassName}
															aria-label="Edit display name"
															title="Edit display name"
															disabled={pending}
															onClick={() => {
																startRename(model);
															}}
														>
															<IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
														</Button>
													) : null}
												</div>
											)}
										</td>
										<td className="py-4 text-right">
											<div className="flex justify-end">
												<Switch.Root
													checked={model.enabled}
													disabled={pending}
													onCheckedChange={(checked: boolean) => {
														onEnabledChange(model.id, checked);
													}}
													className={switchRootClassName}
													aria-label={`Toggle ${model.modelKey}`}
												>
													<Switch.Thumb className={switchThumbClassName} />
												</Switch.Root>
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
