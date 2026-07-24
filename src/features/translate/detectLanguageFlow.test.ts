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
