import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientCallOptions,
  type AiClientInput,
} from "../../modules/ai/runtime/client";
import { DEFAULT_HTTP_TIMEOUT_MS } from "../../modules/ai/runtime/http";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import { isLanguageId, LANGUAGE_IDS, type LanguageId } from "../presets/languages";
import type { LanguageDetectorBinding } from "./settings";

/** Maximum sample length in Unicode code points, so one sample never costs unbounded tokens. */
const MAX_SAMPLE_CODE_POINTS = 2048;

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

export type LanguageDetectionFailureCode =
  | "blank_input"
  | "unconfigured"
  | "no_eligible_model"
  | "unknown_language"
  | "unsupported_language"
  | "failed"
  | "cancelled";

export type LanguageDetectionResult =
  | { ok: true; language: LanguageId }
  | { ok: false; code: LanguageDetectionFailureCode };

export interface DetectLanguageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveSavedModelRequest?: (modelId: string) => Promise<SavedModelRequestResolution>;
  generateText?: (
    connection: AiClientInput,
    request: TextGenerationRequest,
    options?: AiClientCallOptions,
  ) => Promise<string>;
  googleFetch?: GoogleDetectionFetch;
}

/**
 * Free Google Translate endpoint used by the `google` detector. It is undocumented and has no
 * support contract: no key, per-IP rate limits, and a plain-text refusal page under abuse.
 * The sample travels in a form body, so it never appears in a URL.
 */
export const GOOGLE_DETECTION_URL =
  "https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=en";

/** Legacy codes Google still answers with for two supported languages. */
const GOOGLE_CODE_ALIASES: Record<string, LanguageId> = { iw: "he", in: "id" };

/** Minimal response shape the Google request needs; a real `Response` satisfies it. */
export interface GoogleDetectionResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Fetch boundary replacement point for isolated tests. */
export type GoogleDetectionFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<GoogleDetectionResponseLike>;

function failure(code: LanguageDetectionFailureCode): LanguageDetectionResult {
  return { ok: false, code };
}

/** Trims the sample and keeps complete code points, never splitting one in half. */
export function boundDetectionSample(text: string): string {
  const trimmed = text.trim();
  const codePoints = Array.from(trimmed);
  if (codePoints.length <= MAX_SAMPLE_CODE_POINTS) return trimmed;
  return codePoints.slice(0, MAX_SAMPLE_CODE_POINTS).join("");
}

type Answer =
  | { kind: "language"; language: LanguageId }
  | { kind: "undetermined" }
  | { kind: "invalid" };

/**
 * Maps a Google language code onto a supported concrete ID. A regional code keeps its base
 * language (`zh-CN` -> `zh`, `pt-BR` -> `pt`), and an unsupported language returns `null`.
 */
export function normalizeGoogleLanguageCode(raw: string): LanguageId | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const base = normalized.split(/[-_]/)[0] ?? "";
  const candidate = GOOGLE_CODE_ALIASES[base] ?? base;
  return isLanguageId(candidate) ? candidate : null;
}

function looksLikeLanguageCode(value: string): boolean {
  return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i.test(value);
}

/**
 * Reads the detected code from a `translate_a/t` payload. One input answers
 * `[[translatedText, code]]`; other shapes put the code beside the segments.
 */
export function readGoogleLanguageCode(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  for (const entry of payload) {
    if (Array.isArray(entry) && typeof entry[1] === "string" && looksLikeLanguageCode(entry[1])) {
      return entry[1];
    }
  }
  for (const entry of payload) {
    if (typeof entry === "string" && looksLikeLanguageCode(entry)) return entry;
  }
  return null;
}

/** Sends one bounded sample to Google Translate and maps its answer onto a supported ID. */
async function detectWithGoogle(
  sample: string,
  options: DetectLanguageOptions,
): Promise<LanguageDetectionResult> {
  const runFetch: GoogleDetectionFetch = options.googleFetch ?? ((url, init) => fetch(url, init));
  const external = options.signal;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);

  try {
    let response: GoogleDetectionResponseLike;
    try {
      response = await runFetch(GOOGLE_DETECTION_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `q=${encodeURIComponent(sample)}`,
        signal: controller.signal,
      });
    } catch {
      return external?.aborted ? failure("cancelled") : failure("failed");
    }

    if (external?.aborted) return failure("cancelled");
    if (!response.ok || controller.signal.aborted) return failure("failed");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return external?.aborted ? failure("cancelled") : failure("failed");
    }

    if (external?.aborted) return failure("cancelled");

    const code = readGoogleLanguageCode(payload);
    if (code === null) return failure("unknown_language");
    const language = normalizeGoogleLanguageCode(code);
    return language === null ? failure("unsupported_language") : { ok: true, language };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/** Accepts exactly one supported ID or `und`; rejects prose, JSON, locale variants, and `auto`. */
export function parseDetectionAnswer(raw: string): Answer {
  const normalized = raw.trim().toLowerCase();
  if (normalized === UNDETERMINED_ANSWER) return { kind: "undetermined" };
  if (isLanguageId(normalized)) return { kind: "language", language: normalized };
  return { kind: "invalid" };
}

/** Asks one saved model for the sample's language; an unavailable model answers without a request. */
async function detectWithAiModel(
  modelId: string,
  sample: string,
  options: DetectLanguageOptions,
): Promise<LanguageDetectionResult> {
  const resolveModel = options.resolveSavedModelRequest ?? resolveSavedModelRequest;
  const runGeneration = options.generateText ?? aiClient.generateText;

  let raw: string;
  try {
    const resolved = await resolveModel(modelId);
    if (options.signal?.aborted) return failure("cancelled");
    if (!resolved.ok) return failure("no_eligible_model");

    raw = await runGeneration(
      resolved.connection,
      {
        modelId: resolved.modelKey,
        system: DETECTION_SYSTEM_MESSAGE,
        user: sample,
        // One literal ID needs no reasoning; providers that cannot turn it off ignore the hint.
        disableReasoning: true,
      },
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof ProviderProtocolError && error.kind === "cancelled")
    ) {
      return failure("cancelled");
    }
    return failure("failed");
  }
  if (options.signal?.aborted) return failure("cancelled");

  const answer = parseDetectionAnswer(raw);
  if (answer.kind === "language") return { ok: true, language: answer.language };
  if (answer.kind === "undetermined") return failure("unknown_language");
  return failure("failed");
}

/**
 * Detects the dominant language with the enabled detectors in priority order.
 *
 * Each detector runs one bounded sample: AI resolves its saved model and accepts one supported
 * ID, Google asks the free Translate endpoint once. A failure, an ineligible model, or `und`
 * falls through to the next enabled detector. Cancellation stops the chain, and neither
 * detector runs when none is enabled.
 */
export async function detectLanguage(
  text: string,
  detectors: readonly LanguageDetectorBinding[],
  options: DetectLanguageOptions = {},
): Promise<LanguageDetectionResult> {
  if (options.signal?.aborted) return failure("cancelled");

  const sample = boundDetectionSample(text);
  if (sample.length === 0) return failure("blank_input");
  if (detectors.length === 0) return failure("unconfigured");

  let lastFailure: LanguageDetectionFailureCode | null = null;
  let firstUnavailable: LanguageDetectionFailureCode | null = null;

  for (const detector of detectors) {
    if (options.signal?.aborted) return failure("cancelled");

    const result =
      detector.kind === "google"
        ? await detectWithGoogle(sample, options)
        : await detectWithAiModel(detector.modelId, sample, options);

    if (result.ok || result.code === "cancelled") return result;
    if (result.code === "no_eligible_model") {
      firstUnavailable ??= result.code;
      continue;
    }
    lastFailure = result.code;
  }

  return failure(lastFailure ?? firstUnavailable ?? "failed");
}
