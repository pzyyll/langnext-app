// ABOUTME: Unit tests for incremental UTF-8 and SSE decoding over raw chunks.
// ABOUTME: Covers split lines, comments, repeated data fields, and trailing flush.
import { describe, expect, test } from "bun:test";
import { SseEventDecoder, Utf8StreamDecoder } from "./sse";

describe("sse decoder", () => {
  test("parses split lines and repeated data fields", () => {
    const decoder = new SseEventDecoder();
    const first = decoder.push("event: delta\nda");
    expect(first).toEqual([]);
    const second = decoder.push("ta: he");
    expect(second).toEqual([]);
    const third = decoder.push("llo\ndata:  world\n\n");
    expect(third).toEqual([{ event: "delta", data: "hello\n world" }]);
  });

  test("ignores comments and flushes trailing event", () => {
    const decoder = new SseEventDecoder();
    expect(decoder.push(": keepalive\n")).toEqual([]);
    expect(decoder.push("data: done")).toEqual([]);
    expect(decoder.finish()).toEqual([{ event: null, data: "done" }]);
  });

  test("utf8 stream decoder handles multi-byte splits", () => {
    const decoder = new Utf8StreamDecoder();
    const bytes = new TextEncoder().encode("你好");
    const mid = 1;
    const a = decoder.push(bytes.slice(0, mid));
    const b = decoder.push(bytes.slice(mid));
    const c = decoder.finish();
    expect(a + b + c).toBe("你好");
  });
});
