// ABOUTME: Single active translate stream session with workflow callback ownership.
// ABOUTME: Routes own UI/generation guards; this hook filters by active requestId.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TranslateResult } from "../../storage/types";
import { runCancelRequestIds } from "./runTranslate";
import type { TranslationStreamHandlers } from "./translationWorkflow";

export type StreamSessionHandlers = {
  onChunk: (delta: string) => void;
  onReset: (modelId: string) => void;
  onDone: (result: TranslateResult) => void;
  onError: (result: TranslateResult) => void;
};

export type UseTranslateStreamSessionResult = {
  hasActiveRequest: () => boolean;
  getActiveRequestId: () => string | null;
  setActiveRequestId: (requestId: string | null) => void;
  releaseIfActive: (requestId: string) => void;
  clearListeners: () => void;
  abortActive: () => Promise<void>;
  /**
   * Assign active request id and return filtered workflow handlers.
   * Call before `runStartTranslateStream`.
   */
  prepareSession: (
    requestId: string,
    handlers: StreamSessionHandlers,
    shouldContinue: () => boolean,
  ) => Promise<TranslationStreamHandlers | null>;
  markTerminal: (requestId: string) => void;
};

export function useTranslateStreamSession(): UseTranslateStreamSessionResult {
  const activeRequestId = useRef<string | null>(null);
  const activeHandlers = useRef<StreamSessionHandlers | null>(null);

  const clearListeners = useCallback(() => {
    activeHandlers.current = null;
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
    const id = activeRequestId.current;
    activeRequestId.current = null;
    clearListeners();
    if (id) {
      await runCancelRequestIds([id]);
    }
  }, [clearListeners]);

  const prepareSession = useCallback(
    async (
      requestId: string,
      handlers: StreamSessionHandlers,
      shouldContinue: () => boolean,
    ): Promise<TranslationStreamHandlers | null> => {
      activeRequestId.current = requestId;
      activeHandlers.current = handlers;
      if (!shouldContinue()) {
        markTerminal(requestId);
        return null;
      }
      const filtered: TranslationStreamHandlers = {
        onChunk: (delta) => {
          if (activeRequestId.current !== requestId) return;
          activeHandlers.current?.onChunk(delta);
        },
        onReset: (modelId) => {
          if (activeRequestId.current !== requestId) return;
          activeHandlers.current?.onReset(modelId);
        },
        onDone: (result) => {
          if (activeRequestId.current !== requestId) return;
          activeHandlers.current?.onDone(result);
        },
        onError: (result) => {
          if (activeRequestId.current !== requestId) return;
          activeHandlers.current?.onError(result);
        },
      };
      return filtered;
    },
    [markTerminal],
  );

  useEffect(() => {
    return () => {
      activeRequestId.current = null;
      activeHandlers.current = null;
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
