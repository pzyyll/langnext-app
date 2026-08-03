// ABOUTME: Unit tests for three-way OCR recognition dispatch (baidu/plugin/ai).
// ABOUTME: Mocks storage client; asserts native IPC for baidu+plugin and AI path isolation.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OcrServiceDto, ProviderInstanceDto, ProviderModelDto } from "../../storage/types";

const getAppSettingsMock = mock(async () => ({ defaultOcrServiceId: null as string | null }));
const getOcrServiceMock = mock(async (id: string): Promise<OcrServiceDto> => {
  void id;
  throw new Error("getOcrService not mocked");
});
const listAllProviderModelsMock = mock(async (): Promise<ProviderModelDto[]> => []);
const listProviderInstancesMock = mock(async (): Promise<ProviderInstanceDto[]> => []);
const listRuntimeProviderCatalogMock = mock(async () => []);
const runProviderRuntimeChatMock = mock(async () => null);
const recognizeBaiduOcrMock = mock(async () => ({ text: "native", ocrServiceId: "svc" }));

mock.module("../../storage/client", () => ({
  getAppSettings: () => getAppSettingsMock(),
  getOcrService: (id: string) => getOcrServiceMock(id),
  listAllProviderModels: () => listAllProviderModelsMock(),
  listProviderInstances: () => listProviderInstancesMock(),
  listRuntimeProviderCatalog: () => listRuntimeProviderCatalogMock(),
  listRuntimeProviderModels: async () => ({ models: [] }),
  runProviderRuntimeChat: (input: unknown, onEvent?: unknown) => runProviderRuntimeChatMock(input, onEvent),
  cancelProviderRuntime: async () => false,
  recognizeBaiduOcr: (input: unknown) => recognizeBaiduOcrMock(input),
}));

const normalizeProviderErrorMock = mock((error: unknown) => ({
  message: error instanceof Error ? error.message : "normalized",
}));
const mapHttpStatusMock = mock(() => "http_error");
mock.module("../providers/errors", () => ({
  normalizeProviderError: (error: unknown) => normalizeProviderErrorMock(error),
  mapHttpStatus: (status: number) => mapHttpStatusMock(status),
  DEFAULT_DETECT_MAX_TOKENS: 256,
}));

const providerFetchMock = mock(async () => ({ status: 200, body: "{}" }));
mock.module("../providers/providerFetch", () => ({
  providerFetch: (input: unknown) => providerFetchMock(input),
  providerFetchStream: async () => undefined,
}));

const requireProviderPluginMock = mock(() => {
  throw new Error("plugin not expected");
});
const isModelApiTypeExecutableMock = mock(() => true);
mock.module("../providers/registry", () => ({
  requireProviderPlugin: (id: string) => requireProviderPluginMock(id),
  isModelApiTypeExecutable: (input: unknown) => isModelApiTypeExecutableMock(input),
}));

mock.module("../translate/newClientRequestId", () => ({
  newClientRequestId: () => "ocr-req-1",
}));

const { recognizeOcrFlow } = await import("./recognizeOcrFlow");

function baseService(overrides: Partial<OcrServiceDto>): OcrServiceDto {
  return {
    id: "ocr-1",
    providerType: "baidu",
    displayName: "Service",
    enabled: true,
    sortOrder: 0,
    baiduAction: "accurate",
    hasApiKey: true,
    hasSecretKey: true,
    providerModelId: null,
    temperature: null,
    defaultPromptTemplateId: null,
    promptTemplates: [],
    integrationInstanceId: null,
    ocrCapabilityId: null,
    capabilityPreferencesVersion: null,
    capabilityPreferences: null,
    createdAt: "t0",
    updatedAt: "t0",
    ...overrides,
  };
}

describe("recognizeOcrFlow", () => {
  beforeEach(() => {
    getAppSettingsMock.mockReset();
    getOcrServiceMock.mockReset();
    listAllProviderModelsMock.mockReset();
    listProviderInstancesMock.mockReset();
    recognizeBaiduOcrMock.mockReset();
    recognizeBaiduOcrMock.mockResolvedValue({ text: "native", ocrServiceId: "ocr-1" });
    providerFetchMock.mockReset();
    requireProviderPluginMock.mockReset();
    requireProviderPluginMock.mockImplementation(() => {
      throw new Error("plugin not expected");
    });
  });

  test("rejects empty png payload", async () => {
    await expect(recognizeOcrFlow({ pngBase64: "  " })).rejects.toThrow("png_base64 must not be empty");
  });

  test("baidu services call native recognize_ocr IPC helper", async () => {
    getOcrServiceMock.mockResolvedValueOnce(baseService({ providerType: "baidu", id: "baidu-1" }));
    const result = await recognizeOcrFlow({ pngBase64: "abc", ocrServiceId: "baidu-1" });
    expect(result).toEqual({ text: "native", ocrServiceId: "ocr-1" });
    expect(recognizeBaiduOcrMock).toHaveBeenCalledTimes(1);
    const baiduArgs = recognizeBaiduOcrMock.mock.calls[0]?.[0] as {
      pngBase64: string;
      ocrServiceId: string;
      requestId?: string;
    };
    expect(baiduArgs.pngBase64).toBe("abc");
    expect(baiduArgs.ocrServiceId).toBe("baidu-1");
    expect(typeof baiduArgs.requestId).toBe("string");
    expect(baiduArgs.requestId?.length).toBeGreaterThan(0);
    expect(listAllProviderModelsMock).not.toHaveBeenCalled();
  });

  test("plugin_capability services also use native recognize_ocr IPC", async () => {
    getOcrServiceMock.mockResolvedValueOnce(
      baseService({
        providerType: "plugin_capability",
        id: "vision-1",
        baiduAction: null,
        hasApiKey: false,
        hasSecretKey: false,
        integrationInstanceId: "int-1",
        ocrCapabilityId: "ocr.image@1",
        capabilityPreferencesVersion: 1,
        capabilityPreferences: { operation: "document_text_detection", languageHints: [] },
      }),
    );
    await recognizeOcrFlow({ pngBase64: "xyz", ocrServiceId: "vision-1", requestId: "ocr-req-1" });
    expect(recognizeBaiduOcrMock).toHaveBeenCalledWith({
      pngBase64: "xyz",
      ocrServiceId: "vision-1",
      requestId: "ocr-req-1",
    });
    expect(listAllProviderModelsMock).not.toHaveBeenCalled();
  });

  test("ai services do not call native recognize_ocr helper", async () => {
    getOcrServiceMock.mockResolvedValueOnce(
      baseService({
        providerType: "ai",
        id: "ai-1",
        baiduAction: null,
        hasApiKey: false,
        hasSecretKey: false,
        providerModelId: "model-1",
        defaultPromptTemplateId: "tpl-1",
        promptTemplates: [
          {
            id: "tpl-1",
            name: "Default",
            systemTemplate: "sys",
            userTemplate: "user",
          },
        ],
      }),
    );
    listAllProviderModelsMock.mockResolvedValueOnce([]);
    listProviderInstancesMock.mockResolvedValueOnce([]);
    await expect(recognizeOcrFlow({ pngBase64: "img", ocrServiceId: "ai-1" })).rejects.toThrow();
    expect(recognizeBaiduOcrMock).not.toHaveBeenCalled();
    expect(listAllProviderModelsMock).toHaveBeenCalled();
  });
});

describe("runtime_executor_ai_ocr_uses_host_blob_path_without_legacy_http", () => {
  // Fixed 1x1 PNG payload (base64), never expected to appear in errors or requests.
  const FIXED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

  function runtimeProvider(): ProviderInstanceDto {
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
    };
  }

  function aiModel(): ProviderModelDto {
    return {
      id: "model-1",
      providerInstanceId: "p1",
      source: "remote",
      modelKey: "gpt-4o",
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
    };
  }

  function aiService(): OcrServiceDto {
    return baseService({
      providerType: "ai",
      id: "ai-1",
      baiduAction: null,
      hasApiKey: false,
      hasSecretKey: false,
      providerModelId: "model-1",
      temperature: 0.2,
      defaultPromptTemplateId: "tpl-1",
      promptTemplates: [
        {
          id: "tpl-1",
          name: "Default",
          systemTemplate: "Extract text",
          userTemplate: "Read this image",
        },
      ],
    });
  }

  beforeEach(() => {
    listRuntimeProviderCatalogMock.mockReset();
    listRuntimeProviderCatalogMock.mockResolvedValue([]);
    runProviderRuntimeChatMock.mockReset();
    runProviderRuntimeChatMock.mockResolvedValue(null);
  });

  test("runtime AI OCR invokes runtime Chat with host Blob image input and no legacy HTTP", async () => {
    let chatInput: Record<string, unknown> | null = null;
    runProviderRuntimeChatMock.mockImplementation(async (input: Record<string, unknown>) => {
      chatInput = input;
      return { role: "assistant", content: "Hello OCR" };
    });
    getOcrServiceMock.mockResolvedValueOnce(aiService());
    listAllProviderModelsMock.mockResolvedValueOnce([aiModel()]);
    listProviderInstancesMock.mockResolvedValueOnce([runtimeProvider()]);
    listRuntimeProviderCatalogMock.mockResolvedValueOnce([CATALOG_ENTRY]);

    const result = await recognizeOcrFlow({ pngBase64: FIXED_PNG, ocrServiceId: "ai-1" });
    expect(result).toEqual({ text: "Hello OCR", ocrServiceId: "ai-1" });
    expect(providerFetchMock).not.toHaveBeenCalled();
    const request = chatInput?.request as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      images: number[][];
      preferences: { stream: boolean; temperature: number; maxTokens: number; thinking: boolean };
    };
    expect(request.model).toBe("gpt-4o");
    expect(request.messages).toEqual([
      { role: "system", content: "Extract text" },
      { role: "user", content: "Read this image" },
    ]);
    expect(request.images).toHaveLength(1);
    expect(request.images[0]?.length).toBeGreaterThan(0);
    expect(request.preferences).toEqual({ stream: false, temperature: 0.2, maxTokens: 32768, thinking: false });
    expect(chatInput?.providerModelId).toBe("model-1");
    expect(recognizeBaiduOcrMock).not.toHaveBeenCalled();
  });

  test("a synced OCR model without an override recognizes through its source interface", async () => {
    runProviderRuntimeChatMock.mockImplementation(async (input: Record<string, unknown>) => {
      expect((input as { providerModelId?: string }).providerModelId).toBe("model-1");
      return { role: "assistant", content: "Hello OCR" };
    });
    getOcrServiceMock.mockResolvedValueOnce(aiService());
    listAllProviderModelsMock.mockResolvedValueOnce([{ ...aiModel(), sourceAdapterId: "gemini" }]);
    // Provider default API type stays legacy; the gemini interface is runtime-bound.
    listProviderInstancesMock.mockResolvedValueOnce([
      {
        ...runtimeProvider(),
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
      },
    ]);
    listRuntimeProviderCatalogMock.mockResolvedValueOnce([
      { ...CATALOG_ENTRY, packageDigest: "digest-2", legacyAliases: ["gemini"] },
    ]);

    const result = await recognizeOcrFlow({ pngBase64: FIXED_PNG, ocrServiceId: "ai-1" });
    expect(result).toEqual({ text: "Hello OCR", ocrServiceId: "ai-1" });
    expect(providerFetchMock).not.toHaveBeenCalled();
    expect(requireProviderPluginMock).not.toHaveBeenCalled();
  });

  test("runtime image/guest errors normalize without leaking PNG content and never retry legacy", async () => {
    runProviderRuntimeChatMock.mockRejectedValueOnce({ code: "invalid_response", message: "guest failed" });
    getOcrServiceMock.mockResolvedValueOnce(aiService());
    listAllProviderModelsMock.mockResolvedValueOnce([aiModel()]);
    listProviderInstancesMock.mockResolvedValueOnce([runtimeProvider()]);
    listRuntimeProviderCatalogMock.mockResolvedValueOnce([CATALOG_ENTRY]);

    const rejection = await recognizeOcrFlow({ pngBase64: FIXED_PNG, ocrServiceId: "ai-1" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect((rejection as Error).message).toBe("normalized");
    expect((rejection as Error).message).not.toContain(FIXED_PNG);
    expect(providerFetchMock).not.toHaveBeenCalled();
    expect(runProviderRuntimeChatMock).toHaveBeenCalledTimes(1);
  });
});
