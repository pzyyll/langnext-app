// ABOUTME: Fixture tests for Anthropic Messages plugin wire format and parsing.
// ABOUTME: Covers pagination, version header, content extraction, and stream deltas.
import { describe, expect, test } from "bun:test";
import { anthropicPlugin } from "./anthropic";

describe("anthropicPlugin", () => {
  test("builds messages request with version header and default max tokens", () => {
    const wire = anthropicPlugin.buildChatRequest({
      operation: "translate",
      stream: true,
      modelKey: "claude-3-5-haiku",
      systemPrompt: "sys",
      userPrompt: "hi",
      temperature: 0.1,
      maxTokens: null,
      thinking: null,
      imagePngBase64: null,
    });
    expect(wire.relativePath).toBe("v1/messages");
    expect(wire.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(wire.body ?? "{}") as {
      max_tokens: number;
      stream: boolean;
      system: string;
    };
    expect(body.max_tokens).toBe(32768);
    expect(body.stream).toBe(true);
    expect(body.system).toBe("sys");
  });

  test("parses model page continuation from last_id", () => {
    const page = anthropicPlugin.parseModelListPage({
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [{ id: "claude-3-5-haiku", display_name: "Haiku" }],
        has_more: true,
        first_id: "a",
        last_id: "cursor-1",
      }),
    });
    expect(page.items[0]?.modelKey).toBe("claude-3-5-haiku");
    expect(page.continuation).toBe("cursor-1");
    const next = anthropicPlugin.buildModelListRequest({ continuation: "cursor-1" });
    expect([...next.query]).toEqual([["after_id", "cursor-1"]]);
  });

  test("parses content and stream text deltas", () => {
    const text = anthropicPlugin.parseChatResponse({
      status: 200,
      headers: {},
      body: JSON.stringify({ content: [{ type: "text", text: "hello" }] }),
    });
    expect(text).toBe("hello");
    const delta = anthropicPlugin.parseStreamEvent({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "wo" } }),
    });
    expect(delta).toEqual({ kind: "delta", text: "wo" });
  });

  test("resolveAuthScheme is header x-api-key", () => {
    expect(anthropicPlugin.resolveAuthScheme("api_key")).toEqual({
      schemaVersion: 1,
      type: "header",
      name: "x-api-key",
    });
  });
});
