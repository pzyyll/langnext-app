// ABOUTME: Promise bridge from storage Effects for Query and existing callers.
// ABOUTME: Rejects with the raw tagged failure (not FiberFailure) so UI helpers work.
import { Effect, Either, Exit } from "effect";
import type { IpcError } from "./ipcError";

/**
 * Run any Effect as a Promise.
 * On failure, rejects with the raw error-channel value (not an Effect FiberFailure wrapper).
 */
export async function runEffectAsPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
}

/**
 * Run an IPC-only storage Effect as a Promise.
 * Thin wrapper over {@link runEffectAsPromise} that preserves IpcError typing at call sites.
 */
export function runStorage<A>(effect: Effect.Effect<A, IpcError>): Promise<A> {
  return runEffectAsPromise(effect);
}

/**
 * Run a storage Effect and resolve to an Exit for Cause inspection / tests.
 * Production call sites prefer {@link runStorage} / {@link runEffectAsPromise}.
 */
export function runStorageExit<A>(effect: Effect.Effect<A, IpcError>): Promise<Exit.Exit<A, IpcError>> {
  return Effect.runPromiseExit(effect);
}
