// ABOUTME: Always-on-top Quick Translate window: multi-preset parallel translation UI.
// ABOUTME: Independent webview route (not a main-window modal); slots may repeat profiles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import { TitleBar } from "../components/Win/TitleBar";
import { ComboboxField } from "../components/ComboboxField";
import { SelectField } from "../components/SelectField";
import { iconButtonClassName } from "../components/ui";
import { QUICK_TRANSLATE_CLIPBOARD_TEXT } from "../query/events";
import {
	allProviderModelsOptions,
	profileDetailOptions,
	profileListOptions,
	providerListOptions,
} from "../query/options";
import { cancelTranslate, detectLanguage, translateText } from "../storage/client";
import { getIpcErrorMessage } from "../storage/errors";
import type { TranslationProfileDto } from "../storage/types";
import {
	AUTO_LANGUAGE,
	LANGUAGE_IDS,
	getDefaultProfileLanguages,
	isLanguageId,
	isSelectableLanguageId,
	resolveProfileLangPrefs,
	resolveTargetLanguage,
	type LanguageId,
	type SelectableLanguageId,
	type SourceLanguageId,
} from "./translate/-languages";

export const Route = createFileRoute("/quick-translate")({
	component: QuickTranslatePage,
});

/** Debounce before auto-running all slot translations after source/lang changes. */
const TRANSLATE_DEBOUNCE_MS = 500;

const SESSION_KEY = "langnext-quick-translate-session";

type Slot = {
	/** Stable slot instance id (allows the same profile more than once). */
	id: string;
	profileId: string;
};

type SlotResult = {
	text: string;
	error: string | null;
	isTranslating: boolean;
};

type SessionState = {
	sourceLang: SourceLanguageId;
	targetLang: SelectableLanguageId;
	slots: Slot[];
};

function newId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `qt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadSession(): SessionState {
	const fallback: SessionState = {
		sourceLang: "auto",
		targetLang: "zh",
		slots: [],
	};
	if (typeof window === "undefined") {
		return fallback;
	}
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) {
			return fallback;
		}
		const parsed = JSON.parse(raw) as Partial<SessionState>;
		const sourceLang = isSelectableLanguageId(parsed.sourceLang) ? parsed.sourceLang : fallback.sourceLang;
		const targetLang = isSelectableLanguageId(parsed.targetLang) ? parsed.targetLang : fallback.targetLang;
		const slots = Array.isArray(parsed.slots)
			? parsed.slots
					.filter(
						(slot): slot is Slot =>
							!!slot &&
							typeof slot === "object" &&
							typeof (slot as Slot).id === "string" &&
							typeof (slot as Slot).profileId === "string",
					)
					.map((slot) => ({ id: slot.id, profileId: slot.profileId }))
			: [];
		return { sourceLang, targetLang, slots };
	} catch {
		return fallback;
	}
}

function saveSession(state: SessionState): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		localStorage.setItem(SESSION_KEY, JSON.stringify(state));
	} catch {
		// Ignore quota / private-mode failures.
	}
}

function primaryModelId(profile: TranslationProfileDto | undefined): string {
	if (!profile) {
		return "";
	}
	const primary = [...profile.targets].sort((a, b) => a.priority - b.priority)[0];
	return primary?.providerModelId ?? "";
}

const emptyResult: SlotResult = { text: "", error: null, isTranslating: false };

function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const menuPopupClassName =
	"min-w-48 origin-(--transform-origin) border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const menuItemClassName =
	"flex cursor-default items-center px-3 py-1.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

const leadingButtonClassName =
	"inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-none border-0 bg-transparent text-on-surface select-none hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-popup-open:bg-surface-2 data-disabled:text-disabled";

function QuickTranslatePage() {
	const { t, i18n } = useTranslation();
	const queryClient = useQueryClient();
	const [sessionSeed] = useState(() => loadSession());

	const [sourceText, setSourceText] = useState("");
	const [sourceLang, setSourceLang] = useState<SourceLanguageId>(sessionSeed.sourceLang);
	const [targetLang, setTargetLang] = useState<SelectableLanguageId>(sessionSeed.targetLang);
	const [slots, setSlots] = useState<Slot[]>(sessionSeed.slots);
	const [results, setResults] = useState<Record<string, SlotResult>>({});
	const [copiedSlotId, setCopiedSlotId] = useState<string | null>(null);
	const [detectedSourceLang, setDetectedSourceLang] = useState<LanguageId | null>(null);
	const [isPinned, setIsPinned] = useState(false);

	const profilesQuery = useQuery(profileListOptions());
	const providersQuery = useQuery(providerListOptions());
	const modelsQuery = useQuery(allProviderModelsOptions());

	const profiles = useMemo(() => (profilesQuery.data ?? []).filter((profile) => profile.enabled), [profilesQuery.data]);
	const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);

	const enabledModelIds = useMemo(() => {
		const providers = providersQuery.data ?? [];
		const models = modelsQuery.data ?? [];
		const providerById = new Map(providers.map((provider) => [provider.id, provider]));
		const ids = new Set<string>();
		for (const model of models) {
			if (!model.enabled || model.availability === "missing") {
				continue;
			}
			const provider = providerById.get(model.providerInstanceId);
			if (provider?.enabled) {
				ids.add(model.id);
			}
		}
		return ids;
	}, [providersQuery.data, modelsQuery.data]);

	const sourceLanguageOptions = useMemo(
		() => [
			{ id: "auto", label: t("translate.languages.auto") },
			...LANGUAGE_IDS.map((id) => ({ id, label: t(`translate.languages.${id}`) })),
		],
		[t],
	);

	const targetLanguageOptions = useMemo(
		() => [
			{ id: AUTO_LANGUAGE, label: t("translate.languages.auto") },
			...LANGUAGE_IDS.map((id) => ({ id, label: t(`translate.languages.${id}`) })),
		],
		[t],
	);

	const profileSelectOptions = useMemo(
		() => profiles.map((profile) => ({ value: profile.id, label: profile.name })),
		[profiles],
	);

	// Persist session selections across opens of this window.
	useEffect(() => {
		saveSession({ sourceLang, targetLang, slots });
	}, [sourceLang, targetLang, slots]);

	// Double Ctrl+C: backend emits clipboard text; set source so debounced auto-translate runs.
	useEffect(() => {
		if (!isTauriRuntime()) {
			return;
		}

		let unlisten: (() => void) | undefined;
		let cancelled = false;

		void listen<string>(QUICK_TRANSLATE_CLIPBOARD_TEXT, (event) => {
			if (cancelled) {
				return;
			}
			setSourceText(event.payload ?? "");
			setDetectedSourceLang(null);
		}).then((fn) => {
			if (cancelled) {
				fn();
				return;
			}
			unlisten = fn;
		});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	const handlePinChange = useCallback((next: boolean) => {
		setIsPinned(next);
		if (isTauriRuntime()) {
			void invoke("set_pin", { isPin: next });
		}
	}, []);

	const generationRef = useRef(0);
	const requestIdsRef = useRef<Map<string, string>>(new Map());
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const abortAll = useCallback(async () => {
		const ids = [...requestIdsRef.current.values()];
		requestIdsRef.current.clear();
		await Promise.all(
			ids.map(async (requestId) => {
				try {
					await cancelTranslate(requestId);
				} catch {
					// Request may already have finished.
				}
			}),
		);
	}, []);

	useEffect(() => {
		return () => {
			generationRef.current += 1;
			if (debounceTimerRef.current != null) {
				clearTimeout(debounceTimerRef.current);
			}
			void abortAll();
		};
	}, [abortAll]);

	const patchResult = useCallback((slotId: string, patch: Partial<SlotResult>) => {
		setResults((prev) => ({
			...prev,
			[slotId]: { ...(prev[slotId] ?? emptyResult), ...patch },
		}));
	}, []);

	const runTranslations = useCallback(async () => {
		const trimmed = sourceText.trim();
		if (!trimmed || slots.length === 0) {
			return;
		}

		const generation = ++generationRef.current;
		await abortAll();

		// Mark all slots as translating before concurrent work starts.
		setResults((prev) => {
			const next = { ...prev };
			for (const slot of slots) {
				next[slot.id] = { text: "", error: null, isTranslating: true };
			}
			return next;
		});

		// Prefer the first slot's profile for language detection when source is Auto.
		const detectProfileId = slots.find((slot) => slot.profileId)?.profileId ?? null;
		let detectModelId: string | null = null;
		if (detectProfileId) {
			try {
				const detail = await queryClient.fetchQuery(profileDetailOptions(detectProfileId));
				const modelId = primaryModelId(detail);
				detectModelId = modelId && enabledModelIds.has(modelId) ? modelId : null;
			} catch {
				detectModelId = null;
			}
		}

		let effectiveSourceId: LanguageId | null = sourceLang === "auto" ? null : sourceLang;

		if (sourceLang === "auto") {
			const detectRequestId = newId();
			requestIdsRef.current.set("__detect__", detectRequestId);
			try {
				const detected = await detectLanguage(
					{ text: trimmed, modelId: detectModelId, profileId: detectProfileId },
					detectRequestId,
				);
				if (generation !== generationRef.current) {
					return;
				}
				requestIdsRef.current.delete("__detect__");
				if (!detected.ok || !isLanguageId(detected.languageId)) {
					const message =
						detected.errorCode === "cancelled" ? null : detected.message || t("translate.errors.detectFailed");
					if (message) {
						setResults((prev) => {
							const next = { ...prev };
							for (const slot of slots) {
								next[slot.id] = { text: "", error: message, isTranslating: false };
							}
							return next;
						});
					}
					return;
				}
				setDetectedSourceLang(detected.languageId);
				effectiveSourceId = detected.languageId;
			} catch (err) {
				if (generation !== generationRef.current) {
					return;
				}
				requestIdsRef.current.delete("__detect__");
				const message = getIpcErrorMessage(err, t("translate.errors.detectFailed"));
				setResults((prev) => {
					const next = { ...prev };
					for (const slot of slots) {
						next[slot.id] = { text: "", error: message, isTranslating: false };
					}
					return next;
				});
				return;
			}
		} else {
			setDetectedSourceLang(null);
		}

		if (!effectiveSourceId || generation !== generationRef.current) {
			return;
		}

		const sourceId = effectiveSourceId;

		await Promise.all(
			slots.map(async (slot) => {
				const requestId = newId();
				requestIdsRef.current.set(slot.id, requestId);

				try {
					const profile = await queryClient.fetchQuery(profileDetailOptions(slot.profileId));
					if (generation !== generationRef.current) {
						return;
					}

					const modelId = primaryModelId(profile);
					if (!modelId || !enabledModelIds.has(modelId)) {
						patchResult(slot.id, {
							text: "",
							error: t("quickTranslate.noModel"),
							isTranslating: false,
						});
						requestIdsRef.current.delete(slot.id);
						return;
					}

					const defaults = getDefaultProfileLanguages(i18n.language);
					const primaryLang = isLanguageId(profile.primaryLang) ? profile.primaryLang : defaults.primary;
					const preferredTarget = isLanguageId(profile.preferredTargetLang)
						? profile.preferredTargetLang
						: defaults.target;
					const prefs = resolveProfileLangPrefs(true, primaryLang, preferredTarget, i18n.language);
					const effectiveTargetId = resolveTargetLanguage({
						source: sourceId,
						configuredTarget: targetLang,
						primary: prefs.primary,
						preferredTarget: prefs.preferredTarget,
					});

					const result = await translateText(
						{
							modelId,
							sourceLang: t(`translate.languages.${sourceId}`),
							targetLang: t(`translate.languages.${effectiveTargetId}`),
							text: trimmed,
							profileId: slot.profileId,
						},
						requestId,
					);

					if (generation !== generationRef.current) {
						return;
					}
					requestIdsRef.current.delete(slot.id);

					if (result.errorCode === "cancelled") {
						patchResult(slot.id, { isTranslating: false });
						return;
					}
					if (result.ok) {
						patchResult(slot.id, {
							text: result.translatedText,
							error: null,
							isTranslating: false,
						});
					} else {
						patchResult(slot.id, {
							text: "",
							error: result.message || t("translate.errorPrefix"),
							isTranslating: false,
						});
					}
				} catch (err) {
					if (generation !== generationRef.current) {
						return;
					}
					requestIdsRef.current.delete(slot.id);
					patchResult(slot.id, {
						text: "",
						error: getIpcErrorMessage(err, t("translate.errorPrefix")),
						isTranslating: false,
					});
				}
			}),
		);
	}, [
		abortAll,
		enabledModelIds,
		i18n.language,
		patchResult,
		queryClient,
		slots,
		sourceLang,
		sourceText,
		t,
		targetLang,
	]);

	// Debounced auto-translate when source text, languages, or slots change.
	useEffect(() => {
		if (debounceTimerRef.current != null) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}

		const trimmed = sourceText.trim();
		if (!trimmed || slots.length === 0) {
			return;
		}

		debounceTimerRef.current = setTimeout(() => {
			debounceTimerRef.current = null;
			void runTranslations();
		}, TRANSLATE_DEBOUNCE_MS);

		return () => {
			if (debounceTimerRef.current != null) {
				clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
		};
	}, [sourceText, sourceLang, targetLang, slots, runTranslations]);

	function addSlot(profileId: string) {
		setSlots((prev) => [...prev, { id: newId(), profileId }]);
	}

	function removeSlot(slotId: string) {
		setSlots((prev) => prev.filter((slot) => slot.id !== slotId));
		setResults((prev) => {
			const next = { ...prev };
			delete next[slotId];
			return next;
		});
		const requestId = requestIdsRef.current.get(slotId);
		if (requestId) {
			requestIdsRef.current.delete(slotId);
			void cancelTranslate(requestId).catch(() => {});
		}
	}

	function updateSlotProfile(slotId: string, profileId: string) {
		setSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, profileId } : slot)));
	}

	function swapLanguages() {
		// Effective concrete source: manual selection or the last detection result.
		const effectiveSource: LanguageId | null = sourceLang === "auto" ? detectedSourceLang : sourceLang;
		// No concrete source to swap with -> safe no-op.
		if (!effectiveSource) {
			return;
		}
		if (targetLang === "auto") {
			// Auto target: resolve a concrete target from the first slot's profile (or UI defaults).
			const firstProfile = slots.map((slot) => profileById.get(slot.profileId)).find(Boolean);
			const defaults = getDefaultProfileLanguages(i18n.language);
			const primaryLang =
				firstProfile && isLanguageId(firstProfile.primaryLang) ? firstProfile.primaryLang : defaults.primary;
			const preferredTarget =
				firstProfile && isLanguageId(firstProfile.preferredTargetLang)
					? firstProfile.preferredTargetLang
					: defaults.target;
			const prefs = resolveProfileLangPrefs(true, primaryLang, preferredTarget, i18n.language);
			const effectiveTarget = resolveTargetLanguage({
				source: effectiveSource,
				configuredTarget: AUTO_LANGUAGE,
				primary: prefs.primary,
				preferredTarget: prefs.preferredTarget,
			});
			setSourceLang(effectiveTarget);
			setTargetLang(effectiveSource);
		} else {
			setSourceLang(targetLang);
			setTargetLang(effectiveSource);
		}
		setDetectedSourceLang(null);
	}

	async function copySlot(slotId: string) {
		const text = results[slotId]?.text;
		if (!text) {
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			setCopiedSlotId(slotId);
			window.setTimeout(() => {
				setCopiedSlotId((current) => (current === slotId ? null : current));
			}, 1500);
		} catch {
			// Clipboard may be unavailable outside a secure context.
		}
	}

	const profilesLoading = profilesQuery.isLoading;
	const profilesError =
		profilesQuery.error != null ? getIpcErrorMessage(profilesQuery.error, t("translate.profileLoadFailed")) : null;
	const isTranslating = Object.values(results).some((result) => result.isTranslating);

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface text-on-surface">
			<TitleBar
				title={t("quickTranslate.title")}
				minimize={false}
				maximized={false}
				close
				pin
				pinned={isPinned}
				onPinChange={handlePinChange}
				leading={
					<Menu.Root>
						<Menu.Trigger
							className={leadingButtonClassName}
							aria-label={t("quickTranslate.addPreset")}
							disabled={profilesLoading || profiles.length === 0}
						>
							<IconMaterialSymbolsLightAdd className="pointer-events-none size-4" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner className="outline-hidden z-50" sideOffset={4} align="start">
								<Menu.Popup className={`${menuPopupClassName} max-h-64 overflow-y-auto py-1`}>
									{profiles.length === 0 ? (
										<Menu.Item className={menuItemClassName} disabled>
											{t("quickTranslate.noProfiles")}
										</Menu.Item>
									) : (
										profiles.map((profile) => (
											<Menu.Item
												key={profile.id}
												className={menuItemClassName}
												onClick={() => {
													addSlot(profile.id);
												}}
											>
												{profile.name}
											</Menu.Item>
										))
									)}
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				}
			/>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
				{/* Source input */}
				<div className="flex shrink-0 flex-col gap-2">
					<label className="sr-only" htmlFor="quick-translate-source">
						{t("translate.sourceTextAria")}
					</label>
					<textarea
						id="quick-translate-source"
						className="h-32 w-full resize-none rounded-none border border-line bg-surface-container-lowest p-3 text-body-md text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface"
						placeholder={t("quickTranslate.sourcePlaceholder")}
						spellCheck={false}
						value={sourceText}
						onChange={(event) => {
							setSourceText(event.currentTarget.value);
							setDetectedSourceLang(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								void runTranslations();
							}
						}}
					/>
					{detectedSourceLang ? (
						<p className="text-label-sm text-neutral uppercase">
							{t("translate.detected", { language: t(`translate.languages.${detectedSourceLang}`) })}
						</p>
					) : null}
				</div>

				{/* Language selectors: same control chrome as main translate; full content width like input/cards */}
				<div className="flex w-full shrink-0 items-center gap-1">
					<div className="min-w-0 flex-1">
						<ComboboxField
							value={sourceLang}
							onValueChange={(value) => {
								setSourceLang((value ?? "auto") as SourceLanguageId);
								setDetectedSourceLang(null);
							}}
							options={sourceLanguageOptions.map((option) => ({ value: option.id, label: option.label }))}
							disabled={isTranslating}
							emptyText={t("common.noMatches")}
							aria-label={t("translate.sourceLanguage")}
						/>
					</div>

					<Button
						type="button"
						className={iconButtonClassName}
						aria-label={t("translate.swapLanguages")}
						onClick={swapLanguages}
						disabled={isTranslating || (sourceLang === "auto" && !detectedSourceLang)}
					>
						<IconMaterialSymbolsLightSwapHoriz className="size-5" aria-hidden />
					</Button>

					<div className="min-w-0 flex-1">
						<ComboboxField
							value={targetLang}
							onValueChange={(value) => setTargetLang((value ?? "en") as SelectableLanguageId)}
							options={targetLanguageOptions.map((option) => ({ value: option.id, label: option.label }))}
							disabled={isTranslating}
							emptyText={t("common.noMatches")}
							aria-label={t("translate.targetLanguage")}
						/>
					</div>
				</div>

				{profilesError ? (
					<p className="shrink-0 text-body-tight text-error" role="alert">
						{profilesError}
					</p>
				) : null}

				{/* Result cards */}
				<div className="flex flex-col gap-4">
					{slots.length === 0 ? (
						<p className="text-body-tight text-neutral" role="status">
							{profilesLoading ? t("translate.profileLoading") : t("quickTranslate.emptySlots")}
						</p>
					) : (
						slots.map((slot) => {
							const profile = profileById.get(slot.profileId);
							const result = results[slot.id] ?? emptyResult;
							const isCopied = copiedSlotId === slot.id;
							const orphanOption =
								!profile && slot.profileId
									? [{ value: slot.profileId, label: t("quickTranslate.missingProfile") }]
									: undefined;

							return (
								<div key={slot.id} className="flex flex-col border border-line bg-surface">
									<div className="flex h-8 items-center justify-between gap-2 border-b border-line bg-surface-container px-2">
										<div className="min-w-0 flex-1">
											<SelectField
												className="h-7 border-0 bg-transparent text-table-header font-bold tracking-tight uppercase hover:not-data-disabled:bg-transparent data-popup-open:bg-transparent"
												value={slot.profileId}
												onValueChange={(value) => {
													if (value) {
														updateSlotProfile(slot.id, value);
													}
												}}
												options={profileSelectOptions}
												extraOptions={orphanOption}
												disabled={profilesLoading || profileSelectOptions.length === 0}
												aria-label={t("translate.profileAria")}
												compact
											/>
										</div>
										<div className="flex shrink-0 items-center gap-0.5">
											<Button
												type="button"
												className={iconButtonClassName}
												aria-label={isCopied ? t("translate.copied") : t("translate.copy")}
												disabled={!result.text || !!result.error}
												onClick={() => {
													void copySlot(slot.id);
												}}
											>
												{isCopied ? (
													<IconMaterialSymbolsLightCheck className="size-4 text-tertiary" aria-hidden />
												) : (
													<IconMaterialSymbolsLightContentCopy className="size-4" aria-hidden />
												)}
											</Button>
											<Button
												type="button"
												className={iconButtonClassName}
												aria-label={t("quickTranslate.removePreset")}
												onClick={() => {
													removeSlot(slot.id);
												}}
											>
												<IconMaterialSymbolsLightClose className="size-4" aria-hidden />
											</Button>
										</div>
									</div>
									<div className="p-3 text-body-md leading-relaxed text-on-surface">
										{result.error ? (
											<p className="whitespace-pre-wrap text-error select-text" role="alert">
												{result.error}
											</p>
										) : result.text ? (
											<p className="whitespace-pre-wrap select-text">{result.text}</p>
										) : result.isTranslating ? (
											<p className="text-neutral italic select-none" role="status">
												{t("translate.translating")}
											</p>
										) : (
											<p className="text-neutral italic select-none">
												{sourceText.trim() ? t("quickTranslate.waiting") : t("quickTranslate.resultPlaceholder")}
											</p>
										)}
									</div>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
