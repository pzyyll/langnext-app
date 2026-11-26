// ABOUTME: The built-in TTS channel definitions in priority order.
// ABOUTME: The production assembly and isolated tests register these on one registry.
import type { CapabilityChannelDefinition } from "../../framework/integrations";
import { azureTtsDefinition } from "./channels/azure";
import { googleCloudTtsDefinition } from "./channels/google-cloud";
import type { TtsChannelInput, TtsSynthesis } from "./types";

export { azureTtsDefinition, azureTtsConfig, AZURE_SAMPLE_VOICE_NAME } from "./channels/azure";
export type { AzureTtsConfig } from "./channels/azure";
export {
  googleCloudTtsDefinition,
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
export const ttsChannelDefinitions: readonly CapabilityChannelDefinition<
  unknown,
  TtsChannelInput,
  TtsSynthesis
>[] = [
  googleCloudTtsDefinition as unknown as CapabilityChannelDefinition<
    unknown,
    TtsChannelInput,
    TtsSynthesis
  >,
  azureTtsDefinition as unknown as CapabilityChannelDefinition<
    unknown,
    TtsChannelInput,
    TtsSynthesis
  >,
];
