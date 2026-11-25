import { t } from "nsh/i18n";
import type { LanguageId } from "../presets/languages";
import { AZURE_TTS_MAX_UTF8_BYTES, azureTextHasIllegalXml } from "./azure-speech";
import { azureVoiceForLanguage } from "./azure-voices";
import { TTS_MAX_UTF8_BYTES } from "./google-cloud";
import {
  googleAudioOptions,
  googlePreferencesSignature,
  type GoogleAudioOptions,
} from "./google-preferences";
import { resolveGoogleVoice, type GoogleVoiceResolution } from "./google-voices";
import { createTtsSettingsStore, ttsSettingsStore } from "./settings";
import type { TtsChannelId, TtsFailure, TtsSynthesisRequest, TtsVoice } from "./synthesis";

type SpeechSettings = Pick<ReturnType<typeof createTtsSettingsStore>, "activeBinding" | "readKey">;

export interface PreparedQuickSpeech {
  request: TtsSynthesisRequest;
}

export type QuickSpeechPreparation =
  | { ok: true; speech: PreparedQuickSpeech }
  | { ok: false; message: string };

/** Localized recovery text for a Google voice that cannot be selected. */
export function googleVoiceFailureMessage(
  reason: Extract<GoogleVoiceResolution, { ok: false }>["reason"],
): string {
  if (reason === "override_unavailable") return t("quickTranslate.speakVoiceUnavailable");
  if (reason === "no_voice_for_preference") return t("quickTranslate.speakVoiceNeedsSettings");
  return t("quickTranslate.speakUnsupported");
}

/** Resolves a local refusal or the saved request. It does not call a speech service. */
export async function prepareQuickSpeech(
  input: { text: string; language: LanguageId },
  settings: SpeechSettings = ttsSettingsStore,
): Promise<QuickSpeechPreparation> {
  const binding = settings.activeBinding();
  if (binding === null || !binding.enabled) {
    return { ok: false, message: t("quickTranslate.speakOff") };
  }
  let voice: TtsVoice;
  let audio: GoogleAudioOptions | undefined;
  if (binding.channel === "azure") {
    const azureVoice = azureVoiceForLanguage(input.language);
    if (azureVoice === null) {
      return { ok: false, message: t("quickTranslate.speakUnsupportedAzure") };
    }
    voice = azureVoice;
  } else {
    const resolved = resolveGoogleVoice(input.language, binding.preferences);
    if (!resolved.ok) {
      return { ok: false, message: googleVoiceFailureMessage(resolved.reason) };
    }
    voice = { languageCode: resolved.voice.locale, voiceName: resolved.voice.name };
    audio = googleAudioOptions(binding.preferences, resolved.voice.family);
  }
  if (binding.channel === "azure" && azureTextHasIllegalXml(input.text)) {
    return { ok: false, message: t("quickTranslate.speakInvalidText") };
  }
  const limit = binding.channel === "azure" ? AZURE_TTS_MAX_UTF8_BYTES : TTS_MAX_UTF8_BYTES;
  if (new TextEncoder().encode(input.text).byteLength > limit) {
    return {
      ok: false,
      message: t(
        binding.channel === "azure"
          ? "quickTranslate.speakTooLongAzure"
          : "quickTranslate.speakTooLong",
      ),
    };
  }
  const apiKey = await settings.readKey(binding.credentialRef);
  const current = settings.activeBinding();
  const changed =
    current === null ||
    current.channel !== binding.channel ||
    current.credentialRef !== binding.credentialRef ||
    (binding.channel === "azure"
      ? current.channel !== "azure" || current.region !== binding.region
      : current.channel !== "google-cloud" ||
        googlePreferencesSignature(current.preferences) !==
          googlePreferencesSignature(binding.preferences));
  if (apiKey === null || changed) {
    return { ok: false, message: t("settings.tts.keyUnreadable") };
  }
  const request: TtsSynthesisRequest = {
    credentials:
      binding.channel === "azure"
        ? { channel: "azure", apiKey, region: binding.region }
        : { channel: "google-cloud", apiKey },
    text: input.text,
    voice,
    ...(audio !== undefined && Object.keys(audio).length > 0 ? { audio } : {}),
  };
  return { ok: true, speech: { request } };
}

/** A stable message for a synthesis or playback failure. Provider text stays out. */
export function quickSpeechFailureMessage(failure: TtsFailure, channel?: TtsChannelId): string {
  if (failure === "auth") {
    return t(channel === "azure" ? "settings.tts.failure.azureAuth" : "settings.tts.failure.auth");
  }
  if (failure === "rate_limited") return t("settings.tts.failure.azureRateLimited");
  if (failure === "quota") return t("settings.tts.failure.quota");
  if (failure === "text_too_long") {
    return t(
      channel === "azure" ? "quickTranslate.speakTooLongAzure" : "quickTranslate.speakTooLong",
    );
  }
  if (failure === "invalid_text") return t("quickTranslate.speakInvalidText");
  if (failure === "text_blank") return t("quickTranslate.error.blankInput");
  return t("quickTranslate.speakPlayback");
}
