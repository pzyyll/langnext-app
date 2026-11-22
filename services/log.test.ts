import { expect, test } from "nsh/test";
import { createLogger } from "./log";

type Level = "debug" | "info" | "warn" | "error";

interface Captured {
  calls: unknown[][];
  restore(): void;
}

/** Replaces one `console` method so a test reads what a logger wrote. */
function capture(level: Level): Captured {
  const calls: unknown[][] = [];
  const methods = console as unknown as Record<Level, (...data: unknown[]) => void>;
  const original = methods[level];
  methods[level] = (...data: unknown[]) => {
    calls.push(data);
  };
  return {
    calls,
    restore: () => {
      methods[level] = original;
    },
  };
}

test("log: every level writes through its own console method with the scope prefix", () => {
  const logger = createLogger("models/store");
  const levels: Level[] = ["debug", "info", "warn", "error"];
  const captured = levels.map(capture);
  try {
    logger.debug("queued", 1);
    logger.info("loaded");
    logger.warn("kept the defaults");
    logger.error("gave up");
  } finally {
    for (const entry of captured) entry.restore();
  }

  expect(captured[0].calls).toEqual([["[models/store] queued", 1]]);
  expect(captured[1].calls).toEqual([["[models/store] loaded"]]);
  expect(captured[2].calls).toEqual([["[models/store] kept the defaults"]]);
  expect(captured[3].calls).toEqual([["[models/store] gave up"]]);
});

test("log: details pass through untouched and scopes stay apart", () => {
  const detail = { code: "storage_read_failed" };
  const ocr = createLogger("ocr/settings");
  const tts = createLogger("tts/settings");
  const captured = capture("warn");
  try {
    ocr.warn("Could not remove an unused Baidu OCR credential.", detail);
    tts.warn("Could not remove an unused Cloud TTS credential.");
  } finally {
    captured.restore();
  }

  expect(captured.calls).toHaveLength(2);
  expect(captured.calls[0]).toEqual([
    "[ocr/settings] Could not remove an unused Baidu OCR credential.",
    detail,
  ]);
  expect(captured.calls[0][1]).toBe(detail);
  expect(captured.calls[1]).toEqual([
    "[tts/settings] Could not remove an unused Cloud TTS credential.",
  ]);
});
