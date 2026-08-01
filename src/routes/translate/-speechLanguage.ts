// ABOUTME: Pure source/result Speech language resolution for Translate playback.
// ABOUTME: Never infers language from generated text; reuses detection or target Auto rules.
import {
  AUTO_LANGUAGE,
  isLanguageId,
  resolveTargetLanguage,
  type LanguageId,
  type ProfileLangPrefs,
  type SelectableLanguageId,
  type SourceLanguageId,
} from "./-languages";

export type SpeechSourceLanguageInput = {
  sourceLang: SourceLanguageId;
  detectedSourceLang: LanguageId | null;
};

export type SpeechSourceLanguageResult =
  | { kind: "ready"; languageId: LanguageId }
  | { kind: "needs_detection" }
  | { kind: "unresolved" };

/**
 * Resolve the concrete language for source-pane playback.
 * - Manual source language → ready immediately.
 * - Auto with a prior detection result → reuse it.
 * - Auto without detection → needs_detection (caller runs detect flow).
 */
export function resolveSourceSpeechLanguage(input: SpeechSourceLanguageInput): SpeechSourceLanguageResult {
  if (input.sourceLang !== AUTO_LANGUAGE) {
    if (!isLanguageId(input.sourceLang)) {
      return { kind: "unresolved" };
    }
    return { kind: "ready", languageId: input.sourceLang };
  }
  if (input.detectedSourceLang && isLanguageId(input.detectedSourceLang)) {
    return { kind: "ready", languageId: input.detectedSourceLang };
  }
  return { kind: "needs_detection" };
}

export type SpeechResultLanguageInput = {
  /** Effective concrete source used for Auto-target resolution. */
  effectiveSource: LanguageId | null;
  configuredTarget: SelectableLanguageId;
  profileLangPrefs: ProfileLangPrefs;
};

export type SpeechResultLanguageResult = { kind: "ready"; languageId: LanguageId } | { kind: "unresolved" };

/**
 * Resolve the concrete language for result-pane playback.
 * Uses the same Auto-target rule as translation; never reads output text.
 */
export function resolveResultSpeechLanguage(input: SpeechResultLanguageInput): SpeechResultLanguageResult {
  if (input.configuredTarget !== AUTO_LANGUAGE) {
    if (!isLanguageId(input.configuredTarget)) {
      return { kind: "unresolved" };
    }
    return { kind: "ready", languageId: input.configuredTarget };
  }
  if (!input.effectiveSource) {
    return { kind: "unresolved" };
  }
  return {
    kind: "ready",
    languageId: resolveTargetLanguage({
      source: input.effectiveSource,
      configuredTarget: AUTO_LANGUAGE,
      primary: input.profileLangPrefs.primary,
      preferredTarget: input.profileLangPrefs.preferredTarget,
    }),
  };
}
