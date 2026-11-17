import type { ProviderDefinition } from "../../contracts/provider";

/** OpenAI provider policy: Chat Completions and Responses over the official root. */
export const openaiProvider: ProviderDefinition = {
  id: "openai",
  labelKey: "models.preset.openai",
  allowedProtocolIds: ["openai-compatible", "openai-responses"],
  defaultProtocolId: "openai-responses",
  defaultBaseUrl: "https://api.openai.com/v1",
  catalogProviderId: "openai",
};
