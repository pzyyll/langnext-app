// ABOUTME: Tests for multi-slot stream start isolation and cancel-all requestIds.
// ABOUTME: Mocks Tauri invoke; proves one slot failure does not block siblings.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isIpcError } from "../../storage/ipcError";
import type { TranslateInput } from "../../storage/types";

const invokeMock = mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined);

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const { startSlotStreamBatch, cancelRequestIds } = await import("./slotBatch");
const { runStartSlotStreamBatch, runCancelRequestIds } = await import("./runTranslate");

function inputFor(text: string): TranslateInput {
  return {
    modelId: "m1",
    sourceLang: "English",
    targetLang: "Chinese",
    text,
  };
}

describe("startSlotStreamBatch", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("starts every job and reports started outcomes", async () => {
    invokeMock.mockResolvedValue(undefined);
    const outcomes = await Effect.runPromise(
      startSlotStreamBatch([
        { slotId: "s1", requestId: "r1", input: inputFor("a") },
        { slotId: "s2", requestId: "r2", input: inputFor("b") },
      ]),
    );
    expect(outcomes).toEqual([
      { slotId: "s1", requestId: "r1", status: "started" },
      { slotId: "s2", requestId: "r2", status: "started" },
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith("translate_text_stream", {
      input: inputFor("a"),
      requestId: "r1",
    });
    expect(invokeMock).toHaveBeenCalledWith("translate_text_stream", {
      input: inputFor("b"),
      requestId: "r2",
    });
  });

  test("isolates per-slot failure without rejecting the batch", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "translate_text_stream" && args?.requestId === "r-bad") {
        throw { code: "validation_failed", message: "bad slot" };
      }
      return undefined;
    });

    const outcomes = await runStartSlotStreamBatch([
      { slotId: "good", requestId: "r-good", input: inputFor("ok") },
      { slotId: "bad", requestId: "r-bad", input: inputFor("") },
      { slotId: "also-good", requestId: "r-good-2", input: inputFor("ok2") },
    ]);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toEqual({ slotId: "good", requestId: "r-good", status: "started" });
    expect(outcomes[1]?.status).toBe("failed");
    if (outcomes[1]?.status === "failed") {
      expect(isIpcError(outcomes[1].error)).toBe(true);
      expect(outcomes[1].error.code).toBe("validation_failed");
      expect(outcomes[1].error.message).toBe("bad slot");
    }
    expect(outcomes[2]).toEqual({ slotId: "also-good", requestId: "r-good-2", status: "started" });
  });
});

describe("cancelRequestIds", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("invokes cancel_translate for each active id", async () => {
    invokeMock.mockResolvedValue(true);
    await Effect.runPromise(cancelRequestIds(["a", "b"]));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith("cancel_translate", { requestId: "a" });
    expect(invokeMock).toHaveBeenCalledWith("cancel_translate", { requestId: "b" });
  });

  test("no-ops on empty list", async () => {
    await runCancelRequestIds([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("swallows individual cancel failures", async () => {
    invokeMock.mockImplementation(async (_cmd, args) => {
      if (args?.requestId === "dead") {
        throw { code: "not_found", message: "gone" };
      }
      return true;
    });
    await expect(runCancelRequestIds(["live", "dead", "also"])).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });
});
