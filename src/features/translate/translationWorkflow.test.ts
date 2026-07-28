// ABOUTME: Tests for translation context resolution and non-stream early failures.
// ABOUTME: Covers LLM readiness, service branch unary callbacks, and cancel isolation.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type {
  IntegrationInstanceDto,
  ProviderInstanceDto,
  ProviderModelDto,
  TranslateResult,
  TranslationProfileDto,
} from "../../storage/types";
import { registerBuiltinProviderPlugins } from "../providers/builtin";
import * as registry from "../providers/registry";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";

installTauriInvokeMock();
registerBuiltinProviderPlugins();

const { resolveTranslationContext } = await import("./translationContext");
const { runTranslationNonStream, runTranslationStream } = await import("./translationWorkflow");

function provider(
  partial: Partial<ProviderInstanceDto> & Pick<ProviderInstanceDto, "id" | "adapterId">,
): ProviderInstanceDto {
  return {
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
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

function model(
  partial: Partial<ProviderModelDto> & Pick<ProviderModelDto, "id" | "providerInstanceId" | "modelKey">,
): ProviderModelDto {
  return {
    source: "manual",
    remoteDisplayName: null,
    displayNameOverride: "Display",
    enabled: true,
    availability: "available",
    remoteMetadataJson: null,
    capabilityOverridesJson: null,
    adapterId: null,
    lastSeenAt: null,
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

function pluginProfile(id = "prof-svc"): TranslationProfileDto {
  return {
    id,
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

function integration(partial: Partial<IntegrationInstanceDto> = {}): IntegrationInstanceDto {
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
    ...partial,
  };
}

afterEach(() => {
  resetInvokeMock();
});

describe("resolveTranslationContext", () => {
  test("returns early validation for empty text", () => {
    const ctx = resolveTranslationContext(
      { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "  " },
      { providersById: new Map(), modelsById: new Map(), profile: null },
    );
    expect(ctx.earlyFailure?.errorCode).toBe("validation_failed");
  });

  test("builds attempt with display snapshots", () => {
    const p = provider({ id: "p1", adapterId: "openai-compatible", displayName: "OpenAI" });
    const m = model({
      id: "m1",
      providerInstanceId: "p1",
      modelKey: "gpt-4o-mini",
      displayNameOverride: "Mini",
    });
    const ctx = resolveTranslationContext(
      { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "hello" },
      {
        providersById: new Map([["p1", p]]),
        modelsById: new Map([["m1", m]]),
        profile: null,
      },
    );
    expect(ctx.earlyFailure).toBeUndefined();
    expect(ctx.kind).toBe("llm");
    if (ctx.kind !== "llm") {
      throw new Error("expected llm");
    }
    expect(ctx.attempts).toHaveLength(1);
    expect(ctx.attempts[0]?.modelDisplayName).toBe("Mini");
    expect(ctx.attempts[0]?.providerDisplayName).toBe("OpenAI");
  });

  test("includes profile fallback targets and profile name", () => {
    const p = provider({ id: "p1", adapterId: "openai-compatible" });
    const m1 = model({ id: "m1", providerInstanceId: "p1", modelKey: "a" });
    const m2 = model({ id: "m2", providerInstanceId: "p1", modelKey: "b" });
    const profile = {
      id: "prof1",
      name: "Work",
      enabled: true,
      createdAt: "t",
      updatedAt: "t",
      engine: {
        kind: "llm_model_chain",
        templateVersion: 1,
        defaultPromptTemplateId: "t1",
        temperature: 0.1,
        maxOutputTokens: 1000,
        providerOptionsJson: null,
      },
      targets: [
        { translationProfileId: "prof1", providerModelId: "m1", priority: 0 },
        { translationProfileId: "prof1", providerModelId: "m2", priority: 1 },
      ],
      promptTemplates: [
        {
          id: "t1",
          name: "Default",
          systemTemplate: "S {{sourceLang}}",
          userTemplate: "{{text}}",
        },
      ],
    } as TranslationProfileDto;
    const ctx = resolveTranslationContext(
      {
        modelId: "m1",
        sourceLang: "en",
        targetLang: "zh",
        text: "hi",
        profileId: "prof1",
      },
      {
        providersById: new Map([["p1", p]]),
        modelsById: new Map([
          ["m1", m1],
          ["m2", m2],
        ]),
        profile,
      },
    );
    expect(ctx.kind).toBe("llm");
    if (ctx.kind !== "llm") {
      throw new Error("expected llm");
    }
    expect(ctx.attempts.map((a) => a.modelId)).toEqual(["m1", "m2"]);
    expect(ctx.profileName).toBe("Work");
    expect(ctx.systemPrompt).toContain("en");
    expect(ctx.userPrompt).toBe("hi");
  });

  test("plugin profile resolves service context without modelId", () => {
    const profile = pluginProfile();
    const ctx = resolveTranslationContext(
      { sourceLang: "en", targetLang: "zh", text: "hello", profileId: profile.id },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
    );
    expect(ctx.kind).toBe("service_integration");
    if (ctx.kind !== "service_integration") {
      throw new Error("expected service");
    }
    expect(ctx.earlyFailure).toBeUndefined();
    expect(ctx.integrationDisplayName).toBe("Work");
    expect(ctx.capabilityLabel).toBe("translate.text@1");
  });

  test("plugin profile fails closed unless effectiveStatus is ready", () => {
    const profile = pluginProfile();
    const cases: Array<{ status: IntegrationInstanceDto["effectiveStatus"]; code: string; enabled?: boolean }> = [
      { status: "disabled", code: "integration_disabled", enabled: false },
      { status: "unconfigured", code: "integration_unconfigured" },
      { status: "unvalidated", code: "integration_unvalidated" },
      { status: "degraded", code: "integration_degraded" },
      { status: "plugin_missing", code: "plugin_missing" },
    ];
    for (const c of cases) {
      const ctx = resolveTranslationContext(
        { sourceLang: "en", targetLang: "zh", text: "hello", profileId: profile.id },
        {
          providersById: new Map(),
          modelsById: new Map(),
          profile,
          integrationsById: new Map([
            [
              "int-1",
              integration({
                effectiveStatus: c.status,
                enabled: c.enabled ?? true,
                healthStatus: c.status === "ready" ? "ready" : "unconfigured",
              }),
            ],
          ]),
        },
      );
      expect(ctx.kind).toBe("service_integration");
      expect(ctx.earlyFailure?.errorCode).toBe(c.code);
    }
  });
});

describe("runTranslationNonStream", () => {
  test("returns early failure without network when no attempts", async () => {
    const result = await runTranslationNonStream(
      { modelId: "missing", sourceLang: "en", targetLang: "zh", text: "hello" },
      { providersById: new Map(), modelsById: new Map(), profile: null },
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("validation_failed");
  });

  test("service success sends concrete language ids never labels or auto", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "translate_service_profile") {
        return {
          ok: true,
          translatedText: "你好",
          latencyMs: 12,
          errorCode: null,
          message: "ok",
          modelId: null,
        } satisfies TranslateResult;
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const requireSpy = spyOn(registry, "requireProviderPlugin");
    const result = await runTranslationNonStream(
      {
        // Display labels differ from ids (zh-CN UI); service IPC must use ids only.
        sourceLang: "English",
        targetLang: "中文",
        text: "hello",
        profileId: profile.id,
        sourceLangId: "auto",
        targetLangId: "auto",
        effectiveSourceLangId: "en",
        effectiveTargetLangId: "zh",
      },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.modelId).toBeNull();
    expect(requireSpy).not.toHaveBeenCalled();
    const translateCalls = invokeMock.mock.calls.filter((c) => c[0] === "translate_service_profile");
    expect(translateCalls).toHaveLength(1);
    const payload = translateCalls[0]?.[1] as { input: Record<string, unknown> };
    expect(payload.input.profileId).toBe(profile.id);
    expect(payload.input.sourceLang).toBe("en");
    expect(payload.input.targetLang).toBe("zh");
    expect(payload.input.sourceLang).not.toBe("English");
    expect(payload.input.targetLang).not.toBe("中文");
    expect(payload.input.sourceLang).not.toBe("auto");
    expect(payload.input.targetLang).not.toBe("auto");
    expect(payload.input).not.toHaveProperty("pluginId");
    expect(payload.input).not.toHaveProperty("endpoint");
    expect(payload.input).not.toHaveProperty("credential");
    requireSpy.mockRestore();
  });

  test("service source-auto and target-auto never send auto to IPC", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "translate_service_profile") {
        return {
          ok: true,
          translatedText: "hola",
          latencyMs: 5,
          errorCode: null,
          message: "ok",
          modelId: null,
        } satisfies TranslateResult;
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const result = await runTranslationNonStream(
      {
        sourceLang: "Auto",
        targetLang: "Auto",
        text: "hello",
        profileId: profile.id,
        // UI Auto resolved upstream to concrete ids (detect + preferred-target rules).
        sourceLangId: "auto",
        targetLangId: "auto",
        effectiveSourceLangId: "en",
        effectiveTargetLangId: "es",
      },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
    );
    expect(result.ok).toBe(true);
    const payload = invokeMock.mock.calls.find((c) => c[0] === "translate_service_profile")?.[1] as {
      input: Record<string, unknown>;
    };
    expect(payload.input.sourceLang).toBe("en");
    expect(payload.input.targetLang).toBe("es");
    expect(String(payload.input.sourceLang).toLowerCase()).not.toBe("auto");
    expect(String(payload.input.targetLang).toLowerCase()).not.toBe("auto");
  });

  test("service fails before IPC when effective language ids are missing or auto", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const missing = await runTranslationNonStream(
      { sourceLang: "English", targetLang: "中文", text: "hello", profileId: profile.id },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
    );
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe("validation_failed");
    expect(invokeMock.mock.calls).toHaveLength(0);

    const autoSource = await runTranslationNonStream(
      {
        sourceLang: "English",
        targetLang: "中文",
        text: "hello",
        profileId: profile.id,
        effectiveSourceLangId: "auto",
        effectiveTargetLangId: "zh",
      },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
    );
    expect(autoSource.ok).toBe(false);
    expect(autoSource.errorCode).toBe("validation_failed");
    expect(invokeMock.mock.calls).toHaveLength(0);
  });

  test("service error returns soft failure without requireProviderPlugin", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "translate_service_profile") {
        return {
          ok: false,
          translatedText: "",
          latencyMs: 3,
          errorCode: "auth",
          message: "auth failed",
          modelId: null,
        } satisfies TranslateResult;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const requireSpy = spyOn(registry, "requireProviderPlugin");
    const result = await runTranslationNonStream(
      {
        sourceLang: "en",
        targetLang: "zh",
        text: "hello",
        profileId: profile.id,
        effectiveSourceLangId: "en",
        effectiveTargetLangId: "zh",
      },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("auth");
    expect(result.modelId).toBeNull();
    expect(requireSpy).not.toHaveBeenCalled();
    requireSpy.mockRestore();
  });
});

describe("runTranslationStream service branch", () => {
  test("emits onReset label then one terminal onDone and no chunks", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "translate_service_profile") {
        return {
          ok: true,
          translatedText: "hola",
          latencyMs: 8,
          errorCode: null,
          message: "ok",
          modelId: null,
        } satisfies TranslateResult;
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const events: string[] = [];
    const labels: string[] = [];
    const requireSpy = spyOn(registry, "requireProviderPlugin");
    await runTranslationStream(
      {
        sourceLang: "en",
        targetLang: "es",
        text: "hi",
        profileId: profile.id,
        effectiveSourceLangId: "en",
        effectiveTargetLangId: "es",
      },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
      "req-1",
      {
        onChunk: () => events.push("chunk"),
        onReset: (label) => {
          events.push("reset");
          labels.push(label);
        },
        onDone: () => events.push("done"),
        onError: () => events.push("error"),
      },
    );
    expect(events).toEqual(["reset", "done"]);
    expect(labels[0]).toBe("Work");
    expect(labels[0]).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(requireSpy).not.toHaveBeenCalled();
    requireSpy.mockRestore();
  });

  test("cancel returns without terminal callback or history write", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "translate_service_profile") {
        return {
          ok: false,
          translatedText: "",
          latencyMs: 1,
          errorCode: "cancelled",
          message: "cancelled",
          modelId: null,
        } satisfies TranslateResult;
      }
      throw new Error(`unexpected history/cmd ${cmd}`);
    });
    const profile = pluginProfile();
    const events: string[] = [];
    await runTranslationStream(
      {
        sourceLang: "en",
        targetLang: "es",
        text: "hi",
        profileId: profile.id,
        effectiveSourceLangId: "en",
        effectiveTargetLangId: "es",
      },
      {
        providersById: new Map(),
        modelsById: new Map(),
        profile,
        integrationsById: new Map([["int-1", integration()]]),
      },
      "req-cancel",
      {
        onChunk: () => events.push("chunk"),
        onReset: () => events.push("reset"),
        onDone: () => events.push("done"),
        onError: () => events.push("error"),
      },
    );
    expect(events).toEqual(["reset"]);
    const historyCalls = invokeMock.mock.calls.filter((c) => c[0] === "record_translation_history_completion");
    expect(historyCalls).toHaveLength(0);
  });
});
