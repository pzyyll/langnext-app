// ABOUTME: The OCR channel collection behind the shared capability settings host.
// ABOUTME: Order and bindings live under `integrations.ocr.v1`; keys live under `secret.ocr`.
import { Storage } from "nsh";
import {
  createChannelCollection,
  createCredentialVault,
  getContributionRegistry,
  type ChannelCollection,
  type VaultStorage,
} from "../../framework/contributions";

/** Where the OCR channel order and bindings live. */
export const OCR_CHANNELS_STORAGE_KEY = "integrations.ocr.v1";

/** The vault namespace one OCR credential record is stored under. */
export const OCR_CREDENTIAL_NAMESPACE = "secret.ocr";

/** Creates the OCR collection over injected storage; isolated tests pass a double. */
export function createOcrChannelCollection(storage: VaultStorage): ChannelCollection {
  return createChannelCollection({
    capability: "ocr",
    storage,
    storageKey: OCR_CHANNELS_STORAGE_KEY,
    vault: createCredentialVault({ storage, namespace: OCR_CREDENTIAL_NAMESPACE }),
    contributions: () => getContributionRegistry().capabilities("ocr"),
    // A configured OCR channel runs until the user turns it off; a broken key never enables.
    policy: { enableOnFirstSave: true, requireReadableCredentialOnEnable: true },
  });
}

/** Production OCR channels. */
export const ocrChannels = createOcrChannelCollection(Storage);
