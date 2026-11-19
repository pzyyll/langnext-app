import { t } from "nsh/i18n";

/** Supported concrete translation language IDs (mirrors LangNext `LANGUAGE_IDS`). */
export const LANGUAGE_IDS = [
  "zh",
  "en",
  "ar",
  "bg",
  "bn",
  "cs",
  "da",
  "de",
  "el",
  "es",
  "fa",
  "fi",
  "fr",
  "he",
  "hi",
  "hr",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lt",
  "lv",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "sw",
  "ta",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** Sentinel ID for auto-detecting the source language or resolving an automatic target. */
export const AUTO_LANGUAGE = "auto" as const;

export type SourceLanguageId = LanguageId | typeof AUTO_LANGUAGE;
/** A concrete target or the automatic target that resolves from the saved language preferences. */
export type TargetLanguageId = LanguageId | typeof AUTO_LANGUAGE;

/** True for a concrete supported language ID (never `auto`). */
export function isLanguageId(value: unknown): value is LanguageId {
  return (
    typeof value === "string" &&
    value !== AUTO_LANGUAGE &&
    (LANGUAGE_IDS as readonly string[]).includes(value)
  );
}

/** True for `auto` or a concrete supported language ID. */
export function isSourceLanguageId(value: unknown): value is SourceLanguageId {
  return value === AUTO_LANGUAGE || isLanguageId(value);
}

/** True for `auto` or a concrete supported language ID (never an unset value). */
export function isTargetLanguageId(value: unknown): value is TargetLanguageId {
  return value === AUTO_LANGUAGE || isLanguageId(value);
}

/** Localized display label for a source or target language selection. */
export function getLanguageLabel(id: SourceLanguageId | TargetLanguageId): string {
  if (id === AUTO_LANGUAGE) {
    return t("presets.languages.auto");
  }
  return t(`presets.languages.${id}`);
}

/** Localized display label for a target language, where `auto` means Automatic. */
export function getTargetLanguageLabel(id: TargetLanguageId): string {
  if (id === AUTO_LANGUAGE) {
    return t("presets.language.autoTarget");
  }
  return getLanguageLabel(id);
}
