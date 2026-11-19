import { t } from "nsh/i18n";
import {
  AUTO_LANGUAGE,
  NO_PREFERENCE_TARGET,
  type SourceLanguageId,
  type TargetLanguageId,
} from "./languages";
import { formatTemperature } from "./temperature";
import type { PromptTemplate, SavePresetInput, TranslationPreset } from "./types";

export type TargetLanguageValue = TargetLanguageId | typeof NO_PREFERENCE_TARGET;

/** Editable form state for a new or existing translation preset. */
export interface PresetDraft {
  sourceId: string | null;
  name: string;
  enabled: boolean;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageValue;
  primaryModelId: string | null;
  fallbackModelIds: string[];
  temperatureText: string;
  maxOutputTokensText: string;
  templates: PromptTemplate[];
  defaultTemplateId: string;
}

/** Creates a blank new preset draft with one localized Default prompt template. */
export function createEmptyDraft(): PresetDraft {
  const defaultTemplateId = crypto.randomUUID();
  return {
    sourceId: null,
    name: "",
    enabled: true,
    sourceLanguage: AUTO_LANGUAGE,
    targetLanguage: NO_PREFERENCE_TARGET,
    primaryModelId: null,
    fallbackModelIds: [],
    temperatureText: "",
    maxOutputTokensText: "",
    templates: [
      {
        id: defaultTemplateId,
        name: t("presets.prompt.defaultName"),
        systemTemplate: t("presets.prompt.defaultSystem"),
        userTemplate: t("presets.prompt.defaultUser"),
      },
    ],
    defaultTemplateId,
  };
}

/** Creates an isolated draft snapshot from a persisted preset record. */
export function createDraftFromPreset(preset: TranslationPreset): PresetDraft {
  return {
    sourceId: preset.id,
    name: preset.name,
    enabled: preset.enabled,
    sourceLanguage: preset.sourceLanguage,
    targetLanguage: preset.targetLanguage ?? NO_PREFERENCE_TARGET,
    primaryModelId: preset.engine.modelIds[0] ?? null,
    fallbackModelIds: preset.engine.modelIds.slice(1),
    temperatureText: formatTemperature(preset.engine.temperature),
    maxOutputTokensText:
      preset.engine.maxOutputTokens === null ? "" : String(preset.engine.maxOutputTokens),
    templates: preset.engine.templates.map((tpl) => ({ ...tpl })),
    defaultTemplateId: preset.engine.defaultTemplateId,
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
    current.sourceLanguage !== baseline.sourceLanguage ||
    current.targetLanguage !== baseline.targetLanguage ||
    current.primaryModelId !== baseline.primaryModelId ||
    current.temperatureText !== baseline.temperatureText ||
    current.maxOutputTokensText !== baseline.maxOutputTokensText ||
    current.defaultTemplateId !== baseline.defaultTemplateId ||
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
  // Keep the primary slot distinct even when the user has only chosen fallbacks.
  const modelIds = [draft.primaryModelId ?? "", ...draft.fallbackModelIds];
  return {
    id: draft.sourceId,
    name: draft.name,
    enabled: draft.enabled,
    sourceLanguage: draft.sourceLanguage,
    targetLanguage: draft.targetLanguage === NO_PREFERENCE_TARGET ? null : draft.targetLanguage,
    engine: {
      kind: "ai",
      modelIds,
      temperature: draft.temperatureText,
      maxOutputTokens: draft.maxOutputTokensText,
      templates: draft.templates.map((tpl) => ({ ...tpl })),
      defaultTemplateId: draft.defaultTemplateId,
    },
  };
}
