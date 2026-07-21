// ABOUTME: Unit tests for IPC error message/code extraction helpers.
// ABOUTME: Ensures conflict codes are recognized for optimistic concurrency UI.
import { describe, expect, test } from "bun:test";
import { getIpcErrorCode, getIpcErrorMessage, isConflictError } from "./errors";
import { IpcError } from "./ipcError";

describe("getIpcErrorMessage", () => {
  test("prefers object message", () => {
    expect(getIpcErrorMessage({ code: "conflict", message: "stale" }, "fallback")).toBe("stale");
  });

  test("falls back when empty", () => {
    expect(getIpcErrorMessage({}, "fallback")).toBe("fallback");
  });

  test("message-only object keeps message", () => {
    expect(getIpcErrorMessage({ message: "only" }, "fallback")).toBe("only");
  });

  test("empty code with message keeps message", () => {
    expect(getIpcErrorMessage({ code: "", message: "m" }, "fallback")).toBe("m");
  });

  test("IpcError empty message uses fallback", () => {
    const err = new IpcError({ code: "conflict", message: "" });
    expect(getIpcErrorMessage(err, "fallback")).toBe("fallback");
  });

  test("IpcError message is preferred", () => {
    const err = new IpcError({ code: "validation_failed", message: "bad" });
    expect(getIpcErrorMessage(err, "fallback")).toBe("bad");
  });
});

describe("getIpcErrorCode / isConflictError", () => {
  test("reads code from IPC shape", () => {
    expect(getIpcErrorCode({ code: "conflict", message: "x" })).toBe("conflict");
    expect(isConflictError({ code: "conflict", message: "x" })).toBe(true);
  });

  test("non-conflict rejections", () => {
    expect(getIpcErrorCode({ message: "only" })).toBeNull();
    expect(isConflictError({ code: "validation_failed", message: "x" })).toBe(false);
    expect(isConflictError("string error")).toBe(false);
  });

  test("recognizes IpcError conflict instance", () => {
    const err = new IpcError({ code: "conflict", message: "stale" });
    expect(getIpcErrorCode(err)).toBe("conflict");
    expect(isConflictError(err)).toBe(true);
  });
});
