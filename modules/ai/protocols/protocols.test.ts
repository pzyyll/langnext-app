import { expect, test } from "nsh/test";
import { createJsonHttpClient, type FetchLike } from "../runtime/http";
import { openAIChatProtocol } from "./openai-chat";

function jsonFetch(
  body: unknown,
  capture?: (url: string, headers: Record<string, string>) => void,
): FetchLike {
  return async (url, init) => {
    capture?.(url, init.headers);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
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
  const calls: string[] = [];
  const http = createJsonHttpClient({
    fetchImpl: jsonFetch(
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
      (url) => calls.push(url),
    ),
  });

  const models = await openAIChatProtocol.listModels(
    { baseUrl: "https://proxy.example.com/ai/v1", credential: "sk-dummy" },
    { http },
  );

  expect(calls).toEqual(["https://proxy.example.com/ai/v1/models"]);
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
