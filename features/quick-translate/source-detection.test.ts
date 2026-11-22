import { expect, test } from "nsh/test";
import type { LanguageDetectionResult } from "../language-detection/detect";
import type { LanguageDetectionSnapshot } from "../language-detection/settings";
import { createSourceLanguageDetection, type SourceDetectionState } from "./source-detection";

function snapshot(overrides: Partial<LanguageDetectionSnapshot> = {}): LanguageDetectionSnapshot {
  return {
    detectors: [{ kind: "ai", modelId: "m1" }],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("source detection: one run serves every action on the same input", async () => {
  const calls: string[] = [];
  const detection = createSourceLanguageDetection({
    detect: async (text) => {
      calls.push(text);
      return { ok: true, language: "fr" };
    },
  });

  const first = await detection.detect("Bonjour", snapshot());
  const second = await detection.detect("Bonjour", snapshot());

  expect(first).toEqual({ ok: true, language: "fr" });
  expect(second).toEqual({ ok: true, language: "fr" });
  expect(calls).toEqual(["Bonjour"]);
});

test("source detection: concurrent actions share one request", async () => {
  const gate = deferred<LanguageDetectionResult>();
  let calls = 0;
  const detection = createSourceLanguageDetection({
    detect: () => {
      calls += 1;
      return gate.promise;
    },
  });

  const first = detection.detect("Bonjour", snapshot());
  const second = detection.detect("Bonjour", snapshot());
  gate.resolve({ ok: true, language: "fr" });

  expect(await first).toEqual({ ok: true, language: "fr" });
  expect(await second).toEqual({ ok: true, language: "fr" });
  expect(calls).toBe(1);
});

test("source detection: the input text is compared exactly", async () => {
  const calls: string[] = [];
  const detection = createSourceLanguageDetection({
    detect: async (text) => {
      calls.push(text);
      return { ok: true, language: "fr" };
    },
  });

  await detection.detect("Bonjour", snapshot());
  await detection.detect("Bonjour ", snapshot());

  expect(calls).toEqual(["Bonjour", "Bonjour "]);
});

test("source detection: a failed run is not reused", async () => {
  const results: LanguageDetectionResult[] = [
    { ok: false, code: "unknown_language" },
    { ok: true, language: "fr" },
  ];
  let calls = 0;
  const detection = createSourceLanguageDetection({
    detect: async () => results[calls++]!,
  });

  expect(await detection.detect("???", snapshot())).toEqual({
    ok: false,
    code: "unknown_language",
  });
  expect(await detection.detect("???", snapshot())).toEqual({ ok: true, language: "fr" });
  expect(calls).toBe(2);
});

test("source detection: a changed detector chain detects again", async () => {
  let calls = 0;
  const detection = createSourceLanguageDetection({
    detect: async () => {
      calls += 1;
      return { ok: true, language: "fr" };
    },
  });

  await detection.detect("Bonjour", snapshot());
  await detection.detect("Bonjour", snapshot({ detectors: [{ kind: "google" }] }));

  expect(calls).toBe(2);
});

test("source detection: a changed input aborts the run and drops its answer", async () => {
  const gate = deferred<LanguageDetectionResult>();
  const states: SourceDetectionState[] = [];
  let signal: AbortSignal | undefined;
  const detection = createSourceLanguageDetection({
    detect: (_text, _detectors, options) => {
      signal = options?.signal;
      return gate.promise;
    },
    onStateChange: (state) => states.push(state),
  });

  const waiting = detection.detect("Bonjour", snapshot());
  detection.syncText("Bonsoir");
  expect(signal?.aborted).toBe(true);

  gate.resolve({ ok: true, language: "fr" });
  expect(await waiting).toBe(null);
  expect(states[states.length - 1]).toEqual({ status: "idle" });
});

test("source detection: an aborted caller does not cancel the shared run", async () => {
  const gate = deferred<LanguageDetectionResult>();
  let calls = 0;
  const detection = createSourceLanguageDetection({
    detect: () => {
      calls += 1;
      return gate.promise;
    },
  });

  const controller = new AbortController();
  const waiting = detection.detect("Bonjour", snapshot(), controller.signal);
  controller.abort();
  expect(await waiting).toBe(null);

  gate.resolve({ ok: true, language: "fr" });
  expect(await detection.detect("Bonjour", snapshot())).toEqual({
    ok: true,
    language: "fr",
  });
  expect(calls).toBe(1);
});

test("source detection: unconfigured and blank input never call the detector", async () => {
  let calls = 0;
  const detection = createSourceLanguageDetection({
    detect: async () => {
      calls += 1;
      return { ok: true, language: "fr" };
    },
  });

  expect(await detection.detect("Bonjour", snapshot({ detectors: [] }))).toEqual({
    ok: false,
    code: "unconfigured",
  });
  expect(await detection.detect("   ", snapshot())).toEqual({
    ok: false,
    code: "blank_input",
  });
  expect(calls).toBe(0);
});

test("source detection: dispose aborts the run and ignores its late answer", async () => {
  const gate = deferred<LanguageDetectionResult>();
  let signal: AbortSignal | undefined;
  const detection = createSourceLanguageDetection({
    detect: (_text, _detectors, options) => {
      signal = options?.signal;
      return gate.promise;
    },
  });

  const waiting = detection.detect("Bonjour", snapshot());
  detection.dispose();
  expect(signal?.aborted).toBe(true);

  gate.resolve({ ok: true, language: "fr" });
  expect(await waiting).toBe(null);
});
