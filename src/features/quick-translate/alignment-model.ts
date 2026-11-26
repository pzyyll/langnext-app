import { SentenceAlignmentNative, type SemanticModelAsset } from "langnext-native";
import { platform, signal } from "nsh";
import { createHttpFetch, type FetchLike } from "../../services/http";
import { createLogger } from "../../services/log";

const CHUNK_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const log = createLogger("quick-translate/alignment-model");

export type AlignmentModelStatus = "checking" | "missing" | "downloading" | "ready" | "error";
export type AlignmentModelDownloadOutcome = "ready" | "cancelled" | "error";

export interface AlignmentModelNative {
  modelAssets: () => SemanticModelAsset[];
  modelReady: () => Promise<boolean>;
  appendModelChunk: (id: number, offset: number, chunk: Uint8Array) => Promise<void>;
  finishModelAsset: (id: number) => Promise<void>;
  cleanModelDownload: () => Promise<void>;
}

export interface CreateAlignmentModelOptions {
  native?: AlignmentModelNative;
  fetchImpl?: FetchLike;
  platformOs?: string | (() => string);
  timeoutMs?: number;
}

/** Store owning offline semantic alignment model checks, downloads, and cancellation. */
export function createAlignmentModel(options: CreateAlignmentModelOptions = {}) {
  const native = options.native ?? SentenceAlignmentNative;
  const request = createHttpFetch({
    scope: "quick-translate/alignment-model",
    logBodies: false,
    fetchImpl: options.fetchImpl,
  });
  const currentOs =
    typeof options.platformOs === "function"
      ? options.platformOs
      : () => options.platformOs ?? platform.os;
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  const status = signal<AlignmentModelStatus>("checking");
  const progress = signal(0);

  interface Transfer {
    cancelled: boolean;
    cancel: () => void;
    promise: Promise<AlignmentModelDownloadOutcome>;
  }

  let activeTransfer: Transfer | null = null;
  let settlingTransfer: Promise<void> = Promise.resolve();
  let pendingCheck: Promise<boolean> | null = null;

  async function probeInstalled(): Promise<{ ok: boolean; ready: boolean }> {
    if (currentOs() !== "windows" || native.modelAssets().length === 0) {
      return { ok: true, ready: false };
    }
    try {
      return { ok: true, ready: await native.modelReady() };
    } catch {
      return { ok: false, ready: false };
    }
  }

  async function checkInstalled(): Promise<boolean> {
    if (currentOs() !== "windows") {
      if (!activeTransfer) status.set("missing");
      return false;
    }
    if (activeTransfer && !activeTransfer.cancelled) {
      return false;
    }
    await settlingTransfer;
    if (activeTransfer && !activeTransfer.cancelled) {
      return false;
    }
    if (pendingCheck) return pendingCheck;
    const run = (async () => {
      const result = await probeInstalled();
      if (!activeTransfer) {
        if (!result.ok) {
          status.set("error");
          log.warn("Could not check the offline alignment model.");
        } else {
          status.set(result.ready ? "ready" : "missing");
        }
      }
      return result.ok && result.ready;
    })().finally(() => {
      if (pendingCheck === run) pendingCheck = null;
    });
    pendingCheck = run;
    return run;
  }

  function readChunkWithAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal.aborted) {
      return Promise.reject(new Error("Model download stopped."));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("Model download stopped."));
      signal.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  function download(): Promise<AlignmentModelDownloadOutcome> {
    if (currentOs() !== "windows" || native.modelAssets().length === 0) {
      return Promise.resolve("error");
    }
    if (activeTransfer && !activeTransfer.cancelled) {
      return activeTransfer.promise;
    }

    const abort = new AbortController();
    const transfer: Transfer = {
      cancelled: false,
      cancel: () => {
        transfer.cancelled = true;
        abort.abort();
      },
      promise: undefined!,
    };
    activeTransfer = transfer;
    const prevSettle = settlingTransfer;

    transfer.promise = (async (): Promise<AlignmentModelDownloadOutcome> => {
      await prevSettle;
      const files = native.modelAssets();
      if (transfer.cancelled) {
        const check = await probeInstalled();
        if (activeTransfer === transfer) {
          status.set(check.ok && check.ready ? "ready" : "missing");
        }
        return "cancelled";
      }

      const initial = await probeInstalled();
      if (transfer.cancelled) {
        status.set(initial.ok && initial.ready ? "ready" : "missing");
        return "cancelled";
      }
      if (!initial.ok) {
        status.set("error");
        log.warn("Could not check the offline alignment model.");
        return "error";
      }
      if (initial.ready) {
        status.set("ready");
        return "ready";
      }
      if (files.length === 0) {
        status.set("missing");
        return "error";
      }

      status.set("downloading");
      progress.set(0);
      const timeout = setTimeout(() => abort.abort(), timeoutMs);
      const total = files.reduce((sum, asset) => sum + asset.bytes, 0);
      let installed = 0;

      try {
        for (const asset of files) {
          if (transfer.cancelled || abort.signal.aborted) {
            throw new Error("Model download stopped.");
          }
          const response = await request(asset.url, {
            method: "GET",
            headers: {},
            signal: abort.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error("Model response was not readable.");
          }
          const reader = response.body.getReader();
          let offset = 0;
          try {
            for (;;) {
              if (transfer.cancelled || abort.signal.aborted) {
                throw new Error("Model download stopped.");
              }
              const next = await readChunkWithAbort(reader, abort.signal);
              if (next.done) break;
              for (let start = 0; start < next.value.length; start += CHUNK_BYTES) {
                if (transfer.cancelled || abort.signal.aborted) {
                  throw new Error("Model download stopped.");
                }
                const part = next.value.slice(start, start + CHUNK_BYTES);
                await native.appendModelChunk(asset.id, offset, part);
                offset += part.length;
              }
              progress.set(total > 0 ? Math.floor(((installed + offset) * 100) / total) : 0);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          if (transfer.cancelled || abort.signal.aborted || offset !== asset.bytes) {
            throw new Error("Model file was incomplete.");
          }
          await native.finishModelAsset(asset.id);
          installed += offset;
        }
        if (transfer.cancelled || abort.signal.aborted) {
          throw new Error("Model download stopped.");
        }
        status.set("ready");
        return "ready";
      } catch {
        await native.cleanModelDownload().catch(() => {});
        progress.set(0);
        if (transfer.cancelled) {
          const check = await probeInstalled();
          status.set(check.ok && check.ready ? "ready" : "missing");
          return "cancelled";
        }
        status.set("error");
        log.warn("Could not install the offline alignment model.");
        return "error";
      } finally {
        clearTimeout(timeout);
        if (activeTransfer === transfer) {
          activeTransfer = null;
        }
      }
    })();

    settlingTransfer = transfer.promise.then(
      () => undefined,
      () => undefined,
    );
    return transfer.promise;
  }

  return {
    status: () => status(),
    ready: () => status() === "ready",
    progress: () => progress(),
    checkInstalled,
    download,
    cancel: () => {
      activeTransfer?.cancel();
    },
  };
}

export const alignmentModel = createAlignmentModel();
