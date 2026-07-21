// ABOUTME: Tests for runStorage / runStorageExit Promise bridges.
// ABOUTME: Ensures rejections are raw IpcError values for UI helpers.
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { IpcError, isIpcError } from "./ipcError";
import { runStorage, runStorageExit } from "./runStorage";

describe("runStorage", () => {
  test("resolves successful effects", async () => {
    await expect(runStorage(Effect.succeed(42))).resolves.toBe(42);
  });

  test("rejects with raw IpcError on failure", async () => {
    const failure = new IpcError({ code: "conflict", message: "stale" });
    try {
      await runStorage(Effect.fail(failure));
      expect.unreachable("expected rejection");
    } catch (error) {
      expect(isIpcError(error)).toBe(true);
      expect(error).toBe(failure);
      if (isIpcError(error)) {
        expect(error.code).toBe("conflict");
        expect(error.message).toBe("stale");
      }
    }
  });
});

describe("runStorageExit", () => {
  test("returns success Exit", async () => {
    const exit = await runStorageExit(Effect.succeed("ok"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe("ok");
    }
  });

  test("returns failure Exit with IpcError", async () => {
    const failure = new IpcError({ code: "conflict", message: "stale" });
    const exit = await runStorageExit(Effect.fail(failure));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failed = Cause.failureOption(exit.cause);
      expect(Option.isSome(failed)).toBe(true);
      if (Option.isSome(failed)) {
        expect(isIpcError(failed.value)).toBe(true);
        expect(failed.value.code).toBe("conflict");
        expect(failed.value.message).toBe("stale");
      }
    }
  });
});
