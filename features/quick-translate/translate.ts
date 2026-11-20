import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientInput,
  type AiClientStreamOptions,
} from "../../modules/ai/runtime/client";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import { getLanguageLabel, type LanguageId } from "../presets/languages";
import type { PromptTemplate, TranslationPreset } from "../presets/types";

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(source_language|target_language|text)\s*\}\}/g;
const RETRYABLE_ERROR_KINDS = new Set(["timeout", "network", "rate_limited", "server"]);

export interface TranslateWithPresetInput {
  preset: TranslationPreset;
  sourceText: string;
  /** Concrete languages resolved by the caller; a preset never stores or detects them. */
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
  templateId?: string;
}

export interface TranslateWithPresetOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveModelRequest?: (modelId: string) => Promise<SavedModelRequestResolution>;
  /** Translation seam: one streamed generation. */
  streamText?: (
    connection: AiClientInput,
    request: TextGenerationRequest,
    options: AiClientStreamOptions,
  ) => Promise<string>;
  /** Receives the complete translated text after each streamed delta. */
  onText?: (text: string) => void;
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

  const { system, user } = renderPromptTemplate(template, {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    text: sourceText,
  });

  const resolveModel = options.resolveModelRequest ?? resolveSavedModelRequest;
  const runGeneration = options.streamText ?? aiClient.streamText;
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
          disableReasoning: preset.engine.disableReasoning,
        },
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onText: (partial) => options.onText?.(partial),
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
