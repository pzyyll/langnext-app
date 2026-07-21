// ABOUTME: Low-level attach/detach for the four translate stream Tauri events.
// ABOUTME: Shared by single-stream and multi-slot session helpers; no Effect.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  TRANSLATE_CHUNK_EVENT,
  TRANSLATE_DONE_EVENT,
  TRANSLATE_ERROR_EVENT,
  TRANSLATE_RESET_EVENT,
} from "../../storage/client";
import type {
  TranslateStreamChunk,
  TranslateStreamDone,
  TranslateStreamError,
  TranslateStreamReset,
} from "../../storage/types";

export type TranslateStreamHandlers = {
  onChunk: (chunk: TranslateStreamChunk) => void;
  onReset: (reset: TranslateStreamReset) => void;
  onDone: (done: TranslateStreamDone) => void;
  onError: (err: TranslateStreamError) => void;
};

/**
 * Register chunk/reset/done/error listeners. Caller owns unlisten lifecycle.
 * Does not filter by requestId — handlers must ignore stale events.
 */
export async function attachTranslateStreamListeners(
  handlers: TranslateStreamHandlers,
): Promise<UnlistenFn[]> {
  const [unChunk, unReset, unDone, unError] = await Promise.all([
    listen<TranslateStreamChunk>(TRANSLATE_CHUNK_EVENT, (event) => {
      handlers.onChunk(event.payload);
    }),
    listen<TranslateStreamReset>(TRANSLATE_RESET_EVENT, (event) => {
      handlers.onReset(event.payload);
    }),
    listen<TranslateStreamDone>(TRANSLATE_DONE_EVENT, (event) => {
      handlers.onDone(event.payload);
    }),
    listen<TranslateStreamError>(TRANSLATE_ERROR_EVENT, (event) => {
      handlers.onError(event.payload);
    }),
  ]);
  return [unChunk, unReset, unDone, unError];
}

/** Call every unlisten and return an empty list for assignment. */
export function detachTranslateStreamListeners(unlisteners: readonly UnlistenFn[]): void {
  for (const unlisten of unlisteners) {
    unlisten();
  }
}
