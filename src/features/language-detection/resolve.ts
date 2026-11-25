import { AUTO_LANGUAGE, type LanguageId, type TargetLanguageId } from "../presets/languages";
import type { LanguageDetectionFailureCode } from "./detect";
import type { LanguageDetectionSnapshot } from "./settings";

export type LanguageResolutionFailureCode =
  | LanguageDetectionFailureCode
  | "missing_native_language"
  | "missing_preferred_language";

export interface ResolveTargetLanguageInput {
  sourceLanguage: LanguageId;
  targetLanguage: TargetLanguageId;
  detection: LanguageDetectionSnapshot;
}

export type ResolveTranslationLanguagesResult =
  | { ok: true; sourceLanguage: LanguageId; targetLanguage: LanguageId }
  | { ok: false; code: LanguageResolutionFailureCode };

function failure(code: LanguageResolutionFailureCode): ResolveTranslationLanguagesResult {
  return { ok: false, code };
}

/**
 * Turns a detected or selected source into a concrete target language.
 * An automatic target translates other languages into the native language,
 * and the native language into the preferred translation language.
 */
export function resolveTargetLanguage(
  input: ResolveTargetLanguageInput,
): ResolveTranslationLanguagesResult {
  const { sourceLanguage, targetLanguage, detection } = input;

  if (targetLanguage !== AUTO_LANGUAGE) {
    return { ok: true, sourceLanguage, targetLanguage };
  }

  const nativeLanguage = detection.nativeLanguage;
  if (nativeLanguage === null) return failure("missing_native_language");
  if (sourceLanguage !== nativeLanguage) {
    return { ok: true, sourceLanguage, targetLanguage: nativeLanguage };
  }

  const preferred = detection.preferredTranslationLanguage;
  if (preferred === null) return failure("missing_preferred_language");
  return { ok: true, sourceLanguage, targetLanguage: preferred };
}
