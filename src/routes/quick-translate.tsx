// ABOUTME: Always-on-top Quick Translate window: multi-preset parallel translation UI.
// ABOUTME: Independent webview route (not a main-window modal); slots may repeat profiles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Menu } from "@base-ui/react/menu";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconClose from "~icons/material-symbols/close";
import IconCollapseContent from "~icons/material-symbols/collapse-content";
import IconEdit from "~icons/material-symbols/edit-outline";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightMarkdown from "~icons/material-symbols-light/markdown";
import IconMaterialSymbolsLightMarkdownOutline from "~icons/material-symbols-light/markdown-outline";
import IconMaterialSymbolsLightRefresh from "~icons/material-symbols-light/refresh";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import ExpandCircleDownOutlineIcon from "~icons/material-symbols/expand-circle-down-outline";
import FlashAutoIcon from "~icons/material-symbols/flash-auto";
import FlashAutoOutlineIcon from "~icons/material-symbols/flash-auto-outline";
import { MarkdownOutput } from "../components/markdown/MarkdownOutput";
import { TitleBar } from "../components/win/TitleBar";
import { ComboboxField } from "../components/ComboboxField";
import { ScrollArea } from "../components/ScrollArea";
import { SelectField } from "../components/SelectField";
import { TextAutosize, TextAutosizeContent } from "../components/TextAutosize";
import { TextLoading } from "../components/TextLoading";
import { iconButtonClassName } from "../components/ui";
import { cn } from "../lib/cn";
import {
  getOutputViewMode,
  setOutputViewMode,
  toggleOutputViewMode,
  type OutputViewMode,
} from "../lib/output-view-mode";
import { QUICK_TRANSLATE_CLIPBOARD_TEXT } from "../query/events";
import {
  allProviderModelsOptions,
  profileDetailOptions,
  profileListOptions,
  providerListOptions,
} from "../query/options";
import { isContinuousSourceEdit } from "../features/translate/isContinuousSourceEdit";
import { newClientRequestId } from "../features/translate/newClientRequestId";
import {
  loadQuickTranslateSession,
  saveQuickTranslateSession,
  type QuickTranslateSlot,
} from "../features/translate/quickTranslateSession";
import {
  isTauriRuntime,
  notifyReady,
  resizeWindowHeight,
  setPin,
} from "../features/translate/quickTranslateWindow";
import { resolveTranslateFailureMessage } from "../features/translate/resolveTranslateFailureMessage";
import { runDetectLanguage, runStartSlotStreamBatch } from "../features/translate/runTranslate";
import {
  DETECT_REQUEST_KEY,
  useSlotStreamSessions,
} from "../features/translate/useSlotStreamSessions";
import { getIpcErrorMessage } from "../storage/errors";
import type { TranslateInput, TranslationProfileDto } from "../storage/types";
import { slotListAutoAnimate } from "./-quick-translate-list-animate";
import {
  AUTO_LANGUAGE,
  LANGUAGE_IDS,
  getDefaultProfileLanguages,
  isLanguageId,
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

type Slot = QuickTranslateSlot;

type SlotResult = {
  text: string;
  error: string | null;
  isTranslating: boolean;
  /**
   * True after the first stream chunk of the current run.
   * Swaps trailing loading dots for the scramble indicator on stream output.
   */
  streamOutputActive?: boolean;
  /**
   * Fingerprint of the input that produced this completed result.
   * Missing while in-flight or when the card has never finished a run for the current inputs.
   */
  inputKey?: string;
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

function primaryModelId(profile: TranslationProfileDto | undefined): string {
  if (!profile) {
    return "";
  }
  const primary = [...profile.targets].sort((a, b) => a.priority - b.priority)[0];
  return primary?.providerModelId ?? "";
}

const emptyResult: SlotResult = { text: "", error: null, isTranslating: false };

const menuPopupClassName =
  "min-w-48 origin-(--transform-origin) border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const menuItemClassName =
  "flex cursor-default items-center px-3 py-1.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

const leadingButtonClassName =
  "inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md border-0 bg-surface-2 text-on-surface shadow-sm select-none hover:bg-surface-3 active:bg-surface-3 active:shadow-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-popup-open:bg-surface-3 data-disabled:text-disabled";

function QuickTranslatePage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [sessionSeed] = useState(() => loadQuickTranslateSession());
  const [slotListRef] = useAutoAnimate(slotListAutoAnimate);

  const [sourceText, setSourceText] = useState("");
  const [sourceLang, setSourceLang] = useState<SourceLanguageId>(sessionSeed.sourceLang);
  const [targetLang, setTargetLang] = useState<SelectableLanguageId>(sessionSeed.targetLang);
  const [slots, setSlots] = useState<Slot[]>(sessionSeed.slots);
  const [results, setResults] = useState<Record<string, SlotResult>>({});
  const [copiedSlotId, setCopiedSlotId] = useState<string | null>(null);
  /** Slot ids that are currently collapsed; absent ids default to expanded. */
  const [collapsedSlotIds, setCollapsedSlotIds] = useState<Set<string>>(() => new Set(sessionSeed.collapsedSlotIds));
  const [autoTranslate, setAutoTranslate] = useState(sessionSeed.autoTranslate);
  /** Shared with main translate; default plain. */
  const [outputViewMode, setOutputViewModeState] = useState<OutputViewMode>(() => getOutputViewMode());
  const isMarkdownView = outputViewMode === "markdown";
  const [detectedSourceLang, setDetectedSourceLang] = useState<LanguageId | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  /** When true and source has text, show a single-line preview instead of the editor. */
  const [isSourceCollapsed, setIsSourceCollapsed] = useState(false);
  /** Request focus on the source textarea after expanding from preview mode. */
  const focusSourceAfterExpandRef = useRef(false);

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
    saveQuickTranslateSession({
      sourceLang,
      targetLang,
      slots,
      collapsedSlotIds: [...collapsedSlotIds],
      autoTranslate,
    });
  }, [sourceLang, targetLang, slots, collapsedSlotIds, autoTranslate]);

  const handlePinChange = useCallback((next: boolean) => {
    setIsPinned(next);
    if (isTauriRuntime()) {
      void setPin(next);
    }
  }, []);

  const slotStreams = useSlotStreamSessions();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slotsRef = useRef(slots);
  const collapsedSlotIdsRef = useRef(collapsedSlotIds);
  const detectedSourceLangRef = useRef(detectedSourceLang);
  const resultsRef = useRef(results);
  const sourceTextRef = useRef(sourceText);

  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  useEffect(() => {
    collapsedSlotIdsRef.current = collapsedSlotIds;
  }, [collapsedSlotIds]);

  useEffect(() => {
    detectedSourceLangRef.current = detectedSourceLang;
  }, [detectedSourceLang]);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    sourceTextRef.current = sourceText;
  }, [sourceText]);
  /** Titlebar shell: fixed outside the scroll region; height is included in window resize. */
  const titleBarMeasureRef = useRef<HTMLDivElement>(null);
  /** Source + language chrome: fixed above the results scroller; included in window resize. */
  const fixedChromeMeasureRef = useRef<HTMLDivElement>(null);
  /** Body shell (padding + gap); used with fixed/results measures for natural window height. */
  const bodyShellMeasureRef = useRef<HTMLDivElement>(null);
  /** Results list node (h-fit) used to drive window height; state so the observer rebinds on mount. */
  const [contentMeasureEl, setContentMeasureEl] = useState<HTMLDivElement | null>(null);
  const lastContentHeightRef = useRef(0);
  /** True while content size is chasing window height — hide scrollbar to avoid flash. */
  const [isHeightAdapting, setIsHeightAdapting] = useState(false);
  const heightAdaptSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setContentMeasureNode = useCallback((node: HTMLDivElement | null) => {
    setContentMeasureEl((prev) => (prev === node ? prev : node));
  }, []);

  /** Bump every slot epoch and cancel in-flight detect/translate work. */
  const invalidateInFlight = useCallback(() => {
    slotStreams.bumpDetectEpoch();
    for (const slot of slotsRef.current) {
      slotStreams.nextSlotEpoch(slot.id);
    }
    void slotStreams.abortAll();
  }, [slotStreams]);

  /** Drop card outputs so the UI restarts from waiting/translating instead of "旧文…". */
  const clearAllResults = useCallback(() => {
    setResults({});
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
      }
      // Slot stream epochs + in-flight cancel are handled by useSlotStreamSessions unmount.
    };
  }, []);

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
          if (epoch == null || !slotStreams.isSlotEpochCurrent(entry.slotId, epoch)) {
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
    [slotStreams],
  );

  /**
   * Translate the given cards only. Omit `targetSlots` to run every *expanded* card.
   * Collapsed cards are skipped unless explicitly listed (manual retranslate / expand).
   * Cards are independent: adding or refreshing one never clears or re-runs the others.
   * By default, cards whose completed result already matches the current input are skipped;
   * pass `{ force: true }` to re-run anyway (manual retranslate).
   */
  const runTranslations = useCallback(
    async (targetSlots?: Slot[], options?: { force?: boolean }) => {
      const trimmed = sourceText.trim();
      const candidates = targetSlots ?? slotsRef.current.filter((slot) => !collapsedSlotIdsRef.current.has(slot.id));
      if (!trimmed || candidates.length === 0) {
        return;
      }

      const inputKeyFor = (profileId: string) =>
        buildTranslationInputKey(sourceText, sourceLang, targetLang, profileId);

      // Skip cards that already finished for this exact source/lang/profile fingerprint.
      const slotsToRun = options?.force
        ? candidates
        : candidates.filter((slot) => resultsRef.current[slot.id]?.inputKey !== inputKeyFor(slot.profileId));
      if (slotsToRun.length === 0) {
        return;
      }

      const epochs = new Map<string, number>();
      for (const slot of slotsToRun) {
        epochs.set(slot.id, slotStreams.nextSlotEpoch(slot.id));
      }
      await slotStreams.abortSlots(slotsToRun.map((slot) => slot.id));

      // Keep prior text so continuous re-runs show "旧文…" with trailing dots until the first
      // new chunk/result arrives (langnext-translate style). Full source replaces clear earlier
      // in applySourceText so this path starts empty for select-all + retype.
      setResults((prev) => {
        const next = { ...prev };
        for (const slot of slotsToRun) {
          const current = prev[slot.id] ?? emptyResult;
          next[slot.id] = {
            text: current.text,
            error: null,
            isTranslating: true,
            streamOutputActive: false,
          };
        }
        return next;
      });

      const stillCurrentTargets = () =>
        slotsToRun.filter((slot) => slotStreams.isSlotEpochCurrent(slot.id, epochs.get(slot.id) ?? -1));

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

        const detectEpoch = slotStreams.bumpDetectEpoch();
        await slotStreams.abortRequest(DETECT_REQUEST_KEY);
        const detectRequestId = newClientRequestId("qt");
        slotStreams.setRequestId(DETECT_REQUEST_KEY, detectRequestId);
        try {
          const detected = await runDetectLanguage(
            { text: trimmed, modelId: detectModelId, profileId: detectProfileId },
            detectRequestId,
          );
          if (detectEpoch !== slotStreams.getDetectEpoch()) {
            return;
          }
          slotStreams.deleteRequestId(DETECT_REQUEST_KEY);
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
          if (detectEpoch !== slotStreams.getDetectEpoch()) {
            return;
          }
          slotStreams.deleteRequestId(DETECT_REQUEST_KEY);
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

      const resolveFailureMessage = (errorCode: string | null | undefined, message: string | undefined) =>
        resolveTranslateFailureMessage(errorCode, message, {
          timeout: t("translate.errors.timeout"),
          fallback: t("translate.errorPrefix"),
        });

      // Per-slot: prepare listeners, then batch-start that job (N parallel single-job batches).
      // Keeps start-as-ready timing; slotBatch still owns invoke isolation + cancel helpers.
      await Promise.all(
        activeSlots.map(async (slot) => {
          const epoch = epochs.get(slot.id) ?? -1;
          if (!slotStreams.isSlotEpochCurrent(slot.id, epoch)) {
            return;
          }

          const requestId = newClientRequestId("qt");
          slotStreams.setRequestId(slot.id, requestId);

          try {
            const profile = await queryClient.fetchQuery(profileDetailOptions(slot.profileId));
            if (!slotStreams.isSlotEpochCurrent(slot.id, epoch)) {
              slotStreams.deleteRequestId(slot.id);
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
              slotStreams.deleteRequestId(slot.id);
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

            const payload: TranslateInput = {
              modelId,
              sourceLang: t(`translate.languages.${sourceId}`),
              targetLang: t(`translate.languages.${effectiveTargetId}`),
              text: trimmed,
              profileId: slot.profileId,
              sourceLangId: sourceLang,
              targetLangId: targetLang,
              effectiveSourceLangId: sourceId,
              effectiveTargetLangId: effectiveTargetId,
            };

            // First chunk replaces any retained previous result; later chunks append.
            let receivedChunk = false;

            // User-facing translation always streams; non-stream IPC is reserved for internal work.
            // Listen-before-invoke: prepareSlotStream registers listeners before batch start.
            const prepared = await slotStreams.prepareSlotStream(slot.id, epoch, requestId, payload, {
              onChunk: (chunk) => {
                const isFirstChunk = !receivedChunk;
                receivedChunk = true;
                setResults((prev) => {
                  const current = prev[slot.id] ?? emptyResult;
                  return {
                    ...prev,
                    [slot.id]: {
                      ...current,
                      text: isFirstChunk ? chunk.delta : current.text + chunk.delta,
                      error: null,
                      isTranslating: true,
                      streamOutputActive: true,
                    },
                  };
                });
              },
              onReset: () => {
                // Drop partial text from the failed model before fallback chunks arrive.
                receivedChunk = false;
                patchResult(slot.id, {
                  text: "",
                  error: null,
                  isTranslating: true,
                  streamOutputActive: false,
                });
              },
              onDone: (done) => {
                if (done.ok) {
                  // Prefer full text from the server so we do not drift on partial assembly.
                  patchResult(slot.id, {
                    text: done.translatedText,
                    error: null,
                    isTranslating: false,
                    streamOutputActive: false,
                    inputKey: slotInputKey,
                  });
                } else {
                  patchResult(slot.id, {
                    text: "",
                    error: resolveFailureMessage(done.errorCode, done.message),
                    isTranslating: false,
                    streamOutputActive: false,
                    inputKey: slotInputKey,
                  });
                }
              },
              onError: (err) => {
                patchResult(slot.id, {
                  text: "",
                  error: resolveFailureMessage(err.errorCode, err.message),
                  isTranslating: false,
                  streamOutputActive: false,
                  inputKey: slotInputKey,
                });
              },
              onCancelled: () => {
                patchResult(slot.id, { isTranslating: false, streamOutputActive: false });
              },
              onListenFailure: (err) => {
                patchResult(slot.id, {
                  text: "",
                  error: getIpcErrorMessage(err, t("translate.errorPrefix")),
                  isTranslating: false,
                  inputKey: slotInputKey,
                });
              },
            });
            if (!prepared) {
              return;
            }

            // Listener-before-invoke: subscriptions are live before this batch start.
            const [outcome] = await runStartSlotStreamBatch([prepared.job]);
            if (outcome == null || outcome.status === "failed") {
              if (prepared.isCurrentRequest() && outcome?.status === "failed") {
                patchResult(slot.id, {
                  text: "",
                  error: getIpcErrorMessage(outcome.error, t("translate.errorPrefix")),
                  isTranslating: false,
                  inputKey: slotInputKey,
                });
              }
              prepared.settle();
              return;
            }
            // Invoke returned after backend spawn; terminal UI comes from done/error events.
            if (!prepared.isCurrentRequest()) {
              prepared.settle();
              return;
            }
            await prepared.waitUntilSettled;
          } catch (err) {
            if (!slotStreams.isSlotEpochCurrent(slot.id, epoch)) {
              return;
            }
            slotStreams.deleteRequestId(slot.id);
            slotStreams.clearSlotStreamListeners(slot.id);
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
      enabledModelIds,
      failSlots,
      i18n.language,
      patchResult,
      queryClient,
      slotStreams,
      sourceLang,
      sourceText,
      t,
      targetLang,
    ],
  );

  /**
   * Update source text.
   * - Empty: abort and wipe every card (nothing to translate).
   * - Continuous edit: keep prior translations so debounced re-runs can show "旧文…".
   * - Full replace (select-all + retype/paste): clear outputs so loading restarts from empty.
   * Identical text is a no-op (e.g. clipboard re-emit of the same payload).
   */
  const applySourceText = useCallback(
    (next: string) => {
      const prev = sourceTextRef.current;
      if (next === prev) {
        return;
      }
      sourceTextRef.current = next;
      setSourceText(next);
      setDetectedSourceLang(null);

      if (!next) {
        // Empty field always leaves preview mode so the editor is ready for the next input.
        setIsSourceCollapsed(false);
      }

      if (!next.trim()) {
        invalidateInFlight();
        clearAllResults();
        return;
      }

      // Wholesale replace: drop stale "旧文…" and restart waiting/translating from empty.
      if (!isContinuousSourceEdit(prev, next)) {
        invalidateInFlight();
        clearAllResults();
      }
      // Continuous edit: leave results alone; runTranslations will keep text + set dots.
    },
    [clearAllResults, invalidateInFlight],
  );
  const applySourceTextRef = useRef(applySourceText);
  useEffect(() => {
    applySourceTextRef.current = applySourceText;
  }, [applySourceText]);

  // Focus after preview → editor so the textarea exists in the DOM first.
  // Place the caret at the end; default focus leaves it at index 0.
  useEffect(() => {
    if (isSourceCollapsed || !focusSourceAfterExpandRef.current) {
      return;
    }
    focusSourceAfterExpandRef.current = false;
    const field = document.getElementById("quick-translate-source");
    if (!(field instanceof HTMLTextAreaElement)) {
      return;
    }
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [isSourceCollapsed]);

  // Double Ctrl+C: backend emits clipboard text; set source so debounced auto-translate runs.
  // Notify ready only after the listener is registered so first-wake queued text is not lost.
  // Empty deps + ref keep the listener mounted for the page lifetime (no rebind gap).
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
      applySourceTextRef.current(event.payload ?? "");
    })
      .then(async (fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        try {
          await notifyReady();
        } catch {
          // Window may be tearing down; next mount re-notifies.
        }
      })
      .catch(() => {
        // Listener registration failed; leave frontend_ready false so text stays queued.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Debounced auto-translate when source text or languages change — not when cards are added/removed.
  // Skipped entirely while auto-translate is off; Enter is the only input-driven trigger then.
  useEffect(() => {
    if (debounceTimerRef.current != null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (!autoTranslate) {
      return;
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
  }, [autoTranslate, sourceText, sourceLang, targetLang, runTranslations]);

  // Content-driven window height: titlebar + fixed chrome + results (results scroll when clamped).
  // Measure natural heights of fixed/results boxes — not the ScrollArea viewport fill height.
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
      const fixedChromeHeight = fixedChromeMeasureRef.current?.offsetHeight ?? 0;
      // offsetHeight is the layout border-box; h-fit keeps results content-sized inside the viewport.
      const resultsHeight = contentMeasureEl.offsetHeight;
      const bodyShell = bodyShellMeasureRef.current;
      let bodyPaddingAndGap = 0;
      if (bodyShell) {
        const styles = getComputedStyle(bodyShell);
        bodyPaddingAndGap =
          (Number.parseFloat(styles.paddingTop) || 0) +
          (Number.parseFloat(styles.paddingBottom) || 0) +
          (Number.parseFloat(styles.rowGap || styles.gap) || 0);
      }
      const height = Math.ceil(titlebarHeight + bodyPaddingAndGap + fixedChromeHeight + resultsHeight);
      if (height <= 0) {
        clearHeightAdaptSoon();
        return;
      }
      if (Math.abs(height - lastContentHeightRef.current) < 1) {
        clearHeightAdaptSoon();
        return;
      }
      lastContentHeightRef.current = height;
      void resizeWindowHeight(height)
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
    const fixedChromeEl = fixedChromeMeasureRef.current;
    if (fixedChromeEl) {
      observer.observe(fixedChromeEl);
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
    const slot: Slot = { id: newClientRequestId("qt"), profileId };
    setSlots((prev) => [...prev, slot]);
    // Only the new card translates; existing results stay put.
    if (sourceText.trim()) {
      void runTranslations([slot]);
    }
  }

  function removeSlot(slotId: string) {
    slotStreams.nextSlotEpoch(slotId);
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
    void slotStreams.abortRequest(slotId);
    slotStreams.deleteSlotEpoch(slotId);
  }

  function setSlotOpen(slotId: string, open: boolean) {
    const isCollapsed = collapsedSlotIds.has(slotId);
    if (open === !isCollapsed) {
      return;
    }

    if (!open) {
      // Collapsing: leave the translation queue and abort any in-flight request.
      slotStreams.nextSlotEpoch(slotId);
      void slotStreams.abortRequest(slotId);
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
    void runTranslations([slot], { force: true });
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
    // Swap changes the effective fingerprint; restart outputs like a language change.
    invalidateInFlight();
    clearAllResults();
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
    // Titlebar + source + language stay fixed; only result cards scroll when clamped.
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface text-on-surface">
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
            <>
              <Menu.Root>
                <Menu.Trigger
                  className={leadingButtonClassName}
                  aria-label={t("quickTranslate.addPreset")}
                  disabled={profilesLoading || profiles.length === 0}
                >
                  <IconMaterialSymbolsLightAdd className="pointer-events-none size-4" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner className="z-50 outline-hidden" sideOffset={4} align="start">
                    <Menu.Popup
                      className={`
                        ${menuPopupClassName}
                        max-h-64 overflow-y-auto py-1
                      `}
                    >
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
              <Button
                type="button"
                className={leadingButtonClassName}
                aria-label={isMarkdownView ? t("translate.plainText") : t("translate.markdownPreview")}
                aria-pressed={isMarkdownView}
                onClick={() => {
                  setOutputViewModeState((current) => {
                    const next = toggleOutputViewMode(current);
                    setOutputViewMode(next);
                    return next;
                  });
                }}
              >
                {isMarkdownView ? (
                  <IconMaterialSymbolsLightMarkdown className="pointer-events-none size-4" aria-hidden />
                ) : (
                  <IconMaterialSymbolsLightMarkdownOutline className="pointer-events-none size-4" aria-hidden />
                )}
              </Button>
              <Button
                type="button"
                className={leadingButtonClassName}
                aria-label={
                  autoTranslate ? t("quickTranslate.disableAutoTranslate") : t("quickTranslate.enableAutoTranslate")
                }
                aria-pressed={autoTranslate}
                onClick={() => {
                  setAutoTranslate((prev) => !prev);
                }}
              >
                {autoTranslate ? (
                  <FlashAutoIcon className="pointer-events-none size-4" aria-hidden />
                ) : (
                  <FlashAutoOutlineIcon className="pointer-events-none size-4" aria-hidden />
                )}
              </Button>
            </>
          }
        />
      </div>

      <div
        ref={bodyShellMeasureRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden px-3 pt-2 pb-3"
      >
        {/* Source + language stay pinned; only the results list below may scroll. */}
        <div ref={fixedChromeMeasureRef} className="flex min-w-0 shrink-0 flex-col gap-4">
          {/* Source input: editor, or single-line preview when collapsed; footer toolbar always shown. */}
          <div
            className={cn(
              // min-w-0 + overflow-hidden: long unbroken preview text must not expand the pane.
              `
                flex min-w-0 shrink-0 flex-col overflow-hidden border border-line bg-surface-container-lowest
                focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-on-surface
              `,
              isSourceCollapsed && sourceText ? "min-h-0" : "min-h-32",
            )}
          >
            <label className="sr-only" htmlFor="quick-translate-source">
              {t("translate.sourceTextAria")}
            </label>
            {isSourceCollapsed && sourceText ? (
              <button
                type="button"
                className="
                  flex w-full min-w-0 cursor-default border-0 bg-transparent px-3 pt-3 pb-2 text-left text-body-md
                  text-on-surface
                  focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface
                "
                aria-label={t("quickTranslate.editSource")}
                onClick={() => {
                  focusSourceAfterExpandRef.current = true;
                  setIsSourceCollapsed(false);
                }}
              >
                {/*
							  Inner span carries truncate: button text nodes do not ellipsize reliably
							  across engines when the shell is a flex item.
							*/}
                <span className="block min-w-0 flex-1 truncate">{sourceText.split(/\r?\n/, 1)[0] ?? ""}</span>
              </button>
            ) : (
              /*
						  min-h-24 ≈ former h-32 chrome minus h-8 toolbar.
						  minRows={6} keeps a fixed font-scaling floor while height may grow to max-h-64.
						*/
              <TextAutosize
                id="quick-translate-source"
                layout="grow"
                className="max-h-64 min-h-24"
                textareaClassName="px-3 pt-3 pb-2"
                minRows={6}
                placeholder={t("quickTranslate.sourcePlaceholder")}
                spellCheck={false}
                value={sourceText}
                onChange={(event) => {
                  applySourceText(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  // Always allow Ctrl/Cmd+Enter as an explicit run shortcut.
                  if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    void runTranslations();
                    return;
                  }
                  // Manual mode: Enter runs translation; Shift+Enter inserts a newline.
                  if (!autoTranslate && !event.shiftKey) {
                    event.preventDefault();
                    void runTranslations();
                  }
                }}
              />
            )}
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
                  <>
                    <Button
                      type="button"
                      className={iconButtonClassName}
                      aria-label={
                        isSourceCollapsed ? t("quickTranslate.editSource") : t("quickTranslate.collapseSource")
                      }
                      onClick={() => {
                        if (isSourceCollapsed) {
                          focusSourceAfterExpandRef.current = true;
                          setIsSourceCollapsed(false);
                          return;
                        }
                        setIsSourceCollapsed(true);
                      }}
                    >
                      {isSourceCollapsed ? (
                        <IconEdit className="size-4" aria-hidden />
                      ) : (
                        <IconCollapseContent className="size-4" aria-hidden />
                      )}
                    </Button>
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
                  </>
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
                  const next = (value ?? "auto") as SourceLanguageId;
                  if (next === sourceLang) {
                    return;
                  }
                  setSourceLang(next);
                  setDetectedSourceLang(null);
                  // Language change invalidates completed outputs (langnext-translate clears showText).
                  invalidateInFlight();
                  clearAllResults();
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
                onValueChange={(value) => {
                  const next = (value ?? "en") as SelectableLanguageId;
                  if (next === targetLang) {
                    return;
                  }
                  setTargetLang(next);
                  invalidateInFlight();
                  clearAllResults();
                }}
                options={targetLanguageOptions.map((option) => ({ value: option.id, label: option.label }))}
                disabled={isTranslating}
                emptyText={t("common.noMatches")}
                aria-label={t("translate.targetLanguage")}
              />
            </div>
          </div>
        </div>

        <ScrollArea
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          contentClassName="h-fit min-w-0 w-full"
          showScrollbarOnHover={false}
          hideScrollbar={isHeightAdapting}
        >
          <div ref={setContentMeasureNode} className="flex h-fit w-full min-w-0 flex-col gap-4">
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
            <div ref={slotListRef} className="flex min-w-0 flex-col gap-4">
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
                    className="flex min-w-0 flex-col overflow-hidden border border-line bg-surface"
                  >
                    {/* Header is a div trigger so nested controls stay valid HTML. */}
                    <Collapsible.Trigger
                      nativeButton={false}
                      render={<div />}
                      className="
                        group flex h-8 cursor-default items-center gap-2 border-b border-line bg-surface-container px-2
                        select-none
                        focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface
                      "
                    >
                      <ExpandCircleDownOutlineIcon
                        className="
                          size-4 shrink-0 text-on-surface transition-transform duration-100 ease-out
                          group-data-panel-open:rotate-180
                        "
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
                          className="
                            h-7 border-0 bg-transparent text-table-header font-bold tracking-tight uppercase
                            hover:not-data-disabled:bg-transparent
                            data-popup-open:bg-transparent
                          "
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
                    {/*
									  keepMounted: preserve stepped font across collapse. Unmounting reset font to
									  largest; open measured tall then shrank → stretch/shrink jitter on long results.
									*/}
                    <Collapsible.Panel
                      keepMounted
                      className="
                        h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out
                        data-ending-style:h-0
                        data-starting-style:h-0
                        [&[hidden]:not([hidden='until-found'])]:hidden
                      "
                    >
                      {/*
										  Grow without max-h: plain block so card height drives window resize.
										  Font steps only inside minRows; then height grows with content.
										*/}
                      <TextAutosizeContent
                        layout="grow"
                        fontScale={isMarkdownView && !!result.text && !result.error ? "fixed" : "stepped"}
                        stickToEnd={result.isTranslating}
                        contentClassName="p-3 leading-relaxed"
                        minRows={6}
                        text={
                          result.error
                            ? result.error
                            : isMarkdownView
                              ? ""
                              : result.text ||
                                (result.isTranslating
                                  ? t("translate.translating")
                                  : sourceText.trim()
                                    ? t("quickTranslate.waiting")
                                    : "")
                        }
                      >
                        {result.error ? (
                          <p
                            className="min-w-0 wrap-break-word whitespace-pre-wrap text-error select-text"
                            role="alert"
                          >
                            {result.error}
                          </p>
                        ) : result.text || result.isTranslating ? (
                          isMarkdownView && result.text ? (
                            <MarkdownOutput text={result.text} isStreaming={Boolean(result.streamOutputActive)} />
                          ) : (
                            <TextLoading
                              text={result.text}
                              isLoading={result.isTranslating}
                              scramble={Boolean(result.streamOutputActive)}
                              loadingLabel={t("translate.translating")}
                            />
                          )
                        ) : sourceText.trim() ? (
                          // Debounce / manual-mode gap: source ready but this card has not started yet.
                          <TextLoading text="" isLoading loadingLabel={t("quickTranslate.waiting")} />
                        ) : (
                          <p className="text-neutral italic select-none">{t("quickTranslate.resultPlaceholder")}</p>
                        )}
                      </TextAutosizeContent>
                    </Collapsible.Panel>
                  </Collapsible.Root>
                );
              })}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
