import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { openAIChatProtocol } from "../protocols/openai-chat";
import { createAiClient, type AiClientInput } from "./client";
import { createJsonHttpClient, type FetchLike } from "./http";
import { createAiRegistry } from "./registry";

interface Harness {
  client: ReturnType<typeof createAiClient>;
  requests: Array<{ url: string; method: string; headers: Record<string, string> }>;
}

function createHarness(fetchImpl?: FetchLike): Harness {
  const requests: Harness["requests"] = [];
  const registry = createAiRegistry();
  registry.registerProtocol(openAIChatProtocol);
  registry.registerProvider({
    id: "example:provider",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["openai-compatible"],
    defaultProtocolId: "openai-compatible",
    defaultBaseUrl: "https://example.test/v1",
    catalogProviderId: null,
  });

  const capture: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "model-a" }] }) };
  };

  return {
    client: createAiClient({
      registry,
      http: createJsonHttpClient({ fetchImpl: fetchImpl ?? capture }),
    }),
    requests,
  };
}

function input(overrides: Partial<AiClientInput> = {}): AiClientInput {
  return {
    providerTypeId: "example:provider",
    protocolId: "openai-compatible",
    baseUrl: "https://proxy.example.com/ai/v1/",
    credential: "sk-dummy",
    ...overrides,
  };
}

async function expectClientError(
  run: () => Promise<unknown>,
  expected: { kind: string; message: string; status?: number },
): Promise<void> {
  let caught: unknown = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: "ProviderProtocolError",
    kind: expected.kind,
    message: expected.message,
    ...(expected.status === undefined ? {} : { status: expected.status }),
  });
}

test("ai client: testConnection uses the configured root and the provider default", async () => {
  const harness = createHarness();

  await expect(harness.client.testConnection(input())).resolves.toEqual({ modelCount: 1 });
  expect(harness.requests).toEqual([
    {
      url: "https://proxy.example.com/ai/v1/models",
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer sk-dummy" },
    },
  ]);

  await harness.client.testConnection(input({ baseUrl: null }));
  expect(harness.requests[1]).toEqual({
    url: "https://example.test/v1/models",
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer sk-dummy" },
  });
});

test("ai client: resolves a model target through the selected protocol", () => {
  const harness = createHarness();
  const target = harness.client.resolveRequestTarget(input(), {
    kind: "model",
    modelId: "gpt-4.1",
  });

  expect(target.method).toBe("POST");
  expect(target.url).toBe("https://proxy.example.com/ai/v1/chat/completions");
  expect(target.headers.Authorization).toBe("Bearer sk-dummy");
});

test("ai client: rejects a protocol the provider does not allow", async () => {
  const harness = createHarness();
  await expectClientError(() => harness.client.testConnection(input({ protocolId: "anthropic" })), {
    kind: "invalid_request",
    message: t("models.error.unsupportedProtocol"),
  });
  expect(harness.requests).toEqual([]);
});

test("ai client: requires a root when the provider has no default", async () => {
  const registry = createAiRegistry();
  registry.registerProtocol(openAIChatProtocol);
  registry.registerProvider({
    id: "example:custom",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["openai-compatible"],
    defaultProtocolId: "openai-compatible",
    defaultBaseUrl: null,
    catalogProviderId: null,
  });
  const client = createAiClient({
    registry,
    http: createJsonHttpClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    }),
  });

  await expectClientError(
    () => client.testConnection(input({ providerTypeId: "example:custom", baseUrl: "   " })),
    { kind: "invalid_request", message: t("models.error.baseUrlRequired") },
  );
});

test("ai client: reports HTTP authentication failures", async () => {
  const harness = createHarness(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await expectClientError(() => harness.client.testConnection(input()), {
    kind: "auth",
    message: t("protocol.error.auth", { status: 401 }),
    status: 401,
  });

  const forbidden = createHarness(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  await expectClientError(() => forbidden.client.testConnection(input()), {
    kind: "auth",
    message: t("protocol.error.auth", { status: 403 }),
    status: 403,
  });
});

test("ai client: reports rate limiting and server failures", async () => {
  const limited = createHarness(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  await expectClientError(() => limited.client.testConnection(input()), {
    kind: "rate_limited",
    message: t("protocol.error.rateLimited", { status: 429 }),
    status: 429,
  });

  const broken = createHarness(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await expectClientError(() => broken.client.testConnection(input()), {
    kind: "server",
    message: t("protocol.error.server", { status: 500 }),
    status: 500,
  });

  const rejected = createHarness(async () => ({ ok: false, status: 418, json: async () => ({}) }));
  await expectClientError(() => rejected.client.testConnection(input()), {
    kind: "invalid_request",
    message: t("protocol.error.rejected", { status: 418 }),
    status: 418,
  });
});

test("ai client: rejects an unreadable body and an unexpected shape", async () => {
  const unreadable = createHarness(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
  }));
  await expectClientError(() => unreadable.client.testConnection(input()), {
    kind: "invalid_response",
    message: t("protocol.error.unreadable"),
  });

  const wrongShape = createHarness(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
  }));
  await expectClientError(() => wrongShape.client.testConnection(input()), {
    kind: "invalid_response",
    message: t("protocol.error.unexpectedShape"),
  });
});

test("ai client: reports network failures", async () => {
  const harness = createHarness(async () => {
    throw new Error("offline");
  });
  await expectClientError(() => harness.client.testConnection(input()), {
    kind: "network",
    message: t("protocol.error.network", { detail: "offline" }),
  });
});

test("ai client: times out a pending request", async () => {
  const harness = createHarness(
    (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  await expectClientError(() => harness.client.testConnection(input(), { timeoutMs: 5 }), {
    kind: "timeout",
    message: t("protocol.error.timeout"),
  });
});

test("ai client: cancels an external request", async () => {
  const harness = createHarness();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expectClientError(
    () => harness.client.testConnection(input(), { signal: alreadyAborted.signal }),
    { kind: "cancelled", message: t("protocol.error.cancelled") },
  );
  expect(harness.requests).toEqual([]);

  const pending = createHarness(
    (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  const controller = new AbortController();
  const call = pending.client.testConnection(input(), { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await expectClientError(() => call, {
    kind: "cancelled",
    message: t("protocol.error.cancelled"),
  });
});
