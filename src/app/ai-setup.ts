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
import { aiRegistry } from "../modules/ai/runtime/registry";
import { providerSettingsRegistry } from "../modules/ai/ui/registry";

let initialized = false;

function registerBuiltIns(): void {
  aiRegistry.registerProtocol(openAIChatProtocol);
  aiRegistry.registerProtocol(openAIResponsesProtocol);
  aiRegistry.registerProtocol(anthropicProtocol);
  aiRegistry.registerProtocol(geminiProtocol);

  aiRegistry.registerProvider(openaiProvider);
  aiRegistry.registerProvider(geminiProvider);
  aiRegistry.registerProvider(anthropicProvider);
  aiRegistry.registerProvider(deepseekProvider);
  aiRegistry.registerProvider(customProvider);
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
export function initializeAiModules(): void {
  if (initialized) return;
  registerBuiltIns();
  registerPresentations();
  initialized = true;
}
