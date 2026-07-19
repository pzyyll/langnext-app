// ABOUTME: General translation index page with source/target panes and streaming.
// ABOUTME: Nested under /translate; selects profiles and calls provider models via IPC.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightMarkdown from "~icons/material-symbols-light/markdown";
import IconMaterialSymbolsLightMarkdownOutline from "~icons/material-symbols-light/markdown-outline";
import IconMaterialSymbolsLightStopCircleOutline from "~icons/material-symbols-light/stop-circle-outline";
import IconMaterialSymbolsLightSwapHoriz from "~icons/material-symbols-light/swap-horiz";
import IconMaterialSymbolsLightVolumeUp from "~icons/material-symbols-light/volume-up";
import IconPepiconsPrintEnter from "~icons/pepicons-print/enter";
import { MarkdownOutput } from "../../components/markdown/MarkdownOutput";
import { useToast } from "../../components/toast/useToast";
import { iconButtonClassName } from "../../components/ui";
import { ComboboxField } from "../../components/ComboboxField";
import { SelectField } from "../../components/SelectField";
import { TextAutosize, TextAutosizeContent } from "../../components/TextAutosize";
import { TextLoading } from "../../components/TextLoading";
import {
  getOutputViewMode,
  setOutputViewMode,
  toggleOutputViewMode,
  type OutputViewMode,
} from "../../lib/output-view-mode";
import { shouldApplyProfileResult } from "../../query/profileApplyGuard";
import {
  allProviderModelsOptions,
  profileDetailOptions,
  profileListOptions,
  providerListOptions,
} from "../../query/options";
import {
  cancelTranslate,
  detectLanguage,
  TRANSLATE_CHUNK_EVENT,
  TRANSLATE_DONE_EVENT,
  TRANSLATE_ERROR_EVENT,
  TRANSLATE_RESET_EVENT,
  translateTextStream,
} from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
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
} from "./-languages";
import { WorkspaceSidebar } from "./-WorkspaceSidebar";
import {
  MAX_TRANSLATE_WORKSPACES,
  addWorkspaceToStore,
  createTranslateWorkspace,
  getActiveWorkspace,
  getTranslateWorkspacesStore,
  removeWorkspaceFromStore,
  reorderWorkspacesInStore,
  setRailCollapsedInStore,
  setTranslateWorkspacesStore,
  updateWorkspaceInStore,
  type TranslateWorkspace,
  type TranslateWorkspacesStore,
} from "./-workspaces";
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

/** Auto-dismiss for the user-cancel "Stopped" toast. */
const STOPPED_TOAST_MS = 2000;

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

function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `translate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function TranslatePage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  // Restore workspaces (presets, languages, draft text) across navigation and restarts.
  const [boot] = useState(() => {
    const store = getTranslateWorkspacesStore();
    return { store, workspace: getActiveWorkspace(store) };
  });
  const [workspaceStore, setWorkspaceStore] = useState<TranslateWorkspacesStore>(() => boot.store);
  const [sourceLang, setSourceLang] = useState<SourceLanguageId>(boot.workspace.sourceLang);
  const [targetLang, setTargetLang] = useState<SelectableLanguageId>(boot.workspace.targetLang);
  const [detectedSourceLang, setDetectedSourceLang] = useState<LanguageId | null>(boot.workspace.detectedSourceLang);
  const [profilePrimaryLang, setProfilePrimaryLang] = useState<LanguageId | null>(null);
  const [profilePreferredTargetLang, setProfilePreferredTargetLang] = useState<LanguageId | null>(null);
  const [sourceText, setSourceText] = useState(boot.workspace.sourceText);
  const [outputText, setOutputText] = useState(boot.workspace.outputText);
  const [errorMessage, setErrorMessage] = useState<string | null>(boot.workspace.errorMessage);
  /** Tracks whether a translate attempt has finished; kept for session UX side-effects (clear on edit). */
  const [, setHasTranslated] = useState(false);
  const [confidencePercent, setConfidencePercent] = useState(boot.workspace.confidencePercent);
  const [latencyMs, setLatencyMs] = useState<number | null>(boot.workspace.latencyMs);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  /** True after the first stream chunk of the current run; swaps loading dots for scramble. */
  const [streamOutputActive, setStreamOutputActive] = useState(false);
  /** Shared with quick-translate; default plain. */
  const [outputViewMode, setOutputViewModeState] = useState<OutputViewMode>(() => getOutputViewMode());
  const isMarkdownView = outputViewMode === "markdown";
  const [activeModelLabel, setActiveModelLabel] = useState<string | null>(boot.workspace.activeModelLabel);

  const [selectedModelId, setSelectedModelId] = useState(boot.workspace.modelId);
  const [selectedProfileId, setSelectedProfileId] = useState(boot.workspace.profileId);
  /** Empty string = use the profile default template (persisted per workspace). */
  const [selectedPromptTemplateId, setSelectedPromptTemplateId] = useState(boot.workspace.promptTemplateId);
  const [profileApplyError, setProfileApplyError] = useState<string | null>(null);
  const [isApplyingProfile, setIsApplyingProfile] = useState(false);
  /** Skip one persist cycle after hydrating a switched workspace (avoids writing stale fields). */
  const skipNextWorkspacePersist = useRef(false);

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
  const activeProfile = profiles.find((profile) => profile.id === resolvedProfileId) ?? null;
  const promptTemplateOptions = useMemo(() => {
    if (!activeProfile) {
      return [] as Array<{ value: string; label: string }>;
    }
    return [
      { value: "", label: t("translate.promptTemplateDefault") },
      ...activeProfile.promptTemplates.map((template) => ({
        value: template.id,
        label: template.name,
      })),
    ];
  }, [activeProfile, t]);
  // Explicit template is a page-level override; invalid ids fall back to Profile default.
  const resolvedPromptTemplateId =
    selectedPromptTemplateId && promptTemplateOptions.some((option) => option.value === selectedPromptTemplateId)
      ? selectedPromptTemplateId
      : "";

  /** Monotonic local counter + backend stream request id for cancellation. */
  const translateGeneration = useRef(0);
  /** Guards out-of-order profile apply responses when the user switches quickly. */
  const profileApplyGeneration = useRef(0);
  /** Guards out-of-order profile-preference hydration (restore path, not full apply). */
  const profilePrefsGeneration = useRef(0);
  const activeRequestId = useRef<string | null>(null);
  const streamUnlisteners = useRef<UnlistenFn[]>([]);

  /** Snapshot of UI fields that belong to the active workspace. */
  function buildWorkspacePatch(): Partial<Omit<TranslateWorkspace, "id">> {
    return {
      profileId: selectedProfileId,
      modelId: selectedModelId,
      sourceLang,
      targetLang,
      promptTemplateId: selectedPromptTemplateId,
      sourceText,
      outputText,
      detectedSourceLang,
      confidencePercent,
      latencyMs,
      activeModelLabel,
      errorMessage,
    };
  }

  function applyWorkspaceToUi(workspace: TranslateWorkspace) {
    setSelectedProfileId(workspace.profileId);
    setSelectedModelId(workspace.modelId);
    setSourceLang(workspace.sourceLang);
    setTargetLang(workspace.targetLang);
    setSelectedPromptTemplateId(workspace.promptTemplateId);
    setSourceText(workspace.sourceText);
    setOutputText(workspace.outputText);
    setDetectedSourceLang(workspace.detectedSourceLang);
    setConfidencePercent(workspace.confidencePercent);
    setLatencyMs(workspace.latencyMs);
    setActiveModelLabel(workspace.activeModelLabel);
    setErrorMessage(workspace.errorMessage);
    setHasTranslated(false);
    setProfileApplyError(null);
    setIsApplyingProfile(false);
    setStreamOutputActive(false);
    setIsTranslating(false);
  }

  function commitWorkspaceStore(next: TranslateWorkspacesStore) {
    setWorkspaceStore(next);
    setTranslateWorkspacesStore(next);
  }

  function flushActiveWorkspace(store: TranslateWorkspacesStore): TranslateWorkspacesStore {
    return updateWorkspaceInStore(store, store.activeWorkspaceId, buildWorkspacePatch());
  }

  async function selectWorkspace(workspaceId: string) {
    if (workspaceId === workspaceStore.activeWorkspaceId) {
      return;
    }
    const hadActive = activeRequestId.current != null;
    translateGeneration.current += 1;
    await abortActiveRequest();
    if (hadActive) {
      showStoppedToast();
    }
    const flushed = flushActiveWorkspace(workspaceStore);
    const next: TranslateWorkspacesStore = {
      ...flushed,
      activeWorkspaceId: workspaceId,
    };
    // Ensure active id is valid after normalize path.
    const active = next.workspaces.some((ws) => ws.id === workspaceId)
      ? workspaceId
      : (next.workspaces[0]?.id ?? workspaceId);
    const committed = { ...next, activeWorkspaceId: active };
    skipNextWorkspacePersist.current = true;
    commitWorkspaceStore(committed);
    applyWorkspaceToUi(getActiveWorkspace(committed));
  }

  async function createWorkspace() {
    if (workspaceStore.workspaces.length >= MAX_TRANSLATE_WORKSPACES) {
      return;
    }
    const hadActive = activeRequestId.current != null;
    translateGeneration.current += 1;
    await abortActiveRequest();
    if (hadActive) {
      showStoppedToast();
    }
    const flushed = flushActiveWorkspace(workspaceStore);
    const used = new Set(flushed.workspaces.map((ws) => ws.name.trim().toLowerCase()));
    let n = flushed.workspaces.length + 1;
    let name = t("translate.workspace.defaultName", { n });
    while (used.has(name.trim().toLowerCase())) {
      n += 1;
      name = t("translate.workspace.defaultName", { n });
    }
    // New task: keep current toolbar config, start with empty draft panes.
    const workspace = createTranslateWorkspace({
      name,
      profileId: selectedProfileId,
      modelId: selectedModelId,
      sourceLang,
      targetLang,
      promptTemplateId: selectedPromptTemplateId,
    });
    const next = addWorkspaceToStore(flushed, workspace);
    skipNextWorkspacePersist.current = true;
    commitWorkspaceStore(next);
    applyWorkspaceToUi(getActiveWorkspace(next));
  }

  async function deleteWorkspace(workspaceId: string) {
    const hadActive = activeRequestId.current != null && workspaceId === workspaceStore.activeWorkspaceId;
    if (hadActive) {
      translateGeneration.current += 1;
      await abortActiveRequest();
      showStoppedToast();
    }
    // Flush only when deleting a non-active row; active is discarded.
    const base =
      workspaceId === workspaceStore.activeWorkspaceId ? workspaceStore : flushActiveWorkspace(workspaceStore);
    const next = removeWorkspaceFromStore(base, workspaceId, undefined, t("translate.workspace.defaultName", { n: 1 }));
    skipNextWorkspacePersist.current = true;
    commitWorkspaceStore(next);
    applyWorkspaceToUi(getActiveWorkspace(next));
  }

  function renameWorkspace(workspaceId: string, name: string) {
    const next = updateWorkspaceInStore(workspaceStore, workspaceId, { name });
    commitWorkspaceStore(next);
  }

  function reorderWorkspaces(orderedIds: string[]) {
    const flushed = flushActiveWorkspace(workspaceStore);
    const next = reorderWorkspacesInStore(flushed, orderedIds);
    commitWorkspaceStore(next);
  }

  function setWorkspaceRailCollapsed(railCollapsed: boolean) {
    const next = setRailCollapsedInStore(workspaceStore, railCollapsed);
    commitWorkspaceStore(next);
  }

  // Persist active workspace fields so navigation and restarts restore drafts + presets.
  useEffect(() => {
    if (skipNextWorkspacePersist.current) {
      skipNextWorkspacePersist.current = false;
      return;
    }
    setWorkspaceStore((prev) => {
      const next = updateWorkspaceInStore(prev, prev.activeWorkspaceId, buildWorkspacePatch());
      setTranslateWorkspacesStore(next);
      return next;
    });
    // Field snapshot only: store is read/updated via the functional setter above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedProfileId,
    selectedModelId,
    sourceLang,
    targetLang,
    selectedPromptTemplateId,
    sourceText,
    outputText,
    detectedSourceLang,
    confidencePercent,
    latencyMs,
    activeModelLabel,
    errorMessage,
  ]);

  // When a profile id is restored (or becomes valid again), load Primary/Target prefs for Auto-target
  // without re-applying the profile over the user's saved model/language selections.
  // Stale prefs are safe when resolvedProfileId is empty: resolveProfileLangPrefs ignores them.
  useEffect(() => {
    if (!resolvedProfileId || isApplyingProfile) {
      return;
    }

    const generation = ++profilePrefsGeneration.current;
    let cancelled = false;

    void (async () => {
      try {
        const dto = await queryClient.fetchQuery(profileDetailOptions(resolvedProfileId));
        if (cancelled || generation !== profilePrefsGeneration.current) {
          return;
        }
        const defaults = getDefaultProfileLanguages(i18n.language);
        setProfilePrimaryLang(isLanguageId(dto.primaryLang) ? dto.primaryLang : defaults.primary);
        setProfilePreferredTargetLang(
          isLanguageId(dto.preferredTargetLang) ? dto.preferredTargetLang : defaults.target,
        );
      } catch {
        if (cancelled || generation !== profilePrefsGeneration.current) {
          return;
        }
        // Keep UI usable: clear prefs so Auto-target falls back to UI-locale defaults.
        setProfilePrimaryLang(null);
        setProfilePreferredTargetLang(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [resolvedProfileId, isApplyingProfile, queryClient, i18n.language]);

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

  /** Effective Primary/Target preference for the Auto-target resolver. Falls back to the
   * current UI locale when no profile is selected, a legacy profile omits the fields, or the
   * selected profile is cleared/invalidated so stale profile preferences never leak through. */
  const profileLangPrefs = useMemo(
    () => resolveProfileLangPrefs(!!resolvedProfileId, profilePrimaryLang, profilePreferredTargetLang, i18n.language),
    [resolvedProfileId, profilePrimaryLang, profilePreferredTargetLang, i18n.language],
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

  function releaseActiveRequest(requestId: string) {
    if (activeRequestId.current === requestId) {
      activeRequestId.current = null;
    }
  }

  useEffect(() => {
    return () => {
      translateGeneration.current += 1;
      void abortActiveRequest();
    };
  }, [abortActiveRequest]);

  const charCount = sourceText.length;
  const canTranslate =
    sourceText.trim().length > 0 &&
    resolvedModelId.length > 0 &&
    !isTranslating &&
    !isApplyingProfile &&
    !modelsLoading;

  async function applyProfile(profileId: string) {
    const generation = ++profileApplyGeneration.current;
    setDetectedSourceLang(null);
    // Switching profile always restores Profile default (page-level override is not sticky).
    setSelectedPromptTemplateId("");
    if (!profileId) {
      setSelectedProfileId("");
      setProfileApplyError(null);
      setIsApplyingProfile(false);
      setProfilePrimaryLang(null);
      setProfilePreferredTargetLang(null);
      return;
    }
    // Track the optimistic selection, but prevent translation until its model/languages arrive.
    setSelectedProfileId(profileId);
    setProfileApplyError(null);
    setIsApplyingProfile(true);
    try {
      const dto = await queryClient.fetchQuery(profileDetailOptions(profileId));
      if (!shouldApplyProfileResult(generation, profileApplyGeneration.current)) {
        return;
      }

      const primaryTarget = [...dto.targets].sort((a, b) => a.priority - b.priority)[0];
      if (primaryTarget && modelOptions.some((option) => option.id === primaryTarget.providerModelId)) {
        setSelectedModelId(primaryTarget.providerModelId);
      }
      if (isSelectableLanguageId(dto.sourceLang)) {
        setSourceLang(dto.sourceLang);
      }
      if (isSelectableLanguageId(dto.targetLang)) {
        setTargetLang(dto.targetLang);
      }
      // Load profile Primary/Target preferences, falling back to UI-locale defaults for legacy profiles.
      const defaults = getDefaultProfileLanguages(i18n.language);
      setProfilePrimaryLang(isLanguageId(dto.primaryLang) ? dto.primaryLang : defaults.primary);
      setProfilePreferredTargetLang(isLanguageId(dto.preferredTargetLang) ? dto.preferredTargetLang : defaults.target);
    } catch (err) {
      if (!shouldApplyProfileResult(generation, profileApplyGeneration.current)) {
        return;
      }
      setSelectedProfileId("");
      setProfileApplyError(getIpcErrorMessage(err, t("translate.profileLoadFailed")));
    } finally {
      if (shouldApplyProfileResult(generation, profileApplyGeneration.current)) {
        setIsApplyingProfile(false);
      }
    }
  }

  function swapLanguages() {
    // Effective concrete source: manual selection or the last detection result.
    const effectiveSource: LanguageId | null = sourceLang === "auto" ? detectedSourceLang : sourceLang;
    // No concrete source to swap with -> safe no-op.
    if (!effectiveSource) {
      return;
    }
    if (targetLang === "auto") {
      // Auto target: resolve a concrete target from the profile preferences before swapping.
      const effectiveTarget = resolveTargetLanguage({
        source: effectiveSource,
        configuredTarget: AUTO_LANGUAGE,
        primary: profileLangPrefs.primary,
        preferredTarget: profileLangPrefs.preferredTarget,
      });
      setSourceLang(effectiveTarget);
      setTargetLang(effectiveSource);
    } else {
      setSourceLang(targetLang);
      setTargetLang(effectiveSource);
    }
    setDetectedSourceLang(null);
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
    setStreamOutputActive(false);
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
    setStreamOutputActive(false);
    setActiveModelLabel(null);
    setDetectedSourceLang(null);
    if (hadActive) {
      showStoppedToast();
    }
  }

  function beginTranslateUi() {
    setIsTranslating(true);
    setStreamOutputActive(false);
    setErrorMessage(null);
    // Keep prior output while waiting so re-runs show previous text + trailing dots
    // until the first stream chunk (or non-stream result) replaces it.
    setHasTranslated(false);
    setConfidencePercent(0);
    setLatencyMs(null);
    setActiveModelLabel(null);
    setDetectedSourceLang(null);
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
    setStreamOutputActive(false);
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
    setStreamOutputActive(false);
  }

  function finishCancelledUi(generation: number) {
    if (generation !== translateGeneration.current) {
      return;
    }
    setIsTranslating(false);
    setStreamOutputActive(false);
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
      sourceLangId?: string | null;
      targetLangId?: string | null;
      effectiveSourceLangId?: string | null;
      effectiveTargetLangId?: string | null;
    },
    requestId: string,
  ) {
    clearStreamListeners();

    // First chunk replaces any retained previous result; later chunks append.
    let receivedChunk = false;
    const onChunk = (event: { payload: TranslateStreamChunk }) => {
      const chunk = event.payload;
      if (generation !== translateGeneration.current) {
        return;
      }
      if (chunk.id !== activeRequestId.current) {
        return;
      }
      const isFirstChunk = !receivedChunk;
      receivedChunk = true;
      if (isFirstChunk) {
        setStreamOutputActive(true);
      }
      setOutputText((prev) => (isFirstChunk ? chunk.delta : prev + chunk.delta));
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
      receivedChunk = false;
      setStreamOutputActive(false);
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

    const requestId = newRequestId();
    activeRequestId.current = requestId;

    // Resolve the effective source id. Auto-detect first when source is "auto".
    let effectiveSourceId: LanguageId;
    if (sourceLang === "auto") {
      try {
        const detected = await detectLanguage(
          { text: trimmed, modelId: resolvedModelId || null, profileId: resolvedProfileId || null },
          requestId,
        );
        if (generation !== translateGeneration.current) {
          return;
        }
        if (!detected.ok) {
          releaseActiveRequest(requestId);
          if (detected.errorCode === "cancelled") {
            finishCancelledUi(generation);
          } else {
            const message =
              detected.errorCode === "invalid_response"
                ? t("translate.errors.detectFailed")
                : detected.message || t("translate.errors.detectFailed");
            finishErrorUi(generation, message, detected.latencyMs);
          }
          return;
        }
        if (!isLanguageId(detected.languageId)) {
          releaseActiveRequest(requestId);
          finishErrorUi(generation, t("translate.errors.detectFailed"), detected.latencyMs);
          return;
        }
        setDetectedSourceLang(detected.languageId);
        effectiveSourceId = detected.languageId;
      } catch (err) {
        if (generation !== translateGeneration.current) {
          return;
        }
        releaseActiveRequest(requestId);
        finishErrorUi(generation, getIpcErrorMessage(err, t("translate.errors.detectFailed")), null);
        return;
      }
      if (generation !== translateGeneration.current) {
        return;
      }
    } else {
      effectiveSourceId = sourceLang;
    }

    // Resolve the effective concrete target id from the profile Auto-target rule, then localize.
    // The label sent to Rust is always a concrete language; Auto never reaches the backend.
    const effectiveTargetId = resolveTargetLanguage({
      source: effectiveSourceId,
      configuredTarget: targetLang,
      primary: profileLangPrefs.primary,
      preferredTarget: profileLangPrefs.preferredTarget,
    });
    const sourceLabel = t(`translate.languages.${effectiveSourceId}`);
    const targetLabel = t(`translate.languages.${effectiveTargetId}`);
    const payload = {
      modelId: resolvedModelId,
      sourceLang: sourceLabel,
      targetLang: targetLabel,
      text: trimmed,
      profileId: resolvedProfileId || null,
      promptTemplateId: resolvedPromptTemplateId || null,
      sourceLangId: sourceLang,
      targetLangId: targetLang,
      effectiveSourceLangId: effectiveSourceId,
      effectiveTargetLangId: effectiveTargetId,
    };

    // User-facing translation always streams; non-stream IPC is reserved for internal work (e.g. detection).
    await handleTranslateStreaming(generation, payload, requestId);
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
    <div className={`${LAYOUT_HEIGHT_CLASS} flex min-h-0 gap-gutter`}>
      <WorkspaceSidebar
        workspaces={workspaceStore.workspaces}
        activeWorkspaceId={workspaceStore.activeWorkspaceId}
        collapsed={workspaceStore.railCollapsed}
        disabled={isApplyingProfile}
        onSelect={(workspaceId) => {
          void selectWorkspace(workspaceId);
        }}
        onCreate={() => {
          void createWorkspace();
        }}
        onRename={renameWorkspace}
        onDelete={(workspaceId) => {
          void deleteWorkspace(workspaceId);
        }}
        onReorder={reorderWorkspaces}
        onCollapsedChange={setWorkspaceRailCollapsed}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-gutter">
        {/* Top toolbar: profile + model + languages + utility actions */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border border-line bg-surface-2 px-gutter py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-gutter">
            <div className="flex items-center gap-2">
              <label className="text-label-sm text-neutral uppercase" id="translate-profile-label">
                {t("translate.profileLabel")}
              </label>
              <SelectField
                className="max-w-xs"
                value={resolvedProfileId}
                onValueChange={(value) => {
                  void applyProfile(value ?? "");
                }}
                options={[
                  { value: "", label: t("translate.profileNone") },
                  ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                ]}
                disabled={profileSelectDisabled || isTranslating}
                placeholder={profilesLoading ? t("translate.profileLoading") : undefined}
                aria-label={t("translate.profileAria")}
                aria-labelledby="translate-profile-label"
                compact
              />
            </div>

            {resolvedProfileId ? (
              <div className="flex items-center gap-2">
                <label className="text-label-sm text-neutral uppercase" id="translate-prompt-template-label">
                  {t("translate.promptTemplateLabel")}
                </label>
                <SelectField
                  className="max-w-xs"
                  value={resolvedPromptTemplateId}
                  onValueChange={(value) => {
                    setSelectedPromptTemplateId(value ?? "");
                  }}
                  options={promptTemplateOptions}
                  disabled={profileSelectDisabled || isTranslating || isApplyingProfile}
                  placeholder={profilesLoading ? t("translate.promptTemplateLoading") : undefined}
                  aria-label={t("translate.promptTemplateAria")}
                  aria-labelledby="translate-prompt-template-label"
                  compact
                />
              </div>
            ) : null}

            <div className="hidden h-6 w-px bg-outline-variant sm:block" aria-hidden />

            <div className="flex items-center gap-2">
              <label className="text-label-sm text-neutral uppercase" id="translate-model-label">
                {t("translate.modelLabel")}
              </label>
              <SelectField
                className="max-w-xs"
                value={resolvedModelId}
                onValueChange={(value) => setSelectedModelId(value ?? "")}
                options={
                  modelsLoading || modelOptions.length === 0
                    ? []
                    : modelOptions.map((option) => ({ value: option.id, label: option.label }))
                }
                disabled={modelSelectDisabled || isTranslating}
                placeholder={
                  modelsLoading
                    ? t("translate.modelLoading")
                    : modelOptions.length === 0
                      ? t("translate.modelEmpty")
                      : undefined
                }
                aria-label={t("translate.modelAria")}
                aria-labelledby="translate-model-label"
                compact
              />
            </div>

            <div className="hidden h-6 w-px bg-outline-variant sm:block" aria-hidden />

            <div className="flex flex-wrap items-center gap-1">
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
                compact
              />

              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("translate.swapLanguages")}
                onClick={swapLanguages}
                disabled={isTranslating || (sourceLang === "auto" && !detectedSourceLang)}
              >
                <IconMaterialSymbolsLightSwapHoriz className="size-5" aria-hidden />
              </Button>

              <ComboboxField
                value={targetLang}
                onValueChange={(value) => setTargetLang((value ?? "en") as SelectableLanguageId)}
                options={targetLanguageOptions.map((option) => ({ value: option.id, label: option.label }))}
                disabled={isTranslating}
                emptyText={t("common.noMatches")}
                aria-label={t("translate.targetLanguage")}
                compact
              />
            </div>
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
              <div className="flex min-w-0 items-center gap-2">
                <span className={paneLabelClassName}>{t("translate.source")}</span>
                {detectedSourceLang ? (
                  <span className="truncate text-label-sm text-neutral uppercase">
                    {t("translate.detected", { language: t(`translate.languages.${detectedSourceLang}`) })}
                  </span>
                ) : null}
              </div>
              {sourceText ? (
                <Button
                  type="button"
                  className={`${iconButtonClassName} group`}
                  aria-label={t("translate.clearSource")}
                  onClick={() => {
                    void clearSource();
                  }}
                >
                  <IconMaterialSymbolsLightClose
                    className="size-4 transition-transform duration-150 group-hover:scale-110"
                    aria-hidden
                  />
                </Button>
              ) : null}
            </div>

            <div className="relative min-h-0 flex-1">
              <label className="sr-only" htmlFor="translate-source-text">
                {t("translate.sourceTextAria")}
              </label>
              {/* Fixed pane: fill parent, scale font to shell height, scroll when content overflows. */}
              <TextAutosize
                id="translate-source-text"
                layout="fill"
                className="h-full min-h-40 lg:min-h-0"
                textareaClassName="p-gutter"
                placeholder={t("translate.sourcePlaceholder")}
                spellCheck={false}
                value={sourceText}
                disabled={isTranslating}
                onChange={(event) => {
                  setSourceText(event.currentTarget.value);
                  setDetectedSourceLang(null);
                  setHasTranslated(false);
                  setErrorMessage(null);
                  setConfidencePercent(0);
                  setLatencyMs(null);
                }}
              />
            </div>

            <div className="flex shrink-0 items-center bg-surface p-gutter">
              {charCount > 0 ? <span className="text-label-sm text-neutral tabular-nums">{charCount}</span> : null}
              <div className="flex-1" />
              {isTranslating ? (
                <Button
                  type="button"
                  className={`${iconButtonClassName} group`}
                  aria-label={t("translate.stopAria")}
                  onClick={() => {
                    void stopTranslation();
                  }}
                >
                  <IconMaterialSymbolsLightStopCircleOutline
                    className="size-4 transition-transform duration-150 group-hover:scale-110"
                    aria-hidden
                  />
                </Button>
              ) : (
                <Button
                  type="button"
                  className={`${iconButtonClassName} group`}
                  disabled={!canTranslate}
                  focusableWhenDisabled
                  aria-label={t("translate.translate")}
                  onClick={() => {
                    void handleTranslate();
                  }}
                >
                  <IconPepiconsPrintEnter
                    className="size-4 transition-transform duration-150 group-hover:scale-110"
                    aria-hidden
                  />
                </Button>
              )}
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
                    <IconMaterialSymbolsLightMarkdown className="size-4" aria-hidden />
                  ) : (
                    <IconMaterialSymbolsLightMarkdownOutline className="size-4" aria-hidden />
                  )}
                </Button>
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

            {/* Same stepped font as source: measure error/output/loading label, fill fixed pane. */}
            <TextAutosizeContent
              layout="fill"
              fontScale={isMarkdownView && !!outputText && !errorMessage ? "fixed" : "stepped"}
              stickToEnd={isTranslating}
              className="min-h-0 flex-1"
              contentClassName="p-gutter"
              text={
                errorMessage
                  ? `${t("translate.errorPrefix")}: ${errorMessage}`
                  : isMarkdownView
                    ? ""
                    : outputText || (isTranslating ? t("translate.translating") : "")
              }
            >
              {errorMessage ? (
                <p className="min-w-0 break-words whitespace-pre-wrap text-error select-text" role="alert">
                  {t("translate.errorPrefix")}: {errorMessage}
                </p>
              ) : outputText || isTranslating ? (
                isMarkdownView && outputText ? (
                  <MarkdownOutput text={outputText} isStreaming={streamOutputActive} />
                ) : (
                  <TextLoading
                    text={outputText}
                    isLoading={isTranslating}
                    scramble={streamOutputActive}
                    loadingLabel={t("translate.translating")}
                    className="text-on-surface"
                  />
                )
              ) : (
                <p className="text-neutral italic select-none">{t("translate.outputPlaceholder")}</p>
              )}
            </TextAutosizeContent>

            <div className="flex shrink-0 flex-wrap items-center gap-4 bg-surface-2 p-gutter">
              <div className="flex-1" />
              {activeModelLabel || confidencePercent > 0 || latencyMs !== null ? (
                <div
                  className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-label-sm text-neutral"
                  role="status"
                >
                  {activeModelLabel ? (
                    <span className="min-w-0 truncate" title={activeModelLabel}>
                      {t("translate.activeModel", { model: activeModelLabel })}
                    </span>
                  ) : null}
                  {activeModelLabel && confidencePercent > 0 ? (
                    <span className="text-outline-variant select-none" aria-hidden>
                      ·
                    </span>
                  ) : null}
                  {confidencePercent > 0 ? (
                    <span className="shrink-0 tabular-nums">
                      {t("translate.confidenceValue", { percent: confidencePercent })}
                    </span>
                  ) : null}
                  {(activeModelLabel || confidencePercent > 0) && latencyMs !== null ? (
                    <span className="text-outline-variant select-none" aria-hidden>
                      ·
                    </span>
                  ) : null}
                  {latencyMs !== null ? (
                    <span className="shrink-0 tabular-nums">{t("translate.latencyValue", { ms: latencyMs })}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
