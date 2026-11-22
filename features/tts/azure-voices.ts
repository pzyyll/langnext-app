import type { LanguageId } from "../presets/languages";
import type { TtsVoice } from "./synthesis";

/**
 * One generally available Standard neural voice per concrete language.
 * The locale is the one named for that language. The voice is the first
 * Standard voice listed for that locale, except the three sample choices:
 * `en` uses the settings sample, and `zh` and `fr` use the named voices.
 * A language with no Standard voice is omitted.
 */
const AZURE_VOICES: Partial<Record<LanguageId, TtsVoice>> = {
  ar: { languageCode: "ar-SA", voiceName: "ar-SA-ZariyahNeural" },
  bg: { languageCode: "bg-BG", voiceName: "bg-BG-KalinaNeural" },
  bn: { languageCode: "bn-IN", voiceName: "bn-IN-NabanitaNeural" },
  cs: { languageCode: "cs-CZ", voiceName: "cs-CZ-VlastaNeural" },
  da: { languageCode: "da-DK", voiceName: "da-DK-ChristelNeural" },
  de: { languageCode: "de-DE", voiceName: "de-DE-KatjaNeural" },
  el: { languageCode: "el-GR", voiceName: "el-GR-AthinaNeural" },
  en: { languageCode: "en-US", voiceName: "en-US-JennyNeural" },
  es: { languageCode: "es-ES", voiceName: "es-ES-ElviraNeural" },
  fa: { languageCode: "fa-IR", voiceName: "fa-IR-DilaraNeural" },
  fi: { languageCode: "fi-FI", voiceName: "fi-FI-SelmaNeural" },
  fr: { languageCode: "fr-FR", voiceName: "fr-FR-DeniseNeural" },
  he: { languageCode: "he-IL", voiceName: "he-IL-HilaNeural" },
  hi: { languageCode: "hi-IN", voiceName: "hi-IN-SwaraNeural" },
  hr: { languageCode: "hr-HR", voiceName: "hr-HR-GabrijelaNeural" },
  hu: { languageCode: "hu-HU", voiceName: "hu-HU-NoemiNeural" },
  id: { languageCode: "id-ID", voiceName: "id-ID-GadisNeural" },
  it: { languageCode: "it-IT", voiceName: "it-IT-ElsaNeural" },
  ja: { languageCode: "ja-JP", voiceName: "ja-JP-NanamiNeural" },
  ko: { languageCode: "ko-KR", voiceName: "ko-KR-SunHiNeural" },
  lt: { languageCode: "lt-LT", voiceName: "lt-LT-OnaNeural" },
  lv: { languageCode: "lv-LV", voiceName: "lv-LV-EveritaNeural" },
  ms: { languageCode: "ms-MY", voiceName: "ms-MY-YasminNeural" },
  nl: { languageCode: "nl-NL", voiceName: "nl-NL-FennaNeural" },
  no: { languageCode: "nb-NO", voiceName: "nb-NO-PernilleNeural" },
  pl: { languageCode: "pl-PL", voiceName: "pl-PL-AgnieszkaNeural" },
  pt: { languageCode: "pt-PT", voiceName: "pt-PT-RaquelNeural" },
  ro: { languageCode: "ro-RO", voiceName: "ro-RO-AlinaNeural" },
  ru: { languageCode: "ru-RU", voiceName: "ru-RU-SvetlanaNeural" },
  sk: { languageCode: "sk-SK", voiceName: "sk-SK-ViktoriaNeural" },
  sl: { languageCode: "sl-SI", voiceName: "sl-SI-PetraNeural" },
  sr: { languageCode: "sr-RS", voiceName: "sr-RS-SophieNeural" },
  sv: { languageCode: "sv-SE", voiceName: "sv-SE-SofieNeural" },
  sw: { languageCode: "sw-KE", voiceName: "sw-KE-ZuriNeural" },
  ta: { languageCode: "ta-IN", voiceName: "ta-IN-PallaviNeural" },
  th: { languageCode: "th-TH", voiceName: "th-TH-PremwadeeNeural" },
  tl: { languageCode: "fil-PH", voiceName: "fil-PH-BlessicaNeural" },
  tr: { languageCode: "tr-TR", voiceName: "tr-TR-EmelNeural" },
  uk: { languageCode: "uk-UA", voiceName: "uk-UA-PolinaNeural" },
  ur: { languageCode: "ur-PK", voiceName: "ur-PK-UzmaNeural" },
  vi: { languageCode: "vi-VN", voiceName: "vi-VN-HoaiMyNeural" },
  zh: { languageCode: "zh-CN", voiceName: "zh-CN-YunxiNeural" },
};

/** Returns the Azure voice for `language`, or null when none is mapped. */
export function azureVoiceForLanguage(language: LanguageId): TtsVoice | null {
  return AZURE_VOICES[language] ?? null;
}
