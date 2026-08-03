// ABOUTME: Runtime provider executor contract tests over Tauri runtime IPC.
// ABOUTME: Asserts per-interface executor selection, no legacy fallback, and model-identity chat.
import { afterEach, describe, expect, test } from "bun:test";
import { registerBuiltinProviderPlugins } from "./builtin";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import {
  LegacyFrontendProviderExecutor,
  ProviderRuntimeUnavailableError,
  resolveHostDetectPolicy,
  resolveProviderExecutor,
  type ExecutorChatInput,
} from "./executor";
import { normalizeProviderError } from "./errors";
import { RuntimeProviderExecutor } from "./runtimeExecutor";
import type { ProviderInstanceDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";

installTauriInvokeMock();
registerBuiltinProviderPlugins();

const PROVIDER_ID = "provider-1";
const MODEL_ID = "model-1";
const PACKAGE_DIGEST = "digest-1";
const PACKAGE_DIGEST_B = "digest-b";

const CHAT_INPUT = {
  operation: "translate" as const,
  stream: false,
  modelKey: "gpt-4o-mini",
  systemPrompt: "sys",
  userPrompt: "hello",
  temperature: 0.2,
  maxTokens: 128,
  thinking: null,
  imagePngBase64: null,
} satisfies ExecutorChatInput;

/** Fixed sanitized catalog entry for the conformance fixture (legacy alias openai-compatible). */
const CATALOG_ENTRY = {
  pluginId: "langnext.conformance.llm-provider",
  version: "1.0.0",
  packageDigest: PACKAGE_DIGEST,
  publisher: { keyId: "key-1", keyFingerprint: "fp-1" },
  legacyAliases: ["openai-compatible"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "a" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "b" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

/** Second signed package claiming the gemini alias (runtime-only, absent from the TS registry). */
const CATALOG_ENTRY_B = {
  pluginId: "com.langnext.provider.gemini",
  version: "1.0.0",
  packageDigest: PACKAGE_DIGEST_B,
  publisher: { keyId: "key-2", keyFingerprint: "fp-2" },
  legacyAliases: ["gemini"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "c" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "d" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

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
      adapterId: "openai-compatible",
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

/** One Provider with TWO active interface bindings (openai-compatible + gemini). */
function dualRuntimeProvider(): ProviderInstanceDto {
  return provider({
    id: PROVIDER_ID,
    adapterId: "openai-compatible",
    runtime: {
      adapterId: "openai-compatible",
      runtimeKind: "wasm-component",
      packageDigest: PACKAGE_DIGEST,
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
        packageDigest: PACKAGE_DIGEST,
        grantSetRevision: 1,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
      {
        adapterId: "gemini",
        runtimeKind: "wasm-component",
        packageDigest: PACKAGE_DIGEST_B,
        grantSetRevision: 1,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
    ],
  });
}

/** One active runtime binding plus an unavailable second interface binding. */
function partiallyUnavailableProvider(): ProviderInstanceDto {
  const dual = dualRuntimeProvider();
  return {
    ...dual,
    runtimeBindings: [
      dual.runtimeBindings[0],
      {
        adapterId: "gemini",
        runtimeKind: "wasm-component",
        packageDigest: PACKAGE_DIGEST_B,
        grantSetRevision: null,
        state: "unavailable",
        errorCode: "plugin_unavailable",
        errorMessage: "package missing",
        updatedAt: "t",
      },
    ],
  };
}

/** One Provider whose DEFAULT API type is legacy while the gemini interface is runtime-bound. */
function sourceInterfaceProvider(): ProviderInstanceDto {
  return provider({
    id: PROVIDER_ID,
    adapterId: "openai-compatible",
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
        packageDigest: PACKAGE_DIGEST_B,
        grantSetRevision: 1,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
    ],
  });
}

/** Gemini catalog entry carrying host-interpreted detection metadata. */
const CATALOG_ENTRY_SRC = {
  ...CATALOG_ENTRY_B,
  detection: { maxTokens: 96, thinking: true },
} satisfies ProviderRuntimeCatalogEntryDto;

function legacyCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_http_request" || cmd === "provider_http_stream");
}

afterEach(() => {
  resetInvokeMock();
});

describe("runtime_executor_selects_executor_per_interface", () => {
  test("three models on one Provider: interface A and B use runtime executors with model identity; unbound legacy type uses the legacy executor", async () => {
    const runtimeCommands: string[] = [];
    const chatInputs: Array<Record<string, unknown>> = [];
    const listInputs: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_models_list") {
        runtimeCommands.push(cmd);
        listInputs.push(args as Record<string, unknown>);
        return { models: [{ id: "gpt-4o-mini", label: "GPT-4o mini" }] };
      }
      if (cmd === "provider_runtime_chat") {
        runtimeCommands.push(cmd);
        chatInputs.push((args.input ?? {}) as Record<string, unknown>);
        return { role: "assistant", content: "ok" };
      }
      if (cmd === "provider_http_request") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ content: [{ type: "text", text: "legacy" }] }),
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const dual = dualRuntimeProvider();
    // Interface A model (inherited default adapter).
    const modelA = resolveProviderExecutor({
      provider: dual,
      modelAdapterId: null,
      modelId: MODEL_ID,
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    expect(modelA).toBeInstanceOf(RuntimeProviderExecutor);
    // Interface B model (explicit gemini override on the second binding).
    const modelB = resolveProviderExecutor({
      provider: dual,
      modelAdapterId: "gemini",
      modelId: "model-2",
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    expect(modelB).toBeInstanceOf(RuntimeProviderExecutor);
    // Unbound legacy API type (no binding row at all) keeps the legacy executor; no mismatch
    // error is thrown merely because another runtime interface is attached.
    const modelC = resolveProviderExecutor({
      provider: dual,
      modelAdapterId: "anthropic",
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    expect(modelC).toBeInstanceOf(LegacyFrontendProviderExecutor);

    const listA = await modelA.modelsList({ requestId: "r-ma" });
    expect(listA.models).toEqual([
      { modelKey: "gpt-4o-mini", remoteDisplayName: "GPT-4o mini", remoteMetadataJson: null },
    ]);
    // Models List carries the selected API type, never a package digest.
    expect(listInputs[0]?.adapterId).toBe("openai-compatible");
    expect(listInputs[0]?.packageDigest).toBeUndefined();

    const chatA = await modelA.chat({ ...CHAT_INPUT, requestId: "r-ca" });
    expect(chatA.text).toBe("ok");
    // Runtime Chat carries the persisted model id; the host derives the binding.
    expect(chatInputs[0]?.providerModelId).toBe(MODEL_ID);
    expect(chatInputs[0]?.providerId).toBeUndefined();
    expect(chatInputs[0]?.packageDigest).toBeUndefined();

    const chatB = await modelB.chat({ ...CHAT_INPUT, modelKey: "gemini-2.0-flash", requestId: "r-cb" });
    expect(chatB.text).toBe("ok");
    expect(chatInputs[1]?.providerModelId).toBe("model-2");

    const chatC = await modelC.chat({ ...CHAT_INPUT, modelKey: "claude-3-5-sonnet", requestId: "r-cc" });
    expect(chatC.text).toBe("legacy");
    expect(runtimeCommands.filter((cmd) => cmd === "provider_runtime_chat")).toHaveLength(2);
    expect(legacyCalls()).toHaveLength(1);
  });

  test("a synced model without an override resolves through its source interface, not the Provider default", async () => {
    const runtimeCommands: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        runtimeCommands.push(cmd);
        const input = (args.input ?? {}) as { providerModelId: string };
        expect(input.providerModelId).toBe(MODEL_ID);
        return { role: "assistant", content: "ok" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    // Remote model discovered via the gemini interface; no explicit override persisted.
    const executor = resolveProviderExecutor({
      provider: sourceInterfaceProvider(),
      modelAdapterId: null,
      modelSourceAdapterId: "gemini",
      modelId: MODEL_ID,
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_SRC],
    });
    expect(executor).toBeInstanceOf(RuntimeProviderExecutor);
    const result = await executor.chat({ ...CHAT_INPUT, modelKey: "gemini-2.0-flash", requestId: "r-src-1" });
    expect(result.text).toBe("ok");
    expect(runtimeCommands).toHaveLength(1);
    expect(legacyCalls()).toHaveLength(0);
  });

  test("an explicit model override wins over the source interface and over the Provider default", () => {
    // Override names an unbound type: the effective API type is the override, so legacy runs.
    const overridden = resolveProviderExecutor({
      provider: sourceInterfaceProvider(),
      modelAdapterId: "openai-responses",
      modelSourceAdapterId: "gemini",
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_SRC],
    });
    expect(overridden).toBeInstanceOf(LegacyFrontendProviderExecutor);
    // Override names the default type even when the source interface is runtime-bound.
    const explicitDefault = resolveProviderExecutor({
      provider: sourceInterfaceProvider(),
      modelAdapterId: "openai-compatible",
      modelSourceAdapterId: "gemini",
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_SRC],
    });
    expect(explicitDefault).toBeInstanceOf(LegacyFrontendProviderExecutor);
  });

  test("host detect policy resolves through the model source interface when no override exists", () => {
    const policy = resolveHostDetectPolicy({
      provider: sourceInterfaceProvider(),
      modelAdapterId: null,
      modelSourceAdapterId: "gemini",
      catalogEntry: CATALOG_ENTRY_SRC,
      modelKey: "gemini-2.0-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(policy).toEqual({ thinking: true, maxTokens: 96 });
  });

  test("an unavailable matching interface fails closed before either transport", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error(`unexpected cmd`);
    });
    expect(() =>
      resolveProviderExecutor({
        provider: partiallyUnavailableProvider(),
        modelAdapterId: "gemini",
        catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
      }),
    ).toThrow(ProviderRuntimeUnavailableError);
    expect(() =>
      resolveProviderExecutor({
        provider: partiallyUnavailableProvider(),
        modelAdapterId: "gemini",
        catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
      }),
    ).toThrowError(expect.objectContaining({ code: "plugin_unavailable" }));
    // The other interface stays usable.
    const other = resolveProviderExecutor({
      provider: partiallyUnavailableProvider(),
      modelAdapterId: null,
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    expect(other).toBeInstanceOf(RuntimeProviderExecutor);
    expect(invokeMock.mock.calls).toHaveLength(0);
  });

  test("pre-aborted signal: chat and chatStream skip provider_runtime_chat, cancel best-effort, and normalize to cancelled", async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "cancel_provider_runtime") {
        return true;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const controller = new AbortController();
    controller.abort();
    const executor = resolveProviderExecutor({
      provider: dualRuntimeProvider(),
      modelAdapterId: null,
      modelId: MODEL_ID,
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });

    const unaryRejection = await executor.chat({ ...CHAT_INPUT, requestId: "r-pre-1", signal: controller.signal }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(normalizeProviderError(unaryRejection)).toEqual({
      code: "cancelled",
      message: "request cancelled",
      retryable: false,
    });

    const streamRejection = await executor
      .chatStream(
        { ...CHAT_INPUT, stream: true, requestId: "r-pre-2", signal: controller.signal },
        { onDelta: () => {} },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(normalizeProviderError(streamRejection)).toEqual({
      code: "cancelled",
      message: "request cancelled",
      retryable: false,
    });

    expect(calls).toEqual(["cancel_provider_runtime", "cancel_provider_runtime"]);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_runtime_chat")).toHaveLength(0);
    expect(legacyCalls()).toHaveLength(0);
  });

  test("runtime chat failure after start uses runtime IPC only and never retries legacy transport", async () => {
    const deltas: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "text", text: "wo" });
        throw { code: "network", message: "upstream failed" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const executor = resolveProviderExecutor({
      provider: dualRuntimeProvider(),
      modelAdapterId: null,
      modelId: MODEL_ID,
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    const rejection = await executor
      .chatStream({ ...CHAT_INPUT, stream: true, requestId: "r-s2" }, { onDelta: (text) => deltas.push(text) })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(deltas).toEqual(["wo"]);
    expect(normalizeProviderError(rejection)).toEqual({
      code: "network",
      message: "upstream failed",
      retryable: true,
    });
    expect(legacyCalls()).toHaveLength(0);
  });

  test("detect chat reaches runtime IPC with host-selected preferences and the persisted model id", async () => {
    let chatInput: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_chat") {
        chatInput = args.input as Record<string, unknown>;
        return { role: "assistant", content: "en" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const executor = resolveProviderExecutor({
      provider: dualRuntimeProvider(),
      modelAdapterId: null,
      modelId: MODEL_ID,
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    const result = await executor.chat({
      ...CHAT_INPUT,
      operation: "detect",
      temperature: 0,
      maxTokens: 256,
      thinking: true,
      requestId: "r-d1",
    });
    expect(result).toEqual({ text: "en" });
    const request = chatInput?.request as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      images: number[][];
      preferences: { stream: boolean; temperature: number; maxTokens: number; thinking: boolean };
    };
    expect(request.model).toBe("gpt-4o-mini");
    expect(request.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    expect(request.images).toEqual([]);
    expect(request.preferences).toEqual({ stream: false, temperature: 0, maxTokens: 256, thinking: true });
    expect(chatInput?.providerModelId).toBe(MODEL_ID);
    expect(chatInput?.requestId).toBe("r-d1");
  });

  test("post-rollback legacy provider resumes the valid custom-relay executor path", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_http_request") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }, { text: " world" }] } }] }),
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const rolledBack = provider({ id: PROVIDER_ID, adapterId: "openai-compatible" });
    const executor = resolveProviderExecutor({
      provider: rolledBack,
      modelAdapterId: "gemini",
      catalog: [CATALOG_ENTRY, CATALOG_ENTRY_B],
    });
    expect(executor).toBeInstanceOf(LegacyFrontendProviderExecutor);
    const result = await executor.chat({ ...CHAT_INPUT, modelKey: "gemini-2.0-flash", requestId: "r-l1" });
    expect(result.text).toBe("hello world");
    const httpCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_http_request");
    expect(httpCalls).toHaveLength(1);
    const callArgs = (httpCalls[0]?.[1] ?? {}) as {
      input: { providerInstanceId: string; wire: { relativePath: string } };
    };
    expect(callArgs.input.providerInstanceId).toBe(PROVIDER_ID);
    expect(callArgs.input.wire.relativePath).toContain(":generateContent");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_runtime_chat")).toHaveLength(0);
  });
});
