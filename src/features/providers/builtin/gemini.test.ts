// ABOUTME: Fixture tests for Gemini generateContent plugin wire format and parsing.
// ABOUTME: Covers model resource paths, alt=sse, pagination token, and content parts.
import { describe, expect, test } from "bun:test";
import { geminiPlugin } from "./gemini";

describe("geminiPlugin", () => {
  test("builds generate and stream paths with alt=sse", () => {
    const nonStream = geminiPlugin.buildChatRequest({
      operation: "translate",
      stream: false,
      modelKey: "gemini-2.0-flash",
      systemPrompt: "sys",
      userPrompt: "hi",
      temperature: null,
      maxTokens: 256,
      thinking: null,
      imagePngBase64: null,
    });
    expect(nonStream.relativePath).toBe("v1beta/models/gemini-2.0-flash:generateContent");
    expect(nonStream.query).toEqual([]);

    const stream = geminiPlugin.buildChatRequest({
      operation: "translate",
      stream: true,
      modelKey: "models/gemini-2.0-flash",
      systemPrompt: "sys",
      userPrompt: "hi",
      temperature: 0.2,
      maxTokens: null,
      thinking: null,
      imagePngBase64: null,
    });
    expect(stream.relativePath).toBe("v1beta/models/gemini-2.0-flash:streamGenerateContent");
    expect([...stream.query]).toEqual([["alt", "sse"]]);
  });

  test("parses model page and nextPageToken", () => {
    const page = geminiPlugin.parseModelListPage({
      status: 200,
      headers: {},
      body: JSON.stringify({
        models: [
          {
            name: "models/gemini-2.0-flash",
            displayName: "Flash",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
        nextPageToken: "tok-2",
      }),
    });
    expect(page.items[0]?.modelKey).toBe("gemini-2.0-flash");
    expect(page.continuation).toBe("tok-2");
    const next = geminiPlugin.buildModelListRequest({ continuation: "tok-2" });
    expect([...next.query]).toEqual([["pageToken", "tok-2"]]);
  });

  test("parses content and stream parts", () => {
    const payload = {
      candidates: [{ content: { parts: [{ text: "hello" }, { text: " world" }] } }],
    };
    expect(geminiPlugin.parseChatResponse({ status: 200, headers: {}, body: JSON.stringify(payload) })).toBe(
      "hello world",
    );
    expect(geminiPlugin.parseStreamEvent({ event: null, data: JSON.stringify(payload) })).toEqual({
      kind: "delta",
      text: "hello world",
    });
  });

  test("resolveAuthScheme is query key", () => {
    expect(geminiPlugin.resolveAuthScheme("api_key")).toEqual({
      schemaVersion: 1,
      type: "query",
      name: "key",
    });
  });
});
