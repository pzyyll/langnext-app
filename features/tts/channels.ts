import { createAzureSpeechTtsClient } from "./azure-speech";
import {
  createGoogleCloudTtsClient,
  TTS_SAMPLE_LANGUAGE_CODE,
  TTS_SAMPLE_TEXT,
  TTS_SAMPLE_VOICE_NAME,
} from "./google-cloud";
import type { TtsCredentials, TtsSynthesis, TtsSynthesisRequest, TtsVoice } from "./synthesis";

/** Neural voice for the fixed English settings sample. */
export const AZURE_SAMPLE_VOICE_NAME = "en-US-JennyNeural";

/** The saved credentials plus the fixed sample for that channel. */
export function sampleSpeechRequest(credentials: TtsCredentials): TtsSynthesisRequest {
  return {
    credentials,
    text: TTS_SAMPLE_TEXT,
    voice: sampleVoice(credentials),
  };
}

function sampleVoice(credentials: TtsCredentials): TtsVoice {
  if (credentials.channel === "azure") {
    return { languageCode: TTS_SAMPLE_LANGUAGE_CODE, voiceName: AZURE_SAMPLE_VOICE_NAME };
  }
  return { languageCode: TTS_SAMPLE_LANGUAGE_CODE, voiceName: TTS_SAMPLE_VOICE_NAME };
}

/** Sends one request to the channel named by its credentials. */
export function synthesizeSpeech(
  request: TtsSynthesisRequest,
  options?: { signal?: AbortSignal },
): Promise<TtsSynthesis> {
  if (request.credentials.channel === "azure") {
    return createAzureSpeechTtsClient().synthesize(
      {
        apiKey: request.credentials.apiKey,
        region: request.credentials.region,
        text: request.text,
        voice: request.voice,
      },
      options,
    );
  }
  return createGoogleCloudTtsClient().synthesize(
    {
      apiKey: request.credentials.apiKey,
      text: request.text,
      languageCode: request.voice.languageCode,
      voiceName: request.voice.voiceName,
    },
    options,
  );
}
