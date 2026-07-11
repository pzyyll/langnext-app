// ABOUTME: Nested translation profile management page at /translate/profiles.
// ABOUTME: Full CRUD for profiles, model chains, languages, and prompt templates.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/toast/useToast";
import {
	dangerButtonClassName,
	inputClassName,
	outlineButtonClassName,
	primaryButtonClassName,
	selectClassName,
	switchRootClassName,
	switchThumbClassName,
} from "../../components/ui";
import {
	deleteTranslationProfile,
	getTranslationProfile,
	listAllProviderModels,
	listProviderInstances,
	listTranslationProfiles,
	saveTranslationProfile,
	setTranslationProfileEnabled,
} from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type {
	ProviderInstanceDto,
	ProviderModelDto,
	TranslationProfile,
	TranslationProfileDto,
} from "../../storage/types";

export const Route = createFileRoute("/translate/profiles")({
	component: TranslateProfilesPage,
});

/** Viewport minus titlebar-height and main vertical padding (2 × gutter). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-var(--spacing-titlebar-height)-2*var(--spacing-gutter))]";

const LANGUAGE_IDS = ["zh", "en", "ja", "ko", "fr", "de", "es"] as const;
type LanguageId = (typeof LANGUAGE_IDS)[number];

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

const templateTextareaClassName =
	"min-h-28 w-full resize-y rounded-none border border-line bg-surface px-3 py-2 font-mono text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

type ModelOption = {
	id: string;
	label: string;
};

/** List row with target-chain summary loaded via get_translation_profile. */
type ProfileListItem = TranslationProfile & {
	primaryModelId: string | null;
	fallbackCount: number;
};

/** Local editor draft for create or update of a single profile. */
type ProfileDraft = {
	id: string | null;
	name: string;
	enabled: boolean;
	sourceLang: LanguageId;
	targetLang: LanguageId;
	primaryModelId: string;
	fallbackModelIds: string[];
	temperature: string;
	maxOutputTokens: string;
	systemTemplate: string;
	userTemplate: string;
	templateVersion: number;
	providerOptionsJson: unknown | null;
};

function toListItem(profile: TranslationProfile, dto?: TranslationProfileDto | null): ProfileListItem {
	const sorted = dto ? [...dto.targets].sort((a, b) => a.priority - b.priority) : [];
	return {
		...profile,
		primaryModelId: sorted[0]?.providerModelId ?? null,
		fallbackCount: Math.max(0, sorted.length - 1),
	};
}

async function loadProfileListItems(): Promise<ProfileListItem[]> {
	const list = await listTranslationProfiles();
	const details = await Promise.all(
		list.map(async (profile) => {
			try {
				const dto = await getTranslationProfile(profile.id);
				return toListItem(profile, dto);
			} catch {
				return toListItem(profile, null);
			}
		}),
	);
	return details;
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

function isLanguageId(value: string | null | undefined): value is LanguageId {
	return !!value && (LANGUAGE_IDS as readonly string[]).includes(value);
}

function emptyDraft(defaultModelId: string): ProfileDraft {
	return {
		id: null,
		name: "",
		enabled: true,
		sourceLang: "zh",
		targetLang: "en",
		primaryModelId: defaultModelId,
		fallbackModelIds: [],
		temperature: String(DEFAULT_TEMPERATURE),
		maxOutputTokens: String(DEFAULT_MAX_OUTPUT_TOKENS),
		systemTemplate: DEFAULT_SYSTEM_TEMPLATE,
		userTemplate: DEFAULT_USER_TEMPLATE,
		templateVersion: 1,
		providerOptionsJson: null,
	};
}

function draftFromDto(dto: TranslationProfileDto, modelOptions: ModelOption[]): ProfileDraft {
	const sortedTargets = [...dto.targets].sort((a, b) => a.priority - b.priority);
	const modelIds = sortedTargets.map((target) => target.providerModelId);
	const primaryModelId =
		modelIds.find((id) => modelOptions.some((option) => option.id === id)) ??
		modelOptions[0]?.id ??
		modelIds[0] ??
		"";
	const fallbackModelIds = modelIds.filter((id) => id !== primaryModelId);

	return {
		id: dto.id,
		name: dto.name,
		enabled: dto.enabled,
		sourceLang: isLanguageId(dto.sourceLang) ? dto.sourceLang : "zh",
		targetLang: isLanguageId(dto.targetLang) ? dto.targetLang : "en",
		primaryModelId,
		fallbackModelIds,
		temperature: dto.temperature != null ? String(dto.temperature) : String(DEFAULT_TEMPERATURE),
		maxOutputTokens:
			dto.maxOutputTokens != null ? String(dto.maxOutputTokens) : String(DEFAULT_MAX_OUTPUT_TOKENS),
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
	const { t } = useTranslation();
	const toast = useToast();

	const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
	const [profilesLoading, setProfilesLoading] = useState(true);
	const [profilesError, setProfilesError] = useState<string | null>(null);

	const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [modelsError, setModelsError] = useState<string | null>(null);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [draft, setDraft] = useState<ProfileDraft | null>(null);
	const [editorLoading, setEditorLoading] = useState(false);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [savePending, setSavePending] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [enabledPending, setEnabledPending] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const languageOptions = useMemo(
		() =>
			LANGUAGE_IDS.map((id) => ({
				id,
				label: t(`translate.languages.${id}`),
			})),
		[t],
	);

	const modelLabelById = useMemo(() => {
		const map = new Map<string, string>();
		for (const option of modelOptions) {
			map.set(option.id, option.label);
		}
		return map;
	}, [modelOptions]);

	const refreshProfiles = useCallback(async (): Promise<ProfileListItem[]> => {
		const list = await loadProfileListItems();
		setProfiles(list);
		setProfilesError(null);
		return list;
	}, []);

	const selectProfile = useCallback(
		async (profileId: string, options?: ModelOption[]) => {
			const resolvedOptions = options ?? modelOptions;
			setIsCreating(false);
			setSelectedId(profileId);
			setSaveError(null);
			setEditorError(null);
			setEditorLoading(true);
			try {
				const dto = await getTranslationProfile(profileId);
				setDraft(draftFromDto(dto, resolvedOptions));
			} catch (err) {
				setDraft(null);
				setEditorError(getIpcErrorMessage(err, t("translate.profiles.loadFailed")));
			} finally {
				setEditorLoading(false);
			}
		},
		[modelOptions, t],
	);

	useEffect(() => {
		let cancelled = false;

		async function loadInitial() {
			setProfilesLoading(true);
			setModelsLoading(true);
			setProfilesError(null);
			setModelsError(null);
			try {
				const [providers, models, profileList] = await Promise.all([
					listProviderInstances(),
					listAllProviderModels(),
					loadProfileListItems(),
				]);
				if (cancelled) {
					return;
				}
				const options = buildModelOptions(providers, models, (provider, model) =>
					t("translate.modelOption", { provider, model }),
				);
				setModelOptions(options);
				setProfiles(profileList);
				// Open the first profile in the editor after initial hydration.
				const first = profileList[0];
				if (first) {
					setIsCreating(false);
					setSelectedId(first.id);
					setEditorLoading(true);
					try {
						const dto = await getTranslationProfile(first.id);
						if (!cancelled) {
							setDraft(draftFromDto(dto, options));
							setEditorError(null);
						}
					} catch (err) {
						if (!cancelled) {
							setDraft(null);
							setEditorError(getIpcErrorMessage(err, t("translate.profiles.loadFailed")));
						}
					} finally {
						if (!cancelled) {
							setEditorLoading(false);
						}
					}
				}
			} catch (err) {
				if (cancelled) {
					return;
				}
				setModelOptions([]);
				setProfiles([]);
				setModelsError(getIpcErrorMessage(err, t("translate.modelLoadFailed")));
				setProfilesError(getIpcErrorMessage(err, t("translate.profiles.loadFailed")));
			} finally {
				if (!cancelled) {
					setProfilesLoading(false);
					setModelsLoading(false);
				}
			}
		}

		void loadInitial();
		return () => {
			cancelled = true;
		};
	}, [t]);

	function startCreate() {
		setIsCreating(true);
		setSelectedId(null);
		setSaveError(null);
		setEditorError(null);
		setDraft(emptyDraft(modelOptions[0]?.id ?? ""));
	}

	function updateDraft(patch: Partial<ProfileDraft>) {
		setDraft((current) => (current ? { ...current, ...patch } : current));
		setSaveError(null);
	}

	async function handleEnabledChange(checked: boolean) {
		if (!draft) {
			return;
		}
		updateDraft({ enabled: checked });
		if (!draft.id) {
			return;
		}
		setEnabledPending(true);
		try {
			const dto = await setTranslationProfileEnabled(draft.id, checked);
			setProfiles((current) =>
				current.map((profile) =>
					profile.id === dto.id
						? {
								...profile,
								enabled: dto.enabled,
								updatedAt: dto.updatedAt,
								// Preserve chain summary already loaded for the list row.
								primaryModelId: profile.primaryModelId,
								fallbackCount: profile.fallbackCount,
							}
						: profile,
				),
			);
			setDraft((current) => (current && current.id === dto.id ? { ...current, enabled: dto.enabled } : current));
		} catch (err) {
			updateDraft({ enabled: !checked });
			const message = getIpcErrorMessage(err, t("translate.profiles.saveFailed"));
			setSaveError(message);
			toast.error({ title: t("translate.profiles.saveFailed"), description: message });
		} finally {
			setEnabledPending(false);
		}
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

	async function handleSave() {
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

		setSavePending(true);
		setSaveError(null);
		try {
			const dto = await saveTranslationProfile({
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
				targetModelIds: uniqueTargetIds,
			});
			await refreshProfiles();
			setIsCreating(false);
			setSelectedId(dto.id);
			setDraft(draftFromDto(dto, modelOptions));
			toast.success({
				title: draft.id ? t("translate.profileUpdated") : t("translate.profileSaved"),
			});
		} catch (err) {
			const message = getIpcErrorMessage(err, t("translate.profiles.saveFailed"));
			setSaveError(message);
			toast.error({ title: t("translate.profiles.saveFailed"), description: message });
		} finally {
			setSavePending(false);
		}
	}

	async function handleDelete() {
		if (!draft?.id) {
			return;
		}
		const deletedId = draft.id;
		try {
			await deleteTranslationProfile(deletedId);
			const list = await refreshProfiles();
			setDeleteOpen(false);
			setDraft(null);
			setSelectedId(null);
			setIsCreating(false);
			toast.success({ title: t("translate.profileDeleted") });
			const next = list.find((profile) => profile.id !== deletedId) ?? list[0];
			if (next) {
				void selectProfile(next.id);
			}
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

	const usedFallbackIds = draft
		? new Set([draft.primaryModelId, ...draft.fallbackModelIds])
		: new Set<string>();
	const canAddFallback = modelOptions.some((option) => !usedFallbackIds.has(option.id));
	const showEditor = draft != null || editorLoading || editorError;
	const listEmpty = !profilesLoading && !profilesError && profiles.length === 0 && !isCreating;

	return (
		<div className={`flex min-h-0 flex-col gap-gutter ${LAYOUT_HEIGHT_CLASS}`}>
			<header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border border-line bg-surface-2 px-gutter py-2">
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="text-headline-sm font-bold text-on-surface">{t("translate.profiles.title")}</h1>
					<p className="text-body-tight text-neutral">{t("translate.profiles.subtitle")}</p>
				</div>
				<Link
					to="/translate"
					className={`${outlineButtonClassName} no-underline`}
				>
					{t("translate.profiles.backToTranslate")}
				</Link>
			</header>

			<div className="shadow-frame flex min-h-0 flex-1 flex-col overflow-hidden border border-line bg-surface lg:flex-row">
				{/* Profile list */}
				<aside className="flex max-h-64 w-full shrink-0 flex-col border-b border-line bg-surface lg:max-h-none lg:w-models-rail lg:border-r lg:border-b-0">
					<div className="flex min-h-0 flex-1 flex-col p-gutter">
						<div className="mb-3 flex shrink-0 items-center justify-between gap-2">
							<h2 className="text-label-sm font-bold tracking-wide text-on-surface uppercase">
								{t("translate.profiles.listTitle")}
							</h2>
						</div>

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
										void (async () => {
											setProfilesLoading(true);
											try {
												await refreshProfiles();
											} catch (err) {
												setProfilesError(
													getIpcErrorMessage(err, t("translate.profiles.loadFailed")),
												);
											} finally {
												setProfilesLoading(false);
											}
										})();
									}}
								>
									{t("common.retry")}
								</Button>
							</div>
						) : null}

						{listEmpty ? (
							<p className="text-body-tight text-neutral">{t("translate.profiles.empty")}</p>
						) : null}

						{!profilesLoading && !profilesError && profiles.length > 0 ? (
							<ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
								{profiles.map((profile) => {
									const active = !isCreating && selectedId === profile.id;
									const sourceLabel = isLanguageId(profile.sourceLang)
										? t(`translate.languages.${profile.sourceLang}`)
										: "—";
									const targetLabel = isLanguageId(profile.targetLang)
										? t(`translate.languages.${profile.targetLang}`)
										: "—";
									return (
										<li key={profile.id}>
											<button
												type="button"
												className={
													active
														? "w-full rounded-none bg-surface-2 px-3 py-2 text-left"
														: "w-full rounded-none px-3 py-2 text-left hover:bg-surface-2"
												}
												onClick={() => {
													void selectProfile(profile.id);
												}}
											>
												<div className="flex items-center justify-between gap-2">
													<span
														className={
															active
																? "truncate text-body-tight font-bold text-on-surface"
																: "truncate text-body-tight text-on-surface"
														}
													>
														{profile.name}
													</span>
													<span
														className={
															profile.enabled
																? "shrink-0 text-label-sm text-neutral"
																: "shrink-0 text-label-sm text-disabled"
														}
													>
														{profile.enabled
															? t("common.enabled")
															: t("common.disabled")}
													</span>
												</div>
												<p className="mt-0.5 truncate text-label-sm text-neutral">
													{t("translate.profiles.langArrow", {
														source: sourceLabel,
														target: targetLabel,
													})}
												</p>
												<p className="mt-0.5 truncate text-label-sm text-neutral">
													{profile.primaryModelId
														? (modelLabelById.get(profile.primaryModelId) ??
															profile.primaryModelId)
														: t("translate.profiles.noPrimaryModel")}
													{" · "}
													{t("translate.profiles.fallbackCount", {
														count: profile.fallbackCount,
													})}
												</p>
											</button>
										</li>
									);
								})}
							</ul>
						) : null}
					</div>

					<div className="shrink-0 border-t border-line p-gutter">
						<Button
							type="button"
							className={`${outlineButtonClassName} w-full bg-surface-2 hover:not-data-disabled:bg-surface-3`}
							onClick={startCreate}
						>
							{t("translate.profiles.createNew")}
						</Button>
					</div>
				</aside>

				{/* Editor panel */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-gutter">
					{modelsError ? (
						<p className="mb-3 text-body-tight text-error" role="alert">
							{modelsError}
						</p>
					) : null}

					{!showEditor && listEmpty ? (
						<div className="flex flex-1 flex-col items-start justify-center gap-3">
							<p className="text-body-tight text-neutral">{t("translate.profiles.emptyHint")}</p>
							<Button type="button" className={primaryButtonClassName} onClick={startCreate}>
								{t("translate.profiles.emptyCreate")}
							</Button>
						</div>
					) : null}

					{!showEditor && !listEmpty ? (
						<p className="text-body-tight text-neutral">{t("translate.profiles.selectHint")}</p>
					) : null}

					{editorLoading ? (
						<p className="text-body-tight text-neutral" aria-live="polite">
							{t("translate.profiles.loadingEditor")}
						</p>
					) : null}

					{editorError ? (
						<p className="text-body-tight text-error" role="alert">
							{editorError}
						</p>
					) : null}

					{draft && !editorLoading ? (
						<form
							className="flex max-w-3xl flex-col gap-6"
							onSubmit={(event) => {
								event.preventDefault();
								void handleSave();
							}}
						>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<h2 className="text-headline-sm font-bold text-on-surface">
									{draft.id
										? t("translate.profiles.editTitle")
										: t("translate.profiles.createTitle")}
								</h2>
								<label className="flex items-center gap-2 text-body-tight text-on-surface">
									<span className="text-label-sm text-neutral uppercase">
										{t("translate.profiles.enabledLabel")}
									</span>
									<Switch.Root
										checked={draft.enabled}
										disabled={enabledPending || savePending}
										onCheckedChange={(checked) => {
											void handleEnabledChange(checked);
										}}
										className={switchRootClassName}
									>
										<Switch.Thumb className={switchThumbClassName} />
									</Switch.Root>
								</label>
							</div>

							<div>
								<label
									className="mb-1 block text-body-tight font-medium text-on-surface"
									htmlFor="profile-name"
								>
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
								<div>
									<label
										className="mb-1 block text-body-tight font-medium text-on-surface"
										htmlFor="profile-source-lang"
									>
										{t("translate.sourceLanguage")}
									</label>
									<select
										id="profile-source-lang"
										className={selectClassName}
										value={draft.sourceLang}
										disabled={savePending}
										onChange={(event) => {
											updateDraft({ sourceLang: event.currentTarget.value as LanguageId });
										}}
									>
										{languageOptions.map((option) => (
											<option key={option.id} value={option.id}>
												{option.label}
											</option>
										))}
									</select>
								</div>
								<div>
									<label
										className="mb-1 block text-body-tight font-medium text-on-surface"
										htmlFor="profile-target-lang"
									>
										{t("translate.targetLanguage")}
									</label>
									<select
										id="profile-target-lang"
										className={selectClassName}
										value={draft.targetLang}
										disabled={savePending}
										onChange={(event) => {
											updateDraft({ targetLang: event.currentTarget.value as LanguageId });
										}}
									>
										{languageOptions.map((option) => (
											<option key={option.id} value={option.id}>
												{option.label}
											</option>
										))}
									</select>
								</div>
							</div>

							<div>
								<label
									className="mb-1 block text-body-tight font-medium text-on-surface"
									htmlFor="profile-primary-model"
								>
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
									<p className="mt-1 text-body-tight text-neutral">{t("translate.noModelsHint")}</p>
								) : null}
							</div>

							<div>
								<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
									<span className="text-body-tight font-medium text-on-surface">
										{t("translate.profiles.fallbackModels")}
									</span>
									<Button
										type="button"
										className={outlineButtonClassName}
										disabled={savePending || !canAddFallback}
										onClick={addFallback}
									>
										{t("translate.profiles.addFallback")}
									</Button>
								</div>
								{draft.fallbackModelIds.length === 0 ? (
									<p className="text-body-tight text-neutral">
										{t("translate.profiles.fallbackEmpty")}
									</p>
								) : (
									<ul className="space-y-2">
										{draft.fallbackModelIds.map((modelId, index) => (
											<li
												key={`fallback-${index}-${modelId}`}
												className="flex flex-wrap items-center gap-2 border border-line bg-surface-2 p-2"
											>
												<span className="w-6 shrink-0 text-center text-label-sm text-neutral">
													{index + 1}
												</span>
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
														<option value={modelId}>
															{modelLabelById.get(modelId) ?? modelId}
														</option>
													) : null}
												</select>
												<div className="flex shrink-0 gap-1">
													<Button
														type="button"
														className={outlineButtonClassName}
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
														className={outlineButtonClassName}
														disabled={
															savePending || index === draft.fallbackModelIds.length - 1
														}
														aria-label={t("translate.profiles.moveDown")}
														onClick={() => {
															moveFallback(index, 1);
														}}
													>
														↓
													</Button>
													<Button
														type="button"
														className={outlineButtonClassName}
														disabled={savePending}
														aria-label={t("translate.profiles.removeFallback")}
														onClick={() => {
															removeFallback(index);
														}}
													>
														{t("translate.profiles.removeFallback")}
													</Button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>

							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<div>
									<label
										className="mb-1 block text-body-tight font-medium text-on-surface"
										htmlFor="profile-temperature"
									>
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
									<p className="mt-1 text-label-sm text-neutral">
										{t("common.default", { value: DEFAULT_TEMPERATURE })}
									</p>
								</div>
								<div>
									<label
										className="mb-1 block text-body-tight font-medium text-on-surface"
										htmlFor="profile-max-tokens"
									>
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
									<p className="mt-1 text-label-sm text-neutral">
										{t("common.default", { value: DEFAULT_MAX_OUTPUT_TOKENS })}
									</p>
								</div>
							</div>

							<div>
								<label
									className="mb-1 block text-body-tight font-medium text-on-surface"
									htmlFor="profile-system-template"
								>
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
								<p className="mt-1 text-label-sm text-neutral">{templateVarsHint}</p>
							</div>

							<div>
								<label
									className="mb-1 block text-body-tight font-medium text-on-surface"
									htmlFor="profile-user-template"
								>
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
								<p className="mt-1 text-label-sm text-neutral">{templateVarsHint}</p>
							</div>

							{saveError ? (
								<p className="text-body-tight text-error" role="alert">
									{saveError}
								</p>
							) : null}

							<div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
								<Button
									type="submit"
									className={primaryButtonClassName}
									disabled={savePending}
									focusableWhenDisabled
								>
									{savePending ? t("common.saving") : t("common.save")}
								</Button>
								{draft.id ? (
									<Button
										type="button"
										className={dangerButtonClassName}
										disabled={savePending}
										onClick={() => {
											setDeleteOpen(true);
										}}
									>
										{t("common.delete")}
									</Button>
								) : null}
							</div>
						</form>
					) : null}
				</div>
			</div>

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title={t("translate.profiles.deleteTitle")}
				description={
					draft?.name
						? t("translate.profileDeleteConfirm", { name: draft.name })
						: t("translate.profiles.deleteTitle")
				}
				confirmText={t("common.delete")}
				pendingText={t("common.deleting")}
				danger
				onConfirm={handleDelete}
			/>
		</div>
	);
}
