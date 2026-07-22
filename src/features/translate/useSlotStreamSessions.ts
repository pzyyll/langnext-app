// ABOUTME: Multi-slot translate stream session: requestId map, epochs, workflow callbacks.
// ABOUTME: Page owns debounce/UI state; this hook owns request correlation and settle lifecycle.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { TranslateInput, TranslateResult } from "../../storage/types";
import { runCancelRequestIds } from "./runTranslate";
import type { SlotStreamJob } from "./slotBatch";
import type { TranslationContextSnapshots } from "./translationContext";
import type { TranslationStreamHandlers } from "./translationWorkflow";
import {
  bumpAllSlotEpochs,
  isSlotEpochCurrent as isEpochCurrentPure,
  nextSlotEpoch as nextEpochPure,
} from "./slotEpoch";

/** Request-id map key for the in-flight language-detect call. */
export const DETECT_REQUEST_KEY = "__detect__";

export type SlotStreamUiHandlers = {
  onChunk: (delta: string) => void;
  onReset: (modelId: string) => void;
  onDone: (done: TranslateResult) => void;
  onError: (err: TranslateResult) => void;
  onCancelled: () => void;
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
  getSlotEpoch: (slotId: string) => number | undefined;
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
  prepareSlotStream: (
    slotId: string,
    epoch: number,
    requestId: string,
    input: TranslateInput,
    snapshots: TranslationContextSnapshots,
    handlers: SlotStreamUiHandlers,
  ) => Promise<PreparedSlotStream | null>;
};

export function useSlotStreamSessions(): UseSlotStreamSessionsResult {
  const slotEpochRef = useRef<Map<string, number>>(new Map());
  const detectEpochRef = useRef(0);
  const requestIdsRef = useRef<Map<string, string>>(new Map());
  const streamSettleRef = useRef<Map<string, () => void>>(new Map());
  const activeHandlersRef = useRef<Map<string, SlotStreamUiHandlers>>(new Map());

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
    activeHandlersRef.current.delete(slotId);
  }, []);

  const abortRequest = useCallback(
    async (key: string) => {
      const requestId = requestIdsRef.current.get(key);
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
    async (
      slotId: string,
      epoch: number,
      requestId: string,
      input: TranslateInput,
      snapshots: TranslationContextSnapshots,
      handlers: SlotStreamUiHandlers,
    ): Promise<PreparedSlotStream | null> => {
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
      streamSettleRef.current.set(slotId, settle);
      requestIdsRef.current.set(slotId, requestId);
      activeHandlersRef.current.set(slotId, handlers);

      const isCurrentRequest = () =>
        isEpochCurrentPure(slotEpochRef.current, slotId, epoch) && requestIdsRef.current.get(slotId) === requestId;

      const workflowHandlers: TranslationStreamHandlers = {
        onChunk: (delta) => {
          if (!isCurrentRequest()) return;
          activeHandlersRef.current.get(slotId)?.onChunk(delta);
        },
        onReset: (modelId) => {
          if (!isCurrentRequest()) return;
          activeHandlersRef.current.get(slotId)?.onReset(modelId);
        },
        onDone: (done) => {
          if (!isCurrentRequest()) {
            settle();
            return;
          }
          if (done.errorCode === "cancelled") {
            activeHandlersRef.current.get(slotId)?.onCancelled();
          } else {
            activeHandlersRef.current.get(slotId)?.onDone(done);
          }
          settle();
        },
        onError: (err) => {
          if (!isCurrentRequest()) {
            settle();
            return;
          }
          if (err.errorCode === "cancelled") {
            activeHandlersRef.current.get(slotId)?.onCancelled();
          } else {
            activeHandlersRef.current.get(slotId)?.onError(err);
          }
          settle();
        },
      };

      const job: SlotStreamJob = {
        slotId,
        requestId,
        input,
        snapshots,
        handlers: workflowHandlers,
      };

      return {
        job,
        waitUntilSettled,
        settle,
        isCurrentRequest,
      };
    },
    [clearSlotStreamListeners],
  );

  useEffect(() => {
    const settleMap = streamSettleRef.current;
    const requestIds = requestIdsRef.current;
    const handlers = activeHandlersRef.current;
    const epochs = slotEpochRef.current;
    return () => {
      // Drop all tracked sessions on unmount without awaiting cancel.
      for (const settle of settleMap.values()) {
        settle();
      }
      requestIds.clear();
      handlers.clear();
      bumpAllSlotEpochs(epochs);
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
