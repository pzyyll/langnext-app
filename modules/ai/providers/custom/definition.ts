import type { ProviderDefinition } from "../../contracts/provider";

/** Custom provider policy: no default root, no fixed protocol, model-ID-only catalog. */
export const customProvider: ProviderDefinition = {
  id: "custom",
  labelKey: "models.preset.custom",
  allowedProtocolIds: ["openai-compatible", "openai-responses", "anthropic", "gemini"],
  defaultProtocolId: "openai-compatible",
  defaultBaseUrl: null,
  catalogProviderId: null,
};
