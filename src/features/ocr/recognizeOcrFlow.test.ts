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
const recognizeBaiduOcrMock = mock(async () => ({ text: "native", ocrServiceId: "svc" }));

mock.module("../../storage/client", () => ({
  getAppSettings: () => getAppSettingsMock(),
  getOcrService: (id: string) => getOcrServiceMock(id),
  listAllProviderModels: () => listAllProviderModelsMock(),
  listProviderInstances: () => listProviderInstancesMock(),
  recognizeBaiduOcr: (input: unknown) => recognizeBaiduOcrMock(input),
}));

const normalizeProviderErrorMock = mock((error: unknown) => ({
  message: error instanceof Error ? error.message : "normalized",
}));
const mapHttpStatusMock = mock(() => "http_error");
mock.module("../providers/errors", () => ({
  normalizeProviderError: (error: unknown) => normalizeProviderErrorMock(error),
  mapHttpStatus: (status: number) => mapHttpStatusMock(status),
}));

const providerFetchMock = mock(async () => ({ status: 200, body: "{}" }));
mock.module("../providers/providerFetch", () => ({
  providerFetch: (input: unknown) => providerFetchMock(input),
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
