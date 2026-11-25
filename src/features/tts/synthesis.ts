import type { GoogleAudioOptions } from "./google-preferences";

/** Saved speech channel. Quick Translate uses only the active one. */
export type TtsChannelId = "google-cloud" | "azure";

/** Concrete voice selected for one synthesis request. */
export interface TtsVoice {
  languageCode: string;
  voiceName: string;
}

/** Credentials for one channel. The key is never part of the settings record. */
export type TtsCredentials =
  | { channel: "google-cloud"; apiKey: string }
  | { channel: "azure"; apiKey: string; region: string };

/** One synthesis call. The dispatcher selects the client from `credentials.channel`. */
export interface TtsSynthesisRequest {
  credentials: TtsCredentials;
  text: string;
  voice: TtsVoice;
  /** Google-only audio fields. Azure requests never carry them. */
  audio?: GoogleAudioOptions;
}

/**
 * Stable synthesis failures.
 * Google keeps `quota`. Azure adds `invalid_region`, `invalid_text`, and `rate_limited`.
 */
export type TtsFailure =
  | "text_blank"
  | "text_too_long"
  | "invalid_text"
  | "invalid_region"
  | "auth"
  | "quota"
  | "rate_limited"
  | "timeout"
  | "network"
  | "rejected"
  | "malformed";

export type TtsResult<Failure extends TtsFailure = TtsFailure> =
  | { status: "synthesized"; audio: Uint8Array }
  | { status: "cancelled" }
  | { status: "failed"; failure: Failure };

export type TtsSynthesis = TtsResult;

/** Google's returned codes. Azure-only codes stay out of this subset. */
export type GoogleTtsFailure = Exclude<
  TtsFailure,
  "invalid_text" | "invalid_region" | "rate_limited"
>;
