// ABOUTME: Promise runners for translate feature Effects consumed by routes.
// ABOUTME: Keeps JSX modules off deep Effect pipelines while preserving IpcError rejects.
import { runEffectAsPromise, runStorage } from "../../storage/runStorage";
import type { DetectLanguageInput, DetectLanguageResult, TranslateInput } from "../../storage/types";
import { detectLanguageFlow } from "./detectLanguageFlow";
import { cancelRequestIds, startSlotStreamBatch, type SlotStreamJob, type SlotStreamStartOutcome } from "./slotBatch";
import { startTranslateStream } from "./translateStream";

/**
 * Start a streaming translation. Rejects with raw `IpcError` on invoke failure.
 * Callers must register stream listeners before this Promise is awaited.
 */
export function runStartTranslateStream(input: TranslateInput, requestId: string): Promise<void> {
  return runStorage(startTranslateStream(input, requestId));
}

/**
 * Detect language. Soft `ok: false` results resolve; IPC failures reject as `IpcError`.
 */
export function runDetectLanguage(input: DetectLanguageInput, requestId?: string): Promise<DetectLanguageResult> {
  return runStorage(detectLanguageFlow(input, requestId));
}

/**
 * Start multi-slot stream invokes with per-slot failure isolation.
 * Resolves to one outcome per job (never rejects for a single slot's IpcError).
 */
export function runStartSlotStreamBatch(jobs: readonly SlotStreamJob[]): Promise<SlotStreamStartOutcome[]> {
  return runEffectAsPromise(startSlotStreamBatch(jobs));
}

/**
 * Cancel every listed request id. Swallows individual cancel failures.
 * Does not reject — matches route abort helpers that ignore finished requests.
 */
export function runCancelRequestIds(requestIds: readonly string[]): Promise<void> {
  return runEffectAsPromise(cancelRequestIds(requestIds));
}
