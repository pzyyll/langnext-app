import { anthropicProtocol } from "../modules/ai/protocols/anthropic";
import { geminiProtocol } from "../modules/ai/protocols/gemini";
import { openAIChatProtocol } from "../modules/ai/protocols/openai-chat";
import { openAIResponsesProtocol } from "../modules/ai/protocols/openai-responses";
import { anthropicPresentation } from "../modules/ai/providers/anthropic/presentation";
import { anthropicProvider } from "../modules/ai/providers/anthropic/definition";
import { customPresentation } from "../modules/ai/providers/custom/presentation";
import { customProvider } from "../modules/ai/providers/custom/definition";
import { deepseekPresentation } from "../modules/ai/providers/deepseek/presentation";
import { deepseekProvider } from "../modules/ai/providers/deepseek/definition";
import { geminiPresentation } from "../modules/ai/providers/gemini/presentation";
import { geminiProvider } from "../modules/ai/providers/gemini/definition";
import { openaiPresentation } from "../modules/ai/providers/openai/presentation";
import { openaiProvider } from "../modules/ai/providers/openai/definition";
import type { AiRegistry } from "../modules/ai/runtime/registry";
import { aiRegistry } from "../modules/ai/runtime/registry";
import { providerSettingsRegistry } from "../modules/ai/ui/registry";

let initialized = false;

function registerBuiltIns(registry: AiRegistry): void {
  registry.registerProtocol(openAIChatProtocol);
  registry.registerProtocol(openAIResponsesProtocol);
  registry.registerProtocol(anthropicProtocol);
  registry.registerProtocol(geminiProtocol);

  registry.registerProvider(openaiProvider);
  registry.registerProvider(geminiProvider);
  registry.registerProvider(anthropicProvider);
  registry.registerProvider(deepseekProvider);
  registry.registerProvider(customProvider);
}

function registerPresentations(): void {
  providerSettingsRegistry.register(openaiPresentation);
  providerSettingsRegistry.register(geminiPresentation);
  providerSettingsRegistry.register(anthropicPresentation);
  providerSettingsRegistry.register(deepseekPresentation);
  providerSettingsRegistry.register(customPresentation);
}

/**
 * The sole built-in assembly entry. It registers protocols, then provider
 * definitions, then presentations, and runs once per process; importing a
 * runtime module never registers built-ins.
 */
export function initializeAiModules(registry: AiRegistry = aiRegistry): void {
  if (initialized) return;
  registerBuiltIns(registry);
  if (registry === aiRegistry) {
    registerPresentations();
  }
  initialized = true;
}
