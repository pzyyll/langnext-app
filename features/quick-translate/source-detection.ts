import {
  detectLanguage,
  type DetectLanguageOptions,
  type LanguageDetectionResult,
} from "../language-detection/detect";
import type { LanguageDetectionSnapshot } from "../language-detection/settings";
import type { LanguageId } from "../presets/languages";

export type SourceDetectionState =
  | { status: "idle" }
  | { status: "detecting" }
  | { status: "detected"; language: LanguageId };

/** Detection entry point; tests replace it to control timing and answers. */
export type DetectSourceLanguage = (
  text: string,
  detectors: LanguageDetectionSnapshot["detectors"],
  options?: DetectLanguageOptions,
) => Promise<LanguageDetectionResult>;

interface DetectionKey {
  text: string;
  detectors: string;
}

interface DetectionRun {
  key: DetectionKey;
  controller: AbortController;
  promise: Promise<LanguageDetectionResult | null>;
  superseded: boolean;
}

export interface SourceLanguageDetection {
  /**
   * Detects once per input and detector chain. Concurrent calls share one run, and a
   * later call reuses the saved result. Returns `null` when the caller stops waiting
   * or the input changed.
   */
  detect(
    text: string,
    snapshot: LanguageDetectionSnapshot,
    signal?: AbortSignal,
  ): Promise<LanguageDetectionResult | null>;
  /** Drops the saved result when the input text changes. */
  syncText(text: string): void;
  dispose(): void;
}

function detectorSignature(detectors: LanguageDetectionSnapshot["detectors"]): string {
  return detectors
    .map((detector) => {
      if (detector.kind === "ai") return `ai:${detector.modelId}`;
      if (detector.kind === "google") return "google";
      return `google-cloud:${detector.credentialRef}`;
    })
    .join("\u0000");
}

function sameState(left: SourceDetectionState, right: SourceDetectionState): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "detected" || right.status !== "detected") return true;
  return left.language === right.language;
}

/**
 * Owns the source language detection of one Quick Translate input.
 *
 * The result belongs to the text, not to the action that asked: every translation and
 * pronunciation of the same text joins the first run or reuses its answer. A failed run
 * is not saved, so a retry detects again. Changing the text or the detector chain starts
 * over, and a run keeps going when its callers stop waiting.
 */
export function createSourceLanguageDetection(
  options: {
    detect?: DetectSourceLanguage;
    onStateChange?: (state: SourceDetectionState) => void;
  } = {},
): SourceLanguageDetection {
  const runDetector = options.detect ?? detectLanguage;
  let disposed = false;
  let text = "";
  let state: SourceDetectionState = { status: "idle" };
  let cached: { key: DetectionKey; language: LanguageId } | null = null;
  let current: DetectionRun | null = null;

  const publish = (next: SourceDetectionState) => {
    if (disposed || sameState(state, next)) return;
    state = next;
    options.onStateChange?.(next);
  };

  const supersede = () => {
    if (current === null) return;
    current.superseded = true;
    current.controller.abort();
    current = null;
  };

  const start = (
    key: DetectionKey,
    detectors: LanguageDetectionSnapshot["detectors"],
  ): DetectionRun => {
    const controller = new AbortController();
    const run: DetectionRun = {
      key,
      controller,
      superseded: false,
      promise: Promise.resolve(null),
    };
    run.promise = runDetector(key.text, detectors, { signal: controller.signal }).then(
      (result) => {
        if (current === run) current = null;
        if (run.superseded) return null;
        if (result.ok) {
          cached = { key, language: result.language };
          publish({ status: "detected", language: result.language });
          return result;
        }
        publish({ status: "idle" });
        return result;
      },
      () => {
        if (current === run) current = null;
        if (!run.superseded) publish({ status: "idle" });
        return { ok: false, code: "failed" };
      },
    );
    current = run;
    publish({ status: "detecting" });
    return run;
  };

  const join = async (
    run: DetectionRun,
    signal: AbortSignal | undefined,
  ): Promise<LanguageDetectionResult | null> => {
    if (signal?.aborted) return null;
    const result = await Promise.race([
      run.promise,
      new Promise<null>((resolve) => {
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      }),
    ]);
    return run.superseded ? null : result;
  };

  const reset = () => {
    supersede();
    cached = null;
    publish({ status: "idle" });
  };

  return {
    detect: async (nextText, snapshot, signal) => {
      if (disposed) return { ok: false, code: "cancelled" };
      if (nextText !== text) {
        text = nextText;
        reset();
      }

      if (snapshot.detectors.length === 0) {
        reset();
        return { ok: false, code: "unconfigured" };
      }
      if (nextText.trim().length === 0) {
        reset();
        return { ok: false, code: "blank_input" };
      }

      const key: DetectionKey = {
        text: nextText,
        detectors: detectorSignature(snapshot.detectors),
      };
      if (
        cached !== null &&
        cached.key.text === key.text &&
        cached.key.detectors === key.detectors
      ) {
        publish({ status: "detected", language: cached.language });
        return { ok: true, language: cached.language };
      }
      cached = null;

      let run = current;
      if (run === null || run.key.text !== key.text || run.key.detectors !== key.detectors) {
        supersede();
        run = start(key, snapshot.detectors);
      }
      return join(run, signal);
    },
    syncText: (nextText) => {
      if (disposed || nextText === text) return;
      text = nextText;
      reset();
    },
    dispose: () => {
      disposed = true;
      supersede();
      cached = null;
    },
  };
}
