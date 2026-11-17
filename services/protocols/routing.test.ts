import { expect, test } from "nsh/test";
import { resolveRequestTarget } from "./routing";

test("provider routing: OpenAI Chat Completions catalog and model targets preserve prefix", () => {
  const catalog = resolveRequestTarget(
    {
      presetId: "openai",
      adapterId: "openai-compatible",
      baseUrl: "https://proxy.example.com/openai/v1/",
      credential: "sk-dummy",
    },
    { kind: "catalog" },
  );
  expect(catalog.method).toBe("GET");
  expect(catalog.url).toBe("https://proxy.example.com/openai/v1/models");
  expect(catalog.headers.Authorization).toBe("Bearer sk-dummy");

  const model = resolveRequestTarget(
    {
      presetId: "openai",
      adapterId: "openai-compatible",
      baseUrl: "https://proxy.example.com/openai/v1",
      credential: "sk-dummy",
    },
    { kind: "model", modelId: "gpt-4.1" },
  );
  expect(model.method).toBe("POST");
  expect(model.url).toBe("https://proxy.example.com/openai/v1/chat/completions");
  expect(model.headers.Authorization).toBe("Bearer sk-dummy");
});

test("provider routing: OpenAI Responses catalog and model targets preserve prefix", () => {
  const catalog = resolveRequestTarget(
    {
      presetId: "openai",
      adapterId: "openai-responses",
      baseUrl: null,
      credential: "sk-dummy",
    },
    { kind: "catalog" },
  );
  expect(catalog.method).toBe("GET");
  expect(catalog.url).toBe("https://api.openai.com/v1/models");
  expect(catalog.headers.Authorization).toBe("Bearer sk-dummy");

  const model = resolveRequestTarget(
    {
      presetId: "openai",
      adapterId: "openai-responses",
      baseUrl: "https://gateway.example.com/ai/v1",
      credential: "sk-dummy",
    },
    { kind: "model", modelId: "gpt-4.1" },
  );
  expect(model.method).toBe("POST");
  expect(model.url).toBe("https://gateway.example.com/ai/v1/responses");
  expect(model.headers.Authorization).toBe("Bearer sk-dummy");
});

test("provider routing: Anthropic Messages catalog and model targets preserve prefix", () => {
  const catalog = resolveRequestTarget(
    {
      presetId: "anthropic",
      adapterId: "anthropic",
      baseUrl: "https://proxy.example.com/claude/v1",
      credential: "sk-ant-dummy",
    },
    { kind: "catalog", queryExtras: { after_id: "claude-3-7" } },
  );
  expect(catalog.method).toBe("GET");
  expect(catalog.url).toBe("https://proxy.example.com/claude/v1/models?after_id=claude-3-7");
  expect(catalog.headers["x-api-key"]).toBe("sk-ant-dummy");
  expect(catalog.headers["anthropic-version"]).toBe("2023-06-01");

  const model = resolveRequestTarget(
    {
      presetId: "anthropic",
      adapterId: "anthropic",
      baseUrl: "https://proxy.example.com/claude",
      credential: "sk-ant-dummy",
    },
    { kind: "model", modelId: "claude-sonnet-4-20250514" },
  );
  expect(model.method).toBe("POST");
  expect(model.url).toBe("https://proxy.example.com/claude/v1/messages");
  expect(model.headers["x-api-key"]).toBe("sk-ant-dummy");
  expect(model.headers["anthropic-version"]).toBe("2023-06-01");
});

test("provider routing: Gemini API catalog and model targets preserve prefix", () => {
  const catalog = resolveRequestTarget(
    {
      presetId: "gemini",
      adapterId: "gemini",
      baseUrl: "https://proxy.example.com/gemini/v1beta",
      credential: "AIza-dummy",
    },
    { kind: "catalog", queryExtras: { pageToken: "next-page" } },
  );
  expect(catalog.method).toBe("GET");
  expect(catalog.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models?pageToken=next-page&key=AIza-dummy",
  );

  const model = resolveRequestTarget(
    {
      presetId: "gemini",
      adapterId: "gemini",
      baseUrl: "https://proxy.example.com/gemini",
      credential: "AIza-dummy",
    },
    { kind: "model", modelId: "gemini-2.5-flash" },
  );
  expect(model.method).toBe("POST");
  expect(model.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-dummy",
  );
});

test("provider routing: DeepSeek shares GET /models and routes Messages to /anthropic/v1/messages", () => {
  const catalogWithMessages = resolveRequestTarget(
    {
      presetId: "deepseek",
      adapterId: "anthropic",
      baseUrl: null,
      credential: "sk-ds-dummy",
    },
    { kind: "catalog" },
  );
  expect(catalogWithMessages.method).toBe("GET");
  expect(catalogWithMessages.url).toBe("https://api.deepseek.com/models");
  expect(catalogWithMessages.headers.Authorization).toBe("Bearer sk-ds-dummy");

  const messagesTarget = resolveRequestTarget(
    {
      presetId: "deepseek",
      adapterId: "anthropic",
      baseUrl: "https://proxy.example.com/deepseek",
      credential: "sk-ds-dummy",
    },
    { kind: "model", modelId: "deepseek-chat" },
  );
  expect(messagesTarget.method).toBe("POST");
  expect(messagesTarget.url).toBe("https://proxy.example.com/deepseek/anthropic/v1/messages");
  expect(messagesTarget.headers["x-api-key"]).toBe("sk-ds-dummy");
  expect(messagesTarget.headers["anthropic-version"]).toBe("2023-06-01");

  const responsesTarget = resolveRequestTarget(
    {
      presetId: "deepseek",
      adapterId: "openai-responses",
      baseUrl: null,
      credential: "sk-ds-dummy",
    },
    { kind: "model", modelId: "deepseek-reasoner" },
  );
  expect(responsesTarget.method).toBe("POST");
  expect(responsesTarget.url).toBe("https://api.deepseek.com/responses");
  expect(responsesTarget.headers.Authorization).toBe("Bearer sk-ds-dummy");
});

test("provider routing: Custom without base URL rejects instead of falling back", () => {
  expect(() =>
    resolveRequestTarget(
      {
        presetId: "custom",
        adapterId: "openai-compatible",
        baseUrl: "   ",
        credential: "sk-dummy",
      },
      { kind: "catalog" },
    ),
  ).toThrow("Base URL is required");
});
