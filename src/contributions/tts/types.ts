// ABOUTME: Pure text-to-speech result and request types shared by channels, features, and vendor clients.
// ABOUTME: No feature imports live here, so vendor code never depends on the feature layer.
import type { LanguageId } from "../../framework/languages";
import type { GoogleAudioOptions } from "./vendor/google-preferences";

/** Saved speech channel. Quick Translate uses only the active one. */
export type TtsChannelId = "google-cloud" | "azure";

/** Concrete voice selected for one synthesis request. */
export interface TtsVoice {
  languageCode: string;
  voiceName: string;
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

/**
 * One contribution call: callers supply text, language, and cancellation;
 * `prepare` fills the resolved voice and audio and may replace the text with a sample.
 */
export interface TtsChannelInput {
  text: string;
  language: LanguageId;
  /** Use the channel's fixed settings sample instead of `text`. */
  sample?: boolean;
  /** Passed to the vendor request; cancelled calls resolve with `cancelled`. */
  signal?: AbortSignal;
  /** Resolved by `prepare`; absent on an unprepared input. */
  voice?: TtsVoice;
  /** Resolved by `prepare` for Google voices that support these fields. */
  audio?: GoogleAudioOptions;
}
