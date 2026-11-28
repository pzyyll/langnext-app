import type { IntegrationRegistry } from "../../framework/integrations";
import { aiDictionaryChannel } from "./channels/ai";

export {
  buildDictionaryPrompt,
  DictionaryChannelError,
  dictionaryFailureKey,
  isDictionaryChannelFailure,
  parseDictionaryResponse,
  type DictionaryChannelFailure,
  type DictionaryChannelOutcome,
  type DictionaryEntry,
  type DictionaryForm,
  type DictionaryLookupInput,
  type DictionaryLookupResult,
  type DictionaryPhonetic,
  type DictionarySense,
} from "./types";
export { aiDictionaryChannel, aiDictionaryConfig, type AiDictionaryConfig } from "./channels/ai";

export const dictionaryChannelDefinitions = [aiDictionaryChannel] as const;

export function registerDictionaryIntegrations(registry: IntegrationRegistry): void {
  for (const definition of dictionaryChannelDefinitions) {
    registry.registerCapability(definition);
  }
}
