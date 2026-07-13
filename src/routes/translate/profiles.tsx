// ABOUTME: Nested translation profile management page at /translate/profiles.
// ABOUTME: Full CRUD for profiles, model chains, languages, and prompt templates.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/toast/useToast";
import {
	inputClassName,
	outlineButtonClassName,
	primaryButtonClassName,
	selectClassName,
	switchRootClassName,
	switchThumbClassName,
} from "../../components/ui";
import { profileKeys } from "../../query/keys";
import {
	allProviderModelsOptions,
	profileDetailOptions,
	profileListOptions,
	providerListOptions,
} from "../../query/options";
import { deleteTranslationProfile, saveTranslationProfile, setTranslationProfileEnabled } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderInstanceDto, ProviderModelDto, TranslationProfileDto } from "../../storage/types";
import {
	AUTO_LANGUAGE,
	LANGUAGE_IDS,
	getDefaultProfileLanguages,
	isLanguageId,
	isSelectableLanguageId,
	type LanguageId,
	type SelectableLanguageId,
	type SourceLanguageId,
} from "./languages";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";

export const Route = createFileRoute("/translate/profiles")({
	component: TranslateProfilesPage,
});

/** Viewport minus titlebar-height and main vertical padding (2 × gutter). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-var(--spacing-titlebar-height)-2*var(--spacing-gutter))]";

const DEFAULT_SYSTEM_TEMPLATE =
	"You are a professional translation engine. Translate the user's text from {{source_language}} to {{target_language}}.\n" +
	"Rules:\n" +
	"- Output only the translated text, with no preface, labels, quotes, or explanations.\n" +
	"- Preserve meaning, tone, and formatting (line breaks, lists, punctuation) when possible.\n" +
	"- If the source is already in the target language, return it unchanged.\n" +
	"- Do not invent content that is not present in the source.";

const DEFAULT_USER_TEMPLATE = "{{text}}";
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

const templateTextareaClassName =
	"min-h-28 w-full resize-y rounded-none border border-line bg-surface p-3 font-mono text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

const sectionDividerClassName = "space-y-4 border-t border-outline-variant pt-4";

const squareIconButtonClassName = `${outlineButtonClassName} size-control-height shrink-0 px-0`;

const dangerIconButtonClassName =
	"inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-none border-0 bg-transparent text-error hover:bg-surface-2 hover:text-error active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:text-disabled disabled:text-disabled";

const newProfileButtonClassName = `${outlineButtonClassName} w-full font-bold hover:not-data-disabled:bg-on-surface`;

/**
 * Shared rail/editor footer: fixed border-box block size so both columns match.
 * Size = py-4×2 (2rem) + h-control-height action row (2rem) + border-t (1px).
 * Explicit h/min-h/max-h + grow-0/shrink-0; both columns use h-control-height actions.
 */
const panelFooterClassName =
	"box-border flex h-[calc(2rem+2rem+1px)] max-h-[calc(2rem+2rem+1px)] min-h-[calc(2rem+2rem+1px)] shrink-0 grow-0 items-center border-t border-line px-8 py-4";

type ModelOption = {
	id: string;
	label: string;
};

/** List row derived from list DTO targets (no per-row detail IPC). */
type ProfileListItem = TranslationProfileDto & {
	primaryModelId: string | null;
	fallbackCount: number;
};

/** Local editor draft for create or update of a single profile. */
type ProfileDraft = {
	id: string | null;
	name: string;
	enabled: boolean;
	sourceLang: SourceLanguageId;
	targetLang: SelectableLanguageId;
	primaryLang: LanguageId;
	preferredTargetLang: LanguageId;
	primaryModelId: string;
	languageDetectionModelId: string;
	fallbackModelIds: string[];
	temperature: string;
	maxOutputTokens: string;
	systemTemplate: string;
	userTemplate: string;
	templateVersion: number;
	providerOptionsJson: unknown | null;
};

function toListItem(dto: TranslationProfileDto): ProfileListItem {
	const sorted = [...dto.targets].sort((a, b) => a.priority - b.priority);
	return {
		...dto,
		primaryModelId: sorted[0]?.providerModelId ?? null,
		fallbackCount: Math.max(0, sorted.length - 1),
	};
}

function resolveModelDisplayName(model: ProviderModelDto): string {
	return model.displayNameOverride ?? model.remoteDisplayName ?? model.modelKey;
}

function buildModelOptions(
	providers: ProviderInstanceDto[],
	models: ProviderModelDto[],
	formatLabel: (provider: string, model: string) => string,
): ModelOption[] {
	const providerById = new Map(providers.map((provider) => [provider.id, provider]));
	const options: ModelOption[] = [];

	for (const model of models) {
		if (!model.enabled || model.availability === "missing") {
			continue;
		}
		const provider = providerById.get(model.providerInstanceId);
		if (!provider || !provider.enabled) {
			continue;
		}
		const modelName = resolveModelDisplayName(model);
		options.push({
			id: model.id,
			label: formatLabel(provider.displayName, modelName),
		});
	}

	options.sort((a, b) => a.label.localeCompare(b.label));
	return options;
}

function emptyDraft(defaultModelId: string, uiLanguage: string): ProfileDraft {
	const { primary, target } = getDefaultProfileLanguages(uiLanguage);
	return {
		id: null,
		name: "",
		enabled: true,
		sourceLang: "auto",
		targetLang: AUTO_LANGUAGE,
		primaryLang: primary,
		preferredTargetLang: target,
		primaryModelId: defaultModelId,
		languageDetectionModelId: "",
		fallbackModelIds: [],
		temperature: String(DEFAULT_TEMPERATURE),
		maxOutputTokens: String(DEFAULT_MAX_OUTPUT_TOKENS),
		systemTemplate: DEFAULT_SYSTEM_TEMPLATE,
		userTemplate: DEFAULT_USER_TEMPLATE,
		templateVersion: 1,
		providerOptionsJson: null,
	};
}

function draftFromDto(dto: TranslationProfileDto, modelOptions: ModelOption[], uiLanguage: string): ProfileDraft {
	const sortedTargets = [...dto.targets].sort((a, b) => a.priority - b.priority);
	const modelIds = sortedTargets.map((target) => target.providerModelId);
	const primaryModelId =
		modelIds.find((id) => modelOptions.some((option) => option.id === id)) ?? modelOptions[0]?.id ?? modelIds[0] ?? "";
	const fallbackModelIds = modelIds.filter((id) => id !== primaryModelId);
	// Inherit the profile primary model unless an explicit LLM detector model is configured.
	const languageDetectionModelId =
		dto.languageDetection?.type === "llm" && dto.languageDetection.modelId != null ? dto.languageDetection.modelId : "";
	const defaults = getDefaultProfileLanguages(uiLanguage);

	return {
		id: dto.id,
		name: dto.name,
		enabled: dto.enabled,
		sourceLang: isSelectableLanguageId(dto.sourceLang) ? dto.sourceLang : "auto",
		targetLang: isSelectableLanguageId(dto.targetLang) ? dto.targetLang : AUTO_LANGUAGE,
		primaryLang: isLanguageId(dto.primaryLang) ? dto.primaryLang : defaults.primary,
		preferredTargetLang: isLanguageId(dto.preferredTargetLang) ? dto.preferredTargetLang : defaults.target,
		primaryModelId,
		languageDetectionModelId,
		fallbackModelIds,
		temperature: dto.temperature != null ? String(dto.temperature) : String(DEFAULT_TEMPERATURE),
		maxOutputTokens: dto.maxOutputTokens != null ? String(dto.maxOutputTokens) : String(DEFAULT_MAX_OUTPUT_TOKENS),
		systemTemplate: dto.systemTemplate,
		userTemplate: dto.userTemplate,
		templateVersion: dto.templateVersion,
		providerOptionsJson: dto.providerOptionsJson,
	};
}

function parseOptionalNumber(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	const value = Number(trimmed);
	if (!Number.isFinite(value)) {
		return null;
	}
	return value;
}

function TranslateProfilesPage() {
	const { t, i18n } = useTranslation();
	const toast = useToast();
	const queryClient = useQueryClient();

	const profilesQuery = useQuery(profileListOptions());
	const providersQuery = useQuery(providerListOptions());
	const modelsQuery = useQuery(allProviderModelsOptions());

	/** Explicit selection; null means "use first list item when not creating". */
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	/** Local edits only; null means derive draft from detail query. */
	const [draftOverride, setDraftOverride] = useState<ProfileDraft | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const modelOptions = useMemo(
		() =>
			buildModelOptions(providersQuery.data ?? [], modelsQuery.data ?? [], (provider, model) =>
				t("translate.modelOption", { provider, model }),
			),
		[providersQuery.data, modelsQuery.data, t],
	);

	const modelsLoading = providersQuery.isLoading || modelsQuery.isLoading;
	const modelsError =
		providersQuery.error != null || modelsQuery.error != null
			? getIpcErrorMessage(providersQuery.error ?? modelsQuery.error, t("translate.modelLoadFailed"))
			: null;

	const profiles = useMemo(() => (profilesQuery.data ?? []).map((dto) => toListItem(dto)), [profilesQuery.data]);
	const profilesLoading = profilesQuery.isLoading;
	const profilesError =
		profilesQuery.error != null ? getIpcErrorMessage(profilesQuery.error, t("translate.profiles.loadFailed")) : null;

	// Default to the first profile when nothing is explicitly selected (no effect).
	const resolvedSelectedId = isCreating
		? null
		: selectedId && profiles.some((profile) => profile.id === selectedId)
			? selectedId
			: (profiles[0]?.id ?? null);

	const detailQuery = useQuery({
		...profileDetailOptions(resolvedSelectedId ?? ""),
		enabled: !!resolvedSelectedId && !isCreating,
	});

	const sourceLanguageOptions = useMemo(
		() => [
			{ id: "auto", label: t("translate.languages.auto") },
			...LANGUAGE_IDS.map((id) => ({
				id,
				label: t(`translate.languages.${id}`),
			})),
		],
		[t],
	);

	const targetLanguageOptions = useMemo(
		() => [
			{ id: AUTO_LANGUAGE, label: t("translate.languages.auto") },
			...LANGUAGE_IDS.map((id) => ({
				id,
				label: t(`translate.languages.${id}`),
			})),
		],
		[t],
	);

	const modelLabelById = useMemo(() => {
		const map = new Map<string, string>();
		for (const option of modelOptions) {
			map.set(option.id, option.label);
		}
		return map;
	}, [modelOptions]);

	const uiLanguage = i18n.language;

	// Derive draft from detail when not creating and no local override; never mutate cache objects.
	const derivedDraft =
		!isCreating && detailQuery.isSuccess && detailQuery.data
			? draftFromDto(detailQuery.data, modelOptions, uiLanguage)
			: null;
	const draft = isCreating || draftOverride != null ? draftOverride : derivedDraft;

	const saveMutation = useMutation({
		mutationFn: saveTranslationProfile,
		onSuccess: (dto, variables) => {
			// Seed cache then drop local override so remote/refetch remains authoritative.
			queryClient.setQueryData(profileKeys.detail(dto.id), dto);
			void queryClient.invalidateQueries({ queryKey: profileKeys.all });
			setIsCreating(false);
			setSelectedId(dto.id);
			setDraftOverride(null);
			setSaveError(null);
			toast.success({
				title: variables.id ? t("translate.profileUpdated") : t("translate.profileSaved"),
			});
		},
		onError: (err) => {
			const message = getIpcErrorMessage(err, t("translate.profiles.saveFailed"));
			setSaveError(message);
			toast.error({ title: t("translate.profiles.saveFailed"), description: message });
		},
	});

	const enabledMutation = useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => setTranslationProfileEnabled(id, enabled),
		onSuccess: (dto) => {
			queryClient.setQueryData(profileKeys.detail(dto.id), dto);
			queryClient.setQueryData<TranslationProfileDto[]>(profileKeys.list(), (current) =>
				current ? current.map((item) => (item.id === dto.id ? { ...item, enabled: dto.enabled } : item)) : current,
			);
			void queryClient.invalidateQueries({ queryKey: profileKeys.all });
			// Patch only an existing local draft; do not create an override from remote data.
			setDraftOverride((current) =>
				current && current.id === dto.id ? { ...current, enabled: dto.enabled } : current,
			);
		},
		onError: (err, variables) => {
			// Revert optimistic cache when there was no local draft override.
			const detail = queryClient.getQueryData<TranslationProfileDto>(profileKeys.detail(variables.id));
			if (detail) {
				queryClient.setQueryData(profileKeys.detail(variables.id), {
					...detail,
					enabled: !variables.enabled,
				});
			}
			queryClient.setQueryData<TranslationProfileDto[]>(profileKeys.list(), (current) =>
				current
					? current.map((item) => (item.id === variables.id ? { ...item, enabled: !variables.enabled } : item))
					: current,
			);
			setDraftOverride((current) =>
				current && current.id === variables.id ? { ...current, enabled: !variables.enabled } : current,
			);
			const message = getIpcErrorMessage(err, t("translate.profiles.saveFailed"));
			setSaveError(message);
			toast.error({ title: t("translate.profiles.saveFailed"), description: message });
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteTranslationProfile(id),
		onSuccess: async (_void, deletedId) => {
			queryClient.removeQueries({ queryKey: profileKeys.detail(deletedId) });
			await queryClient.invalidateQueries({ queryKey: profileKeys.all });
			setDeleteOpen(false);
			setDraftOverride(null);
			setIsCreating(false);
			toast.success({ title: t("translate.profileDeleted") });

			const list = queryClient.getQueryData<TranslationProfileDto[]>(profileKeys.list()) ?? [];
			const next = list.find((profile) => profile.id !== deletedId) ?? list[0];
			setSelectedId(next?.id ?? null);
		},
	});

	function selectProfile(profileId: string) {
		setIsCreating(false);
		setSelectedId(profileId);
		setDraftOverride(null);
		setSaveError(null);
	}

	function startCreate() {
		setIsCreating(true);
		setSelectedId(null);
		setSaveError(null);
		setDraftOverride(emptyDraft(modelOptions[0]?.id ?? "", uiLanguage));
	}

	function updateDraft(patch: Partial<ProfileDraft>) {
		setDraftOverride((current) => {
			const base =
				current ??
				(detailQuery.data ? draftFromDto(detailQuery.data, modelOptions, uiLanguage) : null) ??
				(isCreating ? emptyDraft(modelOptions[0]?.id ?? "", uiLanguage) : null);
			return base ? { ...base, ...patch } : current;
		});
		setSaveError(null);
	}

	function handleEnabledChange(checked: boolean) {
		if (!draft) {
			return;
		}
		// Create mode: local draft only.
		if (!draft.id) {
			updateDraft({ enabled: checked });
			return;
		}
		// Editing other fields: keep draftOverride in sync with the toggle.
		if (draftOverride != null) {
			updateDraft({ enabled: checked });
		} else {
			// Clean form: optimistic cache write so derived draft tracks server state.
			const detail = detailQuery.data;
			if (detail && detail.id === draft.id) {
				queryClient.setQueryData(profileKeys.detail(detail.id), { ...detail, enabled: checked });
			}
			queryClient.setQueryData<TranslationProfileDto[]>(profileKeys.list(), (current) =>
				current ? current.map((item) => (item.id === draft.id ? { ...item, enabled: checked } : item)) : current,
			);
		}
		enabledMutation.mutate({ id: draft.id, enabled: checked });
	}

	function moveFallback(index: number, direction: -1 | 1) {
		if (!draft) {
			return;
		}
		const nextIndex = index + direction;
		if (nextIndex < 0 || nextIndex >= draft.fallbackModelIds.length) {
			return;
		}
		const next = draft.fallbackModelIds.slice();
		const [item] = next.splice(index, 1);
		if (!item) {
			return;
		}
		next.splice(nextIndex, 0, item);
		updateDraft({ fallbackModelIds: next });
	}

	function addFallback() {
		if (!draft) {
			return;
		}
		const used = new Set([draft.primaryModelId, ...draft.fallbackModelIds]);
		const nextOption = modelOptions.find((option) => !used.has(option.id));
		if (!nextOption) {
			return;
		}
		updateDraft({ fallbackModelIds: [...draft.fallbackModelIds, nextOption.id] });
	}

	function removeFallback(index: number) {
		if (!draft) {
			return;
		}
		updateDraft({ fallbackModelIds: draft.fallbackModelIds.filter((_, i) => i !== index) });
	}

	function setFallbackAt(index: number, modelId: string) {
		if (!draft) {
			return;
		}
		const next = draft.fallbackModelIds.slice();
		next[index] = modelId;
		updateDraft({ fallbackModelIds: next });
	}

	function handleSave() {
		if (!draft) {
			return;
		}
		const name = draft.name.trim();
		if (!name) {
			setSaveError(t("translate.profileNameRequired"));
			return;
		}
		if (!draft.primaryModelId) {
			setSaveError(t("translate.profiles.primaryModelRequired"));
			return;
		}
		if (draft.primaryLang === draft.preferredTargetLang) {
			setSaveError(t("translate.profiles.langPrefEqual"));
			return;
		}

		const temperature = parseOptionalNumber(draft.temperature) ?? DEFAULT_TEMPERATURE;
		const maxOutputTokens = parseOptionalNumber(draft.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;
		const targetModelIds = [
			draft.primaryModelId,
			...draft.fallbackModelIds.filter((id) => id && id !== draft.primaryModelId),
		];
		// Drop duplicate fallbacks while preserving order.
		const uniqueTargetIds: string[] = [];
		for (const id of targetModelIds) {
			if (!uniqueTargetIds.includes(id)) {
				uniqueTargetIds.push(id);
			}
		}

		setSaveError(null);
		saveMutation.mutate({
			id: draft.id,
			name,
			enabled: draft.enabled,
			templateVersion: draft.templateVersion,
			systemTemplate: draft.systemTemplate,
			userTemplate: draft.userTemplate,
			temperature,
			maxOutputTokens,
			providerOptionsJson: draft.providerOptionsJson,
			sourceLang: draft.sourceLang,
			targetLang: draft.targetLang,
			primaryLang: draft.primaryLang,
			preferredTargetLang: draft.preferredTargetLang,
			languageDetection: draft.languageDetectionModelId
				? { type: "llm", modelId: draft.languageDetectionModelId }
				: null,
			targetModelIds: uniqueTargetIds,
		});
	}

	async function handleDelete() {
		if (!draft?.id) {
			return;
		}
		try {
			await deleteMutation.mutateAsync(draft.id);
		} catch (err) {
			const error = new Error(getIpcErrorMessage(err, t("translate.profiles.deleteFailed")));
			throw Object.assign(error, { cause: err });
		}
	}

	const templateVarsHint = t("translate.templateVarsHint", {
		source_language: "{{source_language}}",
		target_language: "{{target_language}}",
		text: "{{text}}",
	});

	const editorLoading = !!resolvedSelectedId && !isCreating && detailQuery.isLoading;
	const editorError =
		!!resolvedSelectedId && !isCreating && detailQuery.isError
			? getIpcErrorMessage(detailQuery.error, t("translate.profiles.loadFailed"))
			: null;

	const savePending = saveMutation.isPending;
	const enabledPending = enabledMutation.isPending;

	const usedFallbackIds = draft ? new Set([draft.primaryModelId, ...draft.fallbackModelIds]) : new Set<string>();
	const canAddFallback = modelOptions.some((option) => !usedFallbackIds.has(option.id));
	const showEditor = draft != null || editorLoading || editorError;
	const listEmpty = !profilesLoading && !profilesError && profiles.length === 0 && !isCreating;

	return (
		<div className={`flex min-h-0 flex-col overflow-hidden border border-line bg-surface ${LAYOUT_HEIGHT_CLASS}`}>
			{/* Page header */}
			<header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3">
				<div className="min-w-0">
					<h1 className="text-headline-sm font-bold tracking-tight text-on-surface uppercase">
						{t("translate.profiles.title")}
					</h1>
					<p className="text-label-sm text-neutral uppercase">{t("translate.profiles.subtitle")}</p>
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
				{/* Profiles rail */}
				<aside className="flex max-h-64 w-full shrink-0 flex-col border-b border-line bg-surface-2 lg:max-h-none lg:w-64 lg:border-r lg:border-b-0">
					<div className="shrink-0 border-b border-line p-3">
						<span className="text-table-header font-bold text-neutral uppercase">
							{t("translate.profiles.listTitle")}
						</span>
					</div>

					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
						{profilesLoading ? (
							<p className="text-body-tight text-neutral" aria-live="polite">
								{t("translate.profiles.loading")}
							</p>
						) : null}

						{profilesError ? (
							<div className="flex flex-col gap-2" role="alert">
								<p className="text-body-tight text-error">{profilesError}</p>
								<Button
									type="button"
									className={outlineButtonClassName}
									onClick={() => {
										void profilesQuery.refetch();
									}}
								>
									{t("common.retry")}
								</Button>
							</div>
						) : null}

						{listEmpty ? <p className="text-body-tight text-neutral">{t("translate.profiles.empty")}</p> : null}

						{!profilesLoading && !profilesError && profiles.length > 0 ? (
							<ul className="space-y-4">
								{profiles.map((profile) => {
									const active = !isCreating && resolvedSelectedId === profile.id;
									const sourceLabel =
										profile.sourceLang === "auto"
											? t("translate.languages.auto")
											: isLanguageId(profile.sourceLang)
												? t(`translate.languages.${profile.sourceLang}`)
												: "—";
									const targetLabel =
										profile.targetLang === AUTO_LANGUAGE
											? t("translate.languages.auto")
											: isLanguageId(profile.targetLang)
												? t(`translate.languages.${profile.targetLang}`)
												: "—";
									return (
										<li key={profile.id}>
											<button
												type="button"
												className={
													active
														? "shadow-frame w-full cursor-default rounded-none border border-line bg-surface p-3 text-left"
														: "w-full cursor-pointer rounded-none border border-line bg-surface p-3 text-left transition-colors hover:bg-surface-container"
												}
												onClick={() => {
													selectProfile(profile.id);
												}}
											>
												<div className="mb-1 flex items-start justify-between gap-2">
													<span className="truncate text-body-tight font-bold text-on-surface">{profile.name}</span>
													{profile.enabled ? <Badge tone="accent">{t("common.enabled")}</Badge> : null}
												</div>
												<div className="truncate text-code-inline text-neutral">
													{t("translate.profiles.langArrow", {
														source: sourceLabel,
														target: targetLabel,
													})}
												</div>
												<div className="truncate text-code-inline text-disabled">
													{profile.primaryModelId
														? (modelLabelById.get(profile.primaryModelId) ?? profile.primaryModelId)
														: t("translate.profiles.noPrimaryModel")}
												</div>
											</button>
										</li>
									);
								})}
							</ul>
						) : null}
					</div>

					<div className={panelFooterClassName}>
						<Button type="button" className={newProfileButtonClassName} onClick={startCreate}>
							+ {t("translate.profiles.createNew")}
						</Button>
					</div>
				</aside>

				{/* Profile editor */}
				<section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface">
					{modelsError ? (
						<p className="shrink-0 px-8 pt-4 text-body-tight text-error" role="alert">
							{modelsError}
						</p>
					) : null}

					{!showEditor && listEmpty ? (
						<div className="flex flex-1 flex-col items-start justify-center gap-3 p-8">
							<p className="text-body-tight text-neutral">{t("translate.profiles.emptyHint")}</p>
							<Button type="button" className={primaryButtonClassName} onClick={startCreate}>
								{t("translate.profiles.emptyCreate")}
							</Button>
						</div>
					) : null}

					{!showEditor && !listEmpty ? (
						<p className="p-8 text-body-tight text-neutral">{t("translate.profiles.selectHint")}</p>
					) : null}

					{editorLoading ? (
						<p className="p-8 text-body-tight text-neutral" aria-live="polite">
							{t("translate.profiles.loadingEditor")}
						</p>
					) : null}

					{editorError ? (
						<p className="p-8 text-body-tight text-error" role="alert">
							{editorError}
						</p>
					) : null}

					{draft && !editorLoading ? (
						<form
							className="flex min-h-0 flex-1 flex-col overflow-hidden"
							onSubmit={(event) => {
								event.preventDefault();
								handleSave();
							}}
						>
							<div className="min-h-0 flex-1 overflow-y-auto p-8">
								<div className="mx-auto max-w-3xl space-y-8 pb-8">
									<div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
										<h2 className="text-headline-md font-bold tracking-tighter text-on-surface uppercase">
											{draft.id ? t("translate.profiles.editTitle") : t("translate.profiles.createTitle")}
										</h2>
										<label className="flex items-center gap-3">
											<span className="text-table-header font-bold text-neutral uppercase">
												{t("translate.profiles.enabledLabel")}
											</span>
											<Switch.Root
												checked={draft.enabled}
												disabled={enabledPending || savePending}
												onCheckedChange={(checked) => {
													handleEnabledChange(checked);
												}}
												className={switchRootClassName}
											>
												<Switch.Thumb className={switchThumbClassName} />
											</Switch.Root>
										</label>
									</div>

									{/* Basic info */}
									<div className="space-y-4">
										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-name">
												{t("translate.profileNameLabel")}
											</label>
											<input
												id="profile-name"
												className={inputClassName}
												type="text"
												value={draft.name}
												placeholder={t("translate.profileNamePlaceholder")}
												spellCheck={false}
												autoComplete="off"
												disabled={savePending}
												onChange={(event) => {
													updateDraft({ name: event.currentTarget.value });
												}}
											/>
										</div>
										<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
											<div className="flex flex-col gap-1">
												<label className={fieldLabelClassName} htmlFor="profile-source-lang">
													{t("translate.sourceLanguage")}
												</label>
												<select
													id="profile-source-lang"
													className={selectClassName}
													value={draft.sourceLang}
													disabled={savePending}
													onChange={(event) => {
														updateDraft({ sourceLang: event.currentTarget.value as SourceLanguageId });
													}}
												>
													{sourceLanguageOptions.map((option) => (
														<option key={option.id} value={option.id}>
															{option.label}
														</option>
													))}
												</select>
											</div>
											<div className="flex flex-col gap-1">
												<label className={fieldLabelClassName} htmlFor="profile-target-lang">
													{t("translate.targetLanguage")}
												</label>
												<select
													id="profile-target-lang"
													className={selectClassName}
													value={draft.targetLang}
													disabled={savePending}
													onChange={(event) => {
														updateDraft({ targetLang: event.currentTarget.value as SelectableLanguageId });
													}}
												>
													{targetLanguageOptions.map((option) => (
														<option key={option.id} value={option.id}>
															{option.label}
														</option>
													))}
												</select>
											</div>
										</div>

										{/* Primary / Target preference (used when target is Auto) */}
										<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
											<div className="flex flex-col gap-1">
												<label className={fieldLabelClassName} htmlFor="profile-primary-lang">
													{t("translate.profiles.primaryLang")}
												</label>
												<select
													id="profile-primary-lang"
													className={selectClassName}
													value={draft.primaryLang}
													disabled={savePending}
													onChange={(event) => {
														updateDraft({ primaryLang: event.currentTarget.value as LanguageId });
													}}
												>
													{LANGUAGE_IDS.map((id) => (
														<option key={id} value={id} disabled={id === draft.preferredTargetLang}>
															{t(`translate.languages.${id}`)}
														</option>
													))}
												</select>
											</div>
											<div className="flex flex-col gap-1">
												<label className={fieldLabelClassName} htmlFor="profile-preferred-target-lang">
													{t("translate.profiles.preferredTargetLang")}
												</label>
												<select
													id="profile-preferred-target-lang"
													className={selectClassName}
													value={draft.preferredTargetLang}
													disabled={savePending}
													onChange={(event) => {
														updateDraft({ preferredTargetLang: event.currentTarget.value as LanguageId });
													}}
												>
													{LANGUAGE_IDS.map((id) => (
														<option key={id} value={id} disabled={id === draft.primaryLang}>
															{t(`translate.languages.${id}`)}
														</option>
													))}
												</select>
											</div>
										</div>
										<p className="text-table-header text-neutral">{t("translate.profiles.langPrefHint")}</p>
									</div>

									{/* Models */}
									<div className={sectionDividerClassName}>
										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-primary-model">
												{t("translate.profiles.primaryModel")}
											</label>
											<select
												id="profile-primary-model"
												className={selectClassName}
												value={draft.primaryModelId}
												disabled={savePending || modelsLoading || modelOptions.length === 0}
												onChange={(event) => {
													const nextPrimary = event.currentTarget.value;
													updateDraft({
														primaryModelId: nextPrimary,
														fallbackModelIds: draft.fallbackModelIds.filter((id) => id !== nextPrimary),
													});
												}}
											>
												{modelsLoading ? (
													<option value="">{t("translate.modelLoading")}</option>
												) : modelOptions.length === 0 ? (
													<option value="">{t("translate.modelEmpty")}</option>
												) : (
													modelOptions.map((option) => (
														<option key={option.id} value={option.id}>
															{option.label}
														</option>
													))
												)}
											</select>
											{!modelsLoading && modelOptions.length === 0 ? (
												<p className="text-body-tight text-neutral">{t("translate.noModelsHint")}</p>
											) : null}
										</div>

										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-detection-model">
												{t("translate.profiles.detectionModel")}
											</label>
											<select
												id="profile-detection-model"
												className={selectClassName}
												value={draft.languageDetectionModelId}
												disabled={savePending || modelsLoading || modelOptions.length === 0}
												onChange={(event) => {
													updateDraft({ languageDetectionModelId: event.currentTarget.value });
												}}
											>
												<option value="">{t("translate.profiles.detectionModelUsePrimary")}</option>
												{modelOptions.map((option) => (
													<option key={option.id} value={option.id}>
														{option.label}
													</option>
												))}
												{/* Keep orphaned ids selectable until user changes them. */}
												{!modelOptions.some((option) => option.id === draft.languageDetectionModelId) &&
												draft.languageDetectionModelId ? (
													<option value={draft.languageDetectionModelId}>
														{modelLabelById.get(draft.languageDetectionModelId) ?? draft.languageDetectionModelId}
													</option>
												) : null}
											</select>
											<p className="text-body-tight text-neutral">{t("translate.profiles.detectionModelHint")}</p>
										</div>

										<div className="space-y-2">
											<div className="flex flex-wrap items-center justify-between gap-2">
												<span className={fieldLabelClassName}>{t("translate.profiles.fallbackModels")}</span>
												<Button
													type="button"
													className={`${outlineButtonClassName} h-6 px-2 text-table-header font-bold uppercase`}
													disabled={savePending || !canAddFallback}
													onClick={addFallback}
												>
													{t("translate.profiles.addFallback")}
												</Button>
											</div>
											{draft.fallbackModelIds.length === 0 ? (
												<p className="text-body-tight text-neutral">{t("translate.profiles.fallbackEmpty")}</p>
											) : (
												<ul className="space-y-2">
													{draft.fallbackModelIds.map((modelId, index) => (
														<li key={`fallback-${index}-${modelId}`} className="flex flex-wrap items-center gap-2">
															<div className="flex size-control-height shrink-0 items-center justify-center border border-line bg-surface-2 text-code-inline font-bold text-on-surface">
																{index + 1}
															</div>
															<select
																className={`${selectClassName} min-w-0 flex-1`}
																value={modelId}
																disabled={savePending}
																aria-label={t("translate.profiles.fallbackItemAria", {
																	index: index + 1,
																})}
																onChange={(event) => {
																	setFallbackAt(index, event.currentTarget.value);
																}}
															>
																{modelOptions.map((option) => (
																	<option key={option.id} value={option.id}>
																		{option.label}
																	</option>
																))}
																{/* Keep orphaned ids selectable until user changes them. */}
																{!modelOptions.some((option) => option.id === modelId) && modelId ? (
																	<option value={modelId}>{modelLabelById.get(modelId) ?? modelId}</option>
																) : null}
															</select>
															<Button
																type="button"
																className={squareIconButtonClassName}
																disabled={savePending || index === 0}
																aria-label={t("translate.profiles.moveUp")}
																onClick={() => {
																	moveFallback(index, -1);
																}}
															>
																↑
															</Button>
															<Button
																type="button"
																className={squareIconButtonClassName}
																disabled={savePending || index === draft.fallbackModelIds.length - 1}
																aria-label={t("translate.profiles.moveDown")}
																onClick={() => {
																	moveFallback(index, 1);
																}}
															>
																↓
															</Button>
															<Button
																type="button"
																className={`${outlineButtonClassName} h-control-height px-3 text-table-header font-bold uppercase hover:not-data-disabled:border-error hover:not-data-disabled:bg-error hover:not-data-disabled:text-on-error`}
																disabled={savePending}
																aria-label={t("translate.profiles.removeFallback")}
																onClick={() => {
																	removeFallback(index);
																}}
															>
																{t("translate.profiles.removeFallback")}
															</Button>
														</li>
													))}
												</ul>
											)}
										</div>
									</div>

									{/* Parameters */}
									<div className="grid grid-cols-1 gap-8 border-t border-outline-variant pt-4 sm:grid-cols-2">
										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-temperature">
												{t("translate.profiles.temperature")}
											</label>
											<input
												id="profile-temperature"
												className={inputClassName}
												type="number"
												step="0.1"
												min="0"
												max="2"
												value={draft.temperature}
												placeholder={String(DEFAULT_TEMPERATURE)}
												disabled={savePending}
												onChange={(event) => {
													updateDraft({ temperature: event.currentTarget.value });
												}}
											/>
											<span className="text-table-header text-disabled">
												{t("common.default", { value: DEFAULT_TEMPERATURE })}
											</span>
										</div>
										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-max-tokens">
												{t("translate.profiles.maxTokens")}
											</label>
											<input
												id="profile-max-tokens"
												className={inputClassName}
												type="number"
												step="1"
												min="1"
												value={draft.maxOutputTokens}
												placeholder={String(DEFAULT_MAX_OUTPUT_TOKENS)}
												disabled={savePending}
												onChange={(event) => {
													updateDraft({ maxOutputTokens: event.currentTarget.value });
												}}
											/>
											<span className="text-table-header text-disabled">
												{t("common.default", { value: DEFAULT_MAX_OUTPUT_TOKENS })}
											</span>
										</div>
									</div>

									{/* Prompt templates */}
									<div className="space-y-6 border-t border-outline-variant pt-4">
										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-system-template">
												{t("translate.systemTemplateLabel")}
											</label>
											<textarea
												id="profile-system-template"
												className={templateTextareaClassName}
												value={draft.systemTemplate}
												spellCheck={false}
												disabled={savePending}
												onChange={(event) => {
													updateDraft({ systemTemplate: event.currentTarget.value });
												}}
											/>
											<span className="font-mono text-table-header text-disabled italic">{templateVarsHint}</span>
										</div>
										<div className="flex flex-col gap-1">
											<label className={fieldLabelClassName} htmlFor="profile-user-template">
												{t("translate.userTemplateLabel")}
											</label>
											<textarea
												id="profile-user-template"
												className={templateTextareaClassName}
												value={draft.userTemplate}
												spellCheck={false}
												disabled={savePending}
												onChange={(event) => {
													updateDraft({ userTemplate: event.currentTarget.value });
												}}
											/>
											<span className="font-mono text-table-header text-disabled italic">{templateVarsHint}</span>
										</div>
									</div>

									{saveError ? (
										<p className="text-body-tight text-error" role="alert">
											{saveError}
										</p>
									) : null}
								</div>
							</div>

							{/* Sticky footer actions */}
							<div className={`${panelFooterClassName} justify-end gap-3 bg-surface`}>
								{draft.id ? (
									<Button
										type="button"
										className={`${dangerIconButtonClassName} mr-auto`}
										aria-label={t("common.delete")}
										title={t("common.delete")}
										disabled={savePending}
										onClick={() => {
											setDeleteOpen(true);
										}}
									>
										<IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
									</Button>
								) : null}
								<Button
									type="submit"
									className={`${primaryButtonClassName} relative`}
									disabled={savePending}
									focusableWhenDisabled
									aria-busy={savePending}
									aria-label={savePending ? t("common.saving") : t("common.save")}
								>
									<span className={savePending ? "invisible" : undefined} aria-hidden="true">
										{t("common.save")}
									</span>
									{savePending ? (
										<span
											className="absolute size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
											aria-hidden="true"
										/>
									) : null}
								</Button>
							</div>
						</form>
					) : null}
				</section>
			</div>

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title={t("translate.profiles.deleteTitle")}
				description={
					draft?.name ? t("translate.profileDeleteConfirm", { name: draft.name }) : t("translate.profiles.deleteTitle")
				}
				confirmText={t("common.delete")}
				pendingText={t("common.deleting")}
				danger
				onConfirm={handleDelete}
			/>
		</div>
	);
}
