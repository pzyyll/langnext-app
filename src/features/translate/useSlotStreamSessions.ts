// ABOUTME: Multi-slot translate stream session: requestId map, epochs, listen-before-start.
// ABOUTME: Page owns debounce/UI state; this hook owns request correlation and unlisten lifecycle.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { TranslateInput, TranslateStreamChunk, TranslateStreamDone, TranslateStreamError, TranslateStreamReset } from "../../storage/types";
import {
  attachTranslateStreamListeners,
  detachTranslateStreamListeners,
} from "./attachTranslateStreamListeners";
import { runCancelRequestIds } from "./runTranslate";
import type { SlotStreamJob } from "./slotBatch";
import { bumpAllSlotEpochs, isSlotEpochCurrent as isEpochCurrentPure, nextSlotEpoch as nextEpochPure } from "./slotEpoch";

/** Request-id map key for the in-flight language-detect call. */
export const DETECT_REQUEST_KEY = "__detect__";

export type SlotStreamUiHandlers = {
  onChunk: (chunk: TranslateStreamChunk) => void;
  onReset: (reset: TranslateStreamReset) => void;
  /** Terminal success/failure (not cancelled). Hook settles after this returns. */
  onDone: (done: TranslateStreamDone) => void;
  onError: (err: TranslateStreamError) => void;
  /** Matching request cancelled while still current. Hook settles after. */
  onCancelled: () => void;
  /** listen() failed while the request was still current. Hook settles after. */
  onListenFailure: (err: unknown) => void;
};

export type PreparedSlotStream = {
  job: SlotStreamJob;
  waitUntilSettled: Promise<void>;
  settle: () => void;
  isCurrentRequest: () => boolean;
};

export type UseSlotStreamSessionsResult = {
  nextSlotEpoch: (slotId: string) => number;
  isSlotEpochCurrent: (slotId: string, epoch: number) => boolean;
  /** Read current epoch for a slot (undefined if never bumped). */
  getSlotEpoch: (slotId: string) => number | undefined;
  /** Drop epoch tracking for a removed card. */
  deleteSlotEpoch: (slotId: string) => void;
  bumpDetectEpoch: () => number;
  getDetectEpoch: () => number;
  setRequestId: (key: string, requestId: string) => void;
  getRequestId: (key: string) => string | undefined;
  deleteRequestId: (key: string) => void;
  clearSlotStreamListeners: (slotId: string) => void;
  abortRequest: (key: string) => Promise<void>;
  abortSlots: (slotIds: string[]) => Promise<void>;
  abortAll: () => Promise<void>;
  /**
   * Register stream listeners for one card and return a start job.
   * Does not invoke translate — callers batch-start after every listener is live.
   */
  prepareSlotStream: (
    slotId: string,
    epoch: number,
    requestId: string,
    input: TranslateInput,
    handlers: SlotStreamUiHandlers,
  ) => Promise<PreparedSlotStream | null>;
};

/**
 * Owns multi-slot requestId/epoch/listener maps for quick-translate.
 * Epoch bumps are driven by the page via `nextSlotEpoch` / `bumpDetectEpoch`.
 */
export function useSlotStreamSessions(): UseSlotStreamSessionsResult {
  const slotEpochRef = useRef<Map<string, number>>(new Map());
  const detectEpochRef = useRef(0);
  const requestIdsRef = useRef<Map<string, string>>(new Map());
  const streamUnlistenersRef = useRef<Map<string, UnlistenFn[]>>(new Map());
  const streamSettleRef = useRef<Map<string, () => void>>(new Map());

  const nextSlotEpoch = useCallback((slotId: string): number => {
    return nextEpochPure(slotEpochRef.current, slotId);
  }, []);

  const isSlotEpochCurrent = useCallback((slotId: string, epoch: number): boolean => {
    return isEpochCurrentPure(slotEpochRef.current, slotId, epoch);
  }, []);

  const getSlotEpoch = useCallback((slotId: string): number | undefined => {
    return slotEpochRef.current.get(slotId);
  }, []);

  const deleteSlotEpoch = useCallback((slotId: string) => {
    slotEpochRef.current.delete(slotId);
  }, []);

  const bumpDetectEpoch = useCallback((): number => {
    detectEpochRef.current += 1;
    return detectEpochRef.current;
  }, []);

  const getDetectEpoch = useCallback((): number => detectEpochRef.current, []);

  const setRequestId = useCallback((key: string, requestId: string) => {
    requestIdsRef.current.set(key, requestId);
  }, []);

  const getRequestId = useCallback((key: string) => requestIdsRef.current.get(key), []);

  const deleteRequestId = useCallback((key: string) => {
    requestIdsRef.current.delete(key);
  }, []);

  const clearSlotStreamListeners = useCallback((slotId: string) => {
    const unlisteners = streamUnlistenersRef.current.get(slotId);
    if (!unlisteners) {
      return;
    }
    detachTranslateStreamListeners(unlisteners);
    streamUnlistenersRef.current.delete(slotId);
  }, []);

  const abortRequest = useCallback(
    async (key: string) => {
      // Capture before settle/listeners clear removes the map entry.
      const requestId = requestIdsRef.current.get(key);
      // Resolve any in-flight stream Promise and drop its listeners.
      const settleStream = streamSettleRef.current.get(key);
      if (settleStream) {
        settleStream();
      } else {
        clearSlotStreamListeners(key);
        requestIdsRef.current.delete(key);
      }
      if (!requestId) {
        return;
      }
      await runCancelRequestIds([requestId]);
    },
    [clearSlotStreamListeners],
  );

  const abortSlots = useCallback(
    async (slotIds: string[]) => {
      await Promise.all(slotIds.map((slotId) => abortRequest(slotId)));
    },
    [abortRequest],
  );

  const abortAll = useCallback(async () => {
    const keys = [...requestIdsRef.current.keys()];
    await Promise.all(keys.map((key) => abortRequest(key)));
  }, [abortRequest]);

  const prepareSlotStream = useCallback(
    (
      slotId: string,
      epoch: number,
      requestId: string,
      input: TranslateInput,
      handlers: SlotStreamUiHandlers,
    ): Promise<PreparedSlotStream | null> => {
      return new Promise((resolvePrepare) => {
        let settled = false;
        let settle!: () => void;
        const waitUntilSettled = new Promise<void>((resolve) => {
          settle = () => {
            if (settled) {
              return;
            }
            settled = true;
            streamSettleRef.current.delete(slotId);
            clearSlotStreamListeners(slotId);
            if (requestIdsRef.current.get(slotId) === requestId) {
              requestIdsRef.current.delete(slotId);
            }
            resolve();
          };
        });
        // So abortRequest can unblock waiters when cancel supersedes this stream.
        streamSettleRef.current.set(slotId, settle);

        const isCurrentRequest = () =>
          isEpochCurrentPure(slotEpochRef.current, slotId, epoch) &&
          requestIdsRef.current.get(slotId) === requestId;

        const onChunk = (chunk: TranslateStreamChunk) => {
          if (chunk.id !== requestId || !isCurrentRequest()) {
            return;
          }
          handlers.onChunk(chunk);
        };

        const onReset = (reset: TranslateStreamReset) => {
          if (reset.id !== requestId || !isCurrentRequest()) {
            return;
          }
          handlers.onReset(reset);
        };

        const onDone = (done: TranslateStreamDone) => {
          if (done.id !== requestId) {
            return;
          }
          if (!isEpochCurrentPure(slotEpochRef.current, slotId, epoch) || requestIdsRef.current.get(slotId) !== requestId) {
            settle();
            return;
          }
          if (done.errorCode === "cancelled") {
            handlers.onCancelled();
            settle();
            return;
          }
          handlers.onDone(done);
          settle();
        };

        const onError = (err: TranslateStreamError) => {
          if (err.id !== requestId) {
            return;
          }
          if (!isEpochCurrentPure(slotEpochRef.current, slotId, epoch) || requestIdsRef.current.get(slotId) !== requestId) {
            settle();
            return;
          }
          if (err.errorCode === "cancelled") {
            handlers.onCancelled();
            settle();
            return;
          }
          handlers.onError(err);
          settle();
        };

        void (async () => {
          try {
            const unlisteners = await attachTranslateStreamListeners({
              onChunk,
              onReset,
              onDone,
              onError,
            });
            if (!isCurrentRequest()) {
              detachTranslateStreamListeners(unlisteners);
              settle();
              resolvePrepare(null);
              return;
            }
            streamUnlistenersRef.current.set(slotId, unlisteners);
            // Listeners live — hand job back so the batch starter can invoke next.
            resolvePrepare({
              job: { slotId, requestId, input },
              waitUntilSettled,
              settle,
              isCurrentRequest,
            });
          } catch (err) {
            // listen() failure: clear translating and surface error (same as pre-extract path).
            if (isCurrentRequest()) {
              handlers.onListenFailure(err);
            }
            settle();
            resolvePrepare(null);
          }
        })();
      });
    },
    [clearSlotStreamListeners],
  );

  useEffect(() => {
    // Capture map identities once — maps are mutated in place for the page lifetime.
    const slotEpochs = slotEpochRef.current;
    const requestIds = requestIdsRef.current;
    const streamSettle = streamSettleRef.current;
    const streamUnlisteners = streamUnlistenersRef.current;
    return () => {
      detectEpochRef.current += 1;
      bumpAllSlotEpochs(slotEpochs);
      const keys = [...requestIds.keys()];
      for (const key of keys) {
        const requestId = requestIds.get(key);
        const settleStream = streamSettle.get(key);
        if (settleStream) {
          settleStream();
        } else {
          const unlisteners = streamUnlisteners.get(key);
          if (unlisteners) {
            detachTranslateStreamListeners(unlisteners);
            streamUnlisteners.delete(key);
          }
          requestIds.delete(key);
        }
        if (requestId) {
          void runCancelRequestIds([requestId]);
        }
      }
    };
  }, []);

  return useMemo(
    () => ({
      nextSlotEpoch,
      isSlotEpochCurrent,
      getSlotEpoch,
      deleteSlotEpoch,
      bumpDetectEpoch,
      getDetectEpoch,
      setRequestId,
      getRequestId,
      deleteRequestId,
      clearSlotStreamListeners,
      abortRequest,
      abortSlots,
      abortAll,
      prepareSlotStream,
    }),
    [
      nextSlotEpoch,
      isSlotEpochCurrent,
      getSlotEpoch,
      deleteSlotEpoch,
      bumpDetectEpoch,
      getDetectEpoch,
      setRequestId,
      getRequestId,
      deleteRequestId,
      clearSlotStreamListeners,
      abortRequest,
      abortSlots,
      abortAll,
      prepareSlotStream,
    ],
  );
}
