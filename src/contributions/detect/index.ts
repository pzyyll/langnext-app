// ABOUTME: The language detection channels, in catalog and priority order.
// ABOUTME: Startup assembly registers them; the detection store reads them back by capability.
import type {
  CapabilityChannelContribution,
  ContributionRegistry,
} from "../../framework/contributions";
import { aiDetectionContribution } from "./channels/ai";
import { googleDetectionContribution } from "./channels/google";
import { googleCloudDetectionContribution } from "./channels/google-cloud";

export {
  DETECTION_SYSTEM_MESSAGE,
  DetectionChannelError,
  detectionFailureKey,
  isDetectionChannelFailure,
  parseDetectionAnswer,
} from "./types";
export type { DetectionAnswer, DetectionChannelFailure, DetectionRequest } from "./types";
export {
  GOOGLE_DETECTION_URL,
  normalizeGoogleLanguageCode,
  readGoogleLanguageCode,
  requestGoogleFreeDetection,
} from "./vendor/google-free";
export type {
  GoogleDetectionFetch,
  GoogleDetectionResponseLike,
  GoogleFreeDetectionCode,
  GoogleFreeDetectionOutcome,
} from "./vendor/google-free";

type ErasedChannel = CapabilityChannelContribution<unknown, unknown, unknown>;

/** Detection channels in priority order: AI, free Google, then Google Cloud. */
export const detectChannelContributions = [
  aiDetectionContribution,
  googleDetectionContribution,
  googleCloudDetectionContribution,
] as const;

/** Registers every detection channel the registry does not have yet. */
export function registerDetectContributions(registry: ContributionRegistry): void {
  for (const contribution of detectChannelContributions) {
    if (registry.findCapability("detect", contribution.id) !== null) continue;
    registry.registerCapability(contribution as unknown as ErasedChannel);
  }
}
