import type { CatalogIndex } from "../../../services/models-dev/catalog";
import type {
  CapabilityFlags,
  DiscoveredRemoteModel,
  ModelFacts,
  RemoteModelRecord,
} from "../contracts/model";

/**
 * Capability fallback inferred from a model ID when the catalog has no facts.
 * The rules are the existing ones; this move adds no new model-name heuristic.
 */
export function inferCapabilitiesFromId(modelId: string): CapabilityFlags {
  const lower = modelId.toLowerCase();
  const isVision =
    lower.includes("gpt-4o") ||
    lower.includes("gpt-4.1") ||
    lower.includes("gpt-4.5") ||
    lower.includes("gpt-5") ||
    lower.includes("o3") ||
    lower.includes("o4") ||
    lower.includes("claude-3") ||
    lower.includes("claude-4") ||
    lower.includes("claude-sonnet") ||
    lower.includes("claude-opus") ||
    lower.includes("claude-haiku") ||
    lower.includes("gemini-1.5") ||
    lower.includes("gemini-2") ||
    lower.includes("gemini-3") ||
    lower.includes("vision") ||
    lower.includes("vl");
  const isGeminiOrClaudePdf =
    lower.includes("gemini-") ||
    lower.includes("claude-3-5") ||
    lower.includes("claude-3-7") ||
    lower.includes("claude-4") ||
    lower.includes("claude-sonnet-4") ||
    lower.includes("claude-opus-4");
  const isVideo =
    lower.includes("gemini-1.5") || lower.includes("gemini-2") || lower.includes("gemini-3");

  return {
    text: true,
    image: isVision,
    pdf: isGeminiOrClaudePdf,
    video: isVideo,
  };
}

function capabilityFacts(facts: {
  text: boolean;
  image: boolean;
  pdf: boolean;
  video: boolean;
}): CapabilityFlags {
  return {
    text: facts.text,
    image: facts.image,
    pdf: facts.pdf,
    video: facts.video,
  };
}

/**
 * Turns raw protocol records into complete discovery results. Catalog
 * capabilities win when known; the model-ID heuristic is the fallback. The
 * endpoint's own token limits win because it describes the deployment.
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
      capabilities:
        record.capabilities ??
        (facts ? capabilityFacts(facts) : inferCapabilitiesFromId(record.modelKey)),
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
