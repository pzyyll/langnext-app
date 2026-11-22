import type { CatalogIndex } from "../../../services/models-dev/catalog";
import type {
  CapabilityFlags,
  DiscoveredRemoteModel,
  ModelFacts,
  RemoteModelRecord,
} from "../contracts/model";

/**
 * Catalog facts assumed for a model the bundled snapshot does not list. The
 * snapshot ships with the app, so this covers only names it does not know.
 */
const UNDESCRIBED_FACTS = {
  text: true,
  image: false,
  pdf: false,
  video: false,
} as const;

function capabilityFacts(facts: CapabilityFlags): CapabilityFlags {
  return {
    text: facts.text,
    image: facts.image,
    pdf: facts.pdf,
    video: facts.video,
  };
}

/**
 * Turns raw protocol records into complete discovery results. Catalog
 * capabilities win when known; a model the catalog does not describe keeps text
 * only rather than guessing from its name. The endpoint's own token limits win
 * because it describes the deployment.
 */
export function enrichDiscoveredModels(
  records: readonly RemoteModelRecord[],
  index: CatalogIndex | null,
  catalogProviderId: string | null,
): DiscoveredRemoteModel[] {
  return records.map((record) => {
    const facts = index?.lookup(record.modelKey, catalogProviderId) ?? null;
    return {
      modelKey: record.modelKey,
      displayName: record.displayName,
      contextLimit: record.contextLimit ?? facts?.contextLimit ?? null,
      maxTokens: record.maxTokens ?? facts?.maxTokens ?? null,
      capabilities: record.capabilities ?? capabilityFacts(facts ?? UNDESCRIBED_FACTS),
    };
  });
}

/** Reads best-effort catalog facts for one model key when a model is added by hand. */
export function lookupModelFacts(
  index: CatalogIndex | null,
  modelKey: string,
  catalogProviderId: string | null,
): ModelFacts | null {
  const facts = index?.lookup(modelKey, catalogProviderId) ?? null;
  if (!facts) return null;
  return {
    capabilities: capabilityFacts(facts),
    contextLimit: facts.contextLimit,
    maxTokens: facts.maxTokens,
  };
}
