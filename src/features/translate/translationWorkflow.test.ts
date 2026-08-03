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
    runtime: {
      runtimeKind: "legacy-frontend-provider",
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
    ],
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

/** Capture history writes across tests (module-scoped helper). */
function historyWrites(): Array<{ ok: boolean; errorCode: string | null }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "record_translation_history_completion")
    .map(([, args]) => {
      const input = (args as { input: { ok: boolean; errorCode: string | null } }).input;
      return { ok: input.ok, errorCode: input.errorCode };
    });
}

describe("legacy_executor_preserves_translation_cancel_and_history_contract", () => {
  // Fixed OpenAI Compatible fixture literal (ported from builtin/openaiCompatible.test.ts).
  const FIXED_CHAT_BODY = JSON.stringify({ choices: [{ message: { content: "  hi  " } }] });
  const FIXED_STREAM_DELTA_EVENT = JSON.stringify({ choices: [{ delta: { content: "wo" } }] });

  function encodeSseEvents(...dataLines: string[]): number[] {
    return Array.from(new TextEncoder().encode(dataLines.map((line) => `data: ${line}\n\n`).join("")));
  }

  test("terminal success and failure write history exactly once; cancellation writes none", async () => {
    const p = provider({ id: "p1", adapterId: "openai-compatible" });
    const m = model({ id: "m1", providerInstanceId: "p1", modelKey: "gpt-4o-mini", adapterId: null });
    const snapshots = {
      providersById: new Map([["p1", p]]),
      modelsById: new Map([["m1", m]]),
      profile: null,
    };
    const translateInput = { modelId: "m1", sourceLang: "en", targetLang: "zh", text: "hello" };

    // Non-stream terminal success writes history once.
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_http_request") {
        return { status: 200, headers: {}, body: FIXED_CHAT_BODY };
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const success = await runTranslationNonStream(translateInput, snapshots);
    expect(success.ok).toBe(true);
    expect(success.translatedText).toBe("hi");
    expect(historyWrites()).toEqual([{ ok: true, errorCode: null }]);

    // Non-stream terminal failure (HTTP 500) writes history once with the bounded code.
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_http_request") {
        return { status: 500, headers: {}, body: "" };
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const failure = await runTranslationNonStream(translateInput, snapshots);
    expect(failure.ok).toBe(false);
    expect(failure.errorCode).toBe("server");
    expect(historyWrites()).toEqual([{ ok: false, errorCode: "server" }]);

    // Stream terminal success writes history once.
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_http_stream") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "started", data: { status: 200, headers: {} } });
        onEvent({ event: "chunk", data: { bytes: encodeSseEvents(FIXED_STREAM_DELTA_EVENT, "[DONE]") } });
        onEvent({ event: "finished", data: null });
        return undefined;
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const streamEvents: string[] = [];
    const streamDone = await new Promise<string>((resolve, reject) => {
      void runTranslationStream(translateInput, snapshots, "req-ok", {
        onChunk: () => streamEvents.push("chunk"),
        onReset: () => streamEvents.push("reset"),
        onDone: (result) => resolve(result.errorCode ?? "ok"),
        onError: (result) => reject(new Error(`unexpected onError ${result.errorCode}`)),
      });
    });
    expect(streamDone).toBe("ok");
    expect(streamEvents).toEqual(["chunk"]);
    expect(historyWrites()).toEqual([{ ok: true, errorCode: null }]);

    // Cancellation after partial output writes no history and emits no terminal callback.
    const controller = new AbortController();
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_http_stream") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "started", data: { status: 200, headers: {} } });
        onEvent({
          event: "chunk",
          data: { bytes: encodeSseEvents(JSON.stringify({ choices: [{ delta: { content: "hello" } }] })) },
        });
        controller.abort();
        throw { code: "cancelled", message: "Request cancelled" };
      }
      if (cmd === "cancel_provider_http") {
        return true;
      }
      if (cmd === "record_translation_history_completion") {
        throw new Error("history must not be written for cancelled work");
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const cancelledEvents: string[] = [];
    await runTranslationStream(
      translateInput,
      snapshots,
      "req-cancel",
      {
        onChunk: () => cancelledEvents.push("chunk"),
        onReset: () => cancelledEvents.push("reset"),
        onDone: () => cancelledEvents.push("done"),
        onError: () => cancelledEvents.push("error"),
      },
      controller.signal,
    );
    expect(cancelledEvents).toEqual(["chunk"]);
    expect(historyWrites()).toEqual([]);
    const cancelCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "cancel_provider_http");
    expect(cancelCalls.map(([, args]) => args)).toEqual([{ requestId: "req-cancel" }]);
  });
});

describe("runtime_executor_translation_preserves_host_fallback_reset_cancel_and_history_once", () => {
  function encodeSseEvents(...dataLines: string[]): number[] {
    return Array.from(new TextEncoder().encode(dataLines.map((line) => `data: ${line}\n\n`).join("")));
  }

  // Fixed sanitized catalog entry for the conformance fixture (legacy alias openai-compatible).
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
    detection: null,
  };

  const FIXED_CHAT_BODY = JSON.stringify({ choices: [{ message: { content: "hola" } }] });

  function runtimeProvider(): ProviderInstanceDto {
    return provider({
      id: "p1",
      adapterId: "openai-compatible",
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
    });
  }

  function fallbackProfile(): TranslationProfileDto {
    return {
      id: "prof-fallback",
      name: "Fallback",
      enabled: true,
      sourceLang: "en",
      targetLang: "es",
      primaryLang: "en",
      preferredTargetLang: "es",
      createdAt: "t",
      updatedAt: "t",
      engine: {
        kind: "llm_model_chain",
        templateVersion: 1,
        defaultPromptTemplateId: "t1",
        temperature: 0.2,
        maxOutputTokens: 512,
        providerOptionsJson: null,
      },
      targets: [
        { translationProfileId: "prof-fallback", providerModelId: "m1", priority: 0 },
        { translationProfileId: "prof-fallback", providerModelId: "m2", priority: 1 },
      ],
      promptTemplates: [{ id: "t1", name: "Default", systemTemplate: "S", userTemplate: "{{text}}" }],
    };
  }

  function runtimeSnapshots(): {
    providersById: Map<string, ProviderInstanceDto>;
    modelsById: Map<string, ProviderModelDto>;
    profile: TranslationProfileDto;
    runtimeCatalog: readonly unknown[];
  } {
    const p1 = runtimeProvider();
    const p2 = provider({ id: "p2", adapterId: "openai-compatible" });
    const m1 = model({ id: "m1", providerInstanceId: "p1", modelKey: "runtime-model", adapterId: null });
    const m2 = model({ id: "m2", providerInstanceId: "p2", modelKey: "gpt-4o-mini", adapterId: null });
    return {
      providersById: new Map([
        ["p1", p1],
        ["p2", p2],
      ]),
      modelsById: new Map([
        ["m1", m1],
        ["m2", m2],
      ]),
      profile: fallbackProfile(),
      runtimeCatalog: [CATALOG_ENTRY],
    };
  }

  test("non-stream runtime failure advances only the configured fallback; no legacy replay on the primary provider", async () => {
    const httpProviderIds: string[] = [];
    let runtimeChatCalls = 0;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        runtimeChatCalls += 1;
        throw { code: "network", message: "guest upstream failed" };
      }
      if (cmd === "provider_http_request") {
        httpProviderIds.push((args as { input: { providerInstanceId: string } }).input.providerInstanceId);
        return { status: 200, headers: {}, body: FIXED_CHAT_BODY };
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const snapshots = runtimeSnapshots();
    const result = await runTranslationNonStream(
      { modelId: "m1", sourceLang: "en", targetLang: "es", text: "hi", profileId: "prof-fallback" },
      snapshots,
    );
    expect(result.ok).toBe(true);
    expect(result.translatedText).toBe("hola");
    expect(result.modelId).toBe("m2");
    expect(runtimeChatCalls).toBe(1);
    // Fallback ran only on the separate legacy provider — never a replay on the runtime provider.
    expect(httpProviderIds).toEqual(["p2"]);
    expect(historyWrites()).toEqual([{ ok: true, errorCode: null }]);
  });

  test("stream runtime failure resets once before the next model text and writes one history record", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      console.log("DBG INVOKE", cmd);
      if (cmd === "provider_runtime_chat") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "text", text: "par" });
        throw { code: "network", message: "guest upstream dropped" };
      }
      if (cmd === "provider_http_stream") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "started", data: { status: 200, headers: {} } });
        onEvent({
          event: "chunk",
          data: { bytes: encodeSseEvents(JSON.stringify({ choices: [{ delta: { content: "tial" } }] })) },
        });
        onEvent({ event: "chunk", data: { bytes: encodeSseEvents("[DONE]") } });
        onEvent({ event: "finished", data: null });
        return undefined;
      }
      if (cmd === "record_translation_history_completion") {
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const snapshots = runtimeSnapshots();
    const events: string[] = [];
    const done = await new Promise<string>((resolve, reject) => {
      void runTranslationStream(
        { modelId: "m1", sourceLang: "en", targetLang: "es", text: "hi", profileId: "prof-fallback" },
        snapshots,
        "req-s1",
        {
          onChunk: () => events.push("chunk"),
          onReset: () => events.push("reset"),
          onDone: (result) => resolve(`${result.modelId}:${result.translatedText}`),
          onError: (result) => reject(new Error(`unexpected onError ${result.errorCode}`)),
        },
      );
    });
    expect(events).toEqual(["chunk", "reset", "chunk"]);
    expect(done).toBe("m2:tial");
    expect(historyWrites()).toEqual([{ ok: true, errorCode: null }]);
    const runtimeCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_runtime_chat");
    expect(runtimeCalls).toHaveLength(1);
  });

  test("cancellation during a runtime stream writes no history and emits no terminal callback", async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "text", text: "par" });
        controller.abort();
        throw { code: "cancelled", message: "request cancelled" };
      }
      if (cmd === "cancel_provider_runtime") {
        return true;
      }
      if (cmd === "record_translation_history_completion") {
        throw new Error("history must not be written for cancelled work");
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const snapshots = runtimeSnapshots();
    const events: string[] = [];
    await runTranslationStream(
      { modelId: "m1", sourceLang: "en", targetLang: "es", text: "hi", profileId: "prof-fallback" },
      snapshots,
      "req-cancel-runtime",
      {
        onChunk: () => events.push("chunk"),
        onReset: () => events.push("reset"),
        onDone: () => events.push("done"),
        onError: () => events.push("error"),
      },
      controller.signal,
    );
    expect(events).toEqual(["chunk"]);
    expect(historyWrites()).toEqual([]);
    const cancelCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "cancel_provider_runtime");
    expect(cancelCalls.map(([, args]) => args)).toEqual([{ requestId: "req-cancel-runtime" }]);
  });
});
