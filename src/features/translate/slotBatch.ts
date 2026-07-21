// ABOUTME: Multi-slot stream start/cancel orchestration with per-slot isolation.
// ABOUTME: Tracks explicit requestIds; does not own stream event listeners or UI state.
import { Effect } from "effect";
import type { IpcError } from "../../storage/ipcError";
import type { TranslateInput } from "../../storage/types";
import { invokeEffect } from "../../storage/invokeEffect";
import { startTranslateStream } from "./translateStream";

/** One prepared stream job: route owns payload construction and listener wiring. */
export interface SlotStreamJob {
  readonly slotId: string;
  readonly requestId: string;
  readonly input: TranslateInput;
}

/** Outcome of attempting to start one slot's stream invoke (not terminal translation). */
export type SlotStreamStartOutcome =
  | { readonly slotId: string; readonly requestId: string; readonly status: "started" }
  | {
      readonly slotId: string;
      readonly requestId: string;
      readonly status: "failed";
      readonly error: IpcError;
    };

/**
 * Start stream invokes for every job. Failures are isolated per slot — one
 * `validation_failed` (or any IpcError) does not cancel sibling starts.
 *
 * Does not wait for translation completion; that still arrives via stream events.
 * Routes must still register listeners before calling this for each job's requestId.
 */
export function startSlotStreamBatch(jobs: readonly SlotStreamJob[]): Effect.Effect<SlotStreamStartOutcome[], never> {
  return Effect.forEach(
    jobs,
    (job) =>
      startTranslateStream(job.input, job.requestId).pipe(
        Effect.map((): SlotStreamStartOutcome => ({
          slotId: job.slotId,
          requestId: job.requestId,
          status: "started",
        })),
        Effect.catchAll((error): Effect.Effect<SlotStreamStartOutcome, never> =>
          Effect.succeed({
            slotId: job.slotId,
            requestId: job.requestId,
            status: "failed",
            error,
          }),
        ),
      ),
    { concurrency: "unbounded" },
  );
}

/**
 * Cancel every active request id. Individual cancel IPC failures are ignored
 * (request may already have finished). Never fails the Effect.
 */
export function cancelRequestIds(requestIds: readonly string[]): Effect.Effect<void, never> {
  if (requestIds.length === 0) {
    return Effect.void;
  }

  return Effect.forEach(
    requestIds,
    (requestId) =>
      invokeEffect<boolean>("cancel_translate", { requestId }).pipe(
        Effect.asVoid,
        Effect.catchAll(() => Effect.void),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid);
}
