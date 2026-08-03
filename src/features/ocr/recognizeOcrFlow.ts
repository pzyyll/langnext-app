// ABOUTME: Frontend OCR recognition: AI via provider plugins; Baidu + plugin via Rust IPC.
// ABOUTME: Backend recognize_ocr dispatches Baidu native and plugin_capability (Vision).
import {
  getAppSettings,
  getOcrService,
  listAllProviderModels,
  listProviderInstances,
  listRuntimeProviderCatalog,
  recognizeBaiduOcr,
} from "../../storage/client";
import type {
  OcrRecognizeInput,
  OcrRecognizeResult,
  OcrServiceDto,
  ProviderInstanceDto,
  ProviderModelDto,
  ProviderRuntimeCatalogEntryDto,
} from "../../storage/types";
import { normalizeProviderError } from "../providers/errors";
import { resolveEffectiveAdapterId, resolveProviderExecutor } from "../providers/executor";
import { isModelApiTypeExecutable, requireProviderPlugin } from "../providers/registry";
import { newClientRequestId } from "../translate/newClientRequestId";

const DEFAULT_AI_OCR_TEMPERATURE = 0.2;
const DEFAULT_AI_OCR_MAX_TOKENS = 4096;
const DEFAULT_TRANSLATE_MAX_TOKENS = 32768;

function modelDisplayName(model: ProviderModelDto): string {
  return model.displayNameOverride?.trim() || model.remoteDisplayName?.trim() || model.modelKey;
}

function resolveMaxTokens(model: ProviderModelDto): number {
  const caps = model.capabilityOverridesJson;
  const modelDefault = caps?.defaultOutputTokens ?? caps?.maxOutputTokens ?? null;
  const resolved = modelDefault ?? DEFAULT_TRANSLATE_MAX_TOKENS;
  return Math.max(resolved, DEFAULT_AI_OCR_MAX_TOKENS);
}

async function resolveOcrService(ocrServiceId?: string | null): Promise<OcrServiceDto> {
  if (ocrServiceId) {
    return getOcrService(ocrServiceId);
  }
  const settings = await getAppSettings();
  if (!settings.defaultOcrServiceId) {
    throw new Error("default OCR service is not configured");
  }
  return getOcrService(settings.defaultOcrServiceId);
}

/**
 * Native/backend OCR path. Used for Baidu and plugin_capability (Vision).
 * IPC command is still named recognize_ocr; client helper keeps historical name.
 */
async function recognizeNativeOcr(
  service: OcrServiceDto,
  pngBase64: string,
  requestId?: string | null,
): Promise<OcrRecognizeResult> {
  return recognizeBaiduOcr({
    pngBase64,
    ocrServiceId: service.id,
    requestId: requestId ?? newClientRequestId("ocr"),
  });
}

async function recognizeAiOcr(
  service: OcrServiceDto,
  pngBase64: string,
  modelsById: Map<string, ProviderModelDto>,
  providersById: Map<string, ProviderInstanceDto>,
  runtimeCatalog: readonly ProviderRuntimeCatalogEntryDto[],
): Promise<OcrRecognizeResult> {
  if (!service.enabled) {
    throw new Error("OCR service is disabled");
  }
  const modelId = service.providerModelId;
  if (!modelId) {
    throw new Error("AI OCR model is not configured");
  }
  const templateId = service.defaultPromptTemplateId;
  if (!templateId) {
    throw new Error("AI OCR default prompt template is not configured");
  }
  const template = service.promptTemplates.find((t) => t.id === templateId);
  if (!template) {
    throw new Error("AI OCR default prompt template is missing");
  }
  const model = modelsById.get(modelId);
  if (!model || !model.enabled) {
    throw new Error("AI OCR model is missing or disabled");
  }
  const provider = providersById.get(model.providerInstanceId);
  if (!provider || !provider.enabled) {
    throw new Error("AI OCR provider is missing or disabled");
  }
  // Unbound API types keep the existing model API Type / custom-relay compatibility rule;
  // an active matching runtime binding enforces declared aliases inside the executor resolver.
  const effectiveAdapterId = resolveEffectiveAdapterId({
    modelAdapterId: model.adapterId,
    modelSourceAdapterId: model.sourceAdapterId,
    providerAdapterId: provider.adapterId,
  });
  const binding = provider.runtimeBindings.find((candidate) => candidate.adapterId === effectiveAdapterId);
  if (!binding || binding.runtimeKind === "legacy-frontend-provider") {
    const pluginId = effectiveAdapterId.trim();
    const plugin = requireProviderPlugin(pluginId);
    const modelAuth = plugin.resolveAuthScheme(provider.credentialKind);
    if (
      !isModelApiTypeExecutable({
        providerPluginId: provider.adapterId,
        modelPluginId: pluginId,
        providerAuthScheme: provider.authScheme,
        modelAuthScheme: modelAuth,
        baseUrlSource: provider.baseUrlSource,
      })
    ) {
      throw new Error("AI OCR model API Type is incompatible with the provider endpoint");
    }
  }

  const executor = resolveProviderExecutor({
    provider,
    modelAdapterId: model.adapterId,
    modelSourceAdapterId: model.sourceAdapterId,
    modelId: model.id,
    catalog: runtimeCatalog,
  });
  // The PNG travels only in semantic executor input; the runtime command converts it to
  // the host-owned WIT image Blob, and legacy adapters encode it inside their wire body.
  const response = await executor.chat({
    operation: "ocr",
    stream: false,
    modelKey: model.modelKey,
    systemPrompt: template.systemTemplate,
    userPrompt: template.userTemplate,
    temperature: service.temperature ?? DEFAULT_AI_OCR_TEMPERATURE,
    maxTokens: resolveMaxTokens(model),
    thinking: false,
    imagePngBase64: pngBase64,
    requestId: newClientRequestId("ocr"),
  });
  const text = response.text.trim();
  return {
    text,
    ocrServiceId: service.id,
  };
}

/**
 * Recognize OCR text.
 * - baidu / plugin_capability → Rust `recognize_ocr` (native Baidu or Vision plugin)
 * - ai → frontend provider plugin multimodal chat
 */
export async function recognizeOcrFlow(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
  const pngBase64 = input.pngBase64.trim();
  if (!pngBase64) {
    throw new Error("png_base64 must not be empty");
  }

  const service = await resolveOcrService(input.ocrServiceId);
  if (service.providerType === "baidu" || service.providerType === "plugin_capability") {
    return recognizeNativeOcr(service, pngBase64, input.requestId);
  }

  try {
    const [models, providers, runtimeCatalog] = await Promise.all([
      listAllProviderModels(),
      listProviderInstances(),
      listRuntimeProviderCatalog(),
    ]);
    const modelsById = new Map(models.map((m) => [m.id, m]));
    const providersById = new Map(providers.map((p) => [p.id, p]));
    return await recognizeAiOcr(service, pngBase64, modelsById, providersById, runtimeCatalog);
  } catch (error) {
    const normalized = normalizeProviderError(error);
    const wrapped = new Error(normalized.message || "OCR recognition failed");
    // Attach original error for diagnostics without relying on ErrorOptions.cause typing.
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }
}

export function ocrModelDisplayName(model: ProviderModelDto): string {
  return modelDisplayName(model);
}
