// ABOUTME: Tests for frontend detectLanguage soft failures and model resolution.
// ABOUTME: Covers empty text, missing model, and plugin service detect branch.
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { DetectLanguageResult, IntegrationInstanceDto, TranslationProfileDto } from "../../storage/types";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";

installTauriInvokeMock();

const { detectLanguage, detectLanguageFlow } = await import("./detectLanguageFlow");

const emptyContext = {
  providersById: new Map(),
  modelsById: new Map(),
  profile: null,
};

function pluginProfile(): TranslationProfileDto {
  return {
    id: "prof-svc",
    name: "Google Work",
    enabled: true,
    sourceLang: "auto",
    targetLang: "zh",
    primaryLang: "en",
    preferredTargetLang: "zh",
    createdAt: "t",
    updatedAt: "t",
    engine: {
      kind: "plugin_capability",
      integrationInstanceId: "int-1",
      translateCapabilityId: "translate.text@1",
      detectCapabilityId: "translate.detect@1",
      capabilityPreferencesVersion: 1,
      capabilityPreferences: {},
    },
    targets: [],
    promptTemplates: [],
  };
}

function integration(): IntegrationInstanceDto {
  return {
    id: "int-1",
    pluginId: "com.langnext.google-cloud",
    pluginVersion: "1.0.0",
    displayName: "Work",
    enabled: true,
    configJson: "{}",
    configSchemaVersion: 1,
    healthStatus: "ready",
    effectiveStatus: "ready",
    lastValidatedAt: "t",
    lastErrorCode: null,
    runtimeKind: "bundled-rust",
    runtimeState: "active",
    createdAt: "t",
    updatedAt: "t",
    credentialSlots: [],
  };
}

afterEach(() => {
  resetInvokeMock();
});

describe("detectLanguageFlow", () => {
  test("empty text returns soft validation failure", async () => {
    const result = await Effect.runPromise(detectLanguageFlow({ text: "   " }, undefined, emptyContext));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("validation_failed");
  });

  test("missing model returns soft validation failure", async () => {
    const result = await Effect.runPromise(detectLanguageFlow({ text: "bonjour" }, "d1", emptyContext));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("validation_failed");
    expect(result.message).toMatch(/detection model/i);
  });

  test("plugin profile detect calls service IPC and never provider plugins", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "detect_service_profile_language") {
        return {
          ok: true,
          languageId: "en",
          detectorType: "service_integration",
          modelId: null,
          latencyMs: 4,
          errorCode: null,
          message: "ok",
        } satisfies DetectLanguageResult;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const result = await detectLanguage({ text: "hello world" }, "detect-1", {
      providersById: new Map(),
      modelsById: new Map(),
      profile,
      integrationsById: new Map([["int-1", integration()]]),
    });
    expect(result.ok).toBe(true);
    expect(result.languageId).toBe("en");
    expect(result.modelId).toBeNull();
    expect(result.detectorType).toBe("service_integration");
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(["detect_service_profile_language"]);
  });

  test("plugin profile without detect capability returns detect_unavailable", async () => {
    const profile = pluginProfile();
    if (profile.engine.kind !== "plugin_capability") {
      throw new Error("expected plugin");
    }
    profile.engine = { ...profile.engine, detectCapabilityId: null };
    const result = await detectLanguage({ text: "hello" }, undefined, {
      providersById: new Map(),
      modelsById: new Map(),
      profile,
      integrationsById: new Map([["int-1", integration()]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("detect_unavailable");
    expect(result.detectorType).toBe("service_integration");
    expect(invokeMock.mock.calls).toHaveLength(0);
  });

  test("plugin profile detect soft-fails on service error without provider plugins", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "detect_service_profile_language") {
        return {
          ok: false,
          languageId: null,
          detectorType: "service_integration",
          modelId: null,
          latencyMs: 2,
          errorCode: "auth",
          message: "auth failed",
        } satisfies DetectLanguageResult;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await detectLanguage({ text: "hello" }, "detect-err", {
      providersById: new Map(),
      modelsById: new Map(),
      profile: pluginProfile(),
      integrationsById: new Map([["int-1", integration()]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("auth");
    expect(result.detectorType).toBe("service_integration");
    expect(result.modelId).toBeNull();
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(["detect_service_profile_language"]);
  });

  test("plugin profile detect soft-fails on cancelled without history side effects", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "detect_service_profile_language") {
        return {
          ok: false,
          languageId: null,
          detectorType: "service_integration",
          modelId: null,
          latencyMs: 1,
          errorCode: "cancelled",
          message: "cancelled",
        } satisfies DetectLanguageResult;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await detectLanguage({ text: "hello" }, "detect-cancel", {
      providersById: new Map(),
      modelsById: new Map(),
      profile: pluginProfile(),
      integrationsById: new Map([["int-1", integration()]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("cancelled");
    expect(result.detectorType).toBe("service_integration");
  });
});

describe("runtime_executor_detection_uses_host_policy_and_supported_language_validation", () => {
  // Fixed sanitized catalog entry with bounded host-interpreted detection metadata.
  const CATALOG_ENTRY = {
    pluginId: "langnext.conformance.llm-provider",
    version: "1.0.0",
    packageDigest: "digest-1",
    publisher: { keyId: "key-1", keyFingerprint: "fp-1" },
    legacyAliases: ["openai-compatible"],
    capabilities: [
      { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "a" },
      { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "b" },
    ],
    detection: { maxTokens: 96, thinking: true },
  };

  function runtimeProvider() {
    return {
      id: "p1",
      adapterId: "openai-compatible",
      displayName: "P",
      baseUrl: "https://api.openai.com/v1",
      baseUrlSource: "custom",
      authScheme: { schemaVersion: 1, type: "bearer" },
      credentialKind: "api_key",
      hasCredential: true,
      enabled: true,
      proxyMode: "inherit",
      insecureHttpConfirmedAt: null,
      modelsSyncedAt: null,
      modelsSyncStatus: "never",
      modelsSyncErrorCode: null,
      runtime: {
        runtimeKind: "wasm-component",
        packageDigest: "digest-1",
        grantSetRevision: 1,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
      runtimeBindings: [
        {
          adapterId: "openai-compatible",
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          grantSetRevision: 1,
          state: "active",
          errorCode: null,
          errorMessage: null,
          updatedAt: "t",
        },
      ],
      createdAt: "t",
      updatedAt: "t",
    } satisfies ProviderInstanceDto;
  }

  function runtimeModel() {
    return {
      id: "m1",
      providerInstanceId: "p1",
      source: "remote",
      modelKey: "runtime-detect-model",
      remoteDisplayName: null,
      displayNameOverride: null,
      enabled: true,
      availability: "available",
      remoteMetadataJson: null,
      capabilityOverridesJson: null,
      adapterId: null,
      lastSeenAt: null,
      createdAt: "t",
      updatedAt: "t",
    } satisfies ProviderModelDto;
  }

  function legacyTransportCalls() {
    return invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_http_request" || cmd === "provider_http_stream");
  }

  test("runtime detection sends host-selected thinking/max-token policy and returns supported codes", async () => {
    let chatInput: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        chatInput = args.input as Record<string, unknown>;
        return { role: "assistant", content: "zh" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await detectLanguage({ text: "你好世界", modelId: "m1" }, "detect-r1", {
      providersById: new Map([["p1", runtimeProvider()]]),
      modelsById: new Map([["m1", runtimeModel()]]),
      profile: null,
      runtimeCatalog: [CATALOG_ENTRY],
    });
    expect(result.ok).toBe(true);
    expect(result.languageId).toBe("zh");
    expect(result.detectorType).toBe("llm");
    const request = chatInput?.request as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      preferences: { stream: boolean; temperature: number; maxTokens: number; thinking: boolean };
    };
    expect(request.model).toBe("runtime-detect-model");
    expect(request.messages[1]?.content).toMatch(/^[\s\S]{1,5000}$/);
    expect(request.preferences).toEqual({ stream: false, temperature: 0, maxTokens: 96, thinking: true });
    expect(chatInput?.providerModelId).toBe("m1");
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("a synced model without an override detects through its source interface, never the Provider default", async () => {
    let chatInput: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        chatInput = args.input as Record<string, unknown>;
        return { role: "assistant", content: "en" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    // Provider default API type stays legacy; the gemini interface is runtime-bound and the
    // synced model carries only discovery provenance (no explicit override).
    const provider = {
      ...runtimeProvider(),
      runtime: {
        runtimeKind: "legacy-frontend-provider" as const,
        packageDigest: null,
        grantSetRevision: null,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
      runtimeBindings: [
        {
          adapterId: "openai-compatible",
          runtimeKind: "legacy-frontend-provider",
          packageDigest: null,
          grantSetRevision: null,
          state: "active",
          errorCode: null,
          errorMessage: null,
          updatedAt: "t",
        },
        {
          adapterId: "gemini",
          runtimeKind: "wasm-component",
          packageDigest: "digest-2",
          grantSetRevision: 1,
          state: "active",
          errorCode: null,
          errorMessage: null,
          updatedAt: "t",
        },
      ],
    } satisfies ProviderInstanceDto;
    const model = {
      ...runtimeModel(),
      sourceAdapterId: "gemini",
    } satisfies ProviderModelDto;
    const result = await detectLanguage({ text: "hello", modelId: "m1" }, "detect-src-1", {
      providersById: new Map([["p1", provider]]),
      modelsById: new Map([["m1", model]]),
      profile: null,
      runtimeCatalog: [{ ...CATALOG_ENTRY, packageDigest: "digest-2", legacyAliases: ["gemini"] }],
    });
    expect(result.ok).toBe(true);
    expect(result.languageId).toBe("en");
    expect(chatInput?.providerModelId).toBe("m1");
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("unsupported language output is a soft invalid_response", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_runtime_chat") {
        return { role: "assistant", content: "klingon" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await detectLanguage({ text: "hola", modelId: "m1" }, "detect-r2", {
      providersById: new Map([["p1", runtimeProvider()]]),
      modelsById: new Map([["m1", runtimeModel()]]),
      profile: null,
      runtimeCatalog: [CATALOG_ENTRY],
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_response");
    expect(result.modelId).toBe("m1");
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("cancelled runtime detection soft-fails without starting legacy transport", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_runtime_chat") {
        throw { code: "cancelled", message: "request cancelled" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await detectLanguage({ text: "bonjour", modelId: "m1" }, "detect-r3", {
      providersById: new Map([["p1", runtimeProvider()]]),
      modelsById: new Map([["m1", runtimeModel()]]),
      profile: null,
      runtimeCatalog: [CATALOG_ENTRY],
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("cancelled");
    expect(legacyTransportCalls()).toHaveLength(0);
  });
});
