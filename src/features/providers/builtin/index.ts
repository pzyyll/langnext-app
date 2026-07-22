// ABOUTME: Registers all built-in provider plugins through the shared registry API.
// ABOUTME: Future external plugins will use the same registerProviderPlugin entrypoint.
import { getProviderPlugin, registerProviderPlugin } from "../registry";
import { anthropicPlugin } from "./anthropic";
import { deepseekPlugin } from "./deepseek";
import { geminiPlugin } from "./gemini";
import { openaiCompatiblePlugin } from "./openaiCompatible";
import { openaiResponsesPlugin } from "./openaiResponses";
import type { ProviderPlugin } from "../types";

const BUILTIN_PROVIDER_PLUGINS: readonly ProviderPlugin[] = [
  openaiCompatiblePlugin,
  openaiResponsesPlugin,
  anthropicPlugin,
  geminiPlugin,
  deepseekPlugin,
];

/** Idempotent registration of all built-in provider plugins. */
export function registerBuiltinProviderPlugins(): void {
  for (const plugin of BUILTIN_PROVIDER_PLUGINS) {
    if (getProviderPlugin(plugin.manifest.id) == null) {
      registerProviderPlugin(plugin);
    }
  }
}

export { anthropicPlugin, deepseekPlugin, geminiPlugin, openaiCompatiblePlugin, openaiResponsesPlugin };
