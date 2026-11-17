import { anthropicProtocol } from "../modules/ai/protocols/anthropic";
import { geminiProtocol } from "../modules/ai/protocols/gemini";
import { openAIChatProtocol } from "../modules/ai/protocols/openai-chat";
import { openAIResponsesProtocol } from "../modules/ai/protocols/openai-responses";
import { anthropicProvider } from "../modules/ai/providers/anthropic/definition";
import { customProvider } from "../modules/ai/providers/custom/definition";
import { deepseekProvider } from "../modules/ai/providers/deepseek/definition";
import { geminiProvider } from "../modules/ai/providers/gemini/definition";
import { openaiProvider } from "../modules/ai/providers/openai/definition";
import type { AiRegistry } from "../modules/ai/runtime/registry";
import { aiRegistry } from "../modules/ai/runtime/registry";

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

/**
 * The sole built-in assembly entry. It registers protocols, then providers, and
 * runs once per process; importing a runtime module never registers built-ins.
 */
export function initializeAiModules(registry: AiRegistry = aiRegistry): void {
  if (initialized) return;
  registerBuiltIns(registry);
  initialized = true;
}
