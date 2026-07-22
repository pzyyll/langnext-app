// ABOUTME: Promise runners for translate feature workflows consumed by routes.
// ABOUTME: Keeps JSX modules off deep Effect pipelines while preserving IpcError rejects.
import { runEffectAsPromise, runStorage } from "../../storage/runStorage";
import type { DetectLanguageInput, DetectLanguageResult, TranslateInput } from "../../storage/types";
import { detectLanguageFlow, type DetectLanguageContext } from "./detectLanguageFlow";
import { cancelRequestIds, startSlotStreamBatch, type SlotStreamJob, type SlotStreamStartOutcome } from "./slotBatch";
import { startTranslateStream, type StartTranslateStreamOptions } from "./translateStream";

/**
 * Start a streaming translation. Rejects with raw `IpcError` on start failure.
 * Callers must assign active request ids and handlers before this Promise is awaited.
 */
export function runStartTranslateStream(
  input: TranslateInput,
  requestId: string,
  options: StartTranslateStreamOptions,
): Promise<void> {
  return runStorage(startTranslateStream(input, requestId, options));
}

/**
 * Detect language. Soft `ok: false` results resolve; unexpected failures reject as `IpcError`.
 */
export function runDetectLanguage(
  input: DetectLanguageInput,
  requestId: string | undefined,
  context: DetectLanguageContext,
): Promise<DetectLanguageResult> {
  return runStorage(detectLanguageFlow(input, requestId, context));
}

/**
 * Start multi-slot stream invokes with per-slot failure isolation.
 */
export function runStartSlotStreamBatch(jobs: readonly SlotStreamJob[]): Promise<SlotStreamStartOutcome[]> {
  return runEffectAsPromise(startSlotStreamBatch(jobs));
}

/**
 * Cancel every listed request id through generic provider HTTP cancellation.
 */
export function runCancelRequestIds(requestIds: readonly string[]): Promise<void> {
  return runEffectAsPromise(cancelRequestIds(requestIds));
}
