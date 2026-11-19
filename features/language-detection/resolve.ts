import {
  AUTO_LANGUAGE,
  type LanguageId,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
import {
  detectLanguage,
  type DetectLanguageOptions,
  type LanguageDetectionFailureCode,
} from "./detect";
import type { LanguageDetectionSettings } from "./settings";

export type LanguageResolutionFailureCode =
  | LanguageDetectionFailureCode
  | "missing_native_language"
  | "missing_preferred_language";

export interface ResolveTranslationLanguagesInput {
  sourceText: string;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId;
  settings: LanguageDetectionSettings;
}

export type ResolveTranslationLanguagesResult =
  | { ok: true; sourceLanguage: LanguageId; targetLanguage: LanguageId }
  | { ok: false; code: LanguageResolutionFailureCode };

function failure(code: LanguageResolutionFailureCode): ResolveTranslationLanguagesResult {
  return { ok: false, code };
}

/**
 * Turns the card's source and target selections into concrete languages.
 * An automatic target translates other languages into the native language,
 * and the native language into the preferred translation language.
 */
export async function resolveTranslationLanguages(
  input: ResolveTranslationLanguagesInput,
  options: DetectLanguageOptions = {},
): Promise<ResolveTranslationLanguagesResult> {
  if (options.signal?.aborted) return failure("cancelled");

  const { sourceText, sourceLanguage, targetLanguage, settings } = input;
  const nativeLanguage = settings.nativeLanguage;
  const automaticTarget = targetLanguage === AUTO_LANGUAGE;

  // An automatic target cannot resolve without a native language, so fail before any request.
  if (automaticTarget && nativeLanguage === null) return failure("missing_native_language");

  let resolvedSource: LanguageId;
  if (sourceLanguage === AUTO_LANGUAGE) {
    const detected = await detectLanguage(sourceText, settings, options);
    if (!detected.ok) return failure(detected.code);
    resolvedSource = detected.language;
  } else {
    resolvedSource = sourceLanguage;
  }

  if (options.signal?.aborted) return failure("cancelled");
  if (!automaticTarget) {
    return { ok: true, sourceLanguage: resolvedSource, targetLanguage };
  }

  if (nativeLanguage !== null && resolvedSource !== nativeLanguage) {
    return { ok: true, sourceLanguage: resolvedSource, targetLanguage: nativeLanguage };
  }

  const preferred = settings.preferredTranslationLanguage;
  if (preferred === null) return failure("missing_preferred_language");

  return { ok: true, sourceLanguage: resolvedSource, targetLanguage: preferred };
}
