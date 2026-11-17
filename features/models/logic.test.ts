import { expect, test } from "nsh/test";
import { initializeAiModules } from "../../app/ai-setup";
import { createChannelDraft } from "./channel-draft";
import { inspectBaseUrl } from "./connection";
import {
  formatModelApiTypeDisplay,
  formatTokenCount,
  resolveEffectiveApiType,
  resolveEffectiveCapabilities,
  resolveEffectiveDisplayName,
} from "./model-helpers";
import type { ProviderModel } from "../../modules/ai/contracts/model";

initializeAiModules();

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

  expect(inspectBaseUrl("http://127.example.com/v1").isInsecureHttp).toBe(true);
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

test("provider channels: draft catalog merge deduplicates by model ID and preserves edits", () => {
  const draft = createChannelDraft("deepseek");
  const baseCapabilities = { text: true, image: false, pdf: false, video: false };

  draft.addManualModel({
    modelKey: "manual-local",
    displayNameOverride: "Local",
    apiTypeOverride: null,
    enabled: true,
  });

  draft.applyDiscoveredModels(
    [
      {
        modelKey: "deepseek-chat",
        displayName: "DeepSeek Chat",
        capabilities: baseCapabilities,
        contextLimit: 64_000,
        maxTokens: 4096,
      },
      {
        modelKey: "legacy-ds",
        displayName: "Legacy DS",
        capabilities: baseCapabilities,
        contextLimit: null,
        maxTokens: null,
      },
    ],
    "openai-compatible",
  );

  const chatModel = draft.models().find((m) => m.modelKey === "deepseek-chat")!;
  draft.setModelEnabled(chatModel.id, true);
  draft.updateModel({
    id: chatModel.id,
    displayNameOverride: "Custom DS",
    apiTypeOverride: "anthropic",
    capabilitiesOverride: { pdf: true },
    contextLimit: 128_000,
    maxTokens: 8192,
  });

  expect(() =>
    draft.addManualModel({
      modelKey: "deepseek-chat",
      displayNameOverride: null,
      apiTypeOverride: "openai-responses",
      enabled: false,
    }),
  ).toThrow();

  const resyncSummary = draft.applyDiscoveredModels(
    [
      {
        modelKey: "deepseek-chat",
        displayName: "DeepSeek V4",
        capabilities: baseCapabilities,
        contextLimit: 64_000,
        maxTokens: 4096,
      },
      {
        modelKey: "deepseek-reasoner",
        displayName: "DeepSeek R1",
        capabilities: baseCapabilities,
        contextLimit: null,
        maxTokens: null,
      },
    ],
    "openai-responses",
  );

  expect(resyncSummary).toEqual({
    discoveredCount: 2,
    addedCount: 1,
    updatedCount: 1,
    missingCount: 1,
  });
  expect(draft.models().filter((m) => m.modelKey === "deepseek-chat")).toHaveLength(1);

  const keptChat = draft.models().find((m) => m.modelKey === "deepseek-chat")!;
  expect(keptChat.id).toBe(chatModel.id);
  expect(keptChat.enabled).toBe(true);
  expect(keptChat.displayNameOverride).toBe("Custom DS");
  expect(keptChat.apiTypeOverride).toBe("anthropic");
  expect(keptChat.contextLimit).toBe(128_000);
  expect(draft.models().find((m) => m.modelKey === "legacy-ds")?.syncStatus).toBe("missing");
  expect(draft.models().find((m) => m.modelKey === "manual-local")?.syncStatus).toBe("active");
});

test("provider channels: a manual model inherits catalog facts", () => {
  const draft = createChannelDraft("anthropic");
  const created = draft.addManualModel({
    modelKey: "claude-sonnet-4-5",
    displayNameOverride: null,
    apiTypeOverride: null,
    enabled: true,
    facts: {
      capabilities: { text: true, image: true, pdf: true, video: false },
      contextLimit: 200_000,
      maxTokens: 64_000,
    },
  });

  expect(created.origin).toBe("manual");
  expect(created.capabilities).toEqual({ text: true, image: true, pdf: true, video: false });
  expect(created.contextLimit).toBe(200_000);
  expect(created.maxTokens).toBe(64_000);
  expect(created.capabilitiesOverride).toBeNull();

  const bare = draft.addManualModel({
    modelKey: "local-model",
    displayNameOverride: null,
    apiTypeOverride: null,
    enabled: true,
  });
  expect(bare.capabilities).toEqual({ text: true, image: false, pdf: false, video: false });
  expect(bare.contextLimit).toBeNull();
  expect(bare.maxTokens).toBeNull();
});
