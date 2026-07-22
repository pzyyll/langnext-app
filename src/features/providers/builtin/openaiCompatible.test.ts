// ABOUTME: Fixture tests for OpenAI Compatible plugin wire format and parsing.
// ABOUTME: Ports payload/content/stream cases from the former Rust adapter tests.
import { describe, expect, test } from "bun:test";
import { openaiCompatiblePlugin } from "./openaiCompatible";

describe("openaiCompatiblePlugin", () => {
  test("builds chat completions body", () => {
    const wire = openaiCompatiblePlugin.buildChatRequest({
      operation: "translate",
      stream: false,
      modelKey: "gpt-4o-mini",
      systemPrompt: "sys",
      userPrompt: "hello",
      temperature: 0.2,
      maxTokens: 128,
      thinking: null,
      imagePngBase64: null,
    });
    expect(wire.relativePath).toBe("chat/completions");
    const body = JSON.parse(wire.body ?? "{}") as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0]?.content).toBe("sys");
    expect(body.messages[1]?.content).toBe("hello");
    expect(body.max_tokens).toBe(128);
  });

  test("parses chat content and stream deltas", () => {
    const text = openaiCompatiblePlugin.parseChatResponse({
      status: 200,
      headers: {},
      body: JSON.stringify({ choices: [{ message: { content: "  hi  " } }] }),
    });
    expect(text).toBe("hi");
    const delta = openaiCompatiblePlugin.parseStreamEvent({
      event: null,
      data: JSON.stringify({ choices: [{ delta: { content: "wo" } }] }),
    });
    expect(delta).toEqual({ kind: "delta", text: "wo" });
  });

  test("parses model list page", () => {
    const page = openaiCompatiblePlugin.parseModelListPage({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }),
    });
    expect(page.items.map((i) => i.modelKey)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(page.continuation).toBeNull();
  });
});
