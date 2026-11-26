// ABOUTME: The production TTS channel collection: integrations.tts.v1 plus the secret.tts vault.
// ABOUTME: Contributions arrive through the startup registry, so this store stays feature-owned.
import { Storage } from "nsh";
import {
  createChannelCollection,
  createCredentialVault,
  getContributionRegistry,
} from "../../framework/contributions";

/** Saved TTS channels with their credentials kept outside the configuration record. */
export const ttsChannels = createChannelCollection({
  capability: "tts",
  storage: Storage,
  storageKey: "integrations.tts.v1",
  vault: createCredentialVault({ storage: Storage, namespace: "secret.tts" }),
  contributions: () => getContributionRegistry().capabilities("tts"),
  policy: { enableOnFirstSave: false, requireReadableCredentialOnEnable: true },
});
