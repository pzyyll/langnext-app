// ABOUTME: Screenshot → OCR orchestration helpers for Quick Translate and related UI.
// ABOUTME: Listens for region capture events, then calls the backend recognize_ocr command.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { REGION_SCREENSHOT_CANCELLED, REGION_SCREENSHOT_CAPTURED } from "../../query/events";
import { getAppSettings, recognizeOcr, startRegionScreenshot } from "../../storage/client";
import type { OcrRecognizeResult, RegionScreenshotResult } from "../../storage/types";

export type ScreenshotOcrOutcome =
  | { status: "recognized"; result: OcrRecognizeResult }
  | { status: "cancelled" }
  | { status: "empty" }
  | { status: "no_default" };

/**
 * Open the region-screenshot overlay and wait for capture or cancel.
 * Registers listeners before starting so the captured event cannot be missed.
 */
export async function captureRegionScreenshot(): Promise<RegionScreenshotResult | null> {
  let unlistenCaptured: UnlistenFn | undefined;
  let unlistenCancelled: UnlistenFn | undefined;

  const cleanup = () => {
    unlistenCaptured?.();
    unlistenCancelled?.();
    unlistenCaptured = undefined;
    unlistenCancelled = undefined;
  };

  try {
    const result = await new Promise<RegionScreenshotResult | null>((resolve, reject) => {
      void (async () => {
        try {
          unlistenCaptured = await listen<RegionScreenshotResult>(REGION_SCREENSHOT_CAPTURED, (event) => {
            cleanup();
            resolve(event.payload);
          });
          unlistenCancelled = await listen(REGION_SCREENSHOT_CANCELLED, () => {
            cleanup();
            resolve(null);
          });
          await startRegionScreenshot();
        } catch (error) {
          cleanup();
          reject(error);
        }
      })();
    });
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Full screenshot OCR flow using the app default OCR service when no id is provided.
 * Returns cancelled/empty outcomes without throwing so the caller can stay quiet on cancel.
 */
export async function runScreenshotOcr(ocrServiceId?: string | null): Promise<ScreenshotOcrOutcome> {
  let resolvedServiceId = ocrServiceId ?? null;
  if (!resolvedServiceId) {
    const settings = await getAppSettings();
    resolvedServiceId = settings.defaultOcrServiceId;
  }
  if (!resolvedServiceId) {
    return { status: "no_default" };
  }

  const capture = await captureRegionScreenshot();
  if (!capture) {
    return { status: "cancelled" };
  }
  if (!capture.pngBase64.trim()) {
    return { status: "empty" };
  }

  const result = await recognizeOcr({
    pngBase64: capture.pngBase64,
    ocrServiceId: resolvedServiceId,
  });
  if (!result.text.trim()) {
    return { status: "empty" };
  }
  return { status: "recognized", result };
}
