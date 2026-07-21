// ABOUTME: Tests for invokeEffect success and conflict rejection decoding.
// ABOUTME: Mocks Tauri invoke so failures surface as typed IpcError Effects.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { isIpcError } from "./ipcError";

const invokeMock = mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined);

mock.module("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

const { invokeEffect } = await import("./invokeEffect");
const { runStorage } = await import("./runStorage");
const { isConflictError } = await import("./errors");

describe("invokeEffect", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("succeeds with invoke result", async () => {
    invokeMock.mockResolvedValueOnce({ id: "p1" });
    const either = await Effect.runPromise(Effect.either(invokeEffect<{ id: string }>("list_provider_instances")));
    expect(either._tag).toBe("Right");
    if (either._tag === "Right") {
      expect(either.right).toEqual({ id: "p1" });
    }
    expect(invokeMock).toHaveBeenCalledWith("list_provider_instances", undefined);
  });

  test("maps conflict reject to IpcError failure channel", async () => {
    invokeMock.mockRejectedValueOnce({ code: "conflict", message: "stale" });
    const either = await Effect.runPromise(
      Effect.either(invokeEffect("save_provider_instance", { input: { id: "x" } })),
    );
    expect(either._tag).toBe("Left");
    if (either._tag === "Left") {
      expect(isIpcError(either.left)).toBe(true);
      expect(either.left.code).toBe("conflict");
      expect(either.left.message).toBe("stale");
    }
  });

  test("forwards args to invoke without alteration", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const args = { requestId: "r1" };
    await Effect.runPromise(invokeEffect<boolean>("cancel_translate", args));
    expect(invokeMock).toHaveBeenCalledWith("cancel_translate", args);
  });

  test("runStorage(invokeEffect) rejects raw IpcError on conflict", async () => {
    invokeMock.mockRejectedValueOnce({ code: "conflict", message: "stale" });
    try {
      await runStorage(invokeEffect("save_provider_instance", { input: { id: "x" } }));
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isIpcError(error)).toBe(true);
      expect(isConflictError(error)).toBe(true);
      if (isIpcError(error)) {
        expect(error.code).toBe("conflict");
        expect(error.message).toBe("stale");
      }
    }
  });
});
