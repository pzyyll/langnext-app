import type { ProviderDefinition } from "../../contracts/provider";

/** Anthropic provider policy: one fixed Messages protocol. */
export const anthropicProvider: ProviderDefinition = {
  id: "anthropic",
  labelKey: "models.preset.anthropic",
  allowedProtocolIds: ["anthropic"],
  defaultProtocolId: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  catalogProviderId: "anthropic",
};
