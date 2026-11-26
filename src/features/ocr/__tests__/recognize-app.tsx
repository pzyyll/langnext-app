// ABOUTME: Test app for screenshot recognition over the OCR channel collection.
import { host, mount, signal, Text, View } from "nsh";
import { initializeAiModules } from "../../../app/ai-setup";
import { loadModelsState } from "../../models/store";
import { loadLanguage } from "../../settings/language";
import {
  checkOcrReadiness,
  enabledOcrEntries,
  recognizeScreenshot,
  type OcrRecognitionOutcome,
  type RecognizeScreenshotOptions,
} from "../recognize";
import { ocrChannels } from "../store";

initializeAiModules();

interface HarnessParams {
  /** PNG bytes as Base64: what the OS capture boundary would return. */
  pngBase64?: string;
  /** Model IDs to recognize with individually; when absent, uses the enabled channels. */
  modelIds?: string[];
  /** Report readiness and skip recognition. */
  readinessOnly?: boolean;
  /** Disable Baidu right after checking readiness to verify mid-capture toggle safety. */
  disableBaiduBeforeRecognize?: boolean;
  /** Disable Google Cloud Vision after readiness and before upload. */
  disableGoogleCloudBeforeRecognize?: boolean;
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
    const options: RecognizeScreenshotOptions = {
      signal: controller.signal,
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
    };
    const outcomes: Array<OcrRecognitionOutcome | null> = [];

    try {
      await loadLanguage();
      await loadModelsState();
      await ocrChannels.load();

      if (params.modelIds && params.modelIds.length > 0) {
        await ocrChannels.add("ai");
        for (const modelId of params.modelIds) {
          await ocrChannels.save("ai", { modelId }, { mode: "keep" });
          outcomes.push(await recognizeScreenshot(enabledOcrEntries(), bytes, options));
        }
        outcomesJson.set(JSON.stringify({ outcomes }));
        status.set("done");
        return;
      }

      const readiness = await checkOcrReadiness(enabledOcrEntries());
      if (!params.readinessOnly) {
        if (params.disableBaiduBeforeRecognize) {
          await ocrChannels.setEnabled("baidu", false);
        }
        if (params.disableGoogleCloudBeforeRecognize) {
          await ocrChannels.setEnabled("google-cloud", false);
        }
        outcomes.push(await recognizeScreenshot(enabledOcrEntries(), bytes, options));
      }
      outcomesJson.set(JSON.stringify({ readiness, outcomes }));
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
