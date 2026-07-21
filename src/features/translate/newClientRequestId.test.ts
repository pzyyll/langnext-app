// ABOUTME: Unit tests for client request id generation.
// ABOUTME: Asserts non-empty unique ids under the crypto.randomUUID path.
import { describe, expect, test } from "bun:test";
import { newClientRequestId } from "./newClientRequestId";

describe("newClientRequestId", () => {
  test("returns a non-empty string", () => {
    const id = newClientRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("returns distinct values across calls", () => {
    const a = newClientRequestId("translate");
    const b = newClientRequestId("translate");
    expect(a).not.toBe(b);
  });
});
