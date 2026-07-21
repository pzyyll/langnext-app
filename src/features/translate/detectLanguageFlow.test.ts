// ABOUTME: Tests for detectLanguageFlow success, soft failure, and IPC errors.
// ABOUTME: Mocks Tauri invoke; covers optional requestId cancel-registry wiring.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isIpcError } from "../../storage/ipcError";
import type { DetectLanguageResult } from "../../storage/types";

const invokeMock = mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined);

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const { detectLanguageFlow } = await import("./detectLanguageFlow");
const { runDetectLanguage } = await import("./runTranslate");

const okResult: DetectLanguageResult = {
  ok: true,
  languageId: "en",
  message: "",
  latencyMs: 12,
  errorCode: null,
  detectorType: "llm",
};

describe("detectLanguageFlow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("invokes detect_language with null requestId when omitted", async () => {
    invokeMock.mockResolvedValueOnce(okResult);
    const result = await Effect.runPromise(detectLanguageFlow({ text: "bonjour" }));
    expect(result).toEqual(okResult);
    expect(invokeMock).toHaveBeenCalledWith("detect_language", {
      input: { text: "bonjour" },
      requestId: null,
    });
  });

  test("forwards requestId for cancel registry", async () => {
    invokeMock.mockResolvedValueOnce(okResult);
    await Effect.runPromise(detectLanguageFlow({ text: "hola", modelId: "m1" }, "detect-1"));
    expect(invokeMock).toHaveBeenCalledWith("detect_language", {
      input: { text: "hola", modelId: "m1" },
      requestId: "detect-1",
    });
  });

  test("soft ok:false still succeeds the Effect", async () => {
    const soft: DetectLanguageResult = {
      ok: false,
      languageId: "",
      message: "could not detect",
      latencyMs: 5,
      errorCode: "invalid_response",
      detectorType: "llm",
    };
    invokeMock.mockResolvedValueOnce(soft);
    const either = await Effect.runPromise(Effect.either(detectLanguageFlow({ text: "???" }, "d2")));
    expect(either._tag).toBe("Right");
    if (either._tag === "Right") {
      expect(either.right.ok).toBe(false);
      expect(either.right.errorCode).toBe("invalid_response");
    }
  });

  test("validation_failed reject becomes IpcError", async () => {
    invokeMock.mockRejectedValueOnce({ code: "validation_failed", message: "text too long" });
    try {
      await runDetectLanguage({ text: "x" }, "d3");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isIpcError(error)).toBe(true);
      if (isIpcError(error)) {
        expect(error.code).toBe("validation_failed");
        expect(error.message).toBe("text too long");
      }
    }
  });
});
