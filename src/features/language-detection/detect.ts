// ABOUTME: Language detection: one bounded sample through enabled channels in priority order.
// ABOUTME: Channel readiness and execution live in the detect contributions; failures fall through.
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientCallOptions,
  type AiClientInput,
} from "../../modules/ai/runtime/client";
import type {
  GoogleCloudDetectInput,
  GoogleCloudDetectOptions,
} from "../../modules/google-cloud-translation/client";
import type { FetchLike } from "../../services/http";
import { createLogger } from "../../services/log";
import {
  getContributionRegistry,
  runChain,
  type CapabilityChannelContribution,
  type ChainStepOutcome,
  type ChannelBinding,
  type CredentialRecord,
  type HostModels,
  type HostServices,
  type ModelConnectionRoute,
  type ResolvedModelRoute,
} from "../../framework/contributions";
import type { LanguageId } from "../../framework/languages";
import {
  DetectionChannelError,
  isDetectionChannelFailure,
  type DetectionChannelFailure,
  type DetectionRequest,
  type GoogleDetectionFetch,
} from "../../contributions/detect";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import { detectChannels } from "./store";
import type { EnabledDetectionChannel } from "./preferences";

export {
  DETECTION_SYSTEM_MESSAGE,
  GOOGLE_DETECTION_URL,
  normalizeGoogleLanguageCode,
  parseDetectionAnswer,
  readGoogleLanguageCode,
} from "../../contributions/detect";
export type {
  DetectionAnswer,
  GoogleDetectionFetch,
  GoogleDetectionResponseLike,
} from "../../contributions/detect";

const log = createLogger("language-detection/detect");

/** Maximum sample length in Unicode code points, so one sample never costs unbounded tokens. */
const MAX_SAMPLE_CODE_POINTS = 2048;

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
  /** Reads a Google Cloud detector's stored key; defaults to the vault of the detection collection. */
  readGoogleCloudCredential?: (credentialRef: string) => Promise<string | null>;
  /** Google Cloud v2 detect seam for isolated tests; the production client is built on demand. */
  googleCloudDetect?: (
    input: GoogleCloudDetectInput,
    options?: GoogleCloudDetectOptions,
  ) => Promise<string>;
}

type DetectionContribution = CapabilityChannelContribution<unknown, DetectionRequest, LanguageId>;

interface DetectionAttempt {
  detector: EnabledDetectionChannel;
  contribution: DetectionContribution;
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

function toResolvedRoute(resolved: SavedModelRequestResolution): ResolvedModelRoute {
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return {
    ok: true,
    modelId: resolved.modelId,
    modelKey: resolved.modelKey,
    connection: {
      providerTypeId: resolved.connection.providerTypeId,
      protocolId: resolved.connection.protocolId,
      baseUrl: resolved.connection.baseUrl,
      credential: resolved.connection.credential,
    },
  };
}

function toClientInput(connection: ModelConnectionRoute): AiClientInput {
  return {
    providerTypeId: connection.providerTypeId as AiClientInput["providerTypeId"],
    protocolId: connection.protocolId as AiClientInput["protocolId"],
    baseUrl: connection.baseUrl,
    credential: connection.credential,
  };
}

/** Builds the AI access one detection call shares; each saved model resolves once per call. */
function detectionModels(
  options: DetectLanguageOptions,
  resolved: Map<string, Promise<ResolvedModelRoute>>,
): HostModels {
  const resolveModel =
    options.resolveSavedModelRequest ??
    ((modelId: string) => resolveSavedModelRequest(modelId, "text"));
  const generate = options.generateText ?? aiClient.generateText;

  return {
    resolveSaved: (modelId) => {
      let pending = resolved.get(modelId);
      if (pending === undefined) {
        pending = resolveModel(modelId).then(toResolvedRoute);
        resolved.set(modelId, pending);
      }
      return pending;
    },
    generateText: (connection, request, callOptions) =>
      generate(
        toClientInput(connection),
        {
          modelId: request.modelId,
          system: request.system,
          user: request.user,
          disableReasoning: request.disableReasoning,
        },
        callOptions,
      ),
    generateTextFromImage: async () => {
      throw new Error("Language detection does not read images.");
    },
  };
}

/** Adapts the legacy Google fetch seam onto the shared fetch boundary. */
function detectionFetch(options: DetectLanguageOptions): FetchLike | undefined {
  const googleFetch = options.googleFetch;
  if (googleFetch === undefined) return undefined;
  return (url, init) =>
    googleFetch(url, {
      method: "POST",
      headers: init.headers,
      body: init.body ?? "",
      signal: init.signal,
    });
}

/** Reads one channel's credential record for this attempt; never logs a value. */
async function detectionCredential(
  contribution: DetectionContribution,
  binding: ChannelBinding,
  options: DetectLanguageOptions,
): Promise<CredentialRecord | null> {
  const fields = contribution.credential;
  if (fields === null || fields.length === 0) return null;
  const credentialRef = binding.credentialRef;
  if (credentialRef === null) return null;

  if (options.readGoogleCloudCredential !== undefined) {
    const field = fields[0]!.key;
    try {
      const value = await options.readGoogleCloudCredential(credentialRef);
      return value === null ? null : { [field]: value };
    } catch {
      return null;
    }
  }
  try {
    return await detectChannels.readCredential(credentialRef);
  } catch {
    return null;
  }
}

function channelFailure(value: string): DetectionChannelFailure {
  return isDetectionChannelFailure(value) ? value : "failed";
}

function unavailableOutcome(reason: string): ChainStepOutcome<LanguageId, DetectionChannelFailure> {
  const code = channelFailure(reason);
  return code === "no_eligible_model"
    ? { kind: "unavailable", reason: code }
    : { kind: "failed", failure: code };
}

/** Runs one enabled detector's readiness check and one attempt. */
async function runDetector(
  attempt: DetectionAttempt,
  request: DetectionRequest,
  options: DetectLanguageOptions,
  models: HostModels,
): Promise<ChainStepOutcome<LanguageId, DetectionChannelFailure>> {
  const { detector, contribution } = attempt;
  const binding = detector.binding;
  const credential = await detectionCredential(contribution, binding, options);
  const host: HostServices = {
    credential,
    models,
    fetchImpl: detectionFetch(options),
    log,
  };

  let readiness: Awaited<ReturnType<DetectionContribution["readiness"]>>;
  try {
    readiness = await contribution.readiness(binding, host);
  } catch {
    return { kind: "failed", failure: "failed" };
  }
  if (options.signal?.aborted) return { kind: "cancelled" };
  if (!readiness.ready) return unavailableOutcome(readiness.reason);

  try {
    const language = await contribution.execute(binding, request, host);
    return { kind: "done", value: language };
  } catch (error) {
    if (options.signal?.aborted) return { kind: "cancelled" };
    if (error instanceof DetectionChannelError) {
      return { kind: "failed", failure: error.code };
    }
    return { kind: "failed", failure: "failed" };
  }
}

/**
 * Detects the dominant language with the enabled detectors in priority order.
 *
 * Each detector runs one bounded sample through its contribution's readiness and execute hooks:
 * AI resolves its saved model and accepts one supported ID, the free Google endpoint asks Google
 * Translate once, and Google Cloud posts the same sample to Cloud Translation v2 with the
 * detector's stored key. A failure, an ineligible model, an unreadable key, or `und` falls
 * through to the next enabled detector. Cancellation stops the chain, and no detector runs when
 * none is enabled.
 */
export async function detectLanguage(
  text: string,
  detectors: readonly EnabledDetectionChannel[],
  options: DetectLanguageOptions = {},
): Promise<LanguageDetectionResult> {
  if (options.signal?.aborted) return failure("cancelled");

  const sample = boundDetectionSample(text);
  if (sample.length === 0) return failure("blank_input");
  if (detectors.length === 0) return failure("unconfigured");

  const registry = getContributionRegistry();
  const attempts: DetectionAttempt[] = [];
  for (const detector of detectors) {
    const contribution = registry.findCapability(
      "detect",
      detector.id,
    ) as DetectionContribution | null;
    if (contribution === null) {
      log.warn("A stored language detector has no registered contribution", detector.id);
      continue;
    }
    attempts.push({ detector, contribution });
  }
  if (attempts.length === 0) return failure("failed");

  const models = detectionModels(options, new Map());
  const request: DetectionRequest = {
    sample,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    googleCloudDetect: options.googleCloudDetect,
  };

  const outcome = await runChain(
    attempts,
    (attempt) => runDetector(attempt, request, options, models),
    { continueOn: (code) => code !== "cancelled" },
    options.signal,
  );

  if (outcome.kind === "done") return { ok: true, language: outcome.value };
  if (outcome.kind === "cancelled") return failure("cancelled");
  if (outcome.kind === "unavailable") {
    return failure(outcome.reason === null ? "failed" : channelFailure(outcome.reason));
  }
  return failure(channelFailure(outcome.failure));
}
