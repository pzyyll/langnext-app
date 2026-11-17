import { loadCatalog, type CatalogIndex } from "../../services/models-dev/catalog";
import type { ProviderPresetId } from "../../services/protocols/presets";
import type { DiscoveredRemoteModel } from "../../services/protocols/types";
import type { ModelFacts } from "./types";

/**
 * Provider IDs used by the models.dev catalog for the app's presets.
 * A custom channel can point anywhere, so it matches by model ID only.
 */
const PRESET_CATALOG_PROVIDER: Record<ProviderPresetId, string | null> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  deepseek: "deepseek",
  custom: null,
};

function catalogProviderId(presetId: ProviderPresetId): string | null {
  return PRESET_CATALOG_PROVIDER[presetId] ?? null;
}

/**
 * Fills catalog facts into discovered models. Provider-reported token limits win
 * because the endpoint describes the deployment; capabilities come from the
 * catalog because no listing endpoint reports them.
 */
export function applyCatalogFacts(
  presetId: ProviderPresetId,
  discovered: readonly DiscoveredRemoteModel[],
  index: CatalogIndex | null,
): DiscoveredRemoteModel[] {
  if (!index) return [...discovered];
  const providerId = catalogProviderId(presetId);

  return discovered.map((model) => {
    const facts = index.lookup(model.modelKey, providerId);
    if (!facts) return model;
    return {
      ...model,
      capabilities: {
        text: facts.text,
        image: facts.image,
        pdf: facts.pdf,
        video: facts.video,
      },
      contextLimit: model.contextLimit ?? facts.contextLimit,
      maxTokens: model.maxTokens ?? facts.maxTokens,
    };
  });
}

/** Resolves catalog facts for one model key, used when a model is added by hand. */
export async function resolveModelFacts(
  presetId: ProviderPresetId,
  modelKey: string,
): Promise<ModelFacts | null> {
  const index = await loadCatalog();
  const facts = index?.lookup(modelKey, catalogProviderId(presetId)) ?? null;
  if (!facts) return null;
  return {
    capabilities: {
      text: facts.text,
      image: facts.image,
      pdf: facts.pdf,
      video: facts.video,
    },
    contextLimit: facts.contextLimit,
    maxTokens: facts.maxTokens,
  };
}
