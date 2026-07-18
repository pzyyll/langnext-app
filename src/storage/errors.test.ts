// ABOUTME: Unit tests for IPC error message/code extraction helpers.
// ABOUTME: Ensures conflict codes are recognized for optimistic concurrency UI.
import { describe, expect, test } from "bun:test";
import { getIpcErrorCode, getIpcErrorMessage, isConflictError } from "./errors";

describe("getIpcErrorMessage", () => {
  test("prefers object message", () => {
    expect(getIpcErrorMessage({ code: "conflict", message: "stale" }, "fallback")).toBe("stale");
  });

  test("falls back when empty", () => {
    expect(getIpcErrorMessage({}, "fallback")).toBe("fallback");
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
});
