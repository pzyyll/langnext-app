// ABOUTME: Frontend language detection workflow using provider plugins and raw HTTP.
// ABOUTME: Soft failures resolve as DetectLanguageResult; unexpected failures reject as IpcError.
import { Effect } from "effect";
import { IpcError } from "../../storage/ipcError";
import type {
  DetectLanguageInput,
  DetectLanguageResult,
  IntegrationInstanceDto,
  ProviderInstanceDto,
  ProviderModelDto,
  TranslationProfileDto,
} from "../../storage/types";
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import { mapHttpStatus, normalizeProviderError } from "../providers/errors";
import { providerFetch } from "../providers/providerFetch";
import { requireProviderPlugin } from "../providers/registry";
import { newClientRequestId } from "./newClientRequestId";
import { isPluginProfile } from "./translationContext";

const DETECT_SAMPLE_CHARS = 5000;
const DETECT_TEMPERATURE = 0.0;
const SUPPORTED_LANGUAGE_IDS = new Set([
  "en",
  "zh",
  "zh-tw",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt",
  "ru",
  "it",
  "ar",
  "hi",
  "th",
  "vi",
  "id",
  "tr",
  "nl",
  "pl",
  "sv",
  "uk",
]);

export type DetectLanguageContext = {
  providersById: Map<string, ProviderInstanceDto>;
  modelsById: Map<string, ProviderModelDto>;
  profile: TranslationProfileDto | null;
  integrationsById?: Map<string, IntegrationInstanceDto>;
};

function softFailure(
  message: string,
  errorCode: string | null,
  latencyMs: number,
  modelId?: string | null,
  detectorType: DetectLanguageResult["detectorType"] = "llm",
): DetectLanguageResult {
  return {
    ok: false,
    languageId: null,
    detectorType,
    modelId: modelId ?? null,
    latencyMs,
    errorCode,
    message,
  };
}

function resolveDetectModelId(input: DetectLanguageInput, ctx: DetectLanguageContext): string | null {
  if (input.modelId) {
    return input.modelId;
  }
  const profile = ctx.profile;
  if (!profile || profile.engine.kind !== "llm_model_chain") {
    return null;
  }
  const detection = profile.engine.languageDetection;
  if (detection?.type === "llm" && detection.modelId) {
    return detection.modelId;
  }
  return profile.targets[0]?.providerModelId ?? null;
}

export async function detectLanguage(
  input: DetectLanguageInput,
  requestId: string | undefined,
  context: DetectLanguageContext,
): Promise<DetectLanguageResult> {
  const started = performance.now();
  const text = input.text.trim();
  if (!text) {
    return softFailure("Source text must not be empty", "validation_failed", 0);
  }

  // Plugin Profile path: unary Rust Detect capability (never requireProviderPlugin).
  if (context.profile && isPluginProfile(context.profile)) {
    const engine = context.profile.engine;
    if (engine.kind !== "plugin_capability" || !engine.detectCapabilityId) {
      return softFailure(
        "Source auto-detect is unavailable for this service profile",
        "detect_unavailable",
        0,
        null,
        "service_integration",
      );
    }
    try {
      const result = await runStorage(
        invokeEffect<DetectLanguageResult>("detect_service_profile_language", {
          input: {
            requestId: requestId ?? newClientRequestId("detect"),
            profileId: context.profile.id,
            text,
          },
        }),
      );
      return { ...result, modelId: null, detectorType: "service_integration" };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return softFailure(
        normalized.message,
        normalized.code,
        Math.round(performance.now() - started),
        null,
        "service_integration",
      );
    }
  }

  const sample = text.length > DETECT_SAMPLE_CHARS ? text.slice(0, DETECT_SAMPLE_CHARS) : text;
  const modelId = resolveDetectModelId(input, context);
  if (!modelId) {
    return softFailure("No detection model configured", "validation_failed", 0);
  }
  const model = context.modelsById.get(modelId);
  if (!model || !model.enabled) {
    return softFailure("Detection model unavailable", "validation_failed", 0, modelId);
  }
  const provider = context.providersById.get(model.providerInstanceId);
  if (!provider || !provider.enabled) {
    return softFailure("Detection provider unavailable", "validation_failed", 0, modelId);
  }
  try {
    const pluginId = (model.adapterId?.trim() || provider.adapterId).trim();
    const plugin = requireProviderPlugin(pluginId);
    const policy = plugin.getDetectPolicy({
      modelKey: model.modelKey,
      baseUrl: provider.baseUrl,
    });
    const systemPrompt =
      "You are a language detector. Reply with only one supported language code from: " +
      Array.from(SUPPORTED_LANGUAGE_IDS).join(", ") +
      ". No explanation.";
    const wire = plugin.buildChatRequest({
      operation: "detect",
      stream: false,
      modelKey: model.modelKey,
      systemPrompt,
      userPrompt: sample,
      temperature: DETECT_TEMPERATURE,
      maxTokens: policy.maxTokens,
      thinking: policy.thinking,
      imagePngBase64: null,
    });
    const response = await providerFetch({
      requestId: requestId ?? newClientRequestId("detect"),
      providerInstanceId: provider.id,
      wire,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (response.status < 200 || response.status >= 300) {
      return softFailure(`Provider HTTP ${response.status}`, mapHttpStatus(response.status), latencyMs, modelId);
    }
    const content = plugin.parseChatResponse(response).trim().toLowerCase();
    const languageId = content.split(/[\s,;]+/)[0] ?? "";
    if (!SUPPORTED_LANGUAGE_IDS.has(languageId)) {
      return softFailure("Unsupported language code", "invalid_response", latencyMs, modelId);
    }
    return {
      ok: true,
      languageId,
      detectorType: "llm",
      modelId,
      latencyMs,
      errorCode: null,
      message: "OK",
    };
  } catch (error) {
    const normalized = normalizeProviderError(error);
    const latencyMs = Math.round(performance.now() - started);
    return softFailure(normalized.message, normalized.code, latencyMs, modelId);
  }
}

/**
 * Effect wrapper for route Promise runners.
 */
export function detectLanguageFlow(
  input: DetectLanguageInput,
  requestId: string | undefined,
  context: DetectLanguageContext,
): Effect.Effect<DetectLanguageResult, IpcError> {
  return Effect.tryPromise({
    try: () => detectLanguage(input, requestId, context),
    catch: (error) =>
      error instanceof IpcError
        ? error
        : new IpcError({ code: "internal_error", message: "Language detection failed" }),
  });
}
