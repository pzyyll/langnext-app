// ABOUTME: Pure TTS result and request types re-exported for feature consumers.
// ABOUTME: The definitions live in the TTS definition so vendor code never imports a feature.
export type {
  GoogleTtsFailure,
  TtsChannelId,
  TtsChannelInput,
  TtsFailure,
  TtsResult,
  TtsSynthesis,
  TtsVoice,
} from "../../integrations/tts/types";
