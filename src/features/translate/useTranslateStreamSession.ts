// ABOUTME: Single active translate stream session: requestId + listener lifecycle.
// ABOUTME: Routes own UI/generation guards; this hook only filters by active requestId.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  attachTranslateStreamListeners,
  detachTranslateStreamListeners,
  type TranslateStreamHandlers,
} from "./attachTranslateStreamListeners";
import { runCancelRequestIds } from "./runTranslate";

export type UseTranslateStreamSessionResult = {
  /** True when a request id is currently tracked (detect or stream). */
  hasActiveRequest: () => boolean;
  /** Current active request id, or null. */
  getActiveRequestId: () => string | null;
  /** Track a request id before detect/stream (e.g. cancel correlation). */
  setActiveRequestId: (requestId: string | null) => void;
  /** Clear active id only when it still matches `requestId`. */
  releaseIfActive: (requestId: string) => void;
  /** Detach listeners without cancelling IPC. */
  clearListeners: () => void;
  /**
   * Cancel the active request (if any), clear id, and detach listeners.
   * Cancel failures are swallowed by `runCancelRequestIds`.
   */
  abortActive: () => Promise<void>;
  /**
   * Attach stream listeners filtered by the active request id, then return.
   * Caller must invoke `runStartTranslateStream` after this resolves successfully.
   * Returns false when `shouldContinue` is false after listen (listeners cleaned up).
   */
  prepareSession: (
    requestId: string,
    handlers: TranslateStreamHandlers,
    shouldContinue: () => boolean,
  ) => Promise<boolean>;
  /**
   * Terminal stream event: detach listeners and release active id when it matches.
   */
  markTerminal: (requestId: string) => void;
};

/**
 * Owns one active stream requestId and its unlisten bundle for the main translate page.
 * Generation / workspace guards stay in the route via handler closures + shouldContinue.
 */
export function useTranslateStreamSession(): UseTranslateStreamSessionResult {
  const activeRequestId = useRef<string | null>(null);
  const streamUnlisteners = useRef<UnlistenFn[]>([]);

  const clearListeners = useCallback(() => {
    detachTranslateStreamListeners(streamUnlisteners.current);
    streamUnlisteners.current = [];
  }, []);

  const hasActiveRequest = useCallback(() => activeRequestId.current != null, []);

  const getActiveRequestId = useCallback(() => activeRequestId.current, []);

  const setActiveRequestId = useCallback((requestId: string | null) => {
    activeRequestId.current = requestId;
  }, []);

  const releaseIfActive = useCallback((requestId: string) => {
    if (activeRequestId.current === requestId) {
      activeRequestId.current = null;
    }
  }, []);

  const markTerminal = useCallback(
    (requestId: string) => {
      clearListeners();
      if (activeRequestId.current === requestId) {
        activeRequestId.current = null;
      }
    },
    [clearListeners],
  );

  const abortActive = useCallback(async () => {
    const requestId = activeRequestId.current;
    activeRequestId.current = null;
    clearListeners();
    if (!requestId) {
      return;
    }
    await runCancelRequestIds([requestId]);
  }, [clearListeners]);

  const prepareSession = useCallback(
    async (
      requestId: string,
      handlers: TranslateStreamHandlers,
      shouldContinue: () => boolean,
    ): Promise<boolean> => {
      clearListeners();
      activeRequestId.current = requestId;

      const filtered: TranslateStreamHandlers = {
        onChunk: (chunk) => {
          if (chunk.id !== activeRequestId.current) {
            return;
          }
          handlers.onChunk(chunk);
        },
        onReset: (reset) => {
          if (reset.id !== activeRequestId.current) {
            return;
          }
          handlers.onReset(reset);
        },
        onDone: (done) => {
          if (done.id !== activeRequestId.current) {
            return;
          }
          handlers.onDone(done);
        },
        onError: (err) => {
          if (err.id !== activeRequestId.current) {
            return;
          }
          handlers.onError(err);
        },
      };

      const unlisteners = await attachTranslateStreamListeners(filtered);
      if (!shouldContinue()) {
        detachTranslateStreamListeners(unlisteners);
        // Drop stale active id so a later run does not false-positive "hadActive".
        if (activeRequestId.current === requestId) {
          activeRequestId.current = null;
        }
        return false;
      }
      streamUnlisteners.current = unlisteners;
      return true;
    },
    [clearListeners],
  );

  useEffect(() => {
    return () => {
      // Match prior page behavior: cancel in-flight on unmount.
      const requestId = activeRequestId.current;
      activeRequestId.current = null;
      detachTranslateStreamListeners(streamUnlisteners.current);
      streamUnlisteners.current = [];
      if (requestId) {
        void runCancelRequestIds([requestId]);
      }
    };
  }, []);

  return useMemo(
    () => ({
      hasActiveRequest,
      getActiveRequestId,
      setActiveRequestId,
      releaseIfActive,
      clearListeners,
      abortActive,
      prepareSession,
      markTerminal,
    }),
    [
      hasActiveRequest,
      getActiveRequestId,
      setActiveRequestId,
      releaseIfActive,
      clearListeners,
      abortActive,
      prepareSession,
      markTerminal,
    ],
  );
}
