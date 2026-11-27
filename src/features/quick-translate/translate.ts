import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientInput,
  type AiClientStreamOptions,
} from "../../modules/ai/runtime/client";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import { createDeepLClient, type DeepLTranslateInput } from "../../modules/deepl/client";
import {
  createGoogleCloudTranslateClient,
  type GoogleCloudTranslateInput,
} from "../../modules/google-cloud-translation/client";
import {
  createGoogleWebTranslateClient,
  type GoogleWebTranslateInput,
  type GoogleWebTranslateOptions,
} from "../../modules/google-web-translation/client";
import { getLanguageLabel, type LanguageId } from "../../framework/languages";
import { createLogger } from "../../services/log";
import { countUsageCharacters, googleCloudUsageStore } from "../presets/google-cloud-usage";
import { presetsStore } from "../presets/store";
import type { PromptTemplate, TranslationPreset } from "../presets/types";

const log = createLogger("quick-translate/translate");
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(source_language|target_language|text)\s*\}\}/g;
const RETRYABLE_ERROR_KINDS = new Set(["timeout", "network", "rate_limited", "server"]);
const BACK_TRANSLATION_PROMPT: Pick<PromptTemplate, "systemTemplate" | "userTemplate"> = {
  systemTemplate:
    "You are a professional translator. Translate the user's text from {{source_language}} to {{target_language}}. Return only the translation, with no extra explanation.",
  userTemplate: "{{text}}",
};

export interface TranslateWithPresetInput {
  preset: TranslationPreset;
  sourceText: string;
  /** Concrete languages resolved by the caller; a preset never stores or detects them. */
  sourceLanguage: LanguageId;
  targetLanguage: LanguageId;
  templateId?: string;
  purpose?: "back-translation";
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
  /** Reads a DeepL preset's stored key; defaults to the shared Presets Store. */
  readDeepLCredential?: (presetId: string) => Promise<string | null>;
  /** DeepL transport seam for isolated tests; the production adapter is built on demand. */
  deepLTranslate?: (input: DeepLTranslateInput, options?: DeepLTranslateOptions) => Promise<string>;
  /** Reads a Google Cloud preset's stored key; defaults to the shared Presets Store. */
  readGoogleCloudCredential?: (presetId: string) => Promise<string | null>;
  /** Google Cloud v2 transport seam for isolated tests; the production client is built on demand. */
  googleCloudTranslate?: (
    input: GoogleCloudTranslateInput,
    options?: GoogleCloudTranslateOptions,
  ) => Promise<string>;
  /** Google Web transport seam for isolated tests; the production client is built on demand. */
  googleWebTranslate?: (
    input: GoogleWebTranslateInput,
    options?: GoogleWebTranslateOptions,
  ) => Promise<string>;
  /** Adds a successful Google Cloud request's characters to the preset's local monthly usage. */
  recordGoogleCloudUsage?: (presetId: string, characters: number) => void | Promise<void>;
}

export interface DeepLTranslateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleCloudTranslateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type TranslateWithPresetResult =
  | {
      ok: true;
      text: string;
      /** The AI model that produced the text; null for DeepL. */
      modelId: string | null;
      /** The prompt template used; null when no prompt was rendered. */
      templateId: string | null;
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
  const engine = preset.engine;
  if (engine.kind !== "ai") {
    return null;
  }
  const templates = engine.templates;
  if (templateId) {
    const exact = templates.find((item) => item.id === templateId);
    if (exact) {
      return { template: exact, fellBackToDefault: false };
    }
  }
  const fallback = templates.find((item) => item.id === engine.defaultTemplateId);
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
 * Sends the caller's resolved pair and stored key to DeepL.
 * The result arrives whole: no model lookup, prompt rendering, or streaming.
 */
async function translateWithDeepL(
  preset: TranslationPreset,
  input: TranslateWithPresetInput,
  options: TranslateWithPresetOptions,
): Promise<TranslateWithPresetResult> {
  const readCredential = options.readDeepLCredential ?? presetsStore.readDeepLCredential;
  let apiKey: string | null;
  try {
    apiKey = await readCredential(preset.id);
  } catch (error) {
    return failureResult(error instanceof Error ? error.message : t("deepl.error.missingKey"));
  }
  if (options.signal?.aborted) {
    return cancelledResult();
  }
  if (!apiKey) {
    return failureResult(t("deepl.error.missingKey"));
  }

  const runDeepL = options.deepLTranslate ?? createDeepLClient().translate;
  try {
    const text = await runDeepL(
      {
        apiKey,
        text: input.sourceText,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
    if (options.signal?.aborted) {
      return cancelledResult();
    }
    return { ok: true, text, modelId: null, templateId: null };
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof ProviderProtocolError && error.kind === "cancelled")
    ) {
      return cancelledResult();
    }
    if (error instanceof ProviderProtocolError) {
      return failureResult(error.message);
    }
    return failureResult(t("protocol.error.networkDefault"));
  }
}

/**
 * Sends the caller's resolved pair and stored key to Google Cloud Translation v2.
 * The result arrives whole: no model lookup, prompt rendering, or streaming.
 */
async function translateWithGoogleCloud(
  preset: TranslationPreset,
  input: TranslateWithPresetInput,
  options: TranslateWithPresetOptions,
): Promise<TranslateWithPresetResult> {
  const readCredential =
    options.readGoogleCloudCredential ?? presetsStore.readGoogleCloudCredential;
  let apiKey: string | null;
  try {
    apiKey = await readCredential(preset.id);
  } catch (error) {
    return failureResult(
      error instanceof Error ? error.message : t("googleCloud.error.missingKey"),
    );
  }
  if (options.signal?.aborted) {
    return cancelledResult();
  }
  if (!apiKey) {
    return failureResult(t("googleCloud.error.missingKey"));
  }

  const runTranslate = options.googleCloudTranslate ?? createGoogleCloudTranslateClient().translate;
  const recordUsage = options.recordGoogleCloudUsage ?? googleCloudUsageStore.record;
  try {
    const text = await runTranslate(
      {
        apiKey,
        text: input.sourceText,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
    if (options.signal?.aborted) {
      return cancelledResult();
    }
    // Google bills the source text, so the local monthly total counts it too.
    try {
      await recordUsage(preset.id, countUsageCharacters(input.sourceText));
    } catch (error) {
      log.warn("Could not record Google Cloud character usage.", error);
    }
    return { ok: true, text, modelId: null, templateId: null };
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof ProviderProtocolError && error.kind === "cancelled")
    ) {
      return cancelledResult();
    }
    if (error instanceof ProviderProtocolError) {
      return failureResult(error.message);
    }
    return failureResult(t("protocol.error.networkDefault"));
  }
}

/**
 * Sends the caller's resolved pair to Google's free web endpoint.
 * The result arrives whole: no credential, model lookup, prompt rendering, or streaming.
 */
async function translateWithGoogleWeb(
  input: TranslateWithPresetInput,
  options: TranslateWithPresetOptions,
): Promise<TranslateWithPresetResult> {
  const runTranslate = options.googleWebTranslate ?? createGoogleWebTranslateClient().translate;
  try {
    const text = await runTranslate(
      {
        text: input.sourceText,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
    if (options.signal?.aborted) {
      return cancelledResult();
    }
    return { ok: true, text, modelId: null, templateId: null };
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof ProviderProtocolError && error.kind === "cancelled")
    ) {
      return cancelledResult();
    }
    if (error instanceof ProviderProtocolError) {
      return failureResult(error.message);
    }
    return failureResult(t("protocol.error.networkDefault"));
  }
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

  if (preset.engine.kind === "deepl") {
    return translateWithDeepL(preset, input, options);
  }

  if (preset.engine.kind === "google-cloud") {
    return translateWithGoogleCloud(preset, input, options);
  }

  if (preset.engine.kind === "google-web") {
    return translateWithGoogleWeb(input, options);
  }

  const isBackTranslation = input.purpose === "back-translation";
  const effectiveTemplateId = input.templateId ?? preset.engine.defaultTemplateId;
  const template = isBackTranslation
    ? null
    : preset.engine.templates.find((item) => item.id === effectiveTemplateId);
  if (!isBackTranslation && !template) {
    return failureResult(t("quickTranslate.error.missingTemplate"));
  }

  if (preset.engine.modelIds.length === 0) {
    return failureResult(t("quickTranslate.error.noModels"));
  }

  const { system, user } = renderPromptTemplate(
    isBackTranslation ? BACK_TRANSLATION_PROMPT : template!,
    {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      text: sourceText,
    },
  );

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
        templateId: isBackTranslation ? null : template!.id,
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
