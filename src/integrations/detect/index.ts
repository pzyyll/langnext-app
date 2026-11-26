// ABOUTME: The language detection channels, in catalog and priority order.
// ABOUTME: Startup assembly registers them; the detection store reads them back by capability.
import type {
  CapabilityChannelDefinition,
  IntegrationRegistry,
} from "../../framework/integrations";
import { aiDetectionDefinition } from "./channels/ai";
import { googleDetectionDefinition } from "./channels/google";
import { googleCloudDetectionDefinition } from "./channels/google-cloud";

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

type ErasedChannel = CapabilityChannelDefinition<unknown, unknown, unknown>;

/** Detection channels in priority order: AI, free Google, then Google Cloud. */
export const detectChannelDefinitions = [
  aiDetectionDefinition,
  googleDetectionDefinition,
  googleCloudDetectionDefinition,
] as const;

/** Registers every detection channel; a duplicate id stops assembly. */
export function registerDetectIntegrations(registry: IntegrationRegistry): void {
  for (const definition of detectChannelDefinitions) {
    registry.registerCapability(definition as unknown as ErasedChannel);
  }
}
