// ABOUTME: Always-on-top Quick Translate window: multi-preset parallel translation UI.
// ABOUTME: Independent webview route (not a main-window modal); slots may repeat profiles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Menu } from "@base-ui/react/menu";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconClose from "~icons/material-symbols/close";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightRefresh from "~icons/material-symbols-light/refresh";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import ExpandCircleDownOutlineIcon from "~icons/material-symbols/expand-circle-down-outline";
import { TitleBar } from "../components/Win/TitleBar";
import { ComboboxField } from "../components/ComboboxField";
import { ScrollArea } from "../components/ScrollArea";
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
import { slotListAutoAnimate } from "./-quick-translate-list-animate";
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

/**
 * Keep the custom scrollbar hidden until content-driven window height stops changing.
 * Covers collapsible height animation (150ms) plus one IPC/layout settle frame.
 */
const HEIGHT_ADAPT_SETTLE_MS = 160;

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
	/**
	 * Fingerprint of the input that produced this completed result.
	 * Missing while in-flight or when the card has never finished a run for the current inputs.
	 */
	inputKey?: string;
};

type SessionState = {
	sourceLang: SourceLanguageId;
	targetLang: SelectableLanguageId;
	slots: Slot[];
	/** Slot ids that are collapsed; expanded cards are omitted. */
	collapsedSlotIds: string[];
};

/** Stable key for whether a card already has a completed translation for the current inputs. */
function buildTranslationInputKey(
	sourceText: string,
	sourceLang: SourceLanguageId,
	targetLang: SelectableLanguageId,
	profileId: string,
): string {
	return `${sourceLang}\0${targetLang}\0${profileId}\0${sourceText.trim()}`;
}

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
		collapsedSlotIds: [],
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
		const slotIds = new Set(slots.map((slot) => slot.id));
		const collapsedSlotIds = Array.isArray(parsed.collapsedSlotIds)
			? parsed.collapsedSlotIds.filter((id): id is string => typeof id === "string" && slotIds.has(id))
			: [];
		return { sourceLang, targetLang, slots, collapsedSlotIds };
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
	"inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md border-0 bg-surface-2 text-on-surface shadow-sm select-none hover:bg-surface-3 active:bg-surface-3 active:shadow-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-popup-open:bg-surface-3 data-disabled:text-disabled";

function QuickTranslatePage() {
	const { t, i18n } = useTranslation();
	const queryClient = useQueryClient();
	const [sessionSeed] = useState(() => loadSession());
	const [slotListRef] = useAutoAnimate(slotListAutoAnimate);

	const [sourceText, setSourceText] = useState("");
	const [sourceLang, setSourceLang] = useState<SourceLanguageId>(sessionSeed.sourceLang);
	const [targetLang, setTargetLang] = useState<SelectableLanguageId>(sessionSeed.targetLang);
	const [slots, setSlots] = useState<Slot[]>(sessionSeed.slots);
	const [results, setResults] = useState<Record<string, SlotResult>>({});
	const [copiedSlotId, setCopiedSlotId] = useState<string | null>(null);
	/** Slot ids that are currently collapsed; absent ids default to expanded. */
	const [collapsedSlotIds, setCollapsedSlotIds] = useState<Set<string>>(() => new Set(sessionSeed.collapsedSlotIds));
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

	// Persist session selections and per-card collapse state across opens of this window.
	useEffect(() => {
		saveSession({
			sourceLang,
			targetLang,
			slots,
			collapsedSlotIds: [...collapsedSlotIds],
		});
	}, [sourceLang, targetLang, slots, collapsedSlotIds]);

	const handlePinChange = useCallback((next: boolean) => {
		setIsPinned(next);
		if (isTauriRuntime()) {
			void invoke("set_pin", { isPin: next });
		}
	}, []);

	/** Per-slot epoch: bumped to invalidate in-flight work for that card only. */
	const slotEpochRef = useRef<Map<string, number>>(new Map());
	/** Bumped when a language-detect request should supersede the previous one. */
	const detectEpochRef = useRef(0);
	const requestIdsRef = useRef<Map<string, string>>(new Map());
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const slotsRef = useRef(slots);
	const collapsedSlotIdsRef = useRef(collapsedSlotIds);
	const detectedSourceLangRef = useRef(detectedSourceLang);

	useEffect(() => {
		slotsRef.current = slots;
	}, [slots]);

	useEffect(() => {
		collapsedSlotIdsRef.current = collapsedSlotIds;
	}, [collapsedSlotIds]);

	useEffect(() => {
		detectedSourceLangRef.current = detectedSourceLang;
	}, [detectedSourceLang]);
	/** Titlebar shell: fixed outside the scroll region; height is included in window resize. */
	const titleBarMeasureRef = useRef<HTMLDivElement>(null);
	/** Body content node (h-fit) used to drive window height; state so the observer rebinds on mount. */
	const [contentMeasureEl, setContentMeasureEl] = useState<HTMLDivElement | null>(null);
	const lastContentHeightRef = useRef(0);
	/** True while content size is chasing window height — hide scrollbar to avoid flash. */
	const [isHeightAdapting, setIsHeightAdapting] = useState(false);
	const heightAdaptSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const setContentMeasureNode = useCallback((node: HTMLDivElement | null) => {
		setContentMeasureEl((prev) => (prev === node ? prev : node));
	}, []);

	const nextSlotEpoch = useCallback((slotId: string): number => {
		const next = (slotEpochRef.current.get(slotId) ?? 0) + 1;
		slotEpochRef.current.set(slotId, next);
		return next;
	}, []);

	const isSlotEpochCurrent = useCallback((slotId: string, epoch: number): boolean => {
		return slotEpochRef.current.get(slotId) === epoch;
	}, []);

	const abortRequest = useCallback(async (key: string) => {
		const requestId = requestIdsRef.current.get(key);
		if (!requestId) {
			return;
		}
		requestIdsRef.current.delete(key);
		try {
			await cancelTranslate(requestId);
		} catch {
			// Request may already have finished.
		}
	}, []);

	const abortSlots = useCallback(
		async (slotIds: string[]) => {
			await Promise.all(slotIds.map((slotId) => abortRequest(slotId)));
		},
		[abortRequest],
	);

	const abortAll = useCallback(async () => {
		const keys = [...requestIdsRef.current.keys()];
		await Promise.all(keys.map((key) => abortRequest(key)));
	}, [abortRequest]);

	useEffect(() => {
		const slotEpochs = slotEpochRef.current;
		return () => {
			detectEpochRef.current += 1;
			for (const slotId of slotEpochs.keys()) {
				const next = (slotEpochs.get(slotId) ?? 0) + 1;
				slotEpochs.set(slotId, next);
			}
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

	const failSlots = useCallback(
		(entries: Array<{ slotId: string; inputKey?: string }>, epochs: Map<string, number>, message: string) => {
			setResults((prev) => {
				const next = { ...prev };
				for (const entry of entries) {
					const epoch = epochs.get(entry.slotId);
					if (epoch == null || slotEpochRef.current.get(entry.slotId) !== epoch) {
						continue;
					}
					next[entry.slotId] = {
						text: "",
						error: message,
						isTranslating: false,
						inputKey: entry.inputKey,
					};
				}
				return next;
			});
		},
		[],
	);

	/**
	 * Translate the given cards only. Omit `targetSlots` to run every *expanded* card.
	 * Collapsed cards are skipped unless explicitly listed (manual retranslate / expand).
	 * Cards are independent: adding or refreshing one never clears or re-runs the others.
	 */
	const runTranslations = useCallback(
		async (targetSlots?: Slot[]) => {
			const trimmed = sourceText.trim();
			const slotsToRun = targetSlots ?? slotsRef.current.filter((slot) => !collapsedSlotIdsRef.current.has(slot.id));
			if (!trimmed || slotsToRun.length === 0) {
				return;
			}

			const inputKeyFor = (profileId: string) =>
				buildTranslationInputKey(sourceText, sourceLang, targetLang, profileId);

			const epochs = new Map<string, number>();
			for (const slot of slotsToRun) {
				epochs.set(slot.id, nextSlotEpoch(slot.id));
			}
			await abortSlots(slotsToRun.map((slot) => slot.id));

			// Mark only the targeted cards as translating.
			setResults((prev) => {
				const next = { ...prev };
				for (const slot of slotsToRun) {
					next[slot.id] = { text: "", error: null, isTranslating: true };
				}
				return next;
			});

			const stillCurrentTargets = () =>
				slotsToRun.filter((slot) => isSlotEpochCurrent(slot.id, epochs.get(slot.id) ?? -1));

			let effectiveSourceId: LanguageId | null = sourceLang === "auto" ? detectedSourceLangRef.current : sourceLang;

			if (sourceLang === "auto" && !effectiveSourceId) {
				// Prefer the first targeted slot's profile for detection model selection.
				const detectProfileId = slotsToRun.find((slot) => slot.profileId)?.profileId ?? null;
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

				const detectEpoch = ++detectEpochRef.current;
				await abortRequest("__detect__");
				const detectRequestId = newId();
				requestIdsRef.current.set("__detect__", detectRequestId);
				try {
					const detected = await detectLanguage(
						{ text: trimmed, modelId: detectModelId, profileId: detectProfileId },
						detectRequestId,
					);
					if (detectEpoch !== detectEpochRef.current) {
						return;
					}
					requestIdsRef.current.delete("__detect__");
					if (!detected.ok || !isLanguageId(detected.languageId)) {
						const message =
							detected.errorCode === "cancelled" ? null : detected.message || t("translate.errors.detectFailed");
						if (message) {
							failSlots(
								stillCurrentTargets().map((slot) => ({
									slotId: slot.id,
									inputKey: inputKeyFor(slot.profileId),
								})),
								epochs,
								message,
							);
						}
						return;
					}
					setDetectedSourceLang(detected.languageId);
					detectedSourceLangRef.current = detected.languageId;
					effectiveSourceId = detected.languageId;
				} catch (err) {
					if (detectEpoch !== detectEpochRef.current) {
						return;
					}
					requestIdsRef.current.delete("__detect__");
					failSlots(
						stillCurrentTargets().map((slot) => ({
							slotId: slot.id,
							inputKey: inputKeyFor(slot.profileId),
						})),
						epochs,
						getIpcErrorMessage(err, t("translate.errors.detectFailed")),
					);
					return;
				}
			} else if (sourceLang !== "auto") {
				setDetectedSourceLang(null);
				detectedSourceLangRef.current = null;
			}

			if (!effectiveSourceId) {
				return;
			}

			const sourceId = effectiveSourceId;
			const activeSlots = stillCurrentTargets();
			if (activeSlots.length === 0) {
				return;
			}

			await Promise.all(
				activeSlots.map(async (slot) => {
					const epoch = epochs.get(slot.id) ?? -1;
					if (!isSlotEpochCurrent(slot.id, epoch)) {
						return;
					}

					const requestId = newId();
					requestIdsRef.current.set(slot.id, requestId);

					try {
						const profile = await queryClient.fetchQuery(profileDetailOptions(slot.profileId));
						if (!isSlotEpochCurrent(slot.id, epoch)) {
							return;
						}

						const slotInputKey = inputKeyFor(slot.profileId);
						const modelId = primaryModelId(profile);
						if (!modelId || !enabledModelIds.has(modelId)) {
							patchResult(slot.id, {
								text: "",
								error: t("quickTranslate.noModel"),
								isTranslating: false,
								inputKey: slotInputKey,
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
								sourceLangId: sourceLang,
								targetLangId: targetLang,
								effectiveSourceLangId: sourceId,
								effectiveTargetLangId: effectiveTargetId,
							},
							requestId,
						);

						if (!isSlotEpochCurrent(slot.id, epoch)) {
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
								inputKey: slotInputKey,
							});
						} else {
							patchResult(slot.id, {
								text: "",
								error: result.message || t("translate.errorPrefix"),
								isTranslating: false,
								inputKey: slotInputKey,
							});
						}
					} catch (err) {
						if (!isSlotEpochCurrent(slot.id, epoch)) {
							return;
						}
						requestIdsRef.current.delete(slot.id);
						patchResult(slot.id, {
							text: "",
							error: getIpcErrorMessage(err, t("translate.errorPrefix")),
							isTranslating: false,
							inputKey: inputKeyFor(slot.profileId),
						});
					}
				}),
			);
		},
		[
			abortRequest,
			abortSlots,
			enabledModelIds,
			failSlots,
			i18n.language,
			isSlotEpochCurrent,
			nextSlotEpoch,
			patchResult,
			queryClient,
			sourceLang,
			sourceText,
			t,
			targetLang,
		],
	);

	/** Update source text; clearing it aborts in-flight work and wipes every card result. */
	const applySourceText = useCallback(
		(next: string) => {
			setSourceText(next);
			setDetectedSourceLang(null);
			if (next.trim()) {
				return;
			}
			detectEpochRef.current += 1;
			for (const slot of slotsRef.current) {
				nextSlotEpoch(slot.id);
			}
			void abortAll();
			setResults({});
		},
		[abortAll, nextSlotEpoch],
	);

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
			applySourceText(event.payload ?? "");
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
	}, [applySourceText]);

	// Debounced auto-translate when source text or languages change — not when cards are added/removed.
	useEffect(() => {
		if (debounceTimerRef.current != null) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}

		const trimmed = sourceText.trim();
		if (!trimmed || slotsRef.current.length === 0) {
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
	}, [sourceText, sourceLang, targetLang, runTranslations]);

	// Content-driven window height: titlebar (fixed) + body (scrolls when clamped).
	// Measure the h-fit content box (offsetHeight), not the ScrollArea viewport fill height.
	// While height is adapting, hide the custom scrollbar so temporary overflow does not flash.
	useEffect(() => {
		if (!isTauriRuntime() || !contentMeasureEl) {
			return;
		}

		let raf = 0;
		const clearHeightAdaptSoon = () => {
			if (heightAdaptSettleTimerRef.current != null) {
				clearTimeout(heightAdaptSettleTimerRef.current);
			}
			heightAdaptSettleTimerRef.current = setTimeout(() => {
				heightAdaptSettleTimerRef.current = null;
				setIsHeightAdapting(false);
			}, HEIGHT_ADAPT_SETTLE_MS);
		};

		const applyHeight = () => {
			raf = 0;
			const titlebarHeight = titleBarMeasureRef.current?.offsetHeight ?? 0;
			// offsetHeight is the layout border-box; h-fit keeps it content-sized inside the viewport.
			const bodyHeight = contentMeasureEl.offsetHeight;
			const height = Math.ceil(titlebarHeight + bodyHeight);
			if (height <= 0) {
				clearHeightAdaptSoon();
				return;
			}
			if (Math.abs(height - lastContentHeightRef.current) < 1) {
				clearHeightAdaptSoon();
				return;
			}
			lastContentHeightRef.current = height;
			void invoke("resize_window_height", { height })
				.catch(() => {
					// Window may have been closed between measure and invoke.
				})
				.finally(() => {
					clearHeightAdaptSoon();
				});
		};

		const schedule = () => {
			// Hide before the next paint so a brief overflow never reveals the track.
			setIsHeightAdapting(true);
			if (heightAdaptSettleTimerRef.current != null) {
				clearTimeout(heightAdaptSettleTimerRef.current);
				heightAdaptSettleTimerRef.current = null;
			}
			if (raf !== 0) {
				cancelAnimationFrame(raf);
			}
			raf = requestAnimationFrame(applyHeight);
		};

		const observer = new ResizeObserver(schedule);
		observer.observe(contentMeasureEl);
		const titlebarEl = titleBarMeasureRef.current;
		if (titlebarEl) {
			observer.observe(titlebarEl);
		}
		schedule();

		return () => {
			if (raf !== 0) {
				cancelAnimationFrame(raf);
			}
			if (heightAdaptSettleTimerRef.current != null) {
				clearTimeout(heightAdaptSettleTimerRef.current);
				heightAdaptSettleTimerRef.current = null;
			}
			observer.disconnect();
		};
	}, [contentMeasureEl]);

	function addSlot(profileId: string) {
		const slot: Slot = { id: newId(), profileId };
		setSlots((prev) => [...prev, slot]);
		// Only the new card translates; existing results stay put.
		if (sourceText.trim()) {
			void runTranslations([slot]);
		}
	}

	function removeSlot(slotId: string) {
		nextSlotEpoch(slotId);
		setSlots((prev) => prev.filter((slot) => slot.id !== slotId));
		setResults((prev) => {
			const next = { ...prev };
			delete next[slotId];
			return next;
		});
		setCollapsedSlotIds((prev) => {
			if (!prev.has(slotId)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(slotId);
			return next;
		});
		void abortRequest(slotId);
		slotEpochRef.current.delete(slotId);
	}

	function setSlotOpen(slotId: string, open: boolean) {
		const isCollapsed = collapsedSlotIds.has(slotId);
		if (open === !isCollapsed) {
			return;
		}

		if (!open) {
			// Collapsing: leave the translation queue and abort any in-flight request.
			nextSlotEpoch(slotId);
			void abortRequest(slotId);
			setResults((prev) => {
				const current = prev[slotId];
				if (!current?.isTranslating) {
					return prev;
				}
				return {
					...prev,
					[slotId]: { ...current, isTranslating: false },
				};
			});
			setCollapsedSlotIds((prev) => {
				const next = new Set(prev);
				next.add(slotId);
				return next;
			});
			return;
		}

		// Expanding: translate once if this card has no completed result for the current inputs.
		setCollapsedSlotIds((prev) => {
			const next = new Set(prev);
			next.delete(slotId);
			return next;
		});

		const slot = slots.find((item) => item.id === slotId);
		if (!slot || !sourceText.trim()) {
			return;
		}
		const inputKey = buildTranslationInputKey(sourceText, sourceLang, targetLang, slot.profileId);
		const result = results[slotId];
		if (result?.inputKey === inputKey) {
			return;
		}
		void runTranslations([slot]);
	}

	function updateSlotProfile(slotId: string, profileId: string) {
		const slot: Slot = { id: slotId, profileId };
		setSlots((prev) => prev.map((item) => (item.id === slotId ? slot : item)));
		// Profile change only re-runs this card when it is expanded.
		if (sourceText.trim() && !collapsedSlotIds.has(slotId)) {
			void runTranslations([slot]);
		}
	}

	function retranslateSlot(slot: Slot) {
		if (!sourceText.trim()) {
			return;
		}
		void runTranslations([slot]);
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
		// Titlebar stays fixed; body scrolls only when content exceeds the clamped window height.
		<div className="flex h-full min-h-0 flex-col bg-surface text-on-surface">
			<div ref={titleBarMeasureRef} className="shrink-0">
				<TitleBar
					className="border-none!"
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
			</div>

			<ScrollArea
				className="min-h-0 flex-1 overflow-hidden"
				contentClassName="h-fit w-full"
				showScrollbarOnHover={false}
				hideScrollbar={isHeightAdapting}
			>
				<div ref={setContentMeasureNode} className="flex h-fit w-full flex-col gap-4 px-3 pb-3 pt-2">
					{/* Source input: outer chrome wraps textarea + sticky footer toolbar */}
					<div className="flex h-32 shrink-0 flex-col border border-line bg-surface-container-lowest focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-on-surface">
						<label className="sr-only" htmlFor="quick-translate-source">
							{t("translate.sourceTextAria")}
						</label>
						<textarea
							id="quick-translate-source"
							className="min-h-0 w-full flex-1 resize-none rounded-none border-0 bg-transparent px-3 pt-3 pb-2 text-body-md text-on-surface placeholder:text-neutral focus:outline-none"
							placeholder={t("quickTranslate.sourcePlaceholder")}
							spellCheck={false}
							value={sourceText}
							onChange={(event) => {
								applySourceText(event.currentTarget.value);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
									event.preventDefault();
									void runTranslations();
								}
							}}
						/>
						<div className="flex h-8 shrink-0 items-center gap-1 px-2">
							{detectedSourceLang ? (
								<p className="min-w-0 truncate text-label-sm text-neutral uppercase">
									{t("translate.detected", {
										language: t(`translate.languages.${detectedSourceLang}`),
									})}
								</p>
							) : null}
							<div className="min-w-0 flex-1" />
							<div className="flex shrink-0 items-center gap-0.5">
								{sourceText ? (
									<Button
										type="button"
										className={iconButtonClassName}
										aria-label={t("translate.clearSource")}
										onClick={() => {
											applySourceText("");
										}}
									>
										<IconClose className="size-4" aria-hidden />
									</Button>
								) : null}
							</div>
						</div>
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

					{/* Empty copy stays outside the animated list so it does not fight card enter/exit. */}
					{slots.length === 0 ? (
						<p className="text-body-tight text-neutral" role="status">
							{profilesLoading ? t("translate.profileLoading") : t("quickTranslate.emptySlots")}
						</p>
					) : null}

					{/* Result cards */}
					<div ref={slotListRef} className="flex flex-col gap-4">
						{slots.map((slot) => {
							const profile = profileById.get(slot.profileId);
							const result = results[slot.id] ?? emptyResult;
							const isCopied = copiedSlotId === slot.id;
							const isOpen = !collapsedSlotIds.has(slot.id);
							const orphanOption =
								!profile && slot.profileId
									? [{ value: slot.profileId, label: t("quickTranslate.missingProfile") }]
									: undefined;

							return (
								<Collapsible.Root
									key={slot.id}
									open={isOpen}
									onOpenChange={(open) => {
										setSlotOpen(slot.id, open);
									}}
									className="flex flex-col border border-line bg-surface"
								>
									{/* Header is a div trigger so nested controls stay valid HTML. */}
									<Collapsible.Trigger
										nativeButton={false}
										render={<div />}
										className="group flex h-8 cursor-default items-center gap-2 border-b border-line bg-surface-container px-2 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface"
									>
										<ExpandCircleDownOutlineIcon
											className="size-4 shrink-0 text-on-surface transition-transform duration-100 ease-out group-data-panel-open:rotate-180"
											aria-hidden
										/>
										<div
											className="max-w-sm shrink-0"
											onClick={(event) => {
												event.stopPropagation();
											}}
											onPointerDown={(event) => {
												event.stopPropagation();
											}}
										>
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
										{/* flex-1 spacer: large blank hit target that toggles collapse */}
										<div className="min-h-full min-w-0 flex-1" />
										<div
											className="flex shrink-0 items-center gap-0.5"
											onClick={(event) => {
												event.stopPropagation();
											}}
											onPointerDown={(event) => {
												event.stopPropagation();
											}}
										>
											<Button
												type="button"
												className={iconButtonClassName}
												aria-label={t("quickTranslate.retranslate")}
												disabled={!sourceText.trim() || result.isTranslating}
												onClick={() => {
													retranslateSlot(slot);
												}}
											>
												<IconMaterialSymbolsLightRefresh className="size-4" aria-hidden />
											</Button>
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
												<IconClose className="size-4" aria-hidden />
											</Button>
										</div>
									</Collapsible.Trigger>
									<Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
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
									</Collapsible.Panel>
								</Collapsible.Root>
							);
						})}
					</div>
				</div>
			</ScrollArea>
		</div>
	);
}
