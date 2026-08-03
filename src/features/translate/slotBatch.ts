// ABOUTME: Multi-slot stream batch start and generic HTTP cancellation helpers.
// ABOUTME: Per-slot isolation: one slot failure does not reject the whole batch.
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import type { IpcError } from "../../storage/ipcError";
import type { TranslateInput } from "../../storage/types";
import type { TranslationContextSnapshots } from "./translationContext";
import { runTranslationStream, type TranslationStreamHandlers } from "./translationWorkflow";

export type SlotStreamJob = {
  slotId: string;
  requestId: string;
  input: TranslateInput;
  snapshots: TranslationContextSnapshots;
  handlers: TranslationStreamHandlers;
  signal?: AbortSignal;
};

export type SlotStreamStartOutcome =
  | { slotId: string; requestId: string; ok: true }
  | { slotId: string; requestId: string; ok: false; error: IpcError };

/**
 * Start every slot stream concurrently. Individual failures become outcomes.
 */
export function startSlotStreamBatch(jobs: readonly SlotStreamJob[]): Effect.Effect<SlotStreamStartOutcome[], never> {
  return Effect.forEach(
    jobs,
    (job) =>
      Effect.tryPromise({
        try: () => runTranslationStream(job.input, job.snapshots, job.requestId, job.handlers, job.signal),
        catch: (error) => error as IpcError,
      }).pipe(
        Effect.map(
          (): SlotStreamStartOutcome => ({
            slotId: job.slotId,
            requestId: job.requestId,
            ok: true as const,
          }),
        ),
        Effect.catchAll(
          (error): Effect.Effect<SlotStreamStartOutcome, never> =>
            Effect.succeed({
              slotId: job.slotId,
              requestId: job.requestId,
              ok: false as const,
              error,
            }),
        ),
      ),
    { concurrency: "unbounded" },
  );
}

/**
 * Cancel every listed request id through both the legacy HTTP and provider-runtime cancel
 * commands (best-effort; whichever transport owns the request id wins). Swallows per-id failures.
 */
export function cancelRequestIds(requestIds: readonly string[]): Effect.Effect<void, never> {
  return Effect.forEach(
    requestIds,
    (requestId) =>
      Effect.forEach(
        [
          invokeEffect<boolean>("cancel_provider_http", { requestId }),
          invokeEffect<boolean>("cancel_provider_runtime", { requestId }),
        ],
        (effect) =>
          effect.pipe(
            Effect.catchAll(() => Effect.void),
            Effect.asVoid,
          ),
        { concurrency: "unbounded" },
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid);
}
