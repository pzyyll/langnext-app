// ABOUTME: The language detection channel collection: storage key, vault namespace, and policy.
// ABOUTME: Google adds enabled immediately; AI and Google Cloud enable on their first successful save.
import { Storage } from "nsh";
import {
  createChannelCollection,
  createCredentialVault,
  getContributionRegistry,
  type ChannelCollection,
  type ChannelCollectionPolicy,
} from "../../framework/contributions";
import type { VaultStorage } from "../../framework/contributions/credential-vault";

export const DETECT_COLLECTION_STORAGE_KEY = "integrations.detect.v1";
export const DETECT_CREDENTIAL_NAMESPACE = "secret.detect";

const DETECT_COLLECTION_POLICY: ChannelCollectionPolicy = { enableOnFirstSave: true };

/** Creates the detection collection over injected storage. Isolated tests call this. */
export function createDetectChannels(storage: VaultStorage): ChannelCollection {
  return createChannelCollection({
    capability: "detect",
    storage,
    storageKey: DETECT_COLLECTION_STORAGE_KEY,
    vault: createCredentialVault({ storage, namespace: DETECT_CREDENTIAL_NAMESPACE }),
    contributions: () => getContributionRegistry().capabilities("detect"),
    policy: DETECT_COLLECTION_POLICY,
  });
}

/** Production detection channels backed by NSH Storage and the shared registry. */
export const detectChannels: ChannelCollection = createDetectChannels(Storage);
