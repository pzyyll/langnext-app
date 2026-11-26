// ABOUTME: The production TTS channel collection: integrations.tts.v1 plus the secret.tts vault.
// ABOUTME: The store reads channel definitions from the startup registry.
import { Storage } from "nsh";
import {
  createChannelCollection,
  createCredentialVault,
  getIntegrationRegistry,
} from "../../framework/integrations";

/** Saved TTS channels with their credentials kept outside the configuration record. */
export const ttsChannels = createChannelCollection({
  capability: "tts",
  storage: Storage,
  storageKey: "integrations.tts.v1",
  vault: createCredentialVault({ storage: Storage, namespace: "secret.tts" }),
  definitions: () => getIntegrationRegistry().capabilities("tts"),
  policy: { enableOnFirstSave: false, requireReadableCredentialOnEnable: true },
});
