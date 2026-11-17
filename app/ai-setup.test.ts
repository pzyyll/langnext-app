import { expect, test } from "nsh/test";
import { aiRegistry } from "../modules/ai/runtime/registry";
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
  expect(aiRegistry.getProvider("deepseek").catalogProtocolId).toBe("openai-compatible");
  expect(aiRegistry.getProvider("gemini").labelKey).toBe("models.preset.gemini");
});
