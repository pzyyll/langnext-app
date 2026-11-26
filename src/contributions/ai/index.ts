// ABOUTME: Registers the built-in AI protocols, providers, and settings presentations.
// ABOUTME: The production assembly and isolated tests call this with one registry instance.
import { anthropicProtocol } from "../../modules/ai/protocols/anthropic";
import { geminiProtocol } from "../../modules/ai/protocols/gemini";
import { openAIChatProtocol } from "../../modules/ai/protocols/openai-chat";
import { openAIResponsesProtocol } from "../../modules/ai/protocols/openai-responses";
import { anthropicPresentation } from "../../modules/ai/providers/anthropic/presentation";
import { anthropicProvider } from "../../modules/ai/providers/anthropic/definition";
import { customPresentation } from "../../modules/ai/providers/custom/presentation";
import { customProvider } from "../../modules/ai/providers/custom/definition";
import { deepseekPresentation } from "../../modules/ai/providers/deepseek/presentation";
import { deepseekProvider } from "../../modules/ai/providers/deepseek/definition";
import { geminiPresentation } from "../../modules/ai/providers/gemini/presentation";
import { geminiProvider } from "../../modules/ai/providers/gemini/definition";
import { openaiPresentation } from "../../modules/ai/providers/openai/presentation";
import { openaiProvider } from "../../modules/ai/providers/openai/definition";
import type { ContributionRegistry } from "../../framework/contributions";

/** Registers the built-in AI contributions on one registry. */
export function registerAiContributions(registry: ContributionRegistry): void {
  registry.registerProtocol(openAIChatProtocol);
  registry.registerProtocol(openAIResponsesProtocol);
  registry.registerProtocol(anthropicProtocol);
  registry.registerProtocol(geminiProtocol);

  registry.registerProvider(openaiProvider);
  registry.registerProvider(geminiProvider);
  registry.registerProvider(anthropicProvider);
  registry.registerProvider(deepseekProvider);
  registry.registerProvider(customProvider);

  registry.registerPresentation(openaiPresentation);
  registry.registerPresentation(geminiPresentation);
  registry.registerPresentation(anthropicPresentation);
  registry.registerPresentation(deepseekPresentation);
  registry.registerPresentation(customPresentation);
}
