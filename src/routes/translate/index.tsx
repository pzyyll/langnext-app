// ABOUTME: General translation index page with source/target panes and streaming.
// ABOUTME: Nested under /translate; selects profiles and calls provider models via IPC.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightContentCopy from "~icons/material-symbols-light/content-copy";
import IconMaterialSymbolsLightMarkdown from "~icons/material-symbols-light/markdown";
import IconMaterialSymbolsLightMarkdownOutline from "~icons/material-symbols-light/markdown-outline";
import IconMaterialSymbolsLightStopCircleOutline from "~icons/material-symbols-light/stop-circle-outline";
import IconMaterialSymbolsLightVolumeUp from "~icons/material-symbols-light/volume-up";
import IconPepiconsPrintEnter from "~icons/pepicons-print/enter";
import { IconButton } from "../../components/IconButton";
import { MarkdownOutput } from "../../components/markdown/MarkdownOutput";
import { useToast } from "../../components/toast/useToast";
import { SelectField } from "../../components/SelectField";
import { TextAutosize, TextAutosizeContent } from "../../components/TextAutosize";
import { TextLoading } from "../../components/TextLoading";
import { toggleOutputViewMode, type OutputViewMode } from "../../lib/output-view-mode";
import { shouldApplyProfileResult } from "../../query/profileApplyGuard";
import {
  allProviderModelsOptions,
  integrationListOptions,
  profileDetailOptions,
  profileListOptions,
  providerListOptions,
} from "../../query/options";
import { newClientRequestId } from "../../features/translate/newClientRequestId";
import {
  resolveTranslateFailureMessage,
  resolveTranslateFailureRecovery,
} from "../../features/translate/resolveTranslateFailureMessage";
import { runDetectLanguage, runStartTranslateStream } from "../../features/translate/runTranslate";
import { useTranslateStreamSession } from "../../features/translate/useTranslateStreamSession";
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
import { LanguageChipBar } from "./-LanguageChipBar";
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
import type { ProviderInstanceDto, ProviderModelDto } from "../../storage/types";

export const Route = createFileRoute("/translate/")({
  component: TranslatePage,
});

/** Viewport minus titlebar only — main shell is edge-to-edge (no outer gutter). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-var(--spacing-titlebar-height))]";

/** Auto-dismiss for the user-cancel "Stopped" toast. */
const STOPPED_TOAST_MS = 2000;

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

function TranslatePage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Restore workspaces (presets, languages, draft text) across navigation and restarts.
  const [boot] = useState(() => {
    const store = getTranslateWorkspacesStore();
    return { store, workspace: getActiveWorkspace(store) };
  });
  const [workspaceStore, setWorkspaceStore] = useState<TranslateWorkspacesStore>(() => boot.store);
  const [sourceLang, setSourceLang] = useState<SourceLanguageId>(boot.workspace.sourceLang);
  const [targetLang, setTargetLang] = useState<SelectableLanguageId>(boot.workspace.targetLang);
  /** Per-workspace used-language tabs (grow-on-use; empty on new workspace). */
  const [usedSourceLangs, setUsedSourceLangs] = useState<LanguageId[]>(() => [...boot.workspace.usedSourceLangs]);
  const [usedTargetLangs, setUsedTargetLangs] = useState<LanguageId[]>(() => [...boot.workspace.usedTargetLangs]);
  const [detectedSourceLang, setDetectedSourceLang] = useState<LanguageId | null>(boot.workspace.detectedSourceLang);
  const [profilePrimaryLang, setProfilePrimaryLang] = useState<LanguageId | null>(null);
  const [profilePreferredTargetLang, setProfilePreferredTargetLang] = useState<LanguageId | null>(null);
  const [sourceText, setSourceText] = useState(boot.workspace.sourceText);
  const [outputText, setOutputText] = useState(boot.workspace.outputText);
  const [errorMessage, setErrorMessage] = useState<string | null>(boot.workspace.errorMessage);
  /** Tracks whether a translate attempt has finished; kept for session UX side-effects (clear on edit). */
  const [, setHasTranslated] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(boot.workspace.latencyMs);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  /** True after the first stream chunk of the current run; swaps loading dots for scramble. */
  const [streamOutputActive, setStreamOutputActive] = useState(false);
  /** Per-workspace plain/markdown output preference (not the global quick-translate key). */
  const [outputViewMode, setOutputViewMode] = useState<OutputViewMode>(boot.workspace.outputViewMode);
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
  const integrationsQuery = useQuery(integrationListOptions());

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
  const resolvedProfileId = profiles.some((profile) => profile.id === selectedProfileId) ? selectedProfileId : "";
  const activeProfile = profiles.find((profile) => profile.id === resolvedProfileId) ?? null;
  const activeIsPluginProfile = activeProfile?.engine.kind === "plugin_capability";
  // Plugin profiles do not overwrite workspace model selection.
  const resolvedModelId = activeIsPluginProfile
    ? selectedModelId && modelOptions.some((option) => option.id === selectedModelId)
      ? selectedModelId
      : (modelOptions[0]?.id ?? "")
    : selectedModelId && modelOptions.some((option) => option.id === selectedModelId)
      ? selectedModelId
      : (modelOptions[0]?.id ?? "");
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
  const streamSession = useTranslateStreamSession();
  /** Source/target panes grid — language more-picker sizes to this box. */
  const languagePopupBoundsRef = useRef<HTMLDivElement>(null);

  /** Snapshot of UI fields that belong to the active workspace. */
  function buildWorkspacePatch(): Partial<Omit<TranslateWorkspace, "id">> {
    return {
      profileId: selectedProfileId,
      modelId: selectedModelId,
      sourceLang,
      targetLang,
      usedSourceLangs,
      usedTargetLangs,
      outputViewMode,
      promptTemplateId: selectedPromptTemplateId,
      sourceText,
      outputText,
      detectedSourceLang,
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
    setUsedSourceLangs([...workspace.usedSourceLangs]);
    setUsedTargetLangs([...workspace.usedTargetLangs]);
    setOutputViewMode(workspace.outputViewMode);
    setSelectedPromptTemplateId(workspace.promptTemplateId);
    setSourceText(workspace.sourceText);
    setOutputText(workspace.outputText);
    setDetectedSourceLang(workspace.detectedSourceLang);
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
    const hadActive = streamSession.hasActiveRequest();
    translateGeneration.current += 1;
    await streamSession.abortActive();
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
    const hadActive = streamSession.hasActiveRequest();
    translateGeneration.current += 1;
    await streamSession.abortActive();
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
    // New task: keep profile/model/prompt, but seed languages from the profile (not the
    // previous workspace's tab selection). Empty used-lang history + empty drafts.
    const profileSeed = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
    const seedSourceLang: SourceLanguageId =
      profileSeed && isSelectableLanguageId(profileSeed.sourceLang) ? profileSeed.sourceLang : AUTO_LANGUAGE;
    const seedTargetLang: SelectableLanguageId =
      profileSeed && isSelectableLanguageId(profileSeed.targetLang) ? profileSeed.targetLang : AUTO_LANGUAGE;
    const workspace = createTranslateWorkspace({
      name,
      profileId: selectedProfileId,
      modelId: selectedModelId,
      sourceLang: seedSourceLang,
      targetLang: seedTargetLang,
      promptTemplateId: selectedPromptTemplateId,
    });
    const next = addWorkspaceToStore(flushed, workspace);
    skipNextWorkspacePersist.current = true;
    commitWorkspaceStore(next);
    applyWorkspaceToUi(getActiveWorkspace(next));
  }

  async function deleteWorkspace(workspaceId: string) {
    const hadActive = streamSession.hasActiveRequest() && workspaceId === workspaceStore.activeWorkspaceId;
    if (hadActive) {
      translateGeneration.current += 1;
      await streamSession.abortActive();
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
    usedSourceLangs,
    usedTargetLangs,
    outputViewMode,
    selectedPromptTemplateId,
    sourceText,
    outputText,
    detectedSourceLang,
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
      { id: AUTO_LANGUAGE, label: t("translate.languages.auto") },
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

  // Bump generation on unmount so late events ignore UI; session hook cancels in-flight.
  useEffect(() => {
    return () => {
      translateGeneration.current += 1;
    };
  }, []);

  const charCount = sourceText.length;
  const canTranslate =
    sourceText.trim().length > 0 &&
    !isTranslating &&
    !isApplyingProfile &&
    (activeIsPluginProfile || (resolvedModelId.length > 0 && !modelsLoading));

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

  /** Runtime translate failures go to the shared toast, not the output pane. */
  function showTranslateErrorToast(message: string, errorCode?: string | null) {
    const title = t("translate.errorPrefix");
    const recovery = resolveTranslateFailureRecovery(errorCode);
    const action = recovery
      ? {
          label: t("translate.openPlugins"),
          onClick: () => {
            void navigate({ to: recovery.path });
          },
        }
      : undefined;
    if (!message || message === title) {
      toast.error({ title, action });
      return;
    }
    toast.error({ title, description: message, action });
  }

  /** Map known backend error codes to localized copy; fall back to server message. */
  function failureMessage(errorCode: string | null | undefined, message: string | undefined): string {
    return resolveTranslateFailureMessage(errorCode, message, {
      timeout: t("translate.errors.timeout"),
      invalidResponse: t("translate.errors.invalidResponse"),
      fallback: t("translate.errorPrefix"),
      integrationDisabled: t("translate.errors.integrationDisabled"),
      integrationUnconfigured: t("translate.errors.integrationUnconfigured"),
      integrationUnvalidated: t("translate.errors.integrationUnvalidated"),
      integrationDegraded: t("translate.errors.integrationDegraded"),
      pluginMissing: t("translate.errors.pluginMissing"),
      invalidConfiguration: t("translate.errors.invalidConfiguration"),
      languageUnresolved: t("translate.errors.languageUnresolved"),
    });
  }

  async function stopTranslation() {
    // Bump generation so late chunks/errors are ignored; toast here because listeners
    // are cleared in abort and the cancelled done event may never reach finishCancelledUi.
    const hadActive = streamSession.hasActiveRequest();
    translateGeneration.current += 1;
    setIsTranslating(false);
    setStreamOutputActive(false);
    setErrorMessage(null);
    await streamSession.abortActive();
    if (hadActive) {
      showStoppedToast();
    }
  }

  async function clearSource() {
    const hadActive = streamSession.hasActiveRequest();
    translateGeneration.current += 1;
    await streamSession.abortActive();
    setSourceText("");
    setOutputText("");
    setErrorMessage(null);
    setHasTranslated(false);
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
    setIsTranslating(false);
    setStreamOutputActive(false);
  }

  function finishErrorUi(generation: number, message: string, latency: number | null, errorCode?: string | null) {
    if (generation !== translateGeneration.current) {
      return;
    }
    // Keep prior/partial output; surface the failure via toast only.
    setLatencyMs(latency);
    setErrorMessage(null);
    setIsTranslating(false);
    setStreamOutputActive(false);
    showTranslateErrorToast(message, errorCode);
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
      modelId?: string | null;
      sourceLang: string;
      targetLang: string;
      text: string;
      profileId?: string | null;
      promptTemplateId?: string | null;
      sourceLangId?: string | null;
      targetLangId?: string | null;
      effectiveSourceLangId?: string | null;
      effectiveTargetLangId?: string | null;
    },
    requestId: string,
  ) {
    // First chunk replaces any retained previous result; later chunks append.
    let receivedChunk = false;

    try {
      // Listen-before-invoke: subscriptions must be live before stream start.
      const prepared = await streamSession.prepareSession(
        requestId,
        {
          onChunk: (delta) => {
            if (generation !== translateGeneration.current) {
              return;
            }
            const isFirstChunk = !receivedChunk;
            receivedChunk = true;
            if (isFirstChunk) {
              setStreamOutputActive(true);
            }
            setOutputText((prev) => (isFirstChunk ? delta : prev + delta));
            setHasTranslated(true);
          },
          onReset: (modelId) => {
            if (generation !== translateGeneration.current) {
              return;
            }
            // Drop partial text from the failed model before fallback chunks arrive.
            receivedChunk = false;
            setStreamOutputActive(false);
            setOutputText("");
            setActiveModelLabel(modelLabelById.get(modelId) ?? modelId);
          },
          onDone: (done) => {
            if (generation !== translateGeneration.current) {
              return;
            }
            streamSession.markTerminal(requestId);
            if (done.errorCode === "cancelled") {
              finishCancelledUi(generation);
              return;
            }
            if (done.ok) {
              // Prefer full text so we do not drift on partial assembly.
              finishSuccessUi(generation, done.translatedText, done.latencyMs, done.modelId ?? null);
            } else {
              finishErrorUi(generation, failureMessage(done.errorCode, done.message), done.latencyMs, done.errorCode);
            }
          },
          onError: (err) => {
            if (generation !== translateGeneration.current) {
              return;
            }
            streamSession.markTerminal(requestId);
            if (err.errorCode === "cancelled") {
              finishCancelledUi(generation);
              return;
            }
            finishErrorUi(generation, failureMessage(err.errorCode, err.message), err.latencyMs, err.errorCode);
          },
        },
        () => generation === translateGeneration.current,
      );
      if (!prepared) {
        return;
      }

      const providersById = new Map((providersQuery.data ?? []).map((p) => [p.id, p]));
      const modelsById = new Map((modelsQuery.data ?? []).map((m) => [m.id, m]));
      const integrationsById = new Map((integrationsQuery.data ?? []).map((i) => [i.id, i]));
      const profile = (profilesQuery.data ?? []).find((p) => p.id === payload.profileId) ?? null;
      await runStartTranslateStream(payload, requestId, {
        snapshots: { providersById, modelsById, profile, integrationsById },
        handlers: prepared,
      });
      if (generation !== translateGeneration.current) {
        streamSession.clearListeners();
      }
    } catch (err) {
      if (generation !== translateGeneration.current) {
        return;
      }
      streamSession.clearListeners();
      streamSession.releaseIfActive(requestId);
      finishErrorUi(generation, getIpcErrorMessage(err, t("translate.errorPrefix")), null);
    }
  }

  async function handleTranslate() {
    const trimmed = sourceText.trim();
    if (!trimmed) {
      return;
    }
    if (!activeIsPluginProfile && !resolvedModelId) {
      toast.error({ title: t("translate.selectModelFirst") });
      return;
    }
    if (activeIsPluginProfile && !resolvedProfileId) {
      toast.error({ title: t("translate.selectModelFirst") });
      return;
    }

    // Cancel any prior in-flight request before starting a new one.
    const hadActive = streamSession.hasActiveRequest();
    await streamSession.abortActive();
    if (hadActive) {
      showStoppedToast();
    }
    const generation = ++translateGeneration.current;
    beginTranslateUi();

    const requestId = newClientRequestId("translate");
    streamSession.setActiveRequestId(requestId);

    // Resolve the effective source id. Auto-detect first when source is "auto".
    let effectiveSourceId: LanguageId;
    if (sourceLang === "auto") {
      try {
        const detected = await runDetectLanguage(
          { text: trimmed, modelId: resolvedModelId || null, profileId: resolvedProfileId || null },
          requestId,
          {
            providersById: new Map((providersQuery.data ?? []).map((p) => [p.id, p])),
            modelsById: new Map((modelsQuery.data ?? []).map((m) => [m.id, m])),
            profile: (profilesQuery.data ?? []).find((p) => p.id === resolvedProfileId) ?? null,
            integrationsById: new Map((integrationsQuery.data ?? []).map((i) => [i.id, i])),
          },
        );
        if (generation !== translateGeneration.current) {
          return;
        }
        if (!detected.ok) {
          streamSession.releaseIfActive(requestId);
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
          streamSession.releaseIfActive(requestId);
          finishErrorUi(generation, t("translate.errors.detectFailed"), detected.latencyMs);
          return;
        }
        setDetectedSourceLang(detected.languageId);
        effectiveSourceId = detected.languageId;
      } catch (err) {
        if (generation !== translateGeneration.current) {
          return;
        }
        streamSession.releaseIfActive(requestId);
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
      // Plugin profiles do not use modelId; omit rather than inventing a placeholder UUID.
      modelId: activeIsPluginProfile ? null : resolvedModelId,
      sourceLang: sourceLabel,
      targetLang: targetLabel,
      text: trimmed,
      profileId: resolvedProfileId || null,
      promptTemplateId: activeIsPluginProfile ? null : resolvedPromptTemplateId || null,
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
    <div
      className={`
        ${LAYOUT_HEIGHT_CLASS}
        flex min-h-0
      `}
    >
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {/* Top toolbar: session config only (profile / prompt / model). Languages live in pane headers. */}
        <div
          className="
            flex h-12 shrink-0 items-center gap-gutter overflow-hidden border-b border-outline bg-surface-container-low
            px-gutter
          "
        >
          <div className="flex min-w-0 items-center gap-2">
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

          {resolvedProfileId && !activeIsPluginProfile ? (
            <div className="flex min-w-0 items-center gap-2">
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

          {activeIsPluginProfile ? null : (
            <>
              <div
                className="
                  hidden h-6 w-px shrink-0 bg-outline-variant
                  sm:block
                "
                aria-hidden
              />

              <div className="flex min-w-0 items-center gap-2">
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
            </>
          )}
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
        {/* Source / target workspace */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-gutter">
          <LanguageChipBar
            sourceLang={sourceLang}
            targetLang={targetLang}
            usedSourceLangs={usedSourceLangs}
            usedTargetLangs={usedTargetLangs}
            sourceOptions={sourceLanguageOptions}
            targetOptions={targetLanguageOptions}
            disabled={isTranslating}
            swapDisabled={sourceLang === "auto" && !detectedSourceLang}
            detectedLanguageLabel={detectedSourceLang ? t(`translate.languages.${detectedSourceLang}`) : null}
            popupBoundsRef={languagePopupBoundsRef}
            onSourceChange={(value) => {
              setSourceLang(value);
              setDetectedSourceLang(null);
            }}
            onTargetChange={setTargetLang}
            onUsedLangsChange={({ source, target }) => {
              setUsedSourceLangs(source);
              setUsedTargetLangs(target);
            }}
            onSwap={swapLanguages}
          />

          <div
            ref={languagePopupBoundsRef}
            className="
              grid min-h-0 flex-1 grid-cols-1 gap-gutter
              lg:grid-cols-2
            "
          >
            {/* Source pane */}
            <section
              className="
                shadow-frame flex min-h-64 flex-col border border-outline bg-surface-container-lowest
                lg:min-h-0
              "
              aria-label={t("translate.source")}
            >
              <div className="relative min-h-0 flex-1">
                <label className="sr-only" htmlFor="translate-source-text">
                  {t("translate.sourceTextAria")}
                </label>
                {/* Fixed pane: fill parent, scale font to shell height, scroll when content overflows. */}
                <TextAutosize
                  id="translate-source-text"
                  layout="fill"
                  className="
                    h-full min-h-40
                    lg:min-h-0
                  "
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
                    setLatencyMs(null);
                  }}
                />
              </div>

              <div
                className="
                  flex shrink-0 items-center gap-1 border-t border-outline bg-surface-container-lowest p-gutter
                "
              >
                {charCount > 0 ? <span className="text-label-sm text-neutral tabular-nums">{charCount}</span> : null}
                <div className="flex-1" />
                {sourceText ? (
                  <IconButton
                    aria-label={t("translate.clearSource")}
                    onClick={() => {
                      void clearSource();
                    }}
                  >
                    <IconMaterialSymbolsLightClose aria-hidden />
                  </IconButton>
                ) : null}
                {isTranslating ? (
                  <IconButton
                    aria-label={t("translate.stopAria")}
                    onClick={() => {
                      void stopTranslation();
                    }}
                  >
                    <IconMaterialSymbolsLightStopCircleOutline aria-hidden />
                  </IconButton>
                ) : (
                  <IconButton
                    disabled={!canTranslate}
                    focusableWhenDisabled
                    aria-label={t("translate.translate")}
                    onClick={() => {
                      void handleTranslate();
                    }}
                  >
                    <IconPepiconsPrintEnter aria-hidden />
                  </IconButton>
                )}
              </div>
            </section>

            {/* Translation pane */}
            <section
              className="
                shadow-frame flex min-h-64 flex-col border border-outline bg-surface-container-low
                lg:min-h-0
              "
              aria-label={t("translate.translation")}
            >
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
                  <p className="min-w-0 wrap-break-word whitespace-pre-wrap text-error select-text" role="alert">
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

              <div className="flex shrink-0 items-center gap-1 border-t border-outline bg-surface-container-low p-gutter">
                {latencyMs !== null ? (
                  <span className="text-label-sm text-neutral tabular-nums" role="status">
                    {t("translate.latencyValue", { ms: latencyMs })}
                  </span>
                ) : null}
                <div className="flex-1" />
                <IconButton
                  aria-label={isMarkdownView ? t("translate.plainText") : t("translate.markdownPreview")}
                  aria-pressed={isMarkdownView}
                  onClick={() => {
                    setOutputViewMode((current) => toggleOutputViewMode(current));
                  }}
                >
                  {isMarkdownView ? (
                    <IconMaterialSymbolsLightMarkdown aria-hidden />
                  ) : (
                    <IconMaterialSymbolsLightMarkdownOutline aria-hidden />
                  )}
                </IconButton>
                <IconButton
                  aria-label={copyFeedback ? t("translate.copied") : t("translate.copy")}
                  onClick={() => {
                    void copyOutput();
                  }}
                  disabled={!outputText || !!errorMessage}
                >
                  <IconMaterialSymbolsLightContentCopy aria-hidden />
                </IconButton>
                <IconButton aria-label={t("translate.speak")} disabled>
                  <IconMaterialSymbolsLightVolumeUp aria-hidden />
                </IconButton>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
