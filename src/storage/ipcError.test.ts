// ABOUTME: Unit tests for IpcError tagging and rejection decoding.
// ABOUTME: Covers structured IPC shapes, strings, Errors, and garbage input.
import { describe, expect, test } from "bun:test";
import { decodeIpcRejection, ipcErrorIsConflict, isIpcError, IpcError } from "./ipcError";

describe("IpcError / isIpcError", () => {
  test("tags instances and recognizes them", () => {
    const err = new IpcError({ code: "conflict", message: "stale" });
    expect(err._tag).toBe("IpcError");
    expect(isIpcError(err)).toBe(true);
    expect(isIpcError({ code: "conflict", message: "stale" })).toBe(false);
  });
});

describe("decodeIpcRejection", () => {
  test("structured conflict keeps code, message, and reason", () => {
    const err = decodeIpcRejection({ code: "conflict", reason: "expired", message: "session ended" });
    expect(isIpcError(err)).toBe(true);
    expect(err.code).toBe("conflict");
    expect(err.message).toBe("session ended");
    expect(err.reason).toBe("expired");
    expect(ipcErrorIsConflict(err)).toBe(true);
  });

  test("reasonless structured conflict stays valid without a reason", () => {
    const err = decodeIpcRejection({ code: "conflict", message: "stale" });
    expect(isIpcError(err)).toBe(true);
    expect(err.code).toBe("conflict");
    expect(err.reason).toBeUndefined();
  });

  test("non-string reason is dropped", () => {
    const err = decodeIpcRejection({ code: "conflict", reason: 42, message: "stale" });
    expect(err.code).toBe("conflict");
    expect(err.reason).toBeUndefined();
    expect(err.message).toBe("stale");
  });

  test("validation_failed preserves open wire code", () => {
    const err = decodeIpcRejection({ code: "validation_failed", message: "bad name" });
    expect(err.code).toBe("validation_failed");
    expect(err.message).toBe("bad name");
    expect(ipcErrorIsConflict(err)).toBe(false);
  });

  test("non-empty string becomes unknown", () => {
    const err = decodeIpcRejection("backend exploded");
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("backend exploded");
  });

  test("empty object becomes unknown with empty message", () => {
    const err = decodeIpcRejection({});
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("");
  });

  test("Error uses message with unknown code", () => {
    const err = decodeIpcRejection(new Error("network down"));
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("network down");
  });

  test("garbage becomes unknown with empty message", () => {
    expect(decodeIpcRejection(null).code).toBe("unknown");
    expect(decodeIpcRejection(null).message).toBe("");
    expect(decodeIpcRejection(42).message).toBe("");
    expect(decodeIpcRejection(undefined).message).toBe("");
  });

  test("returns the same IpcError instance", () => {
    const original = new IpcError({ code: "not_found", message: "gone" });
    expect(decodeIpcRejection(original)).toBe(original);
  });

  test("object code with non-string message uses empty message", () => {
    const err = decodeIpcRejection({ code: "internal_error", message: 99 });
    expect(err.code).toBe("internal_error");
    expect(err.message).toBe("");
  });

  test("message-only object becomes unknown with that message", () => {
    const err = decodeIpcRejection({ message: "only" });
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("only");
  });

  test("empty code with message is treated as message-only", () => {
    const err = decodeIpcRejection({ code: "", message: "m" });
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("m");
  });

  test("preserves open non-listed wire codes as-is", () => {
    const err = decodeIpcRejection({ code: "custom_backend_code", message: "x" });
    expect(err.code).toBe("custom_backend_code");
    expect(err.message).toBe("x");
  });
});
