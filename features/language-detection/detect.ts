import { ProviderProtocolError } from "../../modules/ai/contracts/errors";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientCallOptions,
  type AiClientInput,
} from "../../modules/ai/runtime/client";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import { isLanguageId, LANGUAGE_IDS, type LanguageId } from "../presets/languages";
import type { LanguageDetectionSettings } from "./settings";

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
}

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

/** Accepts exactly one supported ID or `und`; rejects prose, JSON, locale variants, and `auto`. */
export function parseDetectionAnswer(raw: string): Answer {
  const normalized = raw.trim().toLowerCase();
  if (normalized === UNDETERMINED_ANSWER) return { kind: "undetermined" };
  if (isLanguageId(normalized)) return { kind: "language", language: normalized };
  return { kind: "invalid" };
}

/**
 * Detects the dominant language with the saved AI model chain, trying each model in order.
 * Only a valid supported ID wins; `und`, unavailable models, and provider failures fall through.
 */
export async function detectLanguage(
  text: string,
  settings: LanguageDetectionSettings,
  options: DetectLanguageOptions = {},
): Promise<LanguageDetectionResult> {
  if (options.signal?.aborted) return failure("cancelled");

  const sample = boundDetectionSample(text);
  if (sample.length === 0) return failure("blank_input");
  if (settings.mode !== "ai" || settings.modelIds.length === 0) return failure("unconfigured");

  const resolveModel = options.resolveSavedModelRequest ?? resolveSavedModelRequest;
  const runGeneration = options.generateText ?? aiClient.generateText;
  let attempted = false;
  let sawUndetermined = false;

  for (const modelId of settings.modelIds) {
    if (options.signal?.aborted) return failure("cancelled");

    const resolved = await resolveModel(modelId);
    if (options.signal?.aborted) return failure("cancelled");
    if (!resolved.ok) continue;

    attempted = true;
    let raw: string;
    try {
      raw = await runGeneration(
        resolved.connection,
        { modelId: resolved.modelKey, system: DETECTION_SYSTEM_MESSAGE, user: sample },
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof ProviderProtocolError && error.kind === "cancelled")
      ) {
        return failure("cancelled");
      }
      if (error instanceof ProviderProtocolError) continue;
      return failure("failed");
    }
    if (options.signal?.aborted) return failure("cancelled");

    const answer = parseDetectionAnswer(raw);
    if (answer.kind === "language") return { ok: true, language: answer.language };
    if (answer.kind === "undetermined") sawUndetermined = true;
  }

  if (sawUndetermined) return failure("unknown_language");
  if (!attempted) return failure("no_eligible_model");
  return failure("failed");
}
