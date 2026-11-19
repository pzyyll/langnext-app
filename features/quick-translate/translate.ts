import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientCallOptions,
  type AiClientInput,
} from "../../modules/ai/runtime/client";
import { languageResolutionErrorMessage } from "../language-detection/messages";
import { resolveTranslationLanguages } from "../language-detection/resolve";
import {
  languageDetectionStore,
  type LanguageDetectionSettings,
} from "../language-detection/settings";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import {
  getLanguageLabel,
  type LanguageId,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
import type { PromptTemplate, TranslationPreset } from "../presets/types";

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(source_language|target_language|text)\s*\}\}/g;
const RETRYABLE_ERROR_KINDS = new Set(["timeout", "network", "rate_limited", "server"]);

export interface TranslateWithPresetInput {
  preset: TranslationPreset;
  sourceText: string;
  sourceLanguage?: SourceLanguageId;
  targetLanguage?: TargetLanguageId;
  templateId?: string;
}

export interface TranslateWithPresetOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** One saved Language Detection snapshot for this action; read from the store when omitted. */
  languageDetectionSettings?: LanguageDetectionSettings;
  resolveModelRequest?: (modelId: string) => Promise<SavedModelRequestResolution>;
  generateText?: (
    connection: AiClientInput,
    request: TextGenerationRequest,
    options?: AiClientCallOptions,
  ) => Promise<string>;
}

export type TranslateWithPresetResult =
  | {
      ok: true;
      text: string;
      modelId: string;
      templateId: string;
    }
  | {
      ok: false;
      cancelled: boolean;
      error: string;
    };

/** Resolves a card template override against a saved preset, falling back to default when missing. */
export function resolvePresetTemplate(
  preset: Pick<TranslationPreset, "engine">,
  templateId?: string | null,
): { template: PromptTemplate; fellBackToDefault: boolean } | null {
  const templates = preset.engine.templates;
  if (templateId) {
    const exact = templates.find((item) => item.id === templateId);
    if (exact) {
      return { template: exact, fellBackToDefault: false };
    }
  }
  const fallback = templates.find((item) => item.id === preset.engine.defaultTemplateId);
  if (!fallback) {
    return null;
  }
  return {
    template: fallback,
    fellBackToDefault: Boolean(templateId && templateId !== fallback.id),
  };
}

/** Returns the saved preset languages unchanged; resolution happens before rendering. */
export function resolveInitialPresetLanguages(
  preset: Pick<TranslationPreset, "sourceLanguage" | "targetLanguage">,
): { sourceLanguage: SourceLanguageId; targetLanguage: TargetLanguageId } {
  return {
    sourceLanguage: preset.sourceLanguage,
    targetLanguage: preset.targetLanguage,
  };
}

/**
 * Renders template placeholders in one pass so braces inside source text stay literal.
 */
export function renderPromptTemplate(
  template: Pick<PromptTemplate, "systemTemplate" | "userTemplate">,
  params: {
    sourceLanguage: LanguageId;
    targetLanguage: LanguageId;
    text: string;
  },
): { system: string; user: string } {
  const values: Record<"source_language" | "target_language" | "text", string> = {
    source_language: getLanguageLabel(params.sourceLanguage),
    target_language: getLanguageLabel(params.targetLanguage),
    text: params.text,
  };

  const replaceOnce = (raw: string): string =>
    raw.replace(TEMPLATE_TOKEN_PATTERN, (_match, key: string) => {
      return values[key as keyof typeof values];
    });

  return {
    system: replaceOnce(template.systemTemplate),
    user: replaceOnce(template.userTemplate),
  };
}

function cancelledResult(): TranslateWithPresetResult {
  return {
    ok: false,
    cancelled: true,
    error: t("protocol.error.cancelled"),
  };
}

function failureResult(error: string): TranslateWithPresetResult {
  return {
    ok: false,
    cancelled: false,
    error,
  };
}

/**
 * Executes a saved preset's model chain in order with single-pass prompt rendering.
 */
export async function translateWithPreset(
  input: TranslateWithPresetInput,
  options: TranslateWithPresetOptions = {},
): Promise<TranslateWithPresetResult> {
  if (options.signal?.aborted) {
    return cancelledResult();
  }

  const { preset, sourceText } = input;
  if (!preset.enabled) {
    return failureResult(t("quickTranslate.error.presetDisabled"));
  }
  if (sourceText.trim().length === 0) {
    return failureResult(t("quickTranslate.error.blankInput"));
  }

  const effectiveTemplateId = input.templateId ?? preset.engine.defaultTemplateId;
  const template = preset.engine.templates.find((item) => item.id === effectiveTemplateId);
  if (!template) {
    return failureResult(t("quickTranslate.error.missingTemplate"));
  }

  if (preset.engine.modelIds.length === 0) {
    return failureResult(t("quickTranslate.error.noModels"));
  }

  const initialLanguages = resolveInitialPresetLanguages(preset);
  const pair = await resolveTranslationLanguages(
    {
      sourceText,
      sourceLanguage: input.sourceLanguage ?? initialLanguages.sourceLanguage,
      targetLanguage: input.targetLanguage ?? initialLanguages.targetLanguage,
      settings: options.languageDetectionSettings ?? languageDetectionStore.settings(),
    },
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      resolveSavedModelRequest: options.resolveModelRequest,
      generateText: options.generateText,
    },
  );
  if (!pair.ok) {
    if (pair.code === "cancelled") {
      return cancelledResult();
    }
    return failureResult(languageResolutionErrorMessage(pair.code));
  }

  const { system, user } = renderPromptTemplate(template, {
    sourceLanguage: pair.sourceLanguage,
    targetLanguage: pair.targetLanguage,
    text: sourceText,
  });

  const resolveModel = options.resolveModelRequest ?? resolveSavedModelRequest;
  const runGeneration = options.generateText ?? aiClient.generateText;
  let lastFailure: string | null = null;

  for (const modelId of preset.engine.modelIds) {
    if (options.signal?.aborted) {
      return cancelledResult();
    }

    const resolved = await resolveModel(modelId);
    if (options.signal?.aborted) {
      return cancelledResult();
    }
    if (!resolved.ok) {
      lastFailure = resolved.reason;
      continue;
    }

    try {
      const text = await runGeneration(
        resolved.connection,
        {
          modelId: resolved.modelKey,
          system,
          user,
          temperature: preset.engine.temperature,
          maxOutputTokens: preset.engine.maxOutputTokens,
        },
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        },
      );
      if (options.signal?.aborted) {
        return cancelledResult();
      }
      return {
        ok: true,
        text,
        modelId: resolved.modelId,
        templateId: template.id,
      };
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof ProviderProtocolError && error.kind === "cancelled")
      ) {
        return cancelledResult();
      }

      if (error instanceof ProviderProtocolError) {
        if (RETRYABLE_ERROR_KINDS.has(error.kind)) {
          lastFailure = error.message;
          continue;
        }
        return failureResult(error.message);
      }

      return failureResult(t("protocol.error.networkDefault"));
    }
  }

  return failureResult(
    lastFailure
      ? t("quickTranslate.error.translationFailed", { detail: lastFailure })
      : t("quickTranslate.error.noEligibleModel"),
  );
}
