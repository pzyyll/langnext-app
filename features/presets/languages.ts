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

/** Sentinel ID for auto-detecting the source language. */
export const AUTO_LANGUAGE = "auto" as const;

/** UI Select value representing no target language preference (`null` in storage). */
export const NO_PREFERENCE_TARGET = "__none__" as const;

export type SourceLanguageId = LanguageId | typeof AUTO_LANGUAGE;
export type TargetLanguageId = LanguageId;

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

/** True for `null` (no preference) or a concrete supported language ID (never `auto`). */
export function isTargetLanguageId(value: unknown): value is TargetLanguageId | null {
  return value === null || isLanguageId(value);
}

/** Localized display label for a source/target language or no-preference (`null`). */
export function getLanguageLabel(id: SourceLanguageId | null): string {
  if (id === null) {
    return t("presets.language.noPreference");
  }
  if (id === AUTO_LANGUAGE) {
    return t("presets.languages.auto");
  }
  return t(`presets.languages.${id}`);
}
