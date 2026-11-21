import { host, mount, signal, Text, View } from "nsh";
import { initializeAiModules } from "../../../app/ai-setup";
import { loadModelsState } from "../../models/store";
import { loadLanguage } from "../../settings/language";
import { checkOcrReadiness, recognizeScreenshot, type OcrRecognitionOutcome } from "../recognize";
import { ocrSettingsStore } from "../settings";

initializeAiModules();

interface HarnessParams {
  /** PNG bytes as Base64: what the OS capture boundary would return. */
  pngBase64?: string;
  /** Model IDs to recognize with, in order; the saved OCR binding when absent. */
  modelIds?: string[];
  /** Report readiness and skip recognition. */
  readinessOnly?: boolean;
  /** Replace the loaded binding with this AI model before recognition. */
  swapToAiModelId?: string;
  timeoutMs?: number;
  abortAfterMs?: number;
}

function decodeCapturedPng(params: HarnessParams): Uint8Array {
  return Uint8Array.from(Buffer.from(params.pngBase64 ?? "", "base64"));
}

function RecognizeHarnessApp() {
  const params = host.params as HarnessParams;
  const status = signal("running");
  const outcomesJson = signal("");

  void (async () => {
    const controller = new AbortController();
    if (params.abortAfterMs !== undefined) {
      setTimeout(() => controller.abort(), params.abortAfterMs);
    }
    const bytes = decodeCapturedPng(params);
    const outcomes: Array<OcrRecognitionOutcome | null> = [];

    try {
      await loadLanguage();
      await loadModelsState();
      await ocrSettingsStore.load();

      const saved = ocrSettingsStore.settings();
      if (saved?.kind === "baidu" && !(params.modelIds && params.modelIds.length > 0)) {
        const readiness = await checkOcrReadiness(saved);
        if (!params.readinessOnly) {
          if (params.swapToAiModelId) {
            await ocrSettingsStore.save({ kind: "ai", modelId: params.swapToAiModelId });
          }
          outcomes.push(
            await recognizeScreenshot(saved, bytes, {
              signal: controller.signal,
              ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
            }),
          );
        }
        outcomesJson.set(JSON.stringify({ readiness, outcomes }));
        status.set("done");
        return;
      }

      const modelIds =
        params.modelIds && params.modelIds.length > 0
          ? params.modelIds
          : saved?.kind === "ai"
            ? [saved.modelId]
            : [];

      for (const modelId of modelIds) {
        outcomes.push(
          await recognizeScreenshot({ kind: "ai", modelId }, bytes, {
            signal: controller.signal,
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          }),
        );
      }
      outcomesJson.set(JSON.stringify({ outcomes }));
      status.set("done");
    } catch (error) {
      outcomesJson.set(
        JSON.stringify({
          outcomes,
          status: "threw",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      status.set("error");
    }
  })();

  return (
    <View class="p-4">
      <Text testID="ocr-status">{status()}</Text>
      <Text testID="ocr-outcomes">{outcomesJson()}</Text>
    </View>
  );
}

mount(RecognizeHarnessApp);
