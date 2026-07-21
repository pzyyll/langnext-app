// ABOUTME: Unit tests for unified FsError + IpcError user message extraction.
// ABOUTME: Covers FsError trim/fallback and IPC decode path delegation.
import { describe, expect, test } from "bun:test";
import { IpcError } from "../storage/ipcError";
import { FsError } from "./fsError";
import { getUserErrorMessage } from "./userErrorMessage";

describe("getUserErrorMessage", () => {
  test("prefers trimmed FsError message", () => {
    const err = new FsError({ operation: "write", message: "  disk full  " });
    expect(getUserErrorMessage(err, "fallback")).toBe("disk full");
  });

  test("FsError empty message uses fallback", () => {
    const err = new FsError({ operation: "dialog", message: "   " });
    expect(getUserErrorMessage(err, "fallback")).toBe("fallback");
  });

  test("IpcError message is preferred", () => {
    const err = new IpcError({ code: "validation_failed", message: "bad" });
    expect(getUserErrorMessage(err, "fallback")).toBe("bad");
  });

  test("IpcError empty message uses fallback", () => {
    const err = new IpcError({ code: "conflict", message: "" });
    expect(getUserErrorMessage(err, "fallback")).toBe("fallback");
  });

  test("plain IPC shape message is preferred", () => {
    expect(getUserErrorMessage({ code: "conflict", message: "stale" }, "fallback")).toBe("stale");
  });

  test("unknown non-Fs non-IPC uses fallback", () => {
    expect(getUserErrorMessage({}, "fallback")).toBe("fallback");
  });
});
