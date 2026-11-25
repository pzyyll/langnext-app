import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { createJsonHttpClient } from "../runtime/http";
import type { FetchLike, HttpResponseLike } from "../../../services/http";
import { anthropicProtocol } from "./anthropic";
import { geminiProtocol } from "./gemini";
import { openAIChatProtocol } from "./openai-chat";
import { openAIResponsesProtocol } from "./openai-responses";
import type { ProtocolDefinition } from "../contracts/protocol";
import { createAiClient } from "../runtime/client";
import { createAiRegistry } from "../runtime/registry";

interface RequestLog {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
}

function jsonResponse(body: unknown): HttpResponseLike {
  return { ok: true, status: 200, json: async () => body };
}

function fixedFetch(body: unknown, log?: RequestLog[]): FetchLike {
  return async (url, init) => {
    log?.push({
      url,
      headers: init.headers,
      ...(init.method !== "GET" ? { method: init.method } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
    });
    return jsonResponse(body);
  };
}

/** Answers each call with a body derived from the call index. */
function countingFetch(makeBody: (call: number) => unknown, log?: RequestLog[]): FetchLike {
  let calls = 0;
  return async (url, init) => {
    log?.push({ url, headers: init.headers });
    const body = makeBody(calls);
    calls += 1;
    return jsonResponse(body);
  };
}

test("ai protocol: Chat targets preserve a proxy prefix", () => {
  const connection = { baseUrl: "https://proxy.example.com/ai/v1/", credential: "sk-dummy" };

  const catalog = openAIChatProtocol.resolveTarget(connection, { kind: "catalog" });
  expect(catalog.method).toBe("GET");
  expect(catalog.url).toBe("https://proxy.example.com/ai/v1/models");
  expect(catalog.headers.Authorization).toBe("Bearer sk-dummy");

  const model = openAIChatProtocol.resolveTarget(connection, {
    kind: "model",
    modelId: "gpt-4.1",
  });
  expect(model.method).toBe("POST");
  expect(model.url).toBe("https://proxy.example.com/ai/v1/chat/completions");
  expect(model.headers.Authorization).toBe("Bearer sk-dummy");
  expect(model.headers["Content-Type"]).toBe("application/json");
});

test("ai protocol: Chat lists unique normalized models", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        data: [
          {
            id: "gpt-4.1",
            display_name: "GPT-4.1",
            context_window: 1_000_000,
            max_tokens: 32_768,
          },
          { id: "gpt-4.1", display_name: "Duplicate" },
          { id: "   " },
          { id: "gpt-4.1-mini" },
          { id: "broken-limits", context_window: -5, max_output_tokens: 0.5 },
        ],
      },
      log,
    ),
  });

  const models = await openAIChatProtocol.listModels(
    { baseUrl: "https://proxy.example.com/ai/v1", credential: "sk-dummy" },
    { http },
  );
  expect(log.map((request) => request.url)).toEqual(["https://proxy.example.com/ai/v1/models"]);

  expect(models).toEqual([
    {
      modelKey: "gpt-4.1",
      displayName: "GPT-4.1",
      contextLimit: 1_000_000,
      maxTokens: 32_768,
      capabilities: null,
    },
    {
      modelKey: "gpt-4.1-mini",
      displayName: null,
      contextLimit: null,
      maxTokens: null,
      capabilities: null,
    },
    {
      modelKey: "broken-limits",
      displayName: null,
      contextLimit: null,
      maxTokens: null,
      capabilities: null,
    },
  ]);
});

test("ai protocol: Responses uses its own model target", () => {
  const connection = { baseUrl: "https://gateway.example.com/ai/v1", credential: "sk-dummy" };

  const model = openAIResponsesProtocol.resolveTarget(connection, {
    kind: "model",
    modelId: "gpt-4.1",
  });
  expect(model.method).toBe("POST");
  expect(model.url).toBe("https://gateway.example.com/ai/v1/responses");
  expect(model.headers.Authorization).toBe("Bearer sk-dummy");

  const catalog = openAIResponsesProtocol.resolveTarget(connection, { kind: "catalog" });
  expect(catalog.method).toBe("GET");
  expect(catalog.url).toBe("https://gateway.example.com/ai/v1/models");
});

test("ai protocol: Messages paginates with after_id", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: countingFetch(
      (call) =>
        call === 0
          ? { data: [{ id: "claude-3-7" }], has_more: true, last_id: "claude-3-7" }
          : { data: [{ id: "claude-3-7" }, { id: "claude-sonnet-4" }], has_more: false },
      log,
    ),
  });

  const models = await anthropicProtocol.listModels(
    { baseUrl: "https://proxy.example.com/claude/v1", credential: "sk-ant-dummy" },
    { http },
  );

  expect(log).toHaveLength(2);
  expect(log[0]!.url).toBe("https://proxy.example.com/claude/v1/models");
  expect(log[0]!.headers["x-api-key"]).toBe("sk-ant-dummy");
  expect(log[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  expect(log[1]!.url).toBe("https://proxy.example.com/claude/v1/models?after_id=claude-3-7");
  expect(models.map((model) => model.modelKey)).toEqual(["claude-3-7", "claude-sonnet-4"]);
});

test("ai protocol: Gemini paginates with pageToken", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: countingFetch(
      (call) =>
        call === 0
          ? {
              models: [
                {
                  name: "models/gemini-2.5-flash",
                  displayName: "Gemini 2.5 Flash",
                  inputTokenLimit: 1_048_576,
                  outputTokenLimit: 65_536,
                },
              ],
              nextPageToken: "page-2",
            }
          : {
              models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.5-pro" }],
            },
      log,
    ),
  });

  const models = await geminiProtocol.listModels(
    { baseUrl: "https://proxy.example.com/gemini/v1beta", credential: "AIza-dummy" },
    { http },
  );

  expect(log).toHaveLength(2);
  expect(log[0]!.url).toBe("https://proxy.example.com/gemini/v1beta/models?key=AIza-dummy");
  expect(log[1]!.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models?pageToken=page-2&key=AIza-dummy",
  );
  expect(models).toEqual([
    {
      modelKey: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      contextLimit: 1_048_576,
      maxTokens: 65_536,
      capabilities: null,
    },
    {
      modelKey: "gemini-2.5-pro",
      displayName: null,
      contextLimit: null,
      maxTokens: null,
      capabilities: null,
    },
  ]);
});

test("ai protocol: Gemini model targets encode the model ID", () => {
  const connection = { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" };

  const model = geminiProtocol.resolveTarget(connection, {
    kind: "model",
    modelId: "models/gemini-2.5-flash",
  });
  expect(model.method).toBe("POST");
  expect(model.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-dummy",
  );

  const nested = geminiProtocol.resolveTarget(connection, {
    kind: "model",
    modelId: "publishers/google/models/gemini-2.5-pro",
  });
  expect(nested.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models/publishers%2Fgoogle%2Fmodels%2Fgemini-2.5-pro:generateContent?key=AIza-dummy",
  );
});

test("ai protocol: catalog pagination stops safely", async () => {
  const afterIdCalls: RequestLog[] = [];
  const repeatedAfterId = createJsonHttpClient({
    fetchImpl: countingFetch(
      () => ({ data: [{ id: "claude" }], has_more: true, last_id: "same-cursor" }),
      afterIdCalls,
    ),
  });
  await anthropicProtocol.listModels(
    { baseUrl: "https://proxy.example.com/claude", credential: "sk-ant-dummy" },
    { http: repeatedAfterId },
  );
  expect(afterIdCalls).toHaveLength(2);

  const capLog: RequestLog[] = [];
  const endlessAfterId = createJsonHttpClient({
    fetchImpl: countingFetch(
      (call) => ({
        data: [{ id: `model-${call}` }],
        has_more: true,
        last_id: `cursor-${call}`,
      }),
      capLog,
    ),
  });
  const cappedModels = await anthropicProtocol.listModels(
    { baseUrl: "https://proxy.example.com/claude", credential: "sk-ant-dummy" },
    { http: endlessAfterId },
  );
  expect(capLog).toHaveLength(10);
  expect(cappedModels).toHaveLength(10);

  const pageTokenCalls: RequestLog[] = [];
  const repeatedToken = createJsonHttpClient({
    fetchImpl: countingFetch(
      () => ({ models: [{ name: "models/gemini-2.5-flash" }], nextPageToken: "same-token" }),
      pageTokenCalls,
    ),
  });
  const deduped = await geminiProtocol.listModels(
    { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" },
    { http: repeatedToken },
  );
  expect(pageTokenCalls).toHaveLength(2);
  expect(deduped).toHaveLength(1);

  const endlessTokenCalls: RequestLog[] = [];
  const endlessToken = createJsonHttpClient({
    fetchImpl: countingFetch(
      (call) => ({ models: [{ name: `models/model-${call}` }], nextPageToken: `token-${call}` }),
      endlessTokenCalls,
    ),
  });
  const cappedTokenModels = await geminiProtocol.listModels(
    { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" },
    { http: endlessToken },
  );
  expect(endlessTokenCalls).toHaveLength(10);
  expect(cappedTokenModels).toHaveLength(10);
});

test("ai protocol: an empty valid catalog succeeds", async () => {
  const connection = { baseUrl: "https://proxy.example.com/v1", credential: "sk-dummy" };

  const chat = await openAIChatProtocol.listModels(connection, {
    http: createJsonHttpClient({ fetchImpl: fixedFetch({ data: [] }) }),
  });
  expect(chat).toEqual([]);

  const responses = await openAIResponsesProtocol.listModels(connection, {
    http: createJsonHttpClient({ fetchImpl: fixedFetch({ data: [] }) }),
  });
  expect(responses).toEqual([]);

  const messages = await anthropicProtocol.listModels(connection, {
    http: createJsonHttpClient({ fetchImpl: fixedFetch({ data: [] }) }),
  });
  expect(messages).toEqual([]);

  const gemini = await geminiProtocol.listModels(connection, {
    http: createJsonHttpClient({ fetchImpl: fixedFetch({ models: [] }) }),
  });
  expect(gemini).toEqual([]);

  const invalid = createJsonHttpClient({ fetchImpl: fixedFetch({}) });
  await expect(openAIChatProtocol.listModels(connection, { http: invalid })).rejects.toMatchObject({
    kind: "invalid_response",
    message: t("protocol.error.missingModels"),
  });
  await expect(anthropicProtocol.listModels(connection, { http: invalid })).rejects.toMatchObject({
    kind: "invalid_response",
    message: t("protocol.error.missingModels"),
  });
  await expect(geminiProtocol.listModels(connection, { http: invalid })).rejects.toMatchObject({
    kind: "invalid_response",
    message: t("protocol.error.missingGeminiModels"),
  });
});

test("ai protocol: blank model IDs are rejected before any request", () => {
  for (const protocol of [
    openAIChatProtocol,
    openAIResponsesProtocol,
    anthropicProtocol,
    geminiProtocol,
  ]) {
    expect(() =>
      protocol.resolveTarget(
        { baseUrl: "https://proxy.example.com/v1", credential: "sk-dummy" },
        { kind: "model", modelId: "   " },
      ),
    ).toThrow(t("models.error.modelIdRequired"));
  }
});

test("ai protocol: existing /v1 and /v1beta roots stay normalized", () => {
  const messagesBase = { credential: "sk-ant-dummy" };
  for (const baseUrl of [
    "https://proxy.example.com/claude",
    "https://proxy.example.com/claude/v1",
  ]) {
    const target = anthropicProtocol.resolveTarget(
      { ...messagesBase, baseUrl },
      { kind: "model", modelId: "claude-sonnet-4" },
    );
    expect(target.url).toBe("https://proxy.example.com/claude/v1/messages");

    const catalog = anthropicProtocol.resolveTarget(
      { ...messagesBase, baseUrl },
      { kind: "catalog" },
    );
    expect(catalog.url).toBe("https://proxy.example.com/claude/v1/models");
  }

  for (const baseUrl of [
    "https://proxy.example.com/gemini",
    "https://proxy.example.com/gemini/v1",
    "https://proxy.example.com/gemini/v1beta",
  ]) {
    const target = geminiProtocol.resolveTarget(
      { baseUrl, credential: "AIza-dummy" },
      { kind: "model", modelId: "gemini-2.5-pro" },
    );
    expect(target.url).toBe(
      "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-pro:generateContent?key=AIza-dummy",
    );
  }
});

test("text generation: Chat Completions sends messages and returns Bonjour", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        choices: [{ message: { content: "Bonjour" } }],
      },
      log,
    ),
  });

  const text = await openAIChatProtocol.generateText!(
    { baseUrl: "https://proxy.example.com/ai/v1", credential: "sk-dummy" },
    {
      modelId: "gpt-4.1",
      system: "Translate to French",
      user: "Hello",
      temperature: null,
      maxOutputTokens: null,
    },
    { http },
  );

  expect(text).toBe("Bonjour");
  expect(log).toHaveLength(1);
  expect(log[0]!.method).toBe("POST");
  expect(log[0]!.url).toBe("https://proxy.example.com/ai/v1/chat/completions");
  expect(log[0]!.headers.Authorization).toBe("Bearer sk-dummy");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: "Translate to French" },
      { role: "user", content: "Hello" },
    ],
    stream: false,
  });
});

test("text generation: Responses sends instructions and input and returns Bonjour", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "Ignoring reasoning" }] },
          { type: "function_call", name: "lookup", arguments: "{}" },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Bon" },
              { type: "refusal", refusal: "no" },
              { type: "output_text", text: "jour" },
            ],
          },
        ],
      },
      log,
    ),
  });

  const text = await openAIResponsesProtocol.generateText!(
    { baseUrl: "https://gateway.example.com/ai/v1", credential: "sk-dummy" },
    {
      modelId: "gpt-4.1",
      system: "Translate to French",
      user: "Hello",
      temperature: 0.3,
      maxOutputTokens: 200,
    },
    { http },
  );

  expect(text).toBe("Bonjour");
  expect(log).toHaveLength(1);
  expect(log[0]!.method).toBe("POST");
  expect(log[0]!.url).toBe("https://gateway.example.com/ai/v1/responses");
  expect(log[0]!.headers.Authorization).toBe("Bearer sk-dummy");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "gpt-4.1",
    instructions: "Translate to French",
    input: "Hello",
    stream: false,
    temperature: 0.3,
    max_output_tokens: 200,
  });
});

test("text generation: Messages sends system, user, and default max_tokens 1024", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        content: [
          { type: "thinking", thinking: "Internal thinking" },
          { type: "tool_use", id: "tool_1", name: "dict", input: {} },
          { type: "text", text: "Bon" },
          { type: "text", text: "jour" },
        ],
      },
      log,
    ),
  });

  const text = await anthropicProtocol.generateText!(
    { baseUrl: "https://proxy.example.com/claude", credential: "sk-ant-dummy" },
    {
      modelId: "claude-sonnet-4",
      system: "Translate to French",
      user: "Hello",
      temperature: null,
      maxOutputTokens: null,
    },
    { http },
  );

  expect(text).toBe("Bonjour");
  expect(log).toHaveLength(1);
  expect(log[0]!.method).toBe("POST");
  expect(log[0]!.url).toBe("https://proxy.example.com/claude/v1/messages");
  expect(log[0]!.headers["x-api-key"]).toBe("sk-ant-dummy");
  expect(log[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "claude-sonnet-4",
    system: "Translate to French",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 1024,
    stream: false,
  });
});

test("text generation: Gemini sends systemInstruction and contents and excludes thought/tool blocks", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "hidden thought" },
                { functionCall: { name: "helper", args: {} } },
                { text: "Bon" },
                { text: "jour" },
              ],
            },
          },
        ],
      },
      log,
    ),
  });

  const text = await geminiProtocol.generateText!(
    { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" },
    {
      modelId: "gemini-2.5-flash",
      system: "Translate to French",
      user: "Hello",
      temperature: null,
      maxOutputTokens: null,
    },
    { http },
  );

  expect(text).toBe("Bonjour");
  expect(log).toHaveLength(1);
  expect(log[0]!.method).toBe("POST");
  expect(log[0]!.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-dummy",
  );
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    systemInstruction: { parts: [{ text: "Translate to French" }] },
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  });

  await geminiProtocol.generateText!(
    { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" },
    {
      modelId: "gemini-2.5-flash",
      system: "",
      user: "Hello",
      temperature: 0.4,
      maxOutputTokens: 512,
    },
    { http },
  );
  expect(JSON.parse(log[1]!.body!)).toEqual({
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
    },
  });
});

/** Serves server-sent events from an in-memory stream and records the request. */
function sseFetch(events: readonly string[], log?: RequestLog[]): FetchLike {
  return async (url, init) => {
    log?.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
    });
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      }),
    };
  };
}

test("text streaming: Chat streams deltas and sends its reasoning-off field", async () => {
  const log: RequestLog[] = [];
  const partials: string[] = [];
  const http = createJsonHttpClient({
    fetchImpl: sseFetch(
      [
        'data: {"choices":[{"delta":{"content":"Bon"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"jour"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
      log,
    ),
  });

  const text = await openAIChatProtocol.streamText!(
    { baseUrl: "https://proxy.example.com/ai/v1", credential: "sk-dummy" },
    { modelId: "gpt-4.1", system: "Sys", user: "Hello", disableReasoning: true },
    { http, onText: (next) => partials.push(next) },
  );

  expect(text).toBe("Bonjour");
  expect(partials).toEqual(["Bon", "Bonjour"]);
  expect(log[0]!.url).toBe("https://proxy.example.com/ai/v1/chat/completions");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: "Sys" },
      { role: "user", content: "Hello" },
    ],
    stream: true,
    reasoning_effort: "none",
  });
});

test("text streaming: Responses streams output_text deltas and sends its reasoning-off field", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: sseFetch(
      [
        'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Bon"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"jour"}\n\n',
      ],
      log,
    ),
  });

  const text = await openAIResponsesProtocol.streamText!(
    { baseUrl: "https://gateway.example.com/ai/v1", credential: "sk-dummy" },
    { modelId: "gpt-4.1", system: "Sys", user: "Hello", disableReasoning: true },
    { http, onText: () => {} },
  );

  expect(text).toBe("Bonjour");
  expect(log[0]!.url).toBe("https://gateway.example.com/ai/v1/responses");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "gpt-4.1",
    input: "Hello",
    instructions: "Sys",
    stream: true,
    reasoning: { effort: "none" },
  });
});

test("text streaming: Messages streams text deltas, ignores thinking, and disables thinking", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: sseFetch(
      [
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"jour"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ],
      log,
    ),
  });

  const text = await anthropicProtocol.streamText!(
    { baseUrl: "https://proxy.example.com/deepseek", credential: "sk-ds" },
    { modelId: "deepseek-chat", system: "Sys", user: "Hello", disableReasoning: true },
    { http, onText: () => {} },
  );

  expect(text).toBe("Bonjour");
  expect(log[0]!.url).toBe("https://proxy.example.com/deepseek/v1/messages");
  expect(JSON.parse(log[0]!.body!)).toMatchObject({
    model: "deepseek-chat",
    stream: true,
    thinking: { type: "disabled" },
  });
});

test("text streaming: Gemini streams candidate parts from the SSE endpoint with thinking off", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: sseFetch(
      [
        'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"hmm"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"Bon"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"jour"}]}}]}\n\n',
      ],
      log,
    ),
  });

  const text = await geminiProtocol.streamText!(
    { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" },
    { modelId: "gemini-2.5-flash", system: "Sys", user: "Hello", disableReasoning: true },
    { http, onText: () => {} },
  );

  expect(text).toBe("Bonjour");
  expect(log[0]!.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=AIza-dummy",
  );
  expect(JSON.parse(log[0]!.body!)).toEqual({
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    systemInstruction: { parts: [{ text: "Sys" }] },
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });
});

test("text streaming: a buffered body from a gateway that ignores the stream flag is read once", async () => {
  const partials: string[] = [];
  const http = createJsonHttpClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => JSON.stringify({ choices: [{ message: { content: "Bonjour" } }] }),
    }),
  });

  const text = await openAIChatProtocol.streamText!(
    { baseUrl: "https://proxy.example.com/ai/v1", credential: "sk-dummy" },
    { modelId: "gpt-4.1", system: "Sys", user: "Hello" },
    { http, onText: (next) => partials.push(next) },
  );

  expect(text).toBe("Bonjour");
  expect(partials).toEqual(["Bonjour"]);
});

test("text streaming: reports an interrupted provider stream as invalid_response", async () => {
  const http = createJsonHttpClient({
    fetchImpl: sseFetch([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}\n\n',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
    ]),
  });

  await expect(
    anthropicProtocol.streamText!(
      { baseUrl: "https://proxy.example.com/v1", credential: "sk-dummy" },
      { modelId: "m-1", system: "s", user: "u" },
      { http, onText: () => {} },
    ),
  ).rejects.toMatchObject({
    kind: "invalid_response",
    message: t("protocol.error.streamInterrupted"),
  });
});

test("text generation: rejects missing or blank text output as invalid_response", async () => {
  const connection = { baseUrl: "https://proxy.example.com/v1", credential: "sk-dummy" };
  const cases = [
    { protocol: openAIChatProtocol, body: { choices: [{ message: { content: "   " } }] } },
    {
      protocol: openAIChatProtocol,
      body: { choices: [{ message: { content: [{ type: "reasoning", text: "think" }] } }] },
    },
    { protocol: openAIResponsesProtocol, body: { output: [{ type: "reasoning", text: "think" }] } },
    { protocol: openAIResponsesProtocol, body: { output: [{ type: "message", content: [] }] } },
    { protocol: anthropicProtocol, body: { content: [{ type: "thinking", thinking: "think" }] } },
    { protocol: anthropicProtocol, body: { content: [{ type: "text", text: " \n " }] } },
    {
      protocol: geminiProtocol,
      body: { candidates: [{ content: { parts: [{ thought: true, text: "x" }] } }] },
    },
    { protocol: geminiProtocol, body: { candidates: [] } },
  ];

  for (const item of cases) {
    const http = createJsonHttpClient({ fetchImpl: fixedFetch(item.body) });
    await expect(
      item.protocol.generateText!(connection, { modelId: "m-1", system: "s", user: "u" }, { http }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  }
});

/** Smallest valid PNG payload; the protocols treat the bytes as opaque. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_IMAGE = { mimeType: "image/png" as const, base64: PNG_BASE64 };
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const IMAGE_ANSWER = "first line\n第二行";

test("protocol image input: the client sends a PNG through the Responses adapter", async () => {
  const log: RequestLog[] = [];
  const registry = createAiRegistry();
  registry.registerProtocol(openAIResponsesProtocol);
  registry.registerProvider({
    id: "example:vision",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["openai-responses"],
    defaultProtocolId: "openai-responses",
    defaultBaseUrl: "https://gateway.example.com/ai/v1",
    catalogProviderId: null,
  });
  const client = createAiClient({
    registry,
    http: createJsonHttpClient({
      fetchImpl: fixedFetch(
        {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: IMAGE_ANSWER }],
            },
          ],
        },
        log,
      ),
    }),
  });

  const text = await client.generateTextFromImage(
    {
      providerTypeId: "example:vision",
      protocolId: "openai-responses",
      baseUrl: "https://gateway.example.com/ai/v1",
      credential: "sk-dummy",
    },
    {
      modelId: "gpt-4.1",
      system: "Transcribe.",
      user: "Read the text in this image.",
      image: PNG_IMAGE,
    },
  );

  expect(text).toBe(IMAGE_ANSWER);
  expect(log).toHaveLength(1);
  expect(log[0]!.method).toBe("POST");
  expect(log[0]!.url).toBe("https://gateway.example.com/ai/v1/responses");
  expect(log[0]!.headers.Authorization).toBe("Bearer sk-dummy");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "gpt-4.1",
    instructions: "Transcribe.",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Read the text in this image." },
          { type: "input_image", image_url: PNG_DATA_URL },
        ],
      },
    ],
    stream: false,
  });
});

test("protocol image input: Chat sends a text part and an image_url part", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      { choices: [{ message: { content: "第一行" }, finish_reason: "stop" }] },
      log,
    ),
  });

  const text = await openAIChatProtocol.generateTextFromImage!(
    { baseUrl: "https://proxy.example.com/ai/v1", credential: "sk-dummy" },
    {
      modelId: "gpt-4.1",
      system: "Transcribe.",
      user: "Read the text in this image.",
      image: PNG_IMAGE,
    },
    { http },
  );

  expect(text).toBe("第一行");
  expect(log).toHaveLength(1);
  expect(log[0]!.url).toBe("https://proxy.example.com/ai/v1/chat/completions");
  expect(log[0]!.headers.Authorization).toBe("Bearer sk-dummy");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: "Transcribe." },
      {
        role: "user",
        content: [
          { type: "text", text: "Read the text in this image." },
          { type: "image_url", image_url: { url: PNG_DATA_URL } },
        ],
      },
    ],
    stream: false,
  });
});

test("protocol image input: Messages sends a base64 image block", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "第二行" },
        ],
      },
      log,
    ),
  });

  const text = await anthropicProtocol.generateTextFromImage!(
    { baseUrl: "https://proxy.example.com/claude", credential: "sk-ant-dummy" },
    {
      modelId: "claude-sonnet-4",
      system: "",
      user: "Read the text in this image.",
      image: PNG_IMAGE,
    },
    { http },
  );

  expect(text).toBe("第二行");
  expect(log).toHaveLength(1);
  expect(log[0]!.url).toBe("https://proxy.example.com/claude/v1/messages");
  expect(log[0]!.headers["x-api-key"]).toBe("sk-ant-dummy");
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    model: "claude-sonnet-4",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the text in this image." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
          },
        ],
      },
    ],
    max_tokens: 1024,
    stream: false,
  });
});

test("protocol image input: Gemini sends inlineData parts", async () => {
  const log: RequestLog[] = [];
  const http = createJsonHttpClient({
    fetchImpl: fixedFetch(
      {
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ thought: true, text: "hidden" }, { text: "第一行" }] },
          },
        ],
      },
      log,
    ),
  });

  const text = await geminiProtocol.generateTextFromImage!(
    { baseUrl: "https://proxy.example.com/gemini", credential: "AIza-dummy" },
    {
      modelId: "gemini-2.5-flash",
      system: "Transcribe.",
      user: "Read the text in this image.",
      image: PNG_IMAGE,
    },
    { http },
  );

  expect(text).toBe("第一行");
  expect(log).toHaveLength(1);
  expect(log[0]!.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-dummy",
  );
  expect(log[0]!.redirect).toBe("error");
  expect(JSON.parse(log[0]!.body!)).toEqual({
    systemInstruction: { parts: [{ text: "Transcribe." }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "Read the text in this image." },
          { inlineData: { mimeType: "image/png", data: PNG_BASE64 } },
        ],
      },
    ],
  });
});

test("protocol image input: rejects a protocol without image support before any request", async () => {
  const log: RequestLog[] = [];
  const textOnlyProtocol: ProtocolDefinition = {
    id: "text-only",
    labelKey: "ai.protocol.openaiChat",
    resolveTarget: () => ({
      method: "POST",
      url: "https://text-only.test/generate",
      headers: {},
    }),
    listModels: async () => [],
    generateText: async () => "text",
  };
  const registry = createAiRegistry();
  registry.registerProtocol(textOnlyProtocol);
  registry.registerProvider({
    id: "example:text",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["text-only"],
    defaultProtocolId: "text-only",
    defaultBaseUrl: "https://text-only.test",
    catalogProviderId: null,
  });
  const client = createAiClient({
    registry,
    http: createJsonHttpClient({ fetchImpl: fixedFetch({}, log) }),
  });

  await expect(
    client.generateTextFromImage(
      {
        providerTypeId: "example:text",
        protocolId: "text-only",
        baseUrl: "https://text-only.test",
        credential: null,
      },
      { modelId: "m-1", system: "", user: "u", image: PNG_IMAGE },
    ),
  ).rejects.toMatchObject({
    kind: "invalid_request",
    message: t("models.error.unsupportedProtocol"),
  });
  expect(log).toHaveLength(0);
});

test("protocol image input: rejects output the provider marks as truncated", async () => {
  const connection = {
    baseUrl: "https://proxy.example.com/v1",
    credential: "sk-dummy",
  };
  const request = { modelId: "m-1", system: "", user: "u", image: PNG_IMAGE };
  const cases = [
    {
      protocol: openAIChatProtocol,
      body: { choices: [{ message: { content: "partial" }, finish_reason: "length" }] },
    },
    {
      protocol: openAIResponsesProtocol,
      body: {
        status: "incomplete",
        output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
      },
    },
    {
      protocol: anthropicProtocol,
      body: {
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "partial" }],
      },
    },
    {
      protocol: geminiProtocol,
      body: {
        candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }],
      },
    },
  ];

  for (const item of cases) {
    const http = createJsonHttpClient({ fetchImpl: fixedFetch(item.body) });
    await expect(
      item.protocol.generateTextFromImage!(connection, request, { http }),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      message: t("protocol.error.outputTruncated"),
    });
  }
});
