// ABOUTME: The built-in TTS channel contributions in priority order.
// ABOUTME: The production assembly and isolated tests register these on one registry.
import type { CapabilityChannelContribution } from "../../framework/contributions";
import { azureTtsContribution } from "./channels/azure";
import { googleCloudTtsContribution } from "./channels/google-cloud";
import type { TtsChannelInput, TtsSynthesis } from "./types";

export { azureTtsContribution, azureTtsConfig, AZURE_SAMPLE_VOICE_NAME } from "./channels/azure";
export type { AzureTtsConfig } from "./channels/azure";
export {
  googleCloudTtsContribution,
  googleCloudTtsConfig,
  googleFamilyLabel,
  googleFamilyPricingLines,
  googleGenderLabel,
  googleLocaleLabel,
  googlePreviewVoiceLabel,
  googleVoiceProblem,
} from "./channels/google-cloud";
export type { GoogleCloudTtsConfig } from "./channels/google-cloud";
export type {
  GoogleTtsFailure,
  TtsChannelId,
  TtsChannelInput,
  TtsFailure,
  TtsResult,
  TtsSynthesis,
  TtsVoice,
} from "./types";

/** Google Cloud first, then Azure: the default priority order. */
export const ttsChannelContributions: readonly CapabilityChannelContribution<
  unknown,
  TtsChannelInput,
  TtsSynthesis
>[] = [
  googleCloudTtsContribution as unknown as CapabilityChannelContribution<
    unknown,
    TtsChannelInput,
    TtsSynthesis
  >,
  azureTtsContribution as unknown as CapabilityChannelContribution<
    unknown,
    TtsChannelInput,
    TtsSynthesis
  >,
];
