import type { ProviderDefinition } from "../../contracts/provider";
import { normalizeRequestRoot } from "../../protocols/shared";

/**
 * DeepSeek provider policy. Its catalog stays fixed to Chat Completions even
 * when Messages is selected, and Messages keeps its `/anthropic` path segment.
 */
export const deepseekProvider: ProviderDefinition = {
  id: "deepseek",
  labelKey: "models.preset.deepseek",
  allowedProtocolIds: ["openai-compatible", "openai-responses", "anthropic"],
  defaultProtocolId: "openai-compatible",
  defaultBaseUrl: "https://api.deepseek.com",
  catalogProtocolId: "openai-compatible",
  catalogProviderId: "deepseek",
  resolveBaseUrl({ baseUrl, protocolId, operation }) {
    if (operation.kind !== "model" || protocolId !== "anthropic") {
      return baseUrl;
    }
    const base = normalizeRequestRoot(baseUrl)
      .replace(/\/anthropic(?:\/v1)?$/, "")
      .replace(/\/v1$/, "");
    return `${base}/anthropic`;
  },
};
