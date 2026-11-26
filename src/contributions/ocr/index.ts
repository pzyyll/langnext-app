// ABOUTME: The OCR capability contributions, in catalog order.
// ABOUTME: Startup assembly registers them; the OCR store reads them back by capability.
import type {
  CapabilityChannelContribution,
  ContributionRegistry,
} from "../../framework/contributions";
import { aiOcrChannel } from "./channels/ai";
import { baiduOcrChannel } from "./channels/baidu";
import { googleCloudOcrChannel } from "./channels/google-cloud";

type ErasedChannel = CapabilityChannelContribution<unknown, unknown, unknown>;

/** Every OCR channel, in the order the add dialog and a fresh priority list use. */
export const ocrChannelContributions = [
  aiOcrChannel,
  baiduOcrChannel,
  googleCloudOcrChannel,
] as const;

/** Registers every OCR channel; a duplicate id stops assembly. */
export function registerOcrContributions(registry: ContributionRegistry): void {
  for (const contribution of ocrChannelContributions) {
    registry.registerCapability(contribution as unknown as ErasedChannel);
  }
}
