import familiesDoc from "../../../../assets/catalog/google-tts-families.json";
import voicesDoc from "../../../../assets/catalog/google-tts-voices.json";
import { LANGUAGE_IDS, type LanguageId } from "../../../framework/languages";
import type { GoogleVoicePreferences, GoogleVoiceTierId } from "./google-preferences";

/** Approved Google voice families, ordered from least to most expensive. */
export type GoogleVoiceTier = "standard" | "wavenet" | "neural2" | "chirp3-hd" | "studio";

export type GoogleVoiceGender = "female" | "male";

/** One eligible voice from the bundled snapshot. */
export interface GoogleVoice {
  name: string;
  locale: string;
  family: GoogleVoiceTier;
  gender: GoogleVoiceGender;
}

/** One reviewed family: published SKU, free allowance, and overage rate. */
export interface GoogleVoiceFamily {
  id: GoogleVoiceTier;
  name: string;
  sku: string;
  freeCharactersPerMonth: number;
  sharedWith: readonly GoogleVoiceTier[];
  usdPerMillionCharacters: number;
}

/** Published values in the shipped snapshot, dated by the catalog. */
export const GOOGLE_VOICE_PRICING = {
  checkedAt: familiesDoc.checkedAt,
  url: familiesDoc.pricingUrl,
} as const;

export const GOOGLE_VOICE_FAMILIES: readonly GoogleVoiceFamily[] = familiesDoc.families.map(
  (family) => ({
    id: family.id as GoogleVoiceTier,
    name: family.name,
    sku: family.sku,
    freeCharactersPerMonth: family.freeCharactersPerMonth,
    sharedWith: family.sharedWith as readonly GoogleVoiceTier[],
    usdPerMillionCharacters: family.usdPerMillionCharacters,
  }),
);

/** Approved tiers from least to most expensive. */
export const GOOGLE_VOICE_TIERS: readonly GoogleVoiceTier[] = GOOGLE_VOICE_FAMILIES.map(
  (family) => family.id,
);

const VOICES: readonly GoogleVoice[] = voicesDoc.voices.map((voice) => ({
  name: voice.name,
  locale: voice.locale,
  family: voice.family as GoogleVoiceTier,
  gender: voice.gender as GoogleVoiceGender,
}));

const VOICES_BY_NAME = new Map(VOICES.map((voice) => [voice.name, voice]));

/**
 * Google locale for each supported app language.
 * Languages without an entry keep their base tag for explicit alternates only.
 */
const DEFAULT_LOCALES: Partial<Record<LanguageId, string>> = {
  ar: "ar-XA",
  bg: "bg-BG",
  bn: "bn-IN",
  cs: "cs-CZ",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-ES",
  fi: "fi-FI",
  fr: "fr-FR",
  he: "he-IL",
  hi: "hi-IN",
  hr: "hr-HR",
  hu: "hu-HU",
  id: "id-ID",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  lt: "lt-LT",
  lv: "lv-LV",
  ms: "ms-MY",
  nl: "nl-NL",
  no: "nb-NO",
  pl: "pl-PL",
  pt: "pt-PT",
  ro: "ro-RO",
  ru: "ru-RU",
  sk: "sk-SK",
  sl: "sl-SI",
  sr: "sr-RS",
  sv: "sv-SE",
  sw: "sw-KE",
  ta: "ta-IN",
  th: "th-TH",
  tl: "fil-PH",
  tr: "tr-TR",
  uk: "uk-UA",
  ur: "ur-IN",
  vi: "vi-VN",
  zh: "cmn-CN",
};

/** App languages whose Google locales do not share the app language tag. */
const LOCALE_BASE_ALIASES: Partial<Record<LanguageId, readonly string[]>> = {
  ar: ["ar"],
  no: ["nb"],
  tl: ["fil"],
  zh: ["cmn", "yue"],
};

/** The existing per-language Standard voice, kept as the automatic preference. */
const DEFAULT_VOICE_NAMES: Partial<Record<LanguageId, string>> = {
  ar: "ar-XA-Standard-A",
  bg: "bg-BG-Standard-B",
  bn: "bn-IN-Standard-A",
  cs: "cs-CZ-Standard-B",
  da: "da-DK-Standard-F",
  de: "de-DE-Standard-G",
  el: "el-GR-Standard-B",
  en: "en-US-Standard-C",
  es: "es-ES-Standard-F",
  fi: "fi-FI-Standard-B",
  fr: "fr-FR-Standard-F",
  hi: "hi-IN-Standard-A",
  hu: "hu-HU-Standard-B",
  id: "id-ID-Standard-A",
  it: "it-IT-Standard-E",
  ja: "ja-JP-Standard-A",
  ko: "ko-KR-Standard-A",
  lt: "lt-LT-Standard-B",
  lv: "lv-LV-Standard-B",
  ms: "ms-MY-Standard-A",
  nl: "nl-NL-Standard-F",
  no: "nb-NO-Standard-F",
  pl: "pl-PL-Standard-F",
  pt: "pt-PT-Standard-E",
  ro: "ro-RO-Standard-B",
  ru: "ru-RU-Standard-A",
  sk: "sk-SK-Standard-B",
  sv: "sv-SE-Standard-F",
  ta: "ta-IN-Standard-A",
  th: "th-TH-Standard-A",
  tl: "fil-PH-Standard-A",
  tr: "tr-TR-Standard-A",
  vi: "vi-VN-Standard-A",
  zh: "cmn-CN-Standard-A",
};

const LOCALES = [...new Set(VOICES.map((voice) => voice.locale))].sort();
const LOCALE_SET = new Set(LOCALES);

function baseTag(locale: string): string {
  return locale.split("-")[0]!;
}

/**
 * Every locale the picker offers for one app language, default first.
 * Aliases cover scripts and regions Google names away from the app language tag.
 */
export function googleVoiceLocales(language: LanguageId): readonly string[] {
  const defaultLocale = DEFAULT_LOCALES[language];
  const bases = LOCALE_BASE_ALIASES[language] ?? [baseTag(defaultLocale ?? language)];
  const alternates = LOCALES.filter(
    (locale) => bases.includes(baseTag(locale)) && locale !== defaultLocale,
  );
  const locales = defaultLocale === undefined ? alternates : [defaultLocale, ...alternates];
  return locales.filter((locale) => LOCALE_SET.has(locale));
}

/** Eligible voices for one app language, in catalog order. */
export function listGoogleVoices(language: LanguageId): readonly GoogleVoice[] {
  const locales = googleVoiceLocales(language);
  return VOICES.filter((voice) => locales.includes(voice.locale));
}

/** One catalog voice by its exact Google name. */
export function findGoogleVoice(name: string): GoogleVoice | null {
  return VOICES_BY_NAME.get(name) ?? null;
}

/** True when the exact voice can be chosen for this app language. */
export function isGoogleVoiceForLanguage(name: string, language: LanguageId): boolean {
  const voice = findGoogleVoice(name);
  return voice !== null && googleVoiceLocales(language).includes(voice.locale);
}

/** Families in the automatic search order for one preferred tier. */
export function googleFamilyChain(tier: GoogleVoiceTierId): readonly GoogleVoiceTier[] {
  const index = (GOOGLE_VOICE_TIERS as readonly GoogleVoiceTierId[]).indexOf(tier);
  if (index < 0) return [];
  return GOOGLE_VOICE_TIERS.slice(0, index + 1).reverse();
}

export type GoogleVoiceResolution =
  | { ok: true; voice: GoogleVoice }
  | {
      ok: false;
      reason: "override_unavailable" | "no_voice_for_preference" | "no_voice_for_language";
      overrideName?: string;
    };

function preferredCandidate(
  voices: readonly GoogleVoice[],
  language: LanguageId,
  gender: GoogleVoicePreferences["voiceGender"],
): GoogleVoice {
  const matching = gender === "any" ? voices : voices.filter((voice) => voice.gender === gender);
  const pool = matching.length > 0 ? matching : voices;
  const preferredName = DEFAULT_VOICE_NAMES[language];
  const preferred = pool.find((voice) => voice.name === preferredName);
  if (preferred !== undefined) return preferred;
  return [...pool].sort((left, right) => (left.name < right.name ? -1 : 1))[0]!;
}

/**
 * Resolves one exact voice for an app language: an explicit override wins,
 * otherwise the cheapest eligible family in the preference chain.
 */
export function resolveGoogleVoice(
  language: LanguageId,
  preferences: GoogleVoicePreferences,
): GoogleVoiceResolution {
  const override = preferences.voiceOverrides[language];
  if (override !== undefined) {
    if (!isGoogleVoiceForLanguage(override, language)) {
      return { ok: false, reason: "override_unavailable", overrideName: override };
    }
    return { ok: true, voice: findGoogleVoice(override)! };
  }

  const defaultLocale = DEFAULT_LOCALES[language];
  if (listGoogleVoices(language).length === 0) {
    return { ok: false, reason: "no_voice_for_language" };
  }

  if (defaultLocale !== undefined) {
    const automatic = VOICES.filter((voice) => voice.locale === defaultLocale);
    for (const tier of googleFamilyChain(preferences.voiceTier)) {
      const familyVoices = automatic.filter((voice) => voice.family === tier);
      if (familyVoices.length > 0) {
        return {
          ok: true,
          voice: preferredCandidate(familyVoices, language, preferences.voiceGender),
        };
      }
    }
  }
  return { ok: false, reason: "no_voice_for_preference" };
}

/** Families with at least one eligible voice for this app language. */
export function googleFamiliesForLanguage(language: LanguageId): readonly GoogleVoiceTier[] {
  const families = new Set(listGoogleVoices(language).map((voice) => voice.family));
  return GOOGLE_VOICE_TIERS.filter((tier) => families.has(tier));
}

const familyLanguageCounts = new Map<GoogleVoiceTier, number>();

/** App languages with at least one selectable voice in this family. */
export function googleFamilyLanguageCount(tier: GoogleVoiceTier): number {
  const cached = familyLanguageCounts.get(tier);
  if (cached !== undefined) return cached;
  const count = LANGUAGE_IDS.filter((language) =>
    listGoogleVoices(language).some((voice) => voice.family === tier),
  ).length;
  familyLanguageCounts.set(tier, count);
  return count;
}

/** One reviewed family by its tier ID. */
export function googleVoiceFamily(tier: GoogleVoiceTier): GoogleVoiceFamily {
  return GOOGLE_VOICE_FAMILIES.find((family) => family.id === tier)!;
}

/** Default locale shown in the picker for one app language, when published. */
export function googleDefaultLocale(language: LanguageId): string | null {
  return DEFAULT_LOCALES[language] ?? null;
}

/** App languages with any eligible voice in the snapshot. */
export function googleVoiceLanguageCount(): number {
  return LANGUAGE_IDS.filter((language) => listGoogleVoices(language).length > 0).length;
}
