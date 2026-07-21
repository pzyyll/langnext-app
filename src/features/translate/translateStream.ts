// ABOUTME: Effect use-case for starting a streaming translate IPC request.
// ABOUTME: Callers must register stream listeners before invoking startTranslateStream.
import { Effect } from "effect";
import { invokeEffect } from "../../storage/invokeEffect";
import type { IpcError } from "../../storage/ipcError";
import type { TranslateInput } from "../../storage/types";

/**
 * Start `translate_text_stream` for a client-owned `requestId`.
 *
 * **Listener-before-invoke:** routes must attach `translate://chunk|reset|done|error`
 * listeners (and record the active request id) before running this Effect so early
 * validation failures and first chunks cannot race past subscription setup.
 *
 * The invoke resolves after the backend spawns the stream worker; terminal UI still
 * comes from stream events (or from an `IpcError` if the start invoke itself fails).
 */
export function startTranslateStream(input: TranslateInput, requestId: string): Effect.Effect<void, IpcError> {
  return invokeEffect<void>("translate_text_stream", { input, requestId });
}
