import { Storage } from "nsh";
import {
  createChannelCollection,
  createCredentialVault,
  getIntegrationRegistry,
  type ChannelCollection,
  type VaultStorage,
} from "../../framework/integrations";

export const DICTIONARY_CHANNELS_STORAGE_KEY = "integrations.dictionary.v1";
export const DICTIONARY_CREDENTIAL_NAMESPACE = "secret.dictionary";

export function createDictionaryChannels(storage: VaultStorage): ChannelCollection {
  return createChannelCollection({
    capability: "dictionary",
    storage,
    storageKey: DICTIONARY_CHANNELS_STORAGE_KEY,
    vault: createCredentialVault({ storage, namespace: DICTIONARY_CREDENTIAL_NAMESPACE }),
    definitions: () => getIntegrationRegistry().capabilities("dictionary"),
    policy: {
      enableOnFirstSave: true,
      requireReadableCredentialOnEnable: true,
    },
  });
}

export const dictionaryChannels: ChannelCollection = createDictionaryChannels(Storage);
