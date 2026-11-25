import type { LanguageId } from "../presets/languages";

/**
 * One fixed, nonsensitive sentence per app language for the Settings preview.
 * A Cantonese voice reads its own sentence; every other locale uses the text
 * of the app language that resolves to it.
 */
const SAMPLES: Record<LanguageId, string> = {
  ar: "هذه عينة صوتية.",
  bg: "Това е примерен глас.",
  bn: "এটি একটি ভয়েস নমুনা।",
  cs: "Toto je ukázka hlasu.",
  da: "Dette er en stemmeprøve.",
  de: "Dies ist eine Stimmprobe.",
  el: "Αυτό είναι ένα δείγμα φωνής.",
  en: "This is a voice sample.",
  es: "Esta es una muestra de voz.",
  fa: "این یک نمونه صدا است.",
  fi: "Tämä on ääninäyte.",
  fr: "Ceci est un exemple de voix.",
  he: "זוהי דוגמת קול.",
  hi: "यह एक आवाज़ का नमूना है।",
  hr: "Ovo je primjer glasa.",
  hu: "Ez egy hangminta.",
  id: "Ini adalah contoh suara.",
  it: "Questo è un esempio di voce.",
  ja: "これは音声のサンプルです。",
  ko: "이것은 음성 샘플입니다.",
  lt: "Tai balso pavyzdys.",
  lv: "Šis ir balss paraugs.",
  ms: "Ini ialah contoh suara.",
  nl: "Dit is een stemvoorbeeld.",
  no: "Dette er en stemmeprøve.",
  pl: "To jest próbka głosu.",
  pt: "Esta é uma amostra de voz.",
  ro: "Acesta este un eșantion vocal.",
  ru: "Это образец голоса.",
  sk: "Toto je ukážka hlasu.",
  sl: "To je vzorec glasu.",
  sr: "Ово је узорак гласа.",
  sv: "Det här är ett röstprov.",
  sw: "Hii ni sampuli ya sauti.",
  ta: "இது ஒரு குரல் மாதிரி.",
  th: "นี่คือตัวอย่างเสียง",
  tl: "Ito ay isang halimbawa ng boses.",
  tr: "Bu bir ses örneğidir.",
  uk: "Це зразок голосу.",
  ur: "یہ آواز کا نمونہ ہے۔",
  vi: "Đây là một mẫu giọng nói.",
  zh: "这是一段语音示例。",
};

const CANTONESE_SAMPLE = "呢個係一個聲音示範。";

/** Default sample language when the Google settings page opens. */
export const GOOGLE_SAMPLE_LANGUAGE: LanguageId = "en";

/** The fixed sample sentence for one resolved voice locale. */
export function googleSampleText(language: LanguageId, locale: string): string {
  if (locale.startsWith("yue-")) return CANTONESE_SAMPLE;
  return SAMPLES[language];
}
