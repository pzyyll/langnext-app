import type { LanguageId } from "../../features/presets/languages";

/**
 * Google Cloud Translation Basic v2 NMT codes for the app's stable language set.
 * Google uses a region-qualified code for Simplified Chinese; every other app ID is its own code.
 */
const GOOGLE_TRANSLATION_LANGUAGE_CODES: Record<LanguageId, string> = {
  zh: "zh-CN",
  en: "en",
  ar: "ar",
  bg: "bg",
  bn: "bn",
  cs: "cs",
  da: "da",
  de: "de",
  el: "el",
  es: "es",
  fa: "fa",
  fi: "fi",
  fr: "fr",
  he: "he",
  hi: "hi",
  hr: "hr",
  hu: "hu",
  id: "id",
  it: "it",
  ja: "ja",
  ko: "ko",
  lt: "lt",
  lv: "lv",
  ms: "ms",
  nl: "nl",
  no: "no",
  pl: "pl",
  pt: "pt",
  ro: "ro",
  ru: "ru",
  sk: "sk",
  sl: "sl",
  sr: "sr",
  sv: "sv",
  sw: "sw",
  ta: "ta",
  th: "th",
  tl: "tl",
  tr: "tr",
  uk: "uk",
  ur: "ur",
  vi: "vi",
};

/** Maps an app language to its Google Cloud v2 NMT code, or null when Google cannot translate it. */
export function toGoogleTranslationLanguage(id: string): string | null {
  return (GOOGLE_TRANSLATION_LANGUAGE_CODES as Record<string, string | undefined>)[id] ?? null;
}
