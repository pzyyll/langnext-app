// ABOUTME: Effect-based Tauri invoke adapter with typed IpcError failures.
// ABOUTME: Never logs command args — they may contain credentials.
import { invoke } from "@tauri-apps/api/core";
import { Effect } from "effect";
import { decodeIpcRejection, type IpcError } from "./ipcError";

/**
 * Invoke a Tauri command as an Effect that fails with a decoded `IpcError`.
 * Do not log `args` — they may hold credentials or secrets.
 */
export function invokeEffect<A>(cmd: string, args?: Record<string, unknown>): Effect.Effect<A, IpcError> {
  return Effect.tryPromise({
    try: () => invoke<A>(cmd, args),
    catch: (error) => decodeIpcRejection(error),
  });
}
