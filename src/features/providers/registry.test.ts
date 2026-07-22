// ABOUTME: Unit tests for provider plugin registry registration and lookup.
// ABOUTME: Covers duplicate IDs, missing plugins, and auth compatibility helpers.
import { beforeEach, describe, expect, test } from "bun:test";
import { registerBuiltinProviderPlugins } from "./builtin";
import { openaiCompatiblePlugin } from "./builtin/openaiCompatible";
import {
  authSchemesCompatible,
  clearProviderPlugins,
  getProviderPlugin,
  isModelApiTypeExecutable,
  listProviderPlugins,
  registerProviderPlugin,
  requireProviderPlugin,
} from "./registry";

describe("provider registry", () => {
  beforeEach(() => {
    clearProviderPlugins();
  });

  test("registers and lists plugins in order", () => {
    registerProviderPlugin(openaiCompatiblePlugin);
    expect(listProviderPlugins()).toHaveLength(1);
    expect(getProviderPlugin("openai-compatible")?.manifest.label).toBe("OpenAI Compatible");
  });

  test("rejects duplicate plugin ids", () => {
    registerProviderPlugin(openaiCompatiblePlugin);
    expect(() => registerProviderPlugin(openaiCompatiblePlugin)).toThrow(/Duplicate/);
  });

  test("registers builtin plugins idempotently after clear", () => {
    registerBuiltinProviderPlugins();
    expect(getProviderPlugin("openai-responses")?.manifest.id).toBe("openai-responses");
    registerBuiltinProviderPlugins();
    clearProviderPlugins();
    expect(getProviderPlugin("openai-responses")).toBeNull();
    registerBuiltinProviderPlugins();
    expect(requireProviderPlugin("openai-responses").manifest.id).toBe("openai-responses");
  });

  test("requireProviderPlugin throws for missing ids", () => {
    expect(() => requireProviderPlugin("missing")).toThrow(/unavailable/i);
  });

  test("auth scheme compatibility and model override rule", () => {
    const bearer = { schemaVersion: 1 as const, type: "bearer" as const };
    const none = { schemaVersion: 1 as const, type: "none" as const };
    expect(authSchemesCompatible(bearer, bearer)).toBe(true);
    expect(authSchemesCompatible(bearer, none)).toBe(false);
    expect(
      isModelApiTypeExecutable({
        providerPluginId: "openai-compatible",
        modelPluginId: "gemini",
        providerAuthScheme: bearer,
        modelAuthScheme: bearer,
        baseUrlSource: "plugin_default",
      }),
    ).toBe(false);
    expect(
      isModelApiTypeExecutable({
        providerPluginId: "openai-compatible",
        modelPluginId: "gemini",
        providerAuthScheme: bearer,
        modelAuthScheme: bearer,
        baseUrlSource: "custom",
      }),
    ).toBe(true);
  });
});
