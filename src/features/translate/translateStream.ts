// ABOUTME: Starts frontend-owned streaming translation via provider plugins.
// ABOUTME: Callers register workflow callbacks before invoking startTranslateStream.
import { Effect } from "effect";
import type { IpcError } from "../../storage/ipcError";
import type { TranslateInput, TranslateResult } from "../../storage/types";
import type { TranslationContextSnapshots } from "./translationContext";
import { runTranslationStream, type TranslationStreamHandlers } from "./translationWorkflow";

export type StartTranslateStreamOptions = {
  snapshots: TranslationContextSnapshots;
  handlers: TranslationStreamHandlers;
  signal?: AbortSignal;
};

/**
 * Start a frontend streaming translation for a client-owned `requestId`.
 *
 * **Listener-before-invoke:** routes must assign active request ids and handlers
 * before running this Effect so first deltas cannot race past subscription setup.
 */
export function startTranslateStream(
  input: TranslateInput,
  requestId: string,
  options: StartTranslateStreamOptions,
): Effect.Effect<void, IpcError> {
  return Effect.tryPromise({
    try: () => runTranslationStream(input, options.snapshots, requestId, options.handlers, options.signal),
    catch: (error) => error as IpcError,
  });
}

export type { TranslationStreamHandlers, TranslateResult };
