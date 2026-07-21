// ABOUTME: Promise bridge from storage Effects for Query and existing callers.
// ABOUTME: Rejects with the raw IpcError (not FiberFailure) so UI helpers work.
import { Effect, Either, Exit } from "effect";
import type { IpcError } from "./ipcError";

/**
 * Run a storage Effect as a Promise.
 * On failure, rejects with the typed `IpcError` value (not an Effect FiberFailure wrapper).
 */
export async function runStorage<A>(effect: Effect.Effect<A, IpcError>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
}

/** Run a storage Effect and resolve to an Exit for callers that need Cause detail. */
export function runStorageExit<A>(effect: Effect.Effect<A, IpcError>): Promise<Exit.Exit<A, IpcError>> {
  return Effect.runPromiseExit(effect);
}
