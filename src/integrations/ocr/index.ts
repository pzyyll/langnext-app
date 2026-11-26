// ABOUTME: The OCR capability definitions, in catalog order.
// ABOUTME: Startup assembly registers them; the OCR store reads them back by capability.
import type {
  CapabilityChannelDefinition,
  IntegrationRegistry,
} from "../../framework/integrations";
import { aiOcrChannel } from "./channels/ai";
import { baiduOcrChannel } from "./channels/baidu";
import { googleCloudOcrChannel } from "./channels/google-cloud";

type ErasedChannel = CapabilityChannelDefinition<unknown, unknown, unknown>;

/** Every OCR channel, in the order the add dialog and a fresh priority list use. */
export const ocrChannelDefinitions = [
  aiOcrChannel,
  baiduOcrChannel,
  googleCloudOcrChannel,
] as const;

/** Registers every OCR channel; a duplicate id stops assembly. */
export function registerOcrIntegrations(registry: IntegrationRegistry): void {
  for (const definition of ocrChannelDefinitions) {
    registry.registerCapability(definition as unknown as ErasedChannel);
  }
}
