import { LANGUAGE_IDS, type LanguageId } from "../../features/presets/languages";

/**
 * DeepL code maps for the stable text-translation languages shared with the app's
 * LANGUAGE_IDS. Source and target codes differ: DeepL accepts "EN", "PT" and "ZH" as
 * sources but requires qualified targets (e.g. "EN-US", "PT-BR", "ZH-HANS").
 */
const SOURCE_LANGUAGE_CODES: Partial<Record<LanguageId, string>> = {
  ar: "AR",
  bg: "BG",
  cs: "CS",
  da: "DA",
  de: "DE",
  el: "EL",
  en: "EN",
  es: "ES",
  fi: "FI",
  fr: "FR",
  hu: "HU",
  id: "ID",
  it: "IT",
  ja: "JA",
  ko: "KO",
  lt: "LT",
  lv: "LV",
  nl: "NL",
  no: "NB",
  pl: "PL",
  pt: "PT",
  ro: "RO",
  ru: "RU",
  sk: "SK",
  sl: "SL",
  sv: "SV",
  tr: "TR",
  uk: "UK",
  zh: "ZH",
};

const TARGET_LANGUAGE_CODES: Partial<Record<LanguageId, string>> = {
  ar: "AR",
  bg: "BG",
  cs: "CS",
  da: "DA",
  de: "DE",
  el: "EL",
  en: "EN-US",
  es: "ES",
  fi: "FI",
  fr: "FR",
  hu: "HU",
  id: "ID",
  it: "IT",
  ja: "JA",
  ko: "KO",
  lt: "LT",
  lv: "LV",
  nl: "NL",
  no: "NB",
  pl: "PL",
  pt: "PT-BR",
  ro: "RO",
  ru: "RU",
  sk: "SK",
  sl: "SL",
  sv: "SV",
  tr: "TR",
  uk: "UK",
  zh: "ZH-HANS",
};

/** App languages DeepL accepts as a source. */
export const DEEPL_SOURCE_LANGUAGE_IDS: readonly LanguageId[] = LANGUAGE_IDS.filter(
  (id) => SOURCE_LANGUAGE_CODES[id] !== undefined,
);

/** App languages DeepL accepts as a target. */
export const DEEPL_TARGET_LANGUAGE_IDS: readonly LanguageId[] = LANGUAGE_IDS.filter(
  (id) => TARGET_LANGUAGE_CODES[id] !== undefined,
);

/** Maps an app language to its DeepL source code, or null when DeepL cannot read it. */
export function toDeepLSourceLanguage(id: LanguageId): string | null {
  return SOURCE_LANGUAGE_CODES[id] ?? null;
}

/** Maps an app language to its DeepL target code, or null when DeepL cannot write it. */
export function toDeepLTargetLanguage(id: LanguageId): string | null {
  return TARGET_LANGUAGE_CODES[id] ?? null;
}
