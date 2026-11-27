import { t } from "nsh/i18n";
import { formatTemperature } from "./temperature";
import type { PresetEngine, PromptTemplate, SavePresetInput, TranslationPreset } from "./types";

/** Editable form state for a new or existing translation preset. */
export interface PresetDraft {
  sourceId: string | null;
  name: string;
  enabled: boolean;
  engineKind: PresetEngine["kind"];
  primaryModelId: string | null;
  fallbackModelIds: string[];
  temperatureText: string;
  maxOutputTokensText: string;
  disableReasoning: boolean;
  templates: PromptTemplate[];
  defaultTemplateId: string;
  /** Replacement or new DeepL key typed in the editor; empty keeps a stored key. */
  deepLApiKey: string;
  /** True when the saved preset references a stored key; only a placeholder is shown. */
  deepLApiKeyStored: boolean;
  /** Replacement or new Google Cloud key typed in the editor; empty keeps a stored key. */
  googleCloudApiKey: string;
  /** True when the saved preset references a stored key; only a placeholder is shown. */
  googleCloudApiKeyStored: boolean;
}

/** Creates a blank new preset draft with one localized Default prompt template. */
export function createEmptyDraft(engineKind: PresetEngine["kind"] = "ai"): PresetDraft {
  const defaultTemplateId = crypto.randomUUID();
  return {
    sourceId: null,
    name: "",
    enabled: true,
    engineKind,
    primaryModelId: null,
    fallbackModelIds: [],
    temperatureText: "",
    maxOutputTokensText: "",
    disableReasoning: true,
    templates: [
      {
        id: defaultTemplateId,
        name: t("presets.prompt.defaultName"),
        systemTemplate: t("presets.prompt.defaultSystem"),
        userTemplate: t("presets.prompt.defaultUser"),
      },
    ],
    defaultTemplateId,
    deepLApiKey: "",
    deepLApiKeyStored: false,
    googleCloudApiKey: "",
    googleCloudApiKeyStored: false,
  };
}

/** Creates an isolated draft snapshot from a persisted preset record. */
export function createDraftFromPreset(preset: TranslationPreset): PresetDraft {
  const ai = preset.engine.kind === "ai" ? preset.engine : null;
  return {
    sourceId: preset.id,
    name: preset.name,
    enabled: preset.enabled,
    engineKind: preset.engine.kind,
    primaryModelId: ai?.modelIds[0] ?? null,
    fallbackModelIds: ai ? ai.modelIds.slice(1) : [],
    temperatureText: ai ? formatTemperature(ai.temperature) : "",
    maxOutputTokensText: ai && ai.maxOutputTokens !== null ? String(ai.maxOutputTokens) : "",
    disableReasoning: ai ? ai.disableReasoning : true,
    templates: ai ? ai.templates.map((tpl) => ({ ...tpl })) : [],
    defaultTemplateId: ai?.defaultTemplateId ?? "",
    deepLApiKey: "",
    deepLApiKeyStored: preset.engine.kind === "deepl",
    googleCloudApiKey: "",
    googleCloudApiKeyStored: preset.engine.kind === "google-cloud",
  };
}

/** Deep-clones a draft so edits or baseline snapshots never alias mutable arrays. */
export function cloneDraft(draft: PresetDraft): PresetDraft {
  return {
    ...draft,
    fallbackModelIds: [...draft.fallbackModelIds],
    templates: draft.templates.map((tpl) => ({ ...tpl })),
  };
}

/** Returns true when current draft differs from its clean baseline snapshot. */
export function isDraftDirty(current: PresetDraft, baseline: PresetDraft): boolean {
  if (
    current.sourceId !== baseline.sourceId ||
    current.name !== baseline.name ||
    current.enabled !== baseline.enabled ||
    current.engineKind !== baseline.engineKind ||
    current.primaryModelId !== baseline.primaryModelId ||
    current.temperatureText !== baseline.temperatureText ||
    current.maxOutputTokensText !== baseline.maxOutputTokensText ||
    current.disableReasoning !== baseline.disableReasoning ||
    current.defaultTemplateId !== baseline.defaultTemplateId ||
    current.deepLApiKey !== baseline.deepLApiKey ||
    current.deepLApiKeyStored !== baseline.deepLApiKeyStored ||
    current.googleCloudApiKey !== baseline.googleCloudApiKey ||
    current.googleCloudApiKeyStored !== baseline.googleCloudApiKeyStored ||
    current.fallbackModelIds.length !== baseline.fallbackModelIds.length ||
    current.templates.length !== baseline.templates.length
  ) {
    return true;
  }

  for (let i = 0; i < current.fallbackModelIds.length; i += 1) {
    if (current.fallbackModelIds[i] !== baseline.fallbackModelIds[i]) {
      return true;
    }
  }

  for (let i = 0; i < current.templates.length; i += 1) {
    const a = current.templates[i]!;
    const b = baseline.templates[i]!;
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.systemTemplate !== b.systemTemplate ||
      a.userTemplate !== b.userTemplate
    ) {
      return true;
    }
  }

  return false;
}

/** Converts an editor draft into a SavePresetInput payload for the store. */
export function draftToSaveInput(draft: PresetDraft): SavePresetInput {
  if (draft.engineKind === "deepl") {
    return {
      id: draft.sourceId,
      name: draft.name,
      enabled: draft.enabled,
      engine: { kind: "deepl", apiKey: draft.deepLApiKey },
    };
  }

  if (draft.engineKind === "google-cloud") {
    return {
      id: draft.sourceId,
      name: draft.name,
      enabled: draft.enabled,
      engine: { kind: "google-cloud", apiKey: draft.googleCloudApiKey },
    };
  }

  if (draft.engineKind === "google-web") {
    return {
      id: draft.sourceId,
      name: draft.name,
      enabled: draft.enabled,
      engine: { kind: "google-web" },
    };
  }

  // Keep the primary slot distinct even when the user has only chosen fallbacks.
  const modelIds = [draft.primaryModelId ?? "", ...draft.fallbackModelIds];
  return {
    id: draft.sourceId,
    name: draft.name,
    enabled: draft.enabled,
    engine: {
      kind: "ai",
      modelIds,
      temperature: draft.temperatureText,
      maxOutputTokens: draft.maxOutputTokensText,
      disableReasoning: draft.disableReasoning,
      templates: draft.templates.map((tpl) => ({ ...tpl })),
      defaultTemplateId: draft.defaultTemplateId,
    },
  };
}
