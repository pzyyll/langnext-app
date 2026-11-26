import { expect, test } from "nsh/test";
import { registerAiContributions } from "../contributions/ai";
import { createContributionRegistry } from "../framework/contributions";
import { aiRegistry } from "../modules/ai/runtime/registry";
import { providerSettingsRegistry } from "../modules/ai/ui/registry";
import { initializeAiModules } from "./ai-setup";

test("ai setup: initializing twice keeps one ordered built-in set", () => {
  initializeAiModules();
  initializeAiModules();

  expect(aiRegistry.listProtocols().map((protocol) => protocol.id)).toEqual([
    "openai-compatible",
    "openai-responses",
    "anthropic",
    "gemini",
  ]);
  expect(aiRegistry.listProviders().map((provider) => provider.id)).toEqual([
    "openai",
    "gemini",
    "anthropic",
    "deepseek",
    "custom",
  ]);
  expect(
    providerSettingsRegistry.list().map((presentation) => presentation.providerTypeId),
  ).toEqual(["openai", "gemini", "anthropic", "deepseek", "custom"]);
  expect(aiRegistry.getProvider("deepseek").catalogProtocolId).toBe("openai-compatible");
  expect(aiRegistry.getProvider("gemini").labelKey).toBe("models.preset.gemini");
});

test("ai setup: registers built-in protocols, providers, and presentations in a fresh registry", () => {
  const fresh = createContributionRegistry();

  registerAiContributions(fresh);

  expect(fresh.list("protocol").map((protocol) => protocol.id)).toEqual([
    "openai-compatible",
    "openai-responses",
    "anthropic",
    "gemini",
  ]);
  expect(fresh.list("provider").map((provider) => provider.id)).toEqual([
    "openai",
    "gemini",
    "anthropic",
    "deepseek",
    "custom",
  ]);
  expect(
    fresh.list("provider-presentation").map((presentation) => presentation.providerTypeId),
  ).toEqual(["openai", "gemini", "anthropic", "deepseek", "custom"]);
  expect(fresh.diagnostics()).toEqual([]);
});
