// ABOUTME: Fixture tests for DeepSeek plugin thinking controls and detect policy.
// ABOUTME: Ensures thinking payload and raised detect token budget stay plugin-owned.
import { describe, expect, test } from "bun:test";
import { deepseekPlugin } from "./deepseek";

describe("deepseekPlugin", () => {
  test("applies thinking disabled payload", () => {
    const wire = deepseekPlugin.buildChatRequest({
      operation: "detect",
      stream: false,
      modelKey: "deepseek-chat",
      systemPrompt: "sys",
      userPrompt: "hi",
      temperature: 0,
      maxTokens: 2048,
      thinking: false,
      imagePngBase64: null,
    });
    const body = JSON.parse(wire.body ?? "{}") as { thinking?: { type: string } };
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  test("detect policy disables thinking and raises budget", () => {
    const policy = deepseekPlugin.getDetectPolicy({
      modelKey: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
    });
    expect(policy.thinking).toBe(false);
    expect(policy.maxTokens).toBeGreaterThan(256);
  });

  test("resolveAuthScheme none vs bearer", () => {
    expect(deepseekPlugin.resolveAuthScheme("none")).toEqual({ schemaVersion: 1, type: "none" });
    expect(deepseekPlugin.resolveAuthScheme("api_key")).toEqual({ schemaVersion: 1, type: "bearer" });
  });
});
