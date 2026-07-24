// ABOUTME: Nested translation profile management page at /translate/profiles.
// ABOUTME: Full CRUD for profiles, model chains, languages, and prompt templates.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ConfigEditorLayout, configEditorRenameInputClassName } from "../../components/layouts/ConfigEditorLayout";
import { ConfigRailHeader } from "../../components/layouts/ConfigRailHeader";
import { PageLayout } from "../../components/layouts/PageLayout";
import { useToast } from "../../components/toast/useToast";
import {
  iconButtonClassName,
  inputClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  radioClassName,
  radioIndicatorClassName,
  switchRootClassName,
  switchThumbClassName,
  dangerIconButtonClassName,
  dangerButtonClassName,
} from "../../components/ui";
import { ComboboxField } from "../../components/ComboboxField";
import { SelectField } from "../../components/SelectField";
import { profileKeys } from "../../query/keys";
import {
  allProviderModelsOptions,
  integrationDefinitionListOptions,
  integrationListOptions,
  profileDetailOptions,
  profileListOptions,
  providerListOptions,
} from "../../query/options";
import { deleteTranslationProfile, saveTranslationProfile, setTranslationProfileEnabled } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { PromptTemplate, ProviderInstanceDto, ProviderModelDto, TranslationProfileDto } from "../../storage/types";
import { AddTranslationProfileDialog } from "../../features/translate/AddTranslationProfileDialog";
import {
  buildTranslationEngineOptions,
  listCompatiblePluginRebindCandidates,
  type TranslationEngineOption,
} from "../../features/translate/translationEngineOptions";
import {
  AUTO_LANGUAGE,
  LANGUAGE_IDS,
  getDefaultProfileLanguages,
  isLanguageId,
  isSelectableLanguageId,
  type LanguageId,
  type SelectableLanguageId,
  type SourceLanguageId,
} from "./-languages";
import { getCollapsedPromptTemplateIds, setCollapsedPromptTemplateIds } from "./-promptTemplateCollapse";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import ExpandCircleDownOutlineIcon from "~icons/material-symbols/expand-circle-down-outline";

export const Route = createFileRoute("/translate/profiles")({
  component: TranslateProfilesPage,
});

const DEFAULT_SYSTEM_TEMPLATE = `You are a professional translation engine. Translate the user's text from {{source_language}} to {{target_language}}.
Rules:
- Output only the translated text, with no preface, labels, quotes, or explanations.
- Preserve meaning, tone, and formatting (line breaks, lists, punctuation) when possible.
- If the source is already in the target language, return it unchanged.
- Do not invent content that is not present in the source.
- <translate_content> tag content is the text that needs to be translated.`;

const DEFAULT_USER_TEMPLATE = `<translate_content>
{{text}}
</translate_content>`;

const DEFAULT_TEMPERATURE = 0.2;

/** Default display name for the first prompt template on a new profile. */
const DEFAULT_PROMPT_TEMPLATE_NAME = "Default";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

const templateTextareaClassName =
  "min-h-28 w-full resize-y rounded-none border border-line bg-surface p-3 font-mono text-body-tight font-normal text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

const promptTemplateCardClassName = "shadow-frame border border-line bg-surface";

/** Header row doubles as Collapsible.Trigger (div); nested controls stopPropagation. */
const promptTemplateCardHeaderClassName =
  "group flex flex-wrap items-center justify-between gap-3 p-4 select-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-panel-open:border-b data-panel-open:border-outline-variant";

const promptTemplateCardPanelClassName =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden";

const promptTemplateCardBodyClassName = "space-y-4 p-4";

/** Card title for a prompt template (display + inline rename). */
const promptTemplateTitleClassName = "min-w-0 truncate text-title-dialog font-bold text-on-surface";

/** Inline rename field for a prompt template card title. */
const promptTemplateRenameInputClassName =
  "h-control-height min-w-0 flex-1 max-w-md rounded-none border border-line bg-surface px-2 text-title-dialog font-bold text-on-surface placeholder:text-neutral focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface disabled:border-disabled disabled:text-disabled";

const sectionDividerClassName = "space-y-4 border-t border-outline-variant pt-4";

const squareIconButtonClassName = `${outlineButtonClassName} size-control-height shrink-0 px-0`;

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
  /** Engine discriminant; immutable after create. */
  engineKind: "llm_model_chain" | "plugin_capability";
  // LLM fields
  primaryModelId: string;
  languageDetectionModelId: string;
  fallbackModelIds: string[];
  temperature: string;
  maxOutputTokens: string;
  defaultPromptTemplateId: string;
  promptTemplates: PromptTemplate[];
  templateVersion: number;
  providerOptionsJson: unknown | null;
  // Plugin fields
  integrationInstanceId: string;
  translateCapabilityId: string;
  detectCapabilityId: string;
  capabilityPreferencesVersion: number;
  capabilityPreferences: unknown;
};

function newPromptTemplateId(): string {
  return crypto.randomUUID();
}

function createDefaultPromptTemplate(name = DEFAULT_PROMPT_TEMPLATE_NAME): PromptTemplate {
  return {
    id: newPromptTemplateId(),
    name,
    systemTemplate: DEFAULT_SYSTEM_TEMPLATE,
    userTemplate: DEFAULT_USER_TEMPLATE,
  };
}

function toListItem(dto: TranslationProfileDto): ProfileListItem {
  if (dto.engine.kind === "plugin_capability") {
    return {
      ...dto,
      primaryModelId: null,
      fallbackCount: 0,
    };
  }
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
  const defaultTemplate = createDefaultPromptTemplate();
  return {
    id: null,
    name: "",
    enabled: true,
    sourceLang: "auto",
    targetLang: AUTO_LANGUAGE,
    primaryLang: primary,
    preferredTargetLang: target,
    engineKind: "llm_model_chain",
    primaryModelId: defaultModelId,
    languageDetectionModelId: "",
    fallbackModelIds: [],
    temperature: "",
    maxOutputTokens: "",
    defaultPromptTemplateId: defaultTemplate.id,
    promptTemplates: [defaultTemplate],
    templateVersion: 1,
    providerOptionsJson: null,
    integrationInstanceId: "",
    translateCapabilityId: "",
    detectCapabilityId: "",
    capabilityPreferencesVersion: 1,
    capabilityPreferences: {},
  };
}

function emptyPluginDraft(
  uiLanguage: string,
  integrationInstanceId: string,
  translateCapabilityId: string,
  detectCapabilityId: string | null,
): ProfileDraft {
  const base = emptyDraft("", uiLanguage);
  return {
    ...base,
    engineKind: "plugin_capability",
    primaryModelId: "",
    promptTemplates: [],
    defaultPromptTemplateId: "",
    integrationInstanceId,
    translateCapabilityId,
    detectCapabilityId: detectCapabilityId ?? "",
    capabilityPreferencesVersion: 1,
    capabilityPreferences: {},
  };
}

function draftFromDto(dto: TranslationProfileDto, modelOptions: ModelOption[], uiLanguage: string): ProfileDraft {
  const defaults = getDefaultProfileLanguages(uiLanguage);
  const common = {
    id: dto.id as string | null,
    name: dto.name,
    enabled: dto.enabled,
    sourceLang: (isSelectableLanguageId(dto.sourceLang) ? dto.sourceLang : "auto") as SourceLanguageId,
    targetLang: (isSelectableLanguageId(dto.targetLang) ? dto.targetLang : AUTO_LANGUAGE) as SelectableLanguageId,
    primaryLang: (isLanguageId(dto.primaryLang) ? dto.primaryLang : defaults.primary) as LanguageId,
    preferredTargetLang: (isLanguageId(dto.preferredTargetLang)
      ? dto.preferredTargetLang
      : defaults.target) as LanguageId,
  };

  if (dto.engine.kind === "plugin_capability") {
    return {
      ...common,
      engineKind: "plugin_capability",
      primaryModelId: "",
      languageDetectionModelId: "",
      fallbackModelIds: [],
      temperature: "",
      maxOutputTokens: "",
      defaultPromptTemplateId: "",
      promptTemplates: [],
      templateVersion: 1,
      providerOptionsJson: null,
      integrationInstanceId: dto.engine.integrationInstanceId,
      translateCapabilityId: dto.engine.translateCapabilityId,
      detectCapabilityId: dto.engine.detectCapabilityId ?? "",
      capabilityPreferencesVersion: dto.engine.capabilityPreferencesVersion,
      capabilityPreferences: dto.engine.capabilityPreferences,
    };
  }

  const sortedTargets = [...dto.targets].sort((a, b) => a.priority - b.priority);
  const modelIds = sortedTargets.map((target) => target.providerModelId);
  // Only keep ids that still exist. Do not invent modelOptions[0] — that made empty-target
  // profiles look configured after a model delete/re-add without persisting a new binding.
  const primaryModelId = modelIds.find((id) => modelOptions.some((option) => option.id === id)) ?? "";
  const fallbackModelIds = modelIds.filter(
    (id) => id !== primaryModelId && modelOptions.some((option) => option.id === id),
  );
  const llmEngine = dto.engine;
  if (llmEngine.kind !== "llm_model_chain") {
    // Exhaustiveness guard; plugin branch returned above.
    throw new Error("expected llm_model_chain engine");
  }
  // Inherit the profile primary model unless an explicit LLM detector model is configured.
  const languageDetection =
    llmEngine.languageDetection?.type === "llm" && llmEngine.languageDetection.modelId != null
      ? llmEngine.languageDetection.modelId
      : "";
  const promptTemplates =
    dto.promptTemplates.length > 0
      ? dto.promptTemplates.map((template) => ({ ...template }))
      : [createDefaultPromptTemplate()];
  const defaultPromptTemplateId = promptTemplates.some((template) => template.id === llmEngine.defaultPromptTemplateId)
    ? llmEngine.defaultPromptTemplateId
    : promptTemplates[0]!.id;

  return {
    ...common,
    engineKind: "llm_model_chain",
    primaryModelId,
    languageDetectionModelId: languageDetection,
    fallbackModelIds,
    temperature: llmEngine.temperature != null ? String(llmEngine.temperature) : "",
    maxOutputTokens: llmEngine.maxOutputTokens != null ? String(llmEngine.maxOutputTokens) : "",
    defaultPromptTemplateId,
    promptTemplates,
    templateVersion: llmEngine.templateVersion,
    providerOptionsJson: llmEngine.providerOptionsJson,
    integrationInstanceId: "",
    translateCapabilityId: "",
    detectCapabilityId: "",
    capabilityPreferencesVersion: 1,
    capabilityPreferences: {},
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

/** Apply an in-progress card rename so dirty checks match Save payload flush. */
function withPendingTemplateRename(
  draft: ProfileDraft,
  renamingTemplateId: string | null,
  renameValue: string,
): ProfileDraft {
  if (!renamingTemplateId) {
    return draft;
  }
  const trimmed = renameValue.trim();
  if (!trimmed) {
    return draft;
  }
  const current = draft.promptTemplates.find((template) => template.id === renamingTemplateId);
  if (!current || current.name === trimmed) {
    return draft;
  }
  return {
    ...draft,
    promptTemplates: draft.promptTemplates.map((template) =>
      template.id === renamingTemplateId ? { ...template, name: trimmed } : template,
    ),
  };
}

/** Apply an in-progress title rename so dirty checks match Save payload flush. */
function withPendingProfileRename(
  draft: ProfileDraft,
  renamingProfile: boolean,
  profileRenameValue: string,
): ProfileDraft {
  if (!renamingProfile) {
    return draft;
  }
  const trimmed = profileRenameValue.trim();
  if (!trimmed || trimmed === draft.name) {
    return draft;
  }
  return { ...draft, name: trimmed };
}

/** Field-level equality for profile drafts (order-sensitive for lists). */
function isProfileDraftClean(draft: ProfileDraft, baseline: ProfileDraft): boolean {
  return (
    draft.id === baseline.id &&
    draft.name === baseline.name &&
    draft.enabled === baseline.enabled &&
    draft.sourceLang === baseline.sourceLang &&
    draft.targetLang === baseline.targetLang &&
    draft.primaryLang === baseline.primaryLang &&
    draft.preferredTargetLang === baseline.preferredTargetLang &&
    draft.engineKind === baseline.engineKind &&
    draft.primaryModelId === baseline.primaryModelId &&
    draft.languageDetectionModelId === baseline.languageDetectionModelId &&
    draft.temperature === baseline.temperature &&
    draft.maxOutputTokens === baseline.maxOutputTokens &&
    draft.defaultPromptTemplateId === baseline.defaultPromptTemplateId &&
    draft.templateVersion === baseline.templateVersion &&
    draft.integrationInstanceId === baseline.integrationInstanceId &&
    draft.translateCapabilityId === baseline.translateCapabilityId &&
    draft.detectCapabilityId === baseline.detectCapabilityId &&
    draft.capabilityPreferencesVersion === baseline.capabilityPreferencesVersion &&
    JSON.stringify(draft.fallbackModelIds) === JSON.stringify(baseline.fallbackModelIds) &&
    JSON.stringify(draft.promptTemplates) === JSON.stringify(baseline.promptTemplates) &&
    JSON.stringify(draft.providerOptionsJson) === JSON.stringify(baseline.providerOptionsJson) &&
    JSON.stringify(draft.capabilityPreferences) === JSON.stringify(baseline.capabilityPreferences)
  );
}

function TranslateProfilesPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();

  const profilesQuery = useQuery(profileListOptions());
  const providersQuery = useQuery(providerListOptions());
  const modelsQuery = useQuery(allProviderModelsOptions());
  const integrationsQuery = useQuery(integrationListOptions());
  const integrationDefsQuery = useQuery(integrationDefinitionListOptions());

  /** Explicit selection; null means "use first list item when not creating". */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [addEngineOpen, setAddEngineOpen] = useState(false);
  /** Local edits only; null means derive draft from detail query. */
  const [draftOverride, setDraftOverride] = useState<ProfileDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** Prompt template pending delete confirmation; null when closed. */
  const [templateDeleteId, setTemplateDeleteId] = useState<string | null>(null);
  /** Pending plugin integration rebind awaiting explicit confirmation. */
  const [pendingRebindInstanceId, setPendingRebindInstanceId] = useState<string | null>(null);
  /** Inline rename target for one prompt template card title at a time. */
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** Inline rename for the profile title (Models/OCR pattern; commits into draft). */
  const [renamingProfile, setRenamingProfile] = useState(false);
  const [profileRenameValue, setProfileRenameValue] = useState("");
  const profileRenameInputRef = useRef<HTMLInputElement | null>(null);
  /** Collapsed prompt-template card ids; absent ids default to expanded. Persisted in localStorage. */
  const [collapsedTemplateIds, setCollapsedTemplateIds] = useState<Set<string>>(
    () => new Set(getCollapsedPromptTemplateIds()),
  );

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

  // Focus and select the rename input when inline editing starts.
  useEffect(() => {
    if (!renamingTemplateId) {
      return;
    }
    const node = renameInputRef.current;
    if (node instanceof HTMLInputElement) {
      node.focus();
      node.select();
    }
  }, [renamingTemplateId]);

  // Focus and select the profile title rename input when inline editing starts.
  useEffect(() => {
    if (!renamingProfile) {
      return;
    }
    const node = profileRenameInputRef.current;
    if (node instanceof HTMLInputElement) {
      node.focus();
      node.select();
    }
  }, [renamingProfile]);

  // Persist collapse state across reloads and profile switches (ids are template UUIDs).
  useEffect(() => {
    setCollapsedPromptTemplateIds(collapsedTemplateIds);
  }, [collapsedTemplateIds]);

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
  const templatePendingDelete =
    templateDeleteId && draft
      ? (draft.promptTemplates.find((template) => template.id === templateDeleteId) ?? null)
      : null;

  // Create is always dirty; edit mode compares effective draft (incl. pending renames) to detail baseline.
  const isDirty = useMemo(() => {
    if (isCreating) {
      return true;
    }
    if (!draft || !derivedDraft) {
      return false;
    }
    const withProfile = withPendingProfileRename(draft, renamingProfile, profileRenameValue);
    const effectiveDraft = withPendingTemplateRename(withProfile, renamingTemplateId, renameValue);
    return !isProfileDraftClean(effectiveDraft, derivedDraft);
  }, [isCreating, draft, derivedDraft, renamingProfile, profileRenameValue, renamingTemplateId, renameValue]);

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
      cancelRenameTemplate();
      cancelRenameProfile();
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
      cancelRenameTemplate();
      cancelRenameProfile();
      toast.success({ title: t("translate.profileDeleted") });

      const list = queryClient.getQueryData<TranslationProfileDto[]>(profileKeys.list()) ?? [];
      const next = list.find((profile) => profile.id !== deletedId) ?? list[0];
      setSelectedId(next?.id ?? null);
    },
  });

  function cancelRenameTemplate() {
    setRenamingTemplateId(null);
    setRenameValue("");
  }

  function cancelRenameProfile() {
    setRenamingProfile(false);
    setProfileRenameValue("");
  }

  function startRenameProfile() {
    if (!draft) {
      return;
    }
    cancelRenameTemplate();
    setProfileRenameValue(draft.name);
    setRenamingProfile(true);
  }

  function commitRenameProfile() {
    if (!draft) {
      return;
    }
    const trimmed = profileRenameValue.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed !== draft.name) {
      updateDraft({ name: trimmed });
    }
    cancelRenameProfile();
  }

  function setTemplateOpen(templateId: string, open: boolean) {
    setCollapsedTemplateIds((current) => {
      const isCollapsed = current.has(templateId);
      if (open && !isCollapsed) {
        return current;
      }
      if (!open && isCollapsed) {
        return current;
      }
      const next = new Set(current);
      if (open) {
        next.delete(templateId);
      } else {
        next.add(templateId);
      }
      return next;
    });
  }

  function selectProfile(profileId: string) {
    setIsCreating(false);
    setSelectedId(profileId);
    setDraftOverride(null);
    setSaveError(null);
    cancelRenameTemplate();
    cancelRenameProfile();
  }

  function startCreate() {
    setAddEngineOpen(true);
  }

  function startCreateWithEngine(option: TranslationEngineOption) {
    setIsCreating(true);
    setSelectedId(null);
    setSaveError(null);
    cancelRenameTemplate();
    cancelRenameProfile();
    if (option.kind === "plugin_capability" && option.integrationInstanceId && option.translateCapabilityId) {
      setDraftOverride(
        emptyPluginDraft(
          uiLanguage,
          option.integrationInstanceId,
          option.translateCapabilityId,
          option.detectCapabilityId,
        ),
      );
      return;
    }
    setDraftOverride(emptyDraft(modelOptions[0]?.id ?? "", uiLanguage));
  }

  const engineOptionLabels = useMemo(
    () => ({
      llmLabel: t("translate.profiles.engineLlmLabel"),
      llmDescriptionReady: t("translate.profiles.engineLlmDescriptionReady"),
      llmDescriptionNoModel: t("translate.profiles.engineLlmDescriptionNoModel"),
      statusDisabled: t("translate.profiles.engineStatusDisabled"),
      statusPluginMissing: t("translate.profiles.engineStatusPluginMissing"),
      statusNeedsConfig: t("translate.profiles.engineStatusNeedsConfig"),
      statusGeneric: t("translate.profiles.engineStatusGeneric"),
      integrationLabel: t("translate.profiles.engineIntegrationLabel"),
      webChannelGtx: t("plugins.googleTranslateWeb.channelLabelGtx"),
      webChannelProxy: t("plugins.googleTranslateWeb.channelLabelProxy"),
    }),
    [t],
  );

  const engineOptions = useMemo(
    () =>
      buildTranslationEngineOptions({
        enabledModels: modelsQuery.data ?? [],
        instances: integrationsQuery.data ?? [],
        definitions: integrationDefsQuery.data ?? [],
        labels: engineOptionLabels,
      }),
    [modelsQuery.data, integrationsQuery.data, integrationDefsQuery.data, engineOptionLabels],
  );

  const rebindCandidates = useMemo(() => {
    if (!draft || draft.engineKind !== "plugin_capability" || !draft.translateCapabilityId) {
      return [];
    }
    return listCompatiblePluginRebindCandidates({
      currentInstanceId: draft.integrationInstanceId,
      translateCapabilityId: draft.translateCapabilityId,
      detectCapabilityId: draft.detectCapabilityId || null,
      instances: integrationsQuery.data ?? [],
      definitions: integrationDefsQuery.data ?? [],
      labels: { integrationLabel: engineOptionLabels.integrationLabel },
    });
  }, [draft, integrationsQuery.data, integrationDefsQuery.data, engineOptionLabels.integrationLabel]);

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

  function updatePromptTemplate(templateId: string, patch: Partial<Omit<PromptTemplate, "id">>) {
    if (!draft) {
      return;
    }
    updateDraft({
      promptTemplates: draft.promptTemplates.map((template) =>
        template.id === templateId ? { ...template, ...patch } : template,
      ),
    });
  }

  function startRenameTemplate(template: PromptTemplate) {
    cancelRenameProfile();
    setRenameValue(template.name);
    setRenamingTemplateId(template.id);
  }

  function commitRenameTemplate(templateId: string) {
    if (!draft) {
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed) {
      return;
    }
    const current = draft.promptTemplates.find((template) => template.id === templateId);
    if (!current || trimmed === current.name) {
      cancelRenameTemplate();
      return;
    }
    updatePromptTemplate(templateId, { name: trimmed });
    cancelRenameTemplate();
  }

  function addPromptTemplate() {
    if (!draft) {
      return;
    }
    const nextIndex = draft.promptTemplates.length + 1;
    const template = createDefaultPromptTemplate(t("translate.profiles.promptTemplateCardTitle", { index: nextIndex }));
    updateDraft({
      promptTemplates: [...draft.promptTemplates, template],
    });
  }

  function removePromptTemplate(templateId: string) {
    if (!draft || draft.promptTemplates.length <= 1) {
      return;
    }
    if (renamingTemplateId === templateId) {
      cancelRenameTemplate();
    }
    setCollapsedTemplateIds((current) => {
      if (!current.has(templateId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(templateId);
      return next;
    });
    const remaining = draft.promptTemplates.filter((template) => template.id !== templateId);
    // Deterministic default: first remaining template when the default is removed.
    const defaultPromptTemplateId =
      draft.defaultPromptTemplateId === templateId ? remaining[0]!.id : draft.defaultPromptTemplateId;
    updateDraft({
      promptTemplates: remaining,
      defaultPromptTemplateId,
    });
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
    if (!draft || saveMutation.isPending || !isDirty) {
      return;
    }

    // Flush in-progress renames into the payload only; main Save is the persist boundary.
    const promptTemplates = draft.promptTemplates.map((template) => {
      if (template.id !== renamingTemplateId) {
        return template;
      }
      const trimmed = renameValue.trim();
      return trimmed ? { ...template, name: trimmed } : template;
    });

    const pendingProfileName = renamingProfile ? profileRenameValue.trim() : "";
    const name = (pendingProfileName || draft.name).trim();
    if (!name) {
      setSaveError(t("translate.profileNameRequired"));
      return;
    }
    if (draft.primaryLang === draft.preferredTargetLang) {
      setSaveError(t("translate.profiles.langPrefEqual"));
      return;
    }

    if (draft.engineKind === "plugin_capability") {
      if (!draft.integrationInstanceId || !draft.translateCapabilityId) {
        setSaveError(t("translate.profiles.engineBindingRequired"));
        return;
      }
      setSaveError(null);
      saveMutation.mutate({
        id: draft.id,
        name,
        enabled: draft.enabled,
        sourceLang: draft.sourceLang,
        targetLang: draft.targetLang,
        primaryLang: draft.primaryLang,
        preferredTargetLang: draft.preferredTargetLang,
        engine: {
          kind: "plugin_capability",
          integrationInstanceId: draft.integrationInstanceId,
          translateCapabilityId: draft.translateCapabilityId,
          detectCapabilityId: draft.detectCapabilityId || null,
          capabilityPreferencesVersion: draft.capabilityPreferencesVersion,
          capabilityPreferences: draft.capabilityPreferences ?? {},
        },
      });
      return;
    }

    if (!draft.primaryModelId) {
      setSaveError(t("translate.profiles.primaryModelRequired"));
      return;
    }
    if (promptTemplates.length === 0) {
      setSaveError(t("translate.profiles.promptTemplateRequired"));
      return;
    }
    if (promptTemplates.some((template) => template.name.trim() === "")) {
      setSaveError(t("translate.profiles.promptTemplateNameRequired"));
      return;
    }
    if (!promptTemplates.some((template) => template.id === draft.defaultPromptTemplateId)) {
      setSaveError(t("translate.profiles.promptTemplateRequired"));
      return;
    }

    // Empty temperature uses the app default (0.2); empty max tokens uses the model setting.
    const temperature = parseOptionalNumber(draft.temperature);
    const maxOutputTokens = parseOptionalNumber(draft.maxOutputTokens);
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
      sourceLang: draft.sourceLang,
      targetLang: draft.targetLang,
      primaryLang: draft.primaryLang,
      preferredTargetLang: draft.preferredTargetLang,
      engine: {
        kind: "llm_model_chain",
        templateVersion: draft.templateVersion,
        defaultPromptTemplateId: draft.defaultPromptTemplateId,
        promptTemplates: promptTemplates.map((template) => ({
          id: template.id,
          name: template.name.trim(),
          systemTemplate: template.systemTemplate,
          userTemplate: template.userTemplate,
        })),
        temperature,
        maxOutputTokens,
        providerOptionsJson: draft.providerOptionsJson,
        languageDetection: draft.languageDetectionModelId
          ? { type: "llm", modelId: draft.languageDetectionModelId }
          : null,
        targetModelIds: uniqueTargetIds,
      },
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
    <>
      <PageLayout
        title={t("translate.profiles.title")}
        description={t("translate.profiles.subtitle")}
        contentClassName="flex-col overflow-hidden lg:flex-row"
      >
        {/* Profiles rail */}
        <aside
          className="
            flex max-h-64 w-full shrink-0 flex-col border-b border-line bg-surface-2
            lg:max-h-none lg:w-64 lg:border-r lg:border-b-0
          "
        >
          <ConfigRailHeader>{t("translate.profiles.listTitle")}</ConfigRailHeader>

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
                            ? `
                              shadow-frame w-full cursor-default rounded-none border border-line bg-surface p-3
                              text-left
                            `
                            : `
                              w-full cursor-pointer rounded-none border border-line bg-surface p-3 text-left
                              transition-colors
                              hover:bg-surface-container
                            `
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
                          {profile.engine.kind === "plugin_capability"
                            ? (integrationsQuery.data?.find(
                                (i) =>
                                  profile.engine.kind === "plugin_capability" &&
                                  i.id === profile.engine.integrationInstanceId,
                              )?.displayName ??
                              (profile.engine.kind === "plugin_capability" ? profile.engine.translateCapabilityId : ""))
                            : profile.primaryModelId
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
            <ConfigEditorLayout
              as="form"
              onSubmit={(event) => {
                event.preventDefault();
                handleSave();
              }}
              title={
                isCreating ? (
                  <Input
                    id="profile-name"
                    className={configEditorRenameInputClassName}
                    type="text"
                    value={draft.name}
                    placeholder={t("translate.profileNamePlaceholder")}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={savePending}
                    aria-label={t("translate.profileNameLabel")}
                    onChange={(event) => {
                      updateDraft({ name: event.currentTarget.value });
                    }}
                  />
                ) : renamingProfile ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      ref={profileRenameInputRef}
                      id="profile-name"
                      className={configEditorRenameInputClassName}
                      type="text"
                      value={profileRenameValue}
                      placeholder={t("translate.profileNamePlaceholder")}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={savePending}
                      aria-label={t("translate.profileNameLabel")}
                      onChange={(event) => {
                        setProfileRenameValue(event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRenameProfile();
                        }
                        if (event.key === "Escape" && !savePending) {
                          event.preventDefault();
                          cancelRenameProfile();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      className={iconButtonClassName}
                      aria-label={t("translate.profiles.saveProfileName")}
                      disabled={savePending || !profileRenameValue.trim()}
                      onClick={commitRenameProfile}
                    >
                      <IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
                    </Button>
                    <Button
                      type="button"
                      className={iconButtonClassName}
                      aria-label={t("translate.profiles.cancelRename")}
                      disabled={savePending}
                      onClick={cancelRenameProfile}
                    >
                      <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-1">
                    <h1 className="truncate text-headline-display font-bold text-on-surface">{draft.name}</h1>
                    <Button
                      type="button"
                      className={iconButtonClassName}
                      aria-label={t("translate.profiles.renameProfile")}
                      title={t("translate.profiles.renameProfile")}
                      disabled={savePending || enabledPending}
                      onClick={startRenameProfile}
                    >
                      <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
                    </Button>
                  </div>
                )
              }
              titleTrailing={
                <label className="flex shrink-0 items-center gap-2 text-body-tight text-on-surface">
                  <Switch.Root
                    checked={draft.enabled}
                    disabled={enabledPending || savePending}
                    onCheckedChange={(checked) => {
                      handleEnabledChange(checked);
                    }}
                    className={switchRootClassName}
                    aria-label={t("translate.profiles.enabledLabel")}
                  >
                    <Switch.Thumb className={switchThumbClassName} />
                  </Switch.Root>
                </label>
              }
              footer={
                <>
                  {draft.id ? (
                    <Button
                      type="button"
                      className={`
                        ${dangerIconButtonClassName}
                        mr-auto
                      `}
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
                    className={`
                      ${primaryButtonClassName}
                      relative
                    `}
                    disabled={savePending || !isDirty}
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
                </>
              }
            >
              <div className="space-y-8">
                {/* Basic info */}
                <div className="space-y-4">
                  <div
                    className="
                        grid grid-cols-1 gap-4
                        sm:grid-cols-2
                      "
                  >
                    <div className="flex flex-col gap-1">
                      <label className={fieldLabelClassName} id="profile-source-lang-label">
                        {t("translate.sourceLanguage")}
                      </label>
                      <ComboboxField
                        value={draft.sourceLang}
                        onValueChange={(value) => updateDraft({ sourceLang: (value ?? "auto") as SourceLanguageId })}
                        options={sourceLanguageOptions.map((option) => ({ value: option.id, label: option.label }))}
                        disabled={savePending}
                        placeholder={t("common.placeholderEnglish")}
                        emptyText={t("common.noMatches")}
                        aria-labelledby="profile-source-lang-label"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={fieldLabelClassName} id="profile-target-lang-label">
                        {t("translate.targetLanguage")}
                      </label>
                      <ComboboxField
                        value={draft.targetLang}
                        onValueChange={(value) => updateDraft({ targetLang: (value ?? "en") as SelectableLanguageId })}
                        options={targetLanguageOptions.map((option) => ({ value: option.id, label: option.label }))}
                        disabled={savePending}
                        placeholder={t("common.placeholderEnglish")}
                        emptyText={t("common.noMatches")}
                        aria-labelledby="profile-target-lang-label"
                      />
                    </div>
                  </div>

                  {/* Primary / Target preference (used when target is Auto) */}
                  <div
                    className="
                        grid grid-cols-1 gap-4
                        sm:grid-cols-2
                      "
                  >
                    <div className="flex flex-col gap-1">
                      <label className={fieldLabelClassName} id="profile-primary-lang-label">
                        {t("translate.profiles.primaryLang")}
                      </label>
                      <ComboboxField
                        value={draft.primaryLang}
                        onValueChange={(value) => {
                          const next = (value ?? "en") as LanguageId;
                          // Selecting the other preference language swaps the pair.
                          if (next === draft.preferredTargetLang) {
                            updateDraft({
                              primaryLang: next,
                              preferredTargetLang: draft.primaryLang,
                            });
                            return;
                          }
                          updateDraft({ primaryLang: next });
                        }}
                        options={LANGUAGE_IDS.map((id) => ({
                          value: id,
                          label: t(`translate.languages.${id}`),
                        }))}
                        disabled={savePending}
                        placeholder={t("common.placeholderEnglish")}
                        emptyText={t("common.noMatches")}
                        aria-labelledby="profile-primary-lang-label"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={fieldLabelClassName} id="profile-preferred-target-lang-label">
                        {t("translate.profiles.preferredTargetLang")}
                      </label>
                      <ComboboxField
                        value={draft.preferredTargetLang}
                        onValueChange={(value) => {
                          const next = (value ?? "en") as LanguageId;
                          // Selecting the other preference language swaps the pair.
                          if (next === draft.primaryLang) {
                            updateDraft({
                              preferredTargetLang: next,
                              primaryLang: draft.preferredTargetLang,
                            });
                            return;
                          }
                          updateDraft({ preferredTargetLang: next });
                        }}
                        options={LANGUAGE_IDS.map((id) => ({
                          value: id,
                          label: t(`translate.languages.${id}`),
                        }))}
                        disabled={savePending}
                        placeholder={t("common.placeholderEnglish")}
                        emptyText={t("common.noMatches")}
                        aria-labelledby="profile-preferred-target-lang-label"
                      />
                    </div>
                  </div>
                  <p className="text-table-header text-neutral">{t("translate.profiles.langPrefHint")}</p>
                </div>

                {draft.engineKind === "plugin_capability" ? (
                  <div className={sectionDividerClassName}>
                    <div className="flex flex-col gap-2">
                      <label className={fieldLabelClassName} id="profile-service-integration-label">
                        {t("translate.profiles.serviceIntegration")}
                      </label>
                      <SelectField
                        value={draft.integrationInstanceId}
                        onValueChange={(value) => {
                          if (!value || value === draft.integrationInstanceId) {
                            return;
                          }
                          // Existing profiles require explicit confirmation before rebind.
                          if (draft.id) {
                            setPendingRebindInstanceId(value);
                            return;
                          }
                          const candidate = rebindCandidates.find((c) => c.id === value);
                          updateDraft({
                            integrationInstanceId: value,
                            translateCapabilityId: candidate?.translateCapabilityId ?? draft.translateCapabilityId,
                            detectCapabilityId: candidate?.detectCapabilityId ?? draft.detectCapabilityId,
                          });
                        }}
                        options={rebindCandidates
                          .filter((c) => c.ready || c.id === draft.integrationInstanceId)
                          .map((c) => ({
                            value: c.id,
                            label: c.ready ? c.label : `${c.label} (${t("translate.profiles.integrationNotReady")})`,
                            disabled: !c.ready && c.id !== draft.integrationInstanceId,
                          }))}
                        disabled={savePending || rebindCandidates.length === 0}
                        placeholder={t("translate.profiles.serviceIntegrationPlaceholder")}
                        aria-labelledby="profile-service-integration-label"
                      />
                      <p className="text-code-inline text-neutral">{draft.translateCapabilityId}</p>
                      {draft.detectCapabilityId ? (
                        <p className="text-code-inline text-neutral">{draft.detectCapabilityId}</p>
                      ) : (
                        <p className="text-code-inline text-disabled">{t("translate.profiles.detectUnavailable")}</p>
                      )}
                      {(() => {
                        const status = integrationsQuery.data?.find(
                          (i) => i.id === draft.integrationInstanceId,
                        )?.effectiveStatus;
                        return status ? <p className="text-code-inline text-neutral">{status}</p> : null;
                      })()}
                      <p className="text-table-header text-neutral">{t("translate.profiles.rebindHint")}</p>
                    </div>
                  </div>
                ) : null}

                {/* Models + prompts (LLM only) */}
                {draft.engineKind === "llm_model_chain" ? (
                  <>
                    <div className={sectionDividerClassName}>
                      <div className="flex flex-col gap-1">
                        <label className={fieldLabelClassName} id="profile-primary-model-label">
                          {t("translate.profiles.primaryModel")}
                        </label>
                        <SelectField
                          value={draft.primaryModelId}
                          onValueChange={(value) => {
                            const nextPrimary = value ?? "";
                            updateDraft({
                              primaryModelId: nextPrimary,
                              fallbackModelIds: draft.fallbackModelIds.filter((id) => id !== nextPrimary),
                            });
                          }}
                          options={
                            modelsLoading || modelOptions.length === 0
                              ? []
                              : modelOptions.map((option) => ({ value: option.id, label: option.label }))
                          }
                          disabled={savePending || modelsLoading || modelOptions.length === 0}
                          placeholder={
                            modelsLoading
                              ? t("translate.modelLoading")
                              : modelOptions.length === 0
                                ? t("translate.modelEmpty")
                                : undefined
                          }
                          aria-labelledby="profile-primary-model-label"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className={fieldLabelClassName} id="profile-detection-model-label">
                          {t("translate.profiles.detectionModel")}
                        </label>
                        <SelectField
                          value={draft.languageDetectionModelId}
                          onValueChange={(value) => updateDraft({ languageDetectionModelId: value ?? "" })}
                          options={[
                            { value: "", label: t("translate.profiles.detectionModelUsePrimary") },
                            ...modelOptions.map((option) => ({ value: option.id, label: option.label })),
                          ]}
                          extraOptions={
                            draft.languageDetectionModelId &&
                            !modelOptions.some((o) => o.id === draft.languageDetectionModelId)
                              ? [
                                  {
                                    value: draft.languageDetectionModelId,
                                    label:
                                      modelLabelById.get(draft.languageDetectionModelId) ??
                                      draft.languageDetectionModelId,
                                  },
                                ]
                              : undefined
                          }
                          disabled={savePending || modelsLoading || modelOptions.length === 0}
                          aria-labelledby="profile-detection-model-label"
                        />
                        <p className="text-body-tight text-neutral">{t("translate.profiles.detectionModelHint")}</p>
                      </div>

                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={fieldLabelClassName}>{t("translate.profiles.fallbackModels")}</span>
                          <Button
                            type="button"
                            className={`
                            ${outlineButtonClassName}
                            h-6 px-2 text-table-header font-bold uppercase
                          `}
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
                                <div
                                  className="
                                  flex size-control-height shrink-0 items-center justify-center border border-line
                                  bg-surface-2 text-code-inline font-bold text-on-surface
                                "
                                >
                                  {index + 1}
                                </div>
                                <SelectField
                                  className="
                                  flex h-control-height min-w-0 flex-1 items-center justify-between gap-2 rounded-none
                                  border border-line bg-surface px-2 text-body-tight font-normal text-on-surface
                                  select-none
                                  hover:not-data-disabled:bg-surface-2
                                  focus-visible:outline-2 focus-visible:-outline-offset-1
                                  focus-visible:outline-on-surface
                                  data-disabled:border-disabled data-disabled:text-disabled
                                  data-popup-open:bg-surface-2
                                "
                                  value={modelId}
                                  onValueChange={(value) => setFallbackAt(index, value ?? "")}
                                  options={modelOptions.map((option) => ({
                                    value: option.id,
                                    label: option.label,
                                  }))}
                                  extraOptions={
                                    modelId && !modelOptions.some((o) => o.id === modelId)
                                      ? [{ value: modelId, label: modelLabelById.get(modelId) ?? modelId }]
                                      : undefined
                                  }
                                  disabled={savePending}
                                  aria-label={t("translate.profiles.fallbackItemAria", {
                                    index: index + 1,
                                  })}
                                />
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
                                  className={dangerButtonClassName}
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
                    <div className="space-y-4 border-t border-outline-variant pt-4">
                      <div
                        className="
                        grid grid-cols-1 gap-8
                        sm:grid-cols-2
                      "
                      >
                        <div className="flex flex-col gap-1">
                          <label className={fieldLabelClassName} htmlFor="profile-temperature">
                            {t("translate.profiles.temperature")}
                          </label>
                          <Input
                            id="profile-temperature"
                            className={inputClassName}
                            type="number"
                            step="0.1"
                            min="0"
                            max="2"
                            value={draft.temperature}
                            placeholder={t("common.default", { value: DEFAULT_TEMPERATURE })}
                            disabled={savePending}
                            onChange={(event) => {
                              updateDraft({ temperature: event.currentTarget.value });
                            }}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className={fieldLabelClassName} htmlFor="profile-max-tokens">
                            {t("translate.profiles.maxTokens")}
                          </label>
                          <Input
                            id="profile-max-tokens"
                            className={inputClassName}
                            type="number"
                            step="1"
                            min="1"
                            value={draft.maxOutputTokens}
                            placeholder={t("translate.profiles.maxTokensModelDefault")}
                            disabled={savePending}
                            onChange={(event) => {
                              updateDraft({ maxOutputTokens: event.currentTarget.value });
                            }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Prompt templates */}
                    <div className="space-y-4 border-t border-outline-variant pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className={fieldLabelClassName}>{t("translate.profiles.promptTemplates")}</span>
                      </div>

                      <RadioGroup
                        value={draft.defaultPromptTemplateId}
                        onValueChange={(value) => {
                          if (value) {
                            updateDraft({ defaultPromptTemplateId: value });
                          }
                        }}
                        className="space-y-4"
                        disabled={savePending}
                      >
                        {draft.promptTemplates.map((template) => {
                          const canRemove = draft.promptTemplates.length > 1;
                          const isRenaming = renamingTemplateId === template.id;
                          const isOpen = !collapsedTemplateIds.has(template.id);
                          const nameFieldId = `profile-template-name-${template.id}`;
                          const systemFieldId = `profile-template-system-${template.id}`;
                          const userFieldId = `profile-template-user-${template.id}`;
                          return (
                            <Collapsible.Root
                              key={template.id}
                              open={isOpen}
                              onOpenChange={(open) => {
                                setTemplateOpen(template.id, open);
                              }}
                              className={promptTemplateCardClassName}
                            >
                              {/* Header is a div trigger so nested controls stay valid HTML. */}
                              <Collapsible.Trigger
                                nativeButton={false}
                                render={<div />}
                                className={promptTemplateCardHeaderClassName}
                                aria-label={
                                  isOpen
                                    ? t("translate.profiles.promptTemplateCollapse")
                                    : t("translate.profiles.promptTemplateExpand")
                                }
                              >
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  <ExpandCircleDownOutlineIcon
                                    className="
                                    size-5 shrink-0 text-on-surface transition-transform duration-100 ease-out
                                    group-data-panel-open:rotate-180
                                  "
                                    aria-hidden
                                  />
                                  {isRenaming ? (
                                    <div
                                      className="flex min-w-0 flex-1 items-center gap-2"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                      }}
                                      onPointerDown={(event) => {
                                        event.stopPropagation();
                                      }}
                                    >
                                      <Input
                                        ref={renameInputRef}
                                        id={nameFieldId}
                                        className={promptTemplateRenameInputClassName}
                                        value={renameValue}
                                        placeholder={t("translate.profiles.promptTemplateNamePlaceholder")}
                                        aria-label={t("translate.profiles.promptTemplateName")}
                                        spellCheck={false}
                                        autoComplete="off"
                                        disabled={savePending}
                                        onChange={(event) => {
                                          setRenameValue(event.currentTarget.value);
                                        }}
                                        onKeyDown={(event) => {
                                          if (savePending) {
                                            return;
                                          }
                                          // Stage rename into draft only; never submit the profile form.
                                          if (event.key === "Enter") {
                                            event.preventDefault();
                                            commitRenameTemplate(template.id);
                                            return;
                                          }
                                          if (event.key === "Escape") {
                                            event.preventDefault();
                                            cancelRenameTemplate();
                                          }
                                        }}
                                      />
                                      <Button
                                        type="button"
                                        className={iconButtonClassName}
                                        aria-label={t("translate.profiles.promptTemplateSaveName")}
                                        disabled={savePending || !renameValue.trim()}
                                        onClick={() => {
                                          commitRenameTemplate(template.id);
                                        }}
                                      >
                                        <IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
                                      </Button>
                                      <Button
                                        type="button"
                                        className={iconButtonClassName}
                                        aria-label={t("translate.profiles.promptTemplateCancelRename")}
                                        disabled={savePending}
                                        onClick={() => {
                                          cancelRenameTemplate();
                                        }}
                                      >
                                        <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="flex min-w-0 flex-1 items-center gap-1">
                                      <h3 className={promptTemplateTitleClassName}>{template.name}</h3>
                                      <Button
                                        type="button"
                                        className={iconButtonClassName}
                                        aria-label={t("translate.profiles.promptTemplateRename")}
                                        title={t("translate.profiles.promptTemplateRename")}
                                        disabled={savePending}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          startRenameTemplate(template);
                                        }}
                                        onPointerDown={(event) => {
                                          event.stopPropagation();
                                        }}
                                      >
                                        <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
                                      </Button>
                                    </div>
                                  )}
                                </div>

                                <div
                                  className="flex shrink-0 flex-wrap items-center gap-3"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                  }}
                                  onPointerDown={(event) => {
                                    event.stopPropagation();
                                  }}
                                >
                                  <label className="flex items-center gap-2 text-body-tight text-on-surface">
                                    <Radio.Root value={template.id} className={radioClassName}>
                                      <Radio.Indicator className={radioIndicatorClassName} />
                                    </Radio.Root>
                                    <span>{t("translate.profiles.promptTemplateSetDefault")}</span>
                                  </label>
                                  {canRemove ? (
                                    <Button
                                      type="button"
                                      className={dangerIconButtonClassName}
                                      aria-label={t("translate.profiles.promptTemplateRemove")}
                                      title={t("translate.profiles.promptTemplateRemove")}
                                      disabled={savePending}
                                      onClick={() => {
                                        setTemplateDeleteId(template.id);
                                      }}
                                    >
                                      <IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
                                    </Button>
                                  ) : null}
                                </div>
                              </Collapsible.Trigger>

                              <Collapsible.Panel className={promptTemplateCardPanelClassName}>
                                <div className={promptTemplateCardBodyClassName}>
                                  <div className="flex flex-col gap-1">
                                    <label className={fieldLabelClassName} htmlFor={systemFieldId}>
                                      {t("translate.systemTemplateLabel")}
                                    </label>
                                    <textarea
                                      id={systemFieldId}
                                      className={templateTextareaClassName}
                                      value={template.systemTemplate}
                                      spellCheck={false}
                                      disabled={savePending}
                                      onChange={(event) => {
                                        updatePromptTemplate(template.id, {
                                          systemTemplate: event.currentTarget.value,
                                        });
                                      }}
                                    />
                                  </div>

                                  <div className="flex flex-col gap-1">
                                    <label className={fieldLabelClassName} htmlFor={userFieldId}>
                                      {t("translate.userTemplateLabel")}
                                    </label>
                                    <textarea
                                      id={userFieldId}
                                      className={templateTextareaClassName}
                                      value={template.userTemplate}
                                      spellCheck={false}
                                      disabled={savePending}
                                      onChange={(event) => {
                                        updatePromptTemplate(template.id, {
                                          userTemplate: event.currentTarget.value,
                                        });
                                      }}
                                    />
                                    <span className="font-mono text-table-header text-disabled italic">
                                      {templateVarsHint}
                                    </span>
                                  </div>
                                </div>
                              </Collapsible.Panel>
                            </Collapsible.Root>
                          );
                        })}
                      </RadioGroup>

                      <Button
                        type="button"
                        className={`
                        ${outlineButtonClassName}
                        w-full font-bold
                      `}
                        disabled={savePending}
                        onClick={() => {
                          addPromptTemplate();
                        }}
                      >
                        {t("translate.profiles.promptTemplateAdd")}
                      </Button>
                    </div>
                  </>
                ) : null}

                {saveError ? (
                  <p className="text-body-tight text-error" role="alert">
                    {saveError}
                  </p>
                ) : null}
              </div>
            </ConfigEditorLayout>
          ) : null}
        </section>
      </PageLayout>

      <AddTranslationProfileDialog
        open={addEngineOpen}
        onOpenChange={setAddEngineOpen}
        options={engineOptions}
        onSelect={startCreateWithEngine}
      />

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

      <ConfirmDialog
        open={templateDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTemplateDeleteId(null);
          }
        }}
        title={t("translate.profiles.promptTemplateDeleteTitle")}
        description={
          templatePendingDelete
            ? t("translate.profiles.promptTemplateDeleteConfirm", { name: templatePendingDelete.name })
            : t("translate.profiles.promptTemplateDeleteTitle")
        }
        confirmText={t("common.delete")}
        danger
        onConfirm={() => {
          if (templateDeleteId) {
            removePromptTemplate(templateDeleteId);
          }
          setTemplateDeleteId(null);
        }}
      />

      <ConfirmDialog
        open={pendingRebindInstanceId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRebindInstanceId(null);
          }
        }}
        title={t("translate.profiles.rebindTitle")}
        description={t("translate.profiles.rebindConfirm")}
        confirmText={t("translate.profiles.rebindConfirmAction")}
        onConfirm={() => {
          if (!draft || !pendingRebindInstanceId) {
            setPendingRebindInstanceId(null);
            return;
          }
          const candidate = rebindCandidates.find((c) => c.id === pendingRebindInstanceId);
          updateDraft({
            integrationInstanceId: pendingRebindInstanceId,
            translateCapabilityId: candidate?.translateCapabilityId ?? draft.translateCapabilityId,
            detectCapabilityId: candidate?.detectCapabilityId ?? draft.detectCapabilityId,
          });
          setPendingRebindInstanceId(null);
        }}
      />
    </>
  );
}
