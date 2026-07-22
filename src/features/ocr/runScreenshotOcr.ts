// ABOUTME: Screenshot → OCR orchestration helpers for Quick Translate and related UI.
// ABOUTME: Listens for region capture events, then runs frontend OCR recognition flow.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { REGION_SCREENSHOT_CANCELLED, REGION_SCREENSHOT_CAPTURED } from "../../query/events";
import { getAppSettings, startRegionScreenshot } from "../../storage/client";
import type { OcrRecognizeResult, RegionScreenshotResult } from "../../storage/types";
import { recognizeOcrFlow } from "./recognizeOcrFlow";

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

/** Resolve the OCR service id, falling back to the app default when omitted. */
async function resolveOcrServiceId(ocrServiceId?: string | null): Promise<string | null> {
  if (ocrServiceId) {
    return ocrServiceId;
  }
  const settings = await getAppSettings();
  return settings.defaultOcrServiceId;
}

/**
 * Recognize text from an already-captured PNG (global screenshot-OCR shortcut handoff).
 * Does not start a new capture session.
 */
export async function recognizeCapturedScreenshot(
  pngBase64: string,
  ocrServiceId?: string | null,
): Promise<ScreenshotOcrOutcome> {
  const resolvedServiceId = await resolveOcrServiceId(ocrServiceId);
  if (!resolvedServiceId) {
    return { status: "no_default" };
  }
  if (!pngBase64.trim()) {
    return { status: "empty" };
  }

  const result = await recognizeOcrFlow({
    pngBase64,
    ocrServiceId: resolvedServiceId,
  });
  if (!result.text.trim()) {
    return { status: "empty" };
  }
  return { status: "recognized", result };
}

/**
 * Full screenshot OCR flow using the app default OCR service when no id is provided.
 * Returns cancelled/empty outcomes without throwing so the caller can stay quiet on cancel.
 */
export async function runScreenshotOcr(ocrServiceId?: string | null): Promise<ScreenshotOcrOutcome> {
  const resolvedServiceId = await resolveOcrServiceId(ocrServiceId);
  if (!resolvedServiceId) {
    return { status: "no_default" };
  }

  const capture = await captureRegionScreenshot();
  if (!capture) {
    return { status: "cancelled" };
  }

  return recognizeCapturedScreenshot(capture.pngBase64, resolvedServiceId);
}
