// ABOUTME: Tests for startTranslateStream success and validation IpcError failures.
// ABOUTME: Mocks Tauri invoke; does not require the stream event bus.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isIpcError } from "../../storage/ipcError";
import type { TranslateInput } from "../../storage/types";

const invokeMock = mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined);

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const { startTranslateStream } = await import("./translateStream");
const { runStartTranslateStream } = await import("./runTranslate");

const sampleInput: TranslateInput = {
  modelId: "m1",
  sourceLang: "English",
  targetLang: "Chinese",
  text: "hello",
};

describe("startTranslateStream", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("invokes translate_text_stream with input and requestId", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await Effect.runPromise(startTranslateStream(sampleInput, "req-1"));
    expect(invokeMock).toHaveBeenCalledWith("translate_text_stream", {
      input: sampleInput,
      requestId: "req-1",
    });
  });

  test("maps validation_failed reject to IpcError on Effect channel", async () => {
    invokeMock.mockRejectedValueOnce({ code: "validation_failed", message: "empty text" });
    const either = await Effect.runPromise(Effect.either(startTranslateStream(sampleInput, "req-2")));
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(isIpcError(either.left)).toBe(true);
      expect(either.left.code).toBe("validation_failed");
      expect(either.left.message).toBe("empty text");
    }
  });

  test("runStartTranslateStream rejects raw IpcError", async () => {
    invokeMock.mockRejectedValueOnce({ code: "validation_failed", message: "empty text" });
    try {
      await runStartTranslateStream(sampleInput, "req-3");
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isIpcError(error)).toBe(true);
      if (isIpcError(error)) {
        expect(error.code).toBe("validation_failed");
      }
    }
  });
});
