// ABOUTME: General translation index page with source/target panes and streaming.
// ABOUTME: Nested under /translate; selects profiles and calls provider models via IPC.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightArrowForward from "~icons/material-symbols-light/arrow-forward";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightShare from "~icons/material-symbols-light/share";
import IconMaterialSymbolsLightStar from "~icons/material-symbols-light/star";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import IconMaterialSymbolsLightVerifiedUser from "~icons/material-symbols-light/verified-user";
import IconMaterialSymbolsLightVolumeUp from "~icons/material-symbols-light/volume-up";
import { useToast } from "../../components/toast/useToast";
import { iconButtonClassName, outlineButtonClassName, primaryButtonClassName } from "../../components/ui";
import { shouldApplyProfileResult } from "../../query/profileApplyGuard";
import {
	allProviderModelsOptions,
	profileDetailOptions,
	profileListOptions,
	providerListOptions,
} from "../../query/options";
import {
	cancelTranslate,
	TRANSLATE_CHUNK_EVENT,
	TRANSLATE_DONE_EVENT,
	TRANSLATE_ERROR_EVENT,
	TRANSLATE_RESET_EVENT,
	translateText,
	translateTextStream,
} from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type {
	ProviderInstanceDto,
	ProviderModelDto,
	TranslateStreamChunk,
	TranslateStreamDone,
	TranslateStreamError,
	TranslateStreamReset,
} from "../../storage/types";

export const Route = createFileRoute("/translate/")({
	component: TranslatePage,
});

/** Viewport minus titlebar-height and main vertical padding (2 × gutter). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-var(--spacing-titlebar-height)-2*var(--spacing-gutter))]";

const MAX_SOURCE_CHARS = 5000;
/** Auto-dismiss for the user-cancel "Stopped" toast. */
const STOPPED_TOAST_MS = 2000;

const LANGUAGE_IDS = ["zh", "en", "ja", "ko", "fr", "de", "es"] as const;
type LanguageId = (typeof LANGUAGE_IDS)[number];

/** Toolbar-width select (shared select token is w-full). */
const compactSelectClassName =
	"h-control-height rounded-none border border-line bg-surface px-3 text-body-tight font-normal text-on-surface focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

const paneHeaderClassName =
	"flex h-control-height shrink-0 items-center justify-between border-b border-line bg-surface-2 px-2";

const paneLabelClassName = "text-label-sm font-bold tracking-wide text-on-surface uppercase";

type ModelOption = {
	id: string;
	label: string;
};

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

function newRequestId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `translate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function TranslatePage() {
	const { t } = useTranslation();
	const toast = useToast();
	const queryClient = useQueryClient();
	const [sourceLang, setSourceLang] = useState<LanguageId>("zh");
	const [targetLang, setTargetLang] = useState<LanguageId>("en");
	const [sourceText, setSourceText] = useState("");
	const [outputText, setOutputText] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [hasTranslated, setHasTranslated] = useState(false);
	const [confidencePercent, setConfidencePercent] = useState(0);
	const [latencyMs, setLatencyMs] = useState<number | null>(null);
	const [copyFeedback, setCopyFeedback] = useState(false);
	const [isTranslating, setIsTranslating] = useState(false);
	const [useStreaming, setUseStreaming] = useState(true);
	const [activeModelLabel, setActiveModelLabel] = useState<string | null>(null);

	const [selectedModelId, setSelectedModelId] = useState("");
	const [selectedProfileId, setSelectedProfileId] = useState("");
	const [profileApplyError, setProfileApplyError] = useState<string | null>(null);

	const providersQuery = useQuery(providerListOptions());
	const modelsQuery = useQuery(allProviderModelsOptions());
	const profilesQuery = useQuery(profileListOptions());

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

	const profiles = useMemo(() => (profilesQuery.data ?? []).filter((profile) => profile.enabled), [profilesQuery.data]);
	const profilesLoading = profilesQuery.isLoading;
	const profilesError =
		profilesQuery.error != null
			? getIpcErrorMessage(profilesQuery.error, t("translate.profileLoadFailed"))
			: profileApplyError;

	// Keep selection valid when options change after invalidation (derived, no effect).
	const resolvedModelId =
		selectedModelId && modelOptions.some((option) => option.id === selectedModelId)
			? selectedModelId
			: (modelOptions[0]?.id ?? "");
	const resolvedProfileId = profiles.some((profile) => profile.id === selectedProfileId) ? selectedProfileId : "";

	/** Monotonic local counter + backend stream request id for cancellation. */
	const translateGeneration = useRef(0);
	/** Guards out-of-order profile apply responses when the user switches quickly. */
	const profileApplyGeneration = useRef(0);
	const activeRequestId = useRef<string | null>(null);
	const streamUnlisteners = useRef<UnlistenFn[]>([]);

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

	const clearStreamListeners = useCallback(() => {
		for (const unlisten of streamUnlisteners.current) {
			unlisten();
		}
		streamUnlisteners.current = [];
	}, []);

	const abortActiveRequest = useCallback(async () => {
		const requestId = activeRequestId.current;
		activeRequestId.current = null;
		clearStreamListeners();
		if (!requestId) {
			return;
		}
		try {
			await cancelTranslate(requestId);
		} catch {
			// Request may already have finished; ignore cancel IPC failures.
		}
	}, [clearStreamListeners]);

	useEffect(() => {
		return () => {
			translateGeneration.current += 1;
			void abortActiveRequest();
		};
	}, [abortActiveRequest]);

	const charCount = sourceText.length;
	const canTranslate = sourceText.trim().length > 0 && resolvedModelId.length > 0 && !isTranslating && !modelsLoading;

	async function applyProfile(profileId: string) {
		const generation = ++profileApplyGeneration.current;
		if (!profileId) {
			setSelectedProfileId("");
			setProfileApplyError(null);
			return;
		}
		// Optimistic selection so the control tracks the latest user choice immediately.
		setSelectedProfileId(profileId);
		setProfileApplyError(null);
		try {
			const dto = await queryClient.fetchQuery(profileDetailOptions(profileId));
			if (!shouldApplyProfileResult(generation, profileApplyGeneration.current)) {
				return;
			}

			const primaryTarget = [...dto.targets].sort((a, b) => a.priority - b.priority)[0];
			if (primaryTarget && modelOptions.some((option) => option.id === primaryTarget.providerModelId)) {
				setSelectedModelId(primaryTarget.providerModelId);
			}
			if (isLanguageId(dto.sourceLang)) {
				setSourceLang(dto.sourceLang);
			}
			if (isLanguageId(dto.targetLang)) {
				setTargetLang(dto.targetLang);
			}
		} catch (err) {
			if (!shouldApplyProfileResult(generation, profileApplyGeneration.current)) {
				return;
			}
			setProfileApplyError(getIpcErrorMessage(err, t("translate.profileLoadFailed")));
		}
	}

	function swapLanguages() {
		setSourceLang(targetLang);
		setTargetLang(sourceLang);
		if (outputText && !errorMessage) {
			setSourceText(outputText);
			setOutputText(sourceText);
		}
	}

	function showStoppedToast() {
		toast.info({ title: t("translate.cancelled"), duration: STOPPED_TOAST_MS });
	}

	/** Map known backend error codes to localized copy; fall back to server message. */
	function resolveTranslateFailureMessage(errorCode: string | null | undefined, message: string | undefined): string {
		if (errorCode === "timeout") {
			return t("translate.errors.timeout");
		}
		return message || t("translate.errorPrefix");
	}

	async function stopTranslation() {
		// Bump generation so late chunks/errors are ignored; toast here because listeners
		// are cleared in abort and the cancelled done event may never reach finishCancelledUi.
		const hadActive = activeRequestId.current != null;
		translateGeneration.current += 1;
		setIsTranslating(false);
		setErrorMessage(null);
		await abortActiveRequest();
		if (hadActive) {
			showStoppedToast();
		}
	}

	async function clearSource() {
		const hadActive = activeRequestId.current != null;
		translateGeneration.current += 1;
		await abortActiveRequest();
		setSourceText("");
		setOutputText("");
		setErrorMessage(null);
		setHasTranslated(false);
		setConfidencePercent(0);
		setLatencyMs(null);
		setIsTranslating(false);
		setActiveModelLabel(null);
		if (hadActive) {
			showStoppedToast();
		}
	}

	function beginTranslateUi() {
		setIsTranslating(true);
		setErrorMessage(null);
		setOutputText("");
		setHasTranslated(false);
		setConfidencePercent(0);
		setLatencyMs(null);
		setActiveModelLabel(null);
	}

	function finishSuccessUi(generation: number, text: string, latency: number, modelId?: string | null) {
		if (generation !== translateGeneration.current) {
			return;
		}
		setLatencyMs(latency);
		setHasTranslated(true);
		setOutputText(text);
		setErrorMessage(null);
		if (modelId) {
			setActiveModelLabel(modelLabelById.get(modelId) ?? modelId);
		}
		window.requestAnimationFrame(() => {
			if (generation === translateGeneration.current) {
				setConfidencePercent(94);
			}
		});
		setIsTranslating(false);
	}

	function finishErrorUi(generation: number, message: string, latency: number | null) {
		if (generation !== translateGeneration.current) {
			return;
		}
		setHasTranslated(true);
		setOutputText("");
		setLatencyMs(latency);
		setConfidencePercent(0);
		setErrorMessage(message);
		setActiveModelLabel(null);
		setIsTranslating(false);
	}

	function finishCancelledUi(generation: number) {
		if (generation !== translateGeneration.current) {
			return;
		}
		setIsTranslating(false);
		// Keep partial progressive text if any; do not mark as hard error.
		setErrorMessage(null);
		// User cancel that completed with matching generation (e.g. non-stream IPC).
		showStoppedToast();
	}

	async function handleTranslateStreaming(
		generation: number,
		payload: {
			modelId: string;
			sourceLang: string;
			targetLang: string;
			text: string;
			profileId?: string | null;
		},
		requestId: string,
	) {
		clearStreamListeners();

		const onChunk = (event: { payload: TranslateStreamChunk }) => {
			const chunk = event.payload;
			if (generation !== translateGeneration.current) {
				return;
			}
			if (chunk.id !== activeRequestId.current) {
				return;
			}
			setOutputText((prev) => prev + chunk.delta);
			setHasTranslated(true);
		};

		const onReset = (event: { payload: TranslateStreamReset }) => {
			const reset = event.payload;
			if (generation !== translateGeneration.current) {
				return;
			}
			if (reset.id !== activeRequestId.current) {
				return;
			}
			// Drop partial text from the failed model before fallback chunks arrive.
			setOutputText("");
			setActiveModelLabel(modelLabelById.get(reset.modelId) ?? reset.modelId);
		};

		const onDone = (event: { payload: TranslateStreamDone }) => {
			const done = event.payload;
			if (generation !== translateGeneration.current) {
				return;
			}
			if (done.id !== activeRequestId.current) {
				return;
			}
			clearStreamListeners();
			activeRequestId.current = null;
			if (done.errorCode === "cancelled") {
				finishCancelledUi(generation);
				return;
			}
			if (done.ok) {
				// Prefer full text from the server so we do not drift on partial assembly.
				finishSuccessUi(generation, done.translatedText, done.latencyMs, done.modelId);
			} else {
				finishErrorUi(generation, resolveTranslateFailureMessage(done.errorCode, done.message), done.latencyMs);
			}
		};

		const onError = (event: { payload: TranslateStreamError }) => {
			const err = event.payload;
			if (generation !== translateGeneration.current) {
				return;
			}
			if (err.id !== activeRequestId.current) {
				return;
			}
			clearStreamListeners();
			activeRequestId.current = null;
			if (err.errorCode === "cancelled") {
				finishCancelledUi(generation);
				return;
			}
			finishErrorUi(generation, resolveTranslateFailureMessage(err.errorCode, err.message), err.latencyMs);
		};

		activeRequestId.current = requestId;

		try {
			const [unChunk, unReset, unDone, unError] = await Promise.all([
				listen<TranslateStreamChunk>(TRANSLATE_CHUNK_EVENT, onChunk),
				listen<TranslateStreamReset>(TRANSLATE_RESET_EVENT, onReset),
				listen<TranslateStreamDone>(TRANSLATE_DONE_EVENT, onDone),
				listen<TranslateStreamError>(TRANSLATE_ERROR_EVENT, onError),
			]);
			if (generation !== translateGeneration.current) {
				unChunk();
				unReset();
				unDone();
				unError();
				return;
			}
			streamUnlisteners.current = [unChunk, unReset, unDone, unError];

			await translateTextStream(payload, requestId);
			if (generation !== translateGeneration.current) {
				clearStreamListeners();
			}
		} catch (err) {
			if (generation !== translateGeneration.current) {
				return;
			}
			clearStreamListeners();
			activeRequestId.current = null;
			finishErrorUi(generation, getIpcErrorMessage(err, t("translate.errorPrefix")), null);
		}
	}

	async function handleTranslate() {
		const trimmed = sourceText.trim();
		if (!trimmed) {
			return;
		}
		if (!resolvedModelId) {
			setErrorMessage(t("translate.selectModelFirst"));
			setOutputText("");
			setHasTranslated(true);
			setConfidencePercent(0);
			setLatencyMs(null);
			return;
		}

		// Cancel any prior in-flight request before starting a new one.
		const hadActive = activeRequestId.current != null;
		await abortActiveRequest();
		if (hadActive) {
			showStoppedToast();
		}
		const generation = ++translateGeneration.current;
		beginTranslateUi();

		const sourceLabel = t(`translate.languages.${sourceLang}`);
		const targetLabel = t(`translate.languages.${targetLang}`);
		const payload = {
			modelId: resolvedModelId,
			sourceLang: sourceLabel,
			targetLang: targetLabel,
			text: trimmed,
			profileId: resolvedProfileId || null,
		};
		const requestId = newRequestId();
		activeRequestId.current = requestId;

		if (useStreaming) {
			await handleTranslateStreaming(generation, payload, requestId);
			return;
		}

		try {
			const result = await translateText(payload, requestId);
			if (generation !== translateGeneration.current) {
				return;
			}
			activeRequestId.current = null;
			if (result.errorCode === "cancelled") {
				finishCancelledUi(generation);
				return;
			}
			if (result.ok) {
				finishSuccessUi(generation, result.translatedText, result.latencyMs, result.modelId);
			} else {
				finishErrorUi(generation, resolveTranslateFailureMessage(result.errorCode, result.message), result.latencyMs);
			}
		} catch (err) {
			if (generation !== translateGeneration.current) {
				return;
			}
			activeRequestId.current = null;
			finishErrorUi(generation, getIpcErrorMessage(err, t("translate.errorPrefix")), null);
		}
	}

	async function copyOutput() {
		if (!outputText) {
			return;
		}
		try {
			await navigator.clipboard.writeText(outputText);
			setCopyFeedback(true);
			window.setTimeout(() => {
				setCopyFeedback(false);
			}, 1500);
		} catch {
			// Clipboard may be unavailable outside a secure context; ignore quietly.
		}
	}

	const modelSelectDisabled = modelsLoading || modelOptions.length === 0;
	const profileSelectDisabled = profilesLoading;

	return (
		<div className={`${LAYOUT_HEIGHT_CLASS} flex min-h-0 flex-col gap-gutter`}>
			{/* Top toolbar: profile + model + languages + utility actions */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border border-line bg-surface-2 px-gutter py-2">
				<div className="flex min-w-0 flex-wrap items-center gap-gutter">
					<div className="flex items-center gap-2">
						<label className="text-label-sm text-neutral uppercase" htmlFor="translate-profile">
							{t("translate.profileLabel")}
						</label>
						<select
							id="translate-profile"
							className={`${compactSelectClassName} max-w-xs`}
							value={resolvedProfileId}
							disabled={profileSelectDisabled || isTranslating}
							aria-label={t("translate.profileAria")}
							onChange={(event) => {
								void applyProfile(event.currentTarget.value);
							}}
						>
							<option value="">{profilesLoading ? t("translate.profileLoading") : t("translate.profileNone")}</option>
							{profiles.map((profile) => (
								<option key={profile.id} value={profile.id}>
									{profile.name}
								</option>
							))}
						</select>
						<Link
							to="/translate/profiles"
							className={`${outlineButtonClassName} no-underline`}
							aria-label={t("translate.profileManage")}
						>
							{t("translate.profileManage")}
						</Link>
					</div>

					<div className="hidden h-6 w-px bg-outline-variant sm:block" aria-hidden />

					<div className="flex items-center gap-2">
						<label className="text-label-sm text-neutral uppercase" htmlFor="translate-model">
							{t("translate.modelLabel")}
						</label>
						<select
							id="translate-model"
							className={`${compactSelectClassName} max-w-xs`}
							value={resolvedModelId}
							disabled={modelSelectDisabled || isTranslating}
							aria-label={t("translate.modelAria")}
							onChange={(event) => {
								setSelectedModelId(event.currentTarget.value);
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
					</div>

					<div className="hidden h-6 w-px bg-outline-variant sm:block" aria-hidden />

					<div className="flex flex-wrap items-center gap-1">
						<label className="sr-only" htmlFor="translate-source-lang">
							{t("translate.sourceLanguage")}
						</label>
						<select
							id="translate-source-lang"
							className={compactSelectClassName}
							value={sourceLang}
							disabled={isTranslating}
							onChange={(event) => {
								setSourceLang(event.currentTarget.value as LanguageId);
							}}
						>
							{languageOptions.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</select>

						<Button
							type="button"
							className={iconButtonClassName}
							aria-label={t("translate.swapLanguages")}
							onClick={swapLanguages}
							disabled={isTranslating}
						>
							<IconMaterialSymbolsLightSwapHoriz className="size-5" aria-hidden />
						</Button>

						<label className="sr-only" htmlFor="translate-target-lang">
							{t("translate.targetLanguage")}
						</label>
						<select
							id="translate-target-lang"
							className={compactSelectClassName}
							value={targetLang}
							disabled={isTranslating}
							onChange={(event) => {
								setTargetLang(event.currentTarget.value as LanguageId);
							}}
						>
							{languageOptions.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</select>
					</div>

					<div className="hidden h-6 w-px bg-outline-variant sm:block" aria-hidden />

					<label className="flex items-center gap-2 text-body-tight text-on-surface">
						<input
							type="checkbox"
							className="size-4 shrink-0 rounded-none border border-line accent-on-surface"
							checked={useStreaming}
							disabled={isTranslating}
							aria-label={t("translate.streamAria")}
							onChange={(event) => {
								setUseStreaming(event.currentTarget.checked);
							}}
						/>
						<span className="text-label-sm text-neutral uppercase">{t("translate.streamLabel")}</span>
					</label>
				</div>

				<div className="flex items-center gap-2">
					<Button
						type="button"
						className={`${iconButtonClassName} size-control-height border border-line`}
						aria-label={t("translate.share")}
						disabled
					>
						<IconMaterialSymbolsLightShare className="size-4" aria-hidden />
					</Button>
					<Button
						type="button"
						className={`${iconButtonClassName} size-control-height border border-line`}
						aria-label={t("translate.favorite")}
						disabled
					>
						<IconMaterialSymbolsLightStar className="size-4" aria-hidden />
					</Button>
				</div>
			</div>

			{modelsError ? (
				<p className="shrink-0 text-body-tight text-error" role="alert">
					{modelsError}
				</p>
			) : null}
			{profilesError ? (
				<p className="shrink-0 text-body-tight text-error" role="alert">
					{profilesError}
				</p>
			) : null}
			{!modelsLoading && !modelsError && modelOptions.length === 0 ? (
				<p className="shrink-0 text-body-tight text-neutral" role="status">
					{t("translate.noModelsHint")}
				</p>
			) : null}

			{/* Source / target workspace */}
			<div className="grid min-h-0 flex-1 grid-cols-1 gap-gutter lg:grid-cols-2">
				{/* Source pane */}
				<section className="shadow-frame flex min-h-64 flex-col border border-line bg-surface lg:min-h-0">
					<div className={paneHeaderClassName}>
						<span className={paneLabelClassName}>{t("translate.source")}</span>
						<Button
							type="button"
							className={iconButtonClassName}
							aria-label={t("translate.clearSource")}
							onClick={() => {
								void clearSource();
							}}
							disabled={!sourceText && !outputText && !errorMessage && !isTranslating}
						>
							<IconMaterialSymbolsLightClose className="size-4" aria-hidden />
						</Button>
					</div>

					<div className="relative min-h-0 flex-1">
						<label className="sr-only" htmlFor="translate-source-text">
							{t("translate.sourceTextAria")}
						</label>
						<textarea
							id="translate-source-text"
							className="h-full min-h-40 w-full resize-none rounded-none border-0 bg-transparent p-gutter text-body-md text-on-surface placeholder:text-neutral focus:outline-none lg:min-h-0"
							placeholder={t("translate.sourcePlaceholder")}
							spellCheck={false}
							maxLength={MAX_SOURCE_CHARS}
							value={sourceText}
							disabled={isTranslating}
							onChange={(event) => {
								setSourceText(event.currentTarget.value);
								setHasTranslated(false);
								setErrorMessage(null);
								setConfidencePercent(0);
								setLatencyMs(null);
							}}
						/>
						<div className="pointer-events-none absolute bottom-3 left-3 text-label-sm text-neutral">
							{t("translate.charCount", { count: charCount, max: MAX_SOURCE_CHARS })}
						</div>
					</div>

					<div className="flex shrink-0 justify-end gap-2 border-t border-line bg-surface p-gutter">
						{isTranslating ? (
							<Button
								type="button"
								className={outlineButtonClassName}
								aria-label={t("translate.stopAria")}
								onClick={() => {
									void stopTranslation();
								}}
							>
								{t("translate.stop")}
							</Button>
						) : null}
						<Button
							type="button"
							className={primaryButtonClassName}
							disabled={!canTranslate}
							focusableWhenDisabled
							onClick={() => {
								void handleTranslate();
							}}
						>
							<span>{isTranslating ? t("translate.translating") : t("translate.translate")}</span>
							<IconMaterialSymbolsLightArrowForward className="size-4" aria-hidden />
						</Button>
					</div>
				</section>

				{/* Translation pane */}
				<section className="shadow-frame flex min-h-64 flex-col border border-line bg-surface-2 lg:min-h-0">
					<div className={paneHeaderClassName}>
						<span className={paneLabelClassName}>{t("translate.translation")}</span>
						<div className="flex items-center gap-1">
							<Button
								type="button"
								className={iconButtonClassName}
								aria-label={copyFeedback ? t("translate.copied") : t("translate.copy")}
								onClick={() => {
									void copyOutput();
								}}
								disabled={!outputText || !!errorMessage}
							>
								<IconMaterialSymbolsLightContentCopy className="size-4" aria-hidden />
							</Button>
							<Button type="button" className={iconButtonClassName} aria-label={t("translate.speak")} disabled>
								<IconMaterialSymbolsLightVolumeUp className="size-4" aria-hidden />
							</Button>
						</div>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-gutter overflow-auto p-gutter">
						{errorMessage ? (
							<p className="whitespace-pre-wrap text-body-md text-error select-text" role="alert">
								{t("translate.errorPrefix")}: {errorMessage}
							</p>
						) : outputText ? (
							<p className="whitespace-pre-wrap text-body-md text-on-surface select-text">{outputText}</p>
						) : isTranslating ? (
							<p className="text-body-md text-neutral italic select-none" role="status">
								{t("translate.translating")}
							</p>
						) : hasTranslated ? (
							<p className="text-body-md text-neutral italic select-none">{t("translate.outputPlaceholder")}</p>
						) : (
							<p className="text-body-md text-neutral italic select-none">{t("translate.outputPlaceholder")}</p>
						)}

						{activeModelLabel ? (
							<p className="text-label-sm text-neutral">{t("translate.activeModel", { model: activeModelLabel })}</p>
						) : null}

						<div className="mt-auto space-y-4">
							<div className="h-px w-full bg-outline-variant" />
							<div className="grid grid-cols-2 gap-4">
								<div className="border border-outline-variant bg-surface p-2">
									<p className="mb-1 text-table-header text-neutral uppercase">{t("translate.confidence")}</p>
									<div className="h-1 w-full overflow-hidden bg-surface-3">
										<div
											className="h-full bg-on-surface transition-all duration-1000"
											style={{ width: `${confidencePercent}%` }}
										/>
									</div>
								</div>
								<div className="border border-outline-variant bg-surface p-2">
									<p className="mb-1 text-table-header text-neutral uppercase">{t("translate.latency")}</p>
									<p className="text-body-tight font-bold text-on-surface">
										{latencyMs === null ? t("translate.latencyEmpty") : t("translate.latencyValue", { ms: latencyMs })}
									</p>
								</div>
							</div>
						</div>
					</div>

					<div className="flex shrink-0 flex-wrap items-center gap-4 border-t border-line bg-surface-2 p-gutter">
						<Button type="button" className={outlineButtonClassName} disabled>
							{t("translate.addToGlossary")}
						</Button>
						<div className="flex-1" />
						<div className="flex items-center gap-2 text-neutral">
							<IconMaterialSymbolsLightVerifiedUser className="size-4" aria-hidden />
							<span className="text-table-header uppercase">{t("translate.aiGenerated")}</span>
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}
