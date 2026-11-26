// ABOUTME: Language detection: one bounded sample through enabled channels in priority order.
// ABOUTME: Channel readiness and execution live in the detect definitions; failures fall through.
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientCallOptions,
  type AiClientInput,
} from "../../modules/ai/runtime/client";
import type { FetchLike } from "../../services/http";
import { createLogger } from "../../services/log";
import {
  getIntegrationRegistry,
  runChain,
  type CapabilityChannelDefinition,
  type ChainStepOutcome,
  type ChannelBinding,
  type CredentialRecord,
  type HostModels,
  type HostServices,
  type ModelConnectionRoute,
  type ResolvedModelRoute,
} from "../../framework/integrations";
import type { LanguageId } from "../../framework/languages";
import {
  DetectionChannelError,
  isDetectionChannelFailure,
  type DetectionChannelFailure,
  type DetectionRequest,
} from "../../integrations/detect";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "../models/store";
import { detectChannels } from "./store";
import type { EnabledDetectionChannel } from "./preferences";

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
  /** Transport seam for hosted detectors; defaults to the app's logging HTTP wrapper. */
  fetchImpl?: FetchLike;
  /** Reads one channel's stored credential record; defaults to the vault of the detection collection. */
  readCredential?: (credentialRef: string) => Promise<CredentialRecord | null>;
}

type DetectionChannelDefinition = CapabilityChannelDefinition<
  unknown,
  DetectionRequest,
  LanguageId
>;

interface DetectionAttempt {
  detector: EnabledDetectionChannel;
  definition: DetectionChannelDefinition;
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

/** Reads one channel's credential record for this attempt; never logs a value. */
async function detectionCredential(
  definition: DetectionChannelDefinition,
  binding: ChannelBinding,
  options: DetectLanguageOptions,
): Promise<CredentialRecord | null> {
  const fields = definition.credential;
  if (fields === null || fields.length === 0) return null;
  const credentialRef = binding.credentialRef;
  if (credentialRef === null) return null;

  if (options.readCredential !== undefined) {
    try {
      return await options.readCredential(credentialRef);
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
  const { detector, definition } = attempt;
  const binding = detector.binding;
  const credential = await detectionCredential(definition, binding, options);
  const host: HostServices = {
    credential,
    models,
    fetchImpl: options.fetchImpl,
    log,
  };

  let readiness: Awaited<ReturnType<DetectionChannelDefinition["readiness"]>>;
  try {
    readiness = await definition.readiness(binding, host);
  } catch {
    return { kind: "failed", failure: "failed" };
  }
  if (options.signal?.aborted) return { kind: "cancelled" };
  if (!readiness.ready) return unavailableOutcome(readiness.reason);

  try {
    const language = await definition.execute(binding, request, host);
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
 * Each detector runs one bounded sample through its definition's readiness and execute hooks:
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

  const registry = getIntegrationRegistry();
  const attempts: DetectionAttempt[] = [];
  for (const detector of detectors) {
    const definition = registry.findCapability(
      "detect",
      detector.id,
    ) as DetectionChannelDefinition | null;
    if (definition === null) {
      log.warn("A stored language detector has no registered definition", detector.id);
      continue;
    }
    attempts.push({ detector, definition });
  }
  if (attempts.length === 0) return failure("failed");

  const models = detectionModels(options, new Map());
  const request: DetectionRequest = {
    sample,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
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
