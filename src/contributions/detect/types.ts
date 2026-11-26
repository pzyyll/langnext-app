// ABOUTME: Shared language-detection request, answer, and failure types for detect channels.
// ABOUTME: One bounded sample goes in; a channel answers one literal supported language ID or throws.
import type {
  GoogleCloudDetectInput,
  GoogleCloudDetectOptions,
} from "../../modules/google-cloud-translation/client";
import { isLanguageId, LANGUAGE_IDS, type LanguageId } from "../../framework/languages";

/** Sentinel answer a model returns when it cannot name a supported language. */
const UNDETERMINED_ANSWER = "und";

/**
 * Fixed model instruction: one literal supported ID or `und`. The user message is data only,
 * so a prompt cannot be injected through the sampled text.
 */
export const DETECTION_SYSTEM_MESSAGE = [
  "Identify the dominant language of the user's text.",
  `Answer with one literal language ID only, chosen from: ${LANGUAGE_IDS.join(", ")}, ${UNDETERMINED_ANSWER}.`,
  `Answer ${UNDETERMINED_ANSWER} when you cannot determine one supported language.`,
  "Do not add punctuation, explanation, JSON, or Markdown.",
].join(" ");

/** Failure one detect channel reports to the fallback chain. */
export type DetectionChannelFailure =
  | "no_eligible_model"
  | "unknown_language"
  | "unsupported_language"
  | "failed"
  | "cancelled";

/** One detection attempt's bounded sample and cancellation policy. */
export interface DetectionRequest {
  sample: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Isolated-test seam for the Google Cloud v2 transport; the client is built when absent. */
  googleCloudDetect?: (
    input: GoogleCloudDetectInput,
    options?: GoogleCloudDetectOptions,
  ) => Promise<string>;
}

/** Thrown by a channel when one attempt cannot answer with a supported language. */
export class DetectionChannelError extends Error {
  readonly code: DetectionChannelFailure;

  constructor(code: DetectionChannelFailure, message?: string) {
    super(message ?? code);
    this.name = "DetectionChannelError";
    this.code = code;
  }
}

const FAILURE_KEYS: Record<string, string> = {
  unconfigured: "languageDetection.failure.unconfigured",
  no_eligible_model: "languageDetection.failure.noEligibleModel",
  unknown_language: "languageDetection.failure.unknownLanguage",
  unsupported_language: "languageDetection.failure.unsupportedLanguage",
  failed: "languageDetection.failure.failed",
};

/** Maps a detection failure code onto its existing recovery message key. */
export function detectionFailureKey(failure: string): string | null {
  return FAILURE_KEYS[failure] ?? null;
}

/** Whether a string is a failure one channel can report. */
export function isDetectionChannelFailure(value: string): value is DetectionChannelFailure {
  return (
    value === "no_eligible_model" ||
    value === "unknown_language" ||
    value === "unsupported_language" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export type DetectionAnswer =
  | { kind: "language"; language: LanguageId }
  | { kind: "undetermined" }
  | { kind: "invalid" };

/** Accepts exactly one supported ID or `und`; rejects prose, JSON, locale variants, and `auto`. */
export function parseDetectionAnswer(raw: string): DetectionAnswer {
  const normalized = raw.trim().toLowerCase();
  if (normalized === UNDETERMINED_ANSWER) return { kind: "undetermined" };
  if (isLanguageId(normalized)) return { kind: "language", language: normalized };
  return { kind: "invalid" };
}
