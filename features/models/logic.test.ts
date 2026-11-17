import { expect, test } from "nsh/test";
import { inspectBaseUrl } from "./connection";
import {
  formatModelApiTypeDisplay,
  formatTokenCount,
  resolveEffectiveApiType,
  resolveEffectiveCapabilities,
  resolveEffectiveDisplayName,
} from "./model-helpers";
import type { ProviderModel } from "./types";

function makeModel(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: "m1",
    providerId: "p1",
    modelKey: "gpt-4o",
    sourceAdapterId: "openai-compatible",
    origin: "remote",
    syncStatus: "active",
    enabled: false,
    displayName: null,
    displayNameOverride: null,
    apiTypeOverride: null,
    capabilities: { text: true, image: true, pdf: false, video: false },
    capabilitiesOverride: null,
    contextLimit: null,
    maxTokens: null,
    lastSeenAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("inspectBaseUrl allows empty, https, and loopback http without warning", () => {
  expect(inspectBaseUrl("   ")).toEqual({
    ok: true,
    normalizedBaseUrl: null,
    isInsecureHttp: false,
    error: null,
  });

  expect(inspectBaseUrl("https://api.example.com/v1///")).toEqual({
    ok: true,
    normalizedBaseUrl: "https://api.example.com/v1",
    isInsecureHttp: false,
    error: null,
  });

  for (const loopback of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080",
    "http://[::1]:8000",
  ]) {
    expect(inspectBaseUrl(loopback)).toMatchObject({
      ok: true,
      isInsecureHttp: false,
      error: null,
    });
  }
});

test("inspectBaseUrl flags non-loopback http and rejects invalid URLs", () => {
  expect(inspectBaseUrl("http://192.168.1.25:8080/v1")).toEqual({
    ok: true,
    normalizedBaseUrl: "http://192.168.1.25:8080/v1",
    isInsecureHttp: true,
    error: null,
  });

  expect(inspectBaseUrl("ftp://example.com").ok).toBe(false);
  expect(inspectBaseUrl("not-a-url").ok).toBe(false);
});

test("model helpers resolve names, capabilities, and token counts", () => {
  expect(resolveEffectiveDisplayName(makeModel())).toBe("gpt-4o");
  expect(resolveEffectiveDisplayName(makeModel({ displayName: "GPT-4o" }))).toBe("GPT-4o");
  expect(
    resolveEffectiveDisplayName(
      makeModel({ displayName: "GPT-4o", displayNameOverride: "My GPT" }),
    ),
  ).toBe("My GPT");

  expect(
    resolveEffectiveCapabilities(makeModel({ capabilitiesOverride: { image: false, pdf: true } })),
  ).toEqual({ text: true, image: false, pdf: true, video: false });

  expect(formatTokenCount(null)).toBeNull();
  expect(formatTokenCount(128_000)).toBe("128K");
  expect(formatTokenCount(2_000_000)).toBe("2M");
  expect(formatTokenCount(8_192)).toBe("8192");
});

test("provider channels: inherited API follows the channel default", () => {
  const discoveredFromMessages = makeModel({
    origin: "remote",
    sourceAdapterId: "anthropic",
    apiTypeOverride: null,
  });

  expect(formatModelApiTypeDisplay(discoveredFromMessages, "openai-responses")).toBe(
    "Default (OpenAI Responses)",
  );
  expect(resolveEffectiveApiType(discoveredFromMessages, "openai-responses")).toBe(
    "openai-responses",
  );
});

test("provider channels: explicit Chat override takes precedence over channel default", () => {
  const overridden = makeModel({
    origin: "remote",
    sourceAdapterId: "anthropic",
    apiTypeOverride: "openai-compatible",
  });

  expect(resolveEffectiveApiType(overridden, "openai-responses")).toBe("openai-compatible");
  expect(formatModelApiTypeDisplay(overridden, "openai-responses")).toBe("OpenAI Chat Completions");
});

test("provider channels: clearing override restores dynamic channel default inheritance", () => {
  const overridden = makeModel({
    origin: "remote",
    sourceAdapterId: "anthropic",
    apiTypeOverride: "openai-compatible",
  });
  const cleared: ProviderModel = {
    ...overridden,
    apiTypeOverride: null,
  };

  expect(resolveEffectiveApiType(cleared, "openai-responses")).toBe("openai-responses");
  expect(formatModelApiTypeDisplay(cleared, "openai-responses")).toBe("Default (OpenAI Responses)");

  expect(resolveEffectiveApiType(cleared, "openai-compatible")).toBe("openai-compatible");
  expect(formatModelApiTypeDisplay(cleared, "openai-compatible")).toBe(
    "Default (OpenAI Chat Completions)",
  );
});
