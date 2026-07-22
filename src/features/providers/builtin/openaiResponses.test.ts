// ABOUTME: Fixture tests for OpenAI Responses plugin payload and content parsing.
// ABOUTME: Covers input shapes, deltas, lifecycle ignore, and stream error events.
import { describe, expect, test } from "bun:test";
import { openaiResponsesPlugin } from "./openaiResponses";

describe("openaiResponsesPlugin", () => {
  test("text-only input stays string with max_output_tokens", () => {
    const wire = openaiResponsesPlugin.buildChatRequest({
      operation: "translate",
      stream: false,
      modelKey: "gpt-5.4-mini",
      systemPrompt: "You are an OCR engine.",
      userPrompt: "Extract all text from the image.",
      temperature: 0.2,
      maxTokens: 128000,
      thinking: null,
      imagePngBase64: null,
    });
    expect(wire.relativePath).toBe("responses");
    const body = JSON.parse(wire.body ?? "{}") as {
      input: string;
      instructions: string;
      max_output_tokens: number;
    };
    expect(body.input).toBe("Extract all text from the image.");
    expect(body.instructions).toBe("You are an OCR engine.");
    expect(body.max_output_tokens).toBe(128000);
  });

  test("image input uses input_image data URL", () => {
    const wire = openaiResponsesPlugin.buildChatRequest({
      operation: "ocr",
      stream: false,
      modelKey: "gpt-5.4-mini",
      systemPrompt: "ocr",
      userPrompt: "read",
      temperature: null,
      maxTokens: null,
      thinking: null,
      imagePngBase64: "abc123",
    });
    const body = JSON.parse(wire.body ?? "{}") as {
      input: Array<{ role: string; content: Array<{ type: string; image_url?: string; text?: string }> }>;
    };
    expect(body.input[0]?.role).toBe("user");
    expect(body.input[0]?.content[1]?.type).toBe("input_image");
    expect(body.input[0]?.content[1]?.image_url).toBe("data:image/png;base64,abc123");
  });

  test("parses output_text convenience field and stream deltas", () => {
    expect(
      openaiResponsesPlugin.parseChatResponse({
        status: 200,
        headers: {},
        body: JSON.stringify({ output_text: "  done  " }),
      }),
    ).toBe("done");
    const delta = openaiResponsesPlugin.parseStreamEvent({
      event: null,
      data: JSON.stringify({ type: "response.output_text.delta", delta: "hi" }),
    });
    expect(delta).toEqual({ kind: "delta", text: "hi" });
  });

  test("non-JSON delta stream event throws protocol error", () => {
    expect(() =>
      openaiResponsesPlugin.parseStreamEvent({
        event: "response.output_text.delta",
        data: "{not-json",
      }),
    ).toThrow("stream event is not JSON");
  });

  test("lifecycle stream events are ignored", () => {
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: "response.created",
        data: JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
      }),
    ).toEqual({ kind: "ignore" });
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: "response.completed",
        data: JSON.stringify({
          type: "response.completed",
          response: { output_text: "final copy" },
        }),
      }),
    ).toEqual({ kind: "ignore" });
    // Long completed payloads may arrive truncated; content already came via deltas.
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: "response.completed",
        data: '{"type":"response.completed","response":{"output_text":"ide-plugins/je',
      }),
    ).toEqual({ kind: "ignore" });
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: null,
        data: "plain-text-noise",
      }),
    ).toEqual({ kind: "ignore" });
  });

  test("error stream event surfaces provider message", () => {
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: "error",
        data: JSON.stringify({
          type: "error",
          code: "rate_limit_exceeded",
          message: "Rate limit reached for gpt-5.4-mini.",
          param: null,
        }),
      }),
    ).toEqual({ kind: "error", message: "Rate limit reached for gpt-5.4-mini." });
  });

  test("response.failed stream event surfaces nested error message", () => {
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: "response.failed",
        data: JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              code: "server_error",
              message: "The model failed to generate a response.",
            },
          },
        }),
      }),
    ).toEqual({ kind: "error", message: "The model failed to generate a response." });
  });

  test("non-JSON failure stream event returns fallback error", () => {
    expect(
      openaiResponsesPlugin.parseStreamEvent({
        event: "error",
        data: "{broken",
      }),
    ).toEqual({ kind: "error", message: "Provider stream error" });
  });
});
