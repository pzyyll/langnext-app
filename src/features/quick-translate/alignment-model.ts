import { SentenceAlignmentNative } from "langnext-native";
import { platform, signal } from "nsh";
import { createHttpFetch } from "../../services/http";
import { createLogger } from "../../services/log";

const CHUNK_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const log = createLogger("quick-translate/alignment-model");
const request = createHttpFetch({ scope: "quick-translate/alignment-model", logBodies: false });

type ModelStatus = "checking" | "missing" | "downloading" | "ready" | "error";
const status = signal<ModelStatus>("checking");
const progress = signal(0);
let cancelDownload: (() => void) | null = null;
let checked = false;

async function load() {
  if (platform.os !== "windows" || checked) return;
  checked = true;
  try {
    if (SentenceAlignmentNative.modelAssets().length === 0) return;
    status.set((await SentenceAlignmentNative.modelReady()) ? "ready" : "missing");
  } catch {
    status.set("error");
    log.warn("Could not check the offline alignment model.");
  }
}

async function install() {
  if (status() !== "missing" && status() !== "error") return;
  const files = SentenceAlignmentNative.modelAssets();
  if (files.length === 0) return;
  const abort = new AbortController();
  status.set("downloading");
  progress.set(0);
  const timeout = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
  let cancelled = false;
  cancelDownload = () => {
    cancelled = true;
    abort.abort();
  };
  const total = files.reduce((sum, asset) => sum + asset.bytes, 0);
  let installed = 0;
  try {
    for (const asset of files) {
      const response = await request(asset.url, {
        method: "GET",
        headers: {},
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error("Model response was not readable.");
      const reader = response.body.getReader();
      let offset = 0;
      try {
        for (;;) {
          if (abort.signal.aborted) throw new Error("Model download stopped.");
          const next = await reader.read();
          if (next.done) break;
          for (let start = 0; start < next.value.length; start += CHUNK_BYTES) {
            if (abort.signal.aborted) throw new Error("Model download stopped.");
            const part = next.value.slice(start, start + CHUNK_BYTES);
            await SentenceAlignmentNative.appendModelChunk(asset.id, offset, part);
            offset += part.length;
          }
          progress.set(Math.floor(((installed + offset) * 100) / total));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (abort.signal.aborted || offset !== asset.bytes)
        throw new Error("Model file was incomplete.");
      await SentenceAlignmentNative.finishModelAsset(asset.id);
      installed += offset;
    }
    status.set("ready");
  } catch {
    await SentenceAlignmentNative.cleanModelDownload().catch(() => {});
    status.set(cancelled ? "missing" : "error");
    if (!cancelled) log.warn("Could not install the offline alignment model.");
  } finally {
    clearTimeout(timeout);
    cancelDownload = null;
  }
}

export const alignmentModel = {
  status: () => status(),
  ready: () => status() === "ready",
  progress: () => progress(),
  load,
  install,
  cancel: () => cancelDownload?.(),
};
