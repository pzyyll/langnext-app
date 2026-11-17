import type { ProviderDefinition } from "../../contracts/provider";

/** Gemini provider policy: one fixed protocol and the `google` catalog mapping. */
export const geminiProvider: ProviderDefinition = {
  id: "gemini",
  labelKey: "models.preset.gemini",
  allowedProtocolIds: ["gemini"],
  defaultProtocolId: "gemini",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  catalogProviderId: "google",
};
