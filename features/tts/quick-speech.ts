import { t } from "nsh/i18n";
import type { LanguageId } from "../presets/languages";
import { TTS_MAX_UTF8_BYTES, type GoogleCloudTtsFailure } from "./google-cloud";
import { googleVoiceForLanguage, type GoogleStandardVoice } from "./google-voices";
import { createTtsSettingsStore, ttsSettingsStore } from "./settings";

type SpeechSettings = Pick<
  ReturnType<typeof createTtsSettingsStore>,
  "savedBinding" | "readGoogleCloudKey"
>;

export interface PreparedQuickSpeech {
  apiKey: string;
  text: string;
  voice: GoogleStandardVoice;
}

export type QuickSpeechPreparation =
  | { ok: true; speech: PreparedQuickSpeech }
  | { ok: false; message: string };

/** Resolves a local refusal or the saved key and voice. It does not call Google. */
export async function prepareQuickSpeech(
  input: {
    text: string;
    language: LanguageId | null;
    unresolvedAuto: "choose-source" | "translate-first" | null;
  },
  settings: SpeechSettings = ttsSettingsStore,
): Promise<QuickSpeechPreparation> {
  const binding = settings.savedBinding();
  if (binding === null || !binding.enabled) {
    return { ok: false, message: t("quickTranslate.speakOff") };
  }
  if (input.language === null) {
    return {
      ok: false,
      message: t(
        input.unresolvedAuto === "translate-first"
          ? "quickTranslate.speakTranslateFirst"
          : "quickTranslate.speakChooseSource",
      ),
    };
  }
  const voice = googleVoiceForLanguage(input.language);
  if (voice === null) return { ok: false, message: t("quickTranslate.speakUnsupported") };
  if (new TextEncoder().encode(input.text).byteLength > TTS_MAX_UTF8_BYTES) {
    return { ok: false, message: t("quickTranslate.speakTooLong") };
  }
  const apiKey = await settings.readGoogleCloudKey(binding.credentialRef);
  if (apiKey === null || settings.savedBinding()?.credentialRef !== binding.credentialRef) {
    return { ok: false, message: t("settings.tts.keyUnreadable") };
  }
  return { ok: true, speech: { apiKey, text: input.text, voice } };
}

/** A stable message for a synthesis or playback failure. Provider text stays out. */
export function quickSpeechFailureMessage(failure: GoogleCloudTtsFailure): string {
  if (failure === "auth") return t("settings.tts.failure.auth");
  if (failure === "quota") return t("settings.tts.failure.quota");
  if (failure === "text_too_long") return t("quickTranslate.speakTooLong");
  if (failure === "text_blank") return t("quickTranslate.error.blankInput");
  return t("quickTranslate.speakPlayback");
}
