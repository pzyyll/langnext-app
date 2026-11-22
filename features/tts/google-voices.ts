import type { LanguageId } from "../presets/languages";

/** One documented Cloud TTS Standard voice. */
export interface GoogleStandardVoice {
  languageCode: string;
  voiceName: string;
}

/**
 * One Standard voice per concrete language.
 * European voice letters follow Google's January 2025 refresh.
 * `en` uses `en-US-Standard-C`, the same voice as the settings sample.
 * Languages with no current Standard voice are omitted on purpose.
 */
const STANDARD_VOICES: Partial<Record<LanguageId, GoogleStandardVoice>> = {
  ar: { languageCode: "ar-XA", voiceName: "ar-XA-Standard-A" },
  bg: { languageCode: "bg-BG", voiceName: "bg-BG-Standard-B" },
  bn: { languageCode: "bn-IN", voiceName: "bn-IN-Standard-A" },
  cs: { languageCode: "cs-CZ", voiceName: "cs-CZ-Standard-B" },
  da: { languageCode: "da-DK", voiceName: "da-DK-Standard-F" },
  de: { languageCode: "de-DE", voiceName: "de-DE-Standard-G" },
  el: { languageCode: "el-GR", voiceName: "el-GR-Standard-B" },
  en: { languageCode: "en-US", voiceName: "en-US-Standard-C" },
  es: { languageCode: "es-ES", voiceName: "es-ES-Standard-F" },
  fi: { languageCode: "fi-FI", voiceName: "fi-FI-Standard-B" },
  fr: { languageCode: "fr-FR", voiceName: "fr-FR-Standard-F" },
  hi: { languageCode: "hi-IN", voiceName: "hi-IN-Standard-A" },
  hu: { languageCode: "hu-HU", voiceName: "hu-HU-Standard-B" },
  id: { languageCode: "id-ID", voiceName: "id-ID-Standard-A" },
  it: { languageCode: "it-IT", voiceName: "it-IT-Standard-E" },
  ja: { languageCode: "ja-JP", voiceName: "ja-JP-Standard-A" },
  ko: { languageCode: "ko-KR", voiceName: "ko-KR-Standard-A" },
  lt: { languageCode: "lt-LT", voiceName: "lt-LT-Standard-B" },
  lv: { languageCode: "lv-LV", voiceName: "lv-LV-Standard-B" },
  ms: { languageCode: "ms-MY", voiceName: "ms-MY-Standard-A" },
  nl: { languageCode: "nl-NL", voiceName: "nl-NL-Standard-F" },
  no: { languageCode: "nb-NO", voiceName: "nb-NO-Standard-F" },
  pl: { languageCode: "pl-PL", voiceName: "pl-PL-Standard-F" },
  pt: { languageCode: "pt-PT", voiceName: "pt-PT-Standard-E" },
  ro: { languageCode: "ro-RO", voiceName: "ro-RO-Standard-B" },
  ru: { languageCode: "ru-RU", voiceName: "ru-RU-Standard-A" },
  sk: { languageCode: "sk-SK", voiceName: "sk-SK-Standard-B" },
  sv: { languageCode: "sv-SE", voiceName: "sv-SE-Standard-F" },
  ta: { languageCode: "ta-IN", voiceName: "ta-IN-Standard-A" },
  th: { languageCode: "th-TH", voiceName: "th-TH-Standard-A" },
  tl: { languageCode: "fil-PH", voiceName: "fil-PH-Standard-A" },
  tr: { languageCode: "tr-TR", voiceName: "tr-TR-Standard-A" },
  vi: { languageCode: "vi-VN", voiceName: "vi-VN-Standard-A" },
  zh: { languageCode: "cmn-CN", voiceName: "cmn-CN-Standard-A" },
};

/** Returns the Standard voice for `language`, or null when none is documented. */
export function googleVoiceForLanguage(language: LanguageId): GoogleStandardVoice | null {
  return STANDARD_VOICES[language] ?? null;
}
