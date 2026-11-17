import { t } from "nsh/i18n";
import { expect, test } from "nsh/test";
import { anthropicProtocol } from "../protocols/anthropic";
import { geminiProtocol } from "../protocols/gemini";
import { openAIChatProtocol } from "../protocols/openai-chat";
import { openAIResponsesProtocol } from "../protocols/openai-responses";
import { anthropicProvider } from "../providers/anthropic/definition";
import { customProvider } from "../providers/custom/definition";
import { deepseekProvider } from "../providers/deepseek/definition";
import { geminiProvider } from "../providers/gemini/definition";
import { openaiProvider } from "../providers/openai/definition";
import {
  createCatalog,
  type CatalogDeps,
  type CatalogIndex,
} from "../../../services/models-dev/catalog";
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
function registerBuiltIns(registry: ReturnType<typeof createAiRegistry>): void {
  registry.registerProtocol(openAIChatProtocol);
  registry.registerProtocol(openAIResponsesProtocol);
  registry.registerProtocol(anthropicProtocol);
  registry.registerProtocol(geminiProtocol);
  registry.registerProvider(openaiProvider);
  registry.registerProvider(geminiProvider);
  registry.registerProvider(anthropicProvider);
  registry.registerProvider(deepseekProvider);
  registry.registerProvider(customProvider);
}

function createBuiltInHarness(
  fetchImpl?: FetchLike,
  loadCatalog?: () => Promise<CatalogIndex | null>,
): Harness {
  const requests: Harness["requests"] = [];
  const registry = createAiRegistry();
  registerBuiltIns(registry);
  const capture: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers });
    if (fetchImpl) return fetchImpl(url, init);
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "model-a" }] }) };
  };
  return {
    client: createAiClient({
      registry,
      http: createJsonHttpClient({ fetchImpl: capture }),
      loadCatalog,
    }),
    requests,
  };
}

test("ai client: DeepSeek catalog stays shared with Messages selected", async () => {
  const harness = createBuiltInHarness();

  const result = await harness.client.testConnection({
    providerTypeId: "deepseek",
    protocolId: "anthropic",
    baseUrl: "https://proxy.example.com/deepseek",
    credential: "sk-ds-dummy",
  });

  expect(result).toEqual({ modelCount: 1 });
  expect(harness.requests).toEqual([
    {
      url: "https://proxy.example.com/deepseek/models",
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer sk-ds-dummy" },
    },
  ]);
});

test("ai client: DeepSeek Messages preserves its proxy origin", () => {
  const harness = createBuiltInHarness();

  for (const baseUrl of [
    "https://proxy.example.com/deepseek",
    "https://proxy.example.com/deepseek/v1",
    "https://proxy.example.com/deepseek/anthropic",
    "https://proxy.example.com/deepseek/anthropic/v1",
  ]) {
    const target = harness.client.resolveRequestTarget(
      {
        providerTypeId: "deepseek",
        protocolId: "anthropic",
        baseUrl,
        credential: "sk-ds-dummy",
      },
      { kind: "model", modelId: "deepseek-chat" },
    );
    expect(target.url).toBe("https://proxy.example.com/deepseek/anthropic/v1/messages");
    expect(target.headers["x-api-key"]).toBe("sk-ds-dummy");
    expect(target.headers["anthropic-version"]).toBe("2023-06-01");
  }
});

test("ai client: provider policy sets defaults, fixed choices, and real roots", () => {
  const harness = createBuiltInHarness();
  const registry = createAiRegistry();
  registerBuiltIns(registry);

  expect(registry.getProvider("openai").defaultProtocolId).toBe("openai-responses");
  expect(registry.getProvider("gemini").allowedProtocolIds).toEqual(["gemini"]);
  expect(registry.getProvider("anthropic").allowedProtocolIds).toEqual(["anthropic"]);
  expect(registry.getProvider("custom").defaultBaseUrl).toBeNull();
  expect(registry.getProvider("custom").allowedProtocolIds).toHaveLength(4);
  expect(registry.getProvider("gemini").catalogProviderId).toBe("google");

  const openaiModel = harness.client.resolveRequestTarget(
    { providerTypeId: "openai", protocolId: "openai-responses", baseUrl: null, credential: "sk" },
    { kind: "model", modelId: "gpt-4.1" },
  );
  expect(openaiModel.url).toBe("https://api.openai.com/v1/responses");

  const geminiModel = harness.client.resolveRequestTarget(
    { providerTypeId: "gemini", protocolId: "gemini", baseUrl: null, credential: "AIza" },
    { kind: "model", modelId: "gemini-2.5-pro" },
  );
  expect(geminiModel.url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=AIza",
  );

  const anthropicModel = harness.client.resolveRequestTarget(
    { providerTypeId: "anthropic", protocolId: "anthropic", baseUrl: null, credential: "sk-ant" },
    { kind: "model", modelId: "claude-sonnet-4" },
  );
  expect(anthropicModel.url).toBe("https://api.anthropic.com/v1/messages");
});

test("ai client: a disallowed protocol rejects even for fixed-catalog discovery", async () => {
  const harness = createBuiltInHarness();
  await expectClientError(
    () =>
      harness.client.testConnection({
        providerTypeId: "deepseek",
        protocolId: "gemini",
        baseUrl: "https://proxy.example.com/deepseek",
        credential: "sk-ds-dummy",
      }),
    { kind: "invalid_request", message: t("models.error.unsupportedProtocol") },
  );
  expect(harness.requests).toEqual([]);
});

test("ai client: Custom has no default root", async () => {
  const harness = createBuiltInHarness();
  await expectClientError(
    () =>
      harness.client.testConnection({
        providerTypeId: "custom",
        protocolId: "openai-compatible",
        baseUrl: "  ",
        credential: "sk",
      }),
    { kind: "invalid_request", message: t("models.error.baseUrlRequired") },
  );
  expect(harness.requests).toEqual([]);
});

test("ai client: provider root policy cannot switch the configured origin", async () => {
  const registry = createAiRegistry();
  registry.registerProtocol(openAIChatProtocol);
  registry.registerProvider({
    id: "example:redirect",
    labelKey: "models.preset.custom",
    allowedProtocolIds: ["openai-compatible"],
    defaultProtocolId: "openai-compatible",
    defaultBaseUrl: "https://example.test/v1",
    catalogProviderId: null,
    resolveBaseUrl: () => "https://elsewhere.example.com/v1",
  });
  const client = createAiClient({
    registry,
    http: createJsonHttpClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    }),
  });

  await expectClientError(
    () =>
      client.testConnection({
        providerTypeId: "example:redirect",
        protocolId: "openai-compatible",
        baseUrl: "https://proxy.example.com/v1",
        credential: "sk",
      }),
    { kind: "invalid_request", message: t("ai.error.providerOriginChanged") },
  );
});
const DAY_MS = 24 * 60 * 60 * 1000;

function catalogBoundary(
  options: { body?: Record<string, unknown>; fail?: boolean; cache?: string | null } = {},
): () => Promise<CatalogIndex | null> {
  const deps: Partial<CatalogDeps> = {
    now: () => 1_000_000,
    readCache: async () => options.cache ?? null,
    writeCache: async () => {},
    fetchCatalog: async () => {
      if (options.fail) throw new Error("offline");
      return JSON.stringify(options.body ?? {});
    },
  };
  const catalog = createCatalog(deps);
  return () => catalog.load();
}

const GEMINI_CATALOG = {
  "google/gemini-2.5-flash": {
    modalities: { input: ["text", "image", "pdf", "video"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  "other/gemini-2.5-flash": {
    modalities: { input: ["text"] },
    limit: { context: 8_000, output: 1_000 },
  },
};

const geminiDiscoveryInput: AiClientInput = {
  providerTypeId: "gemini",
  protocolId: "gemini",
  baseUrl: "https://proxy.example.com/gemini",
  credential: "AIza-dummy",
};

function geminiListing(fetchImpl?: FetchLike): FetchLike {
  return (
    fetchImpl ??
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: "models/gemini-2.5-flash" }] }),
    }))
  );
}

test("ai client: discovery uses the provider catalog mapping", async () => {
  const harness = createBuiltInHarness(
    geminiListing(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ name: "models/gemini-2.5-flash", inputTokenLimit: 500_000 }],
      }),
    })),
    catalogBoundary({ body: GEMINI_CATALOG }),
  );

  const models = await harness.client.discoverModels(geminiDiscoveryInput);

  expect(harness.requests[0]!.url).toBe(
    "https://proxy.example.com/gemini/v1beta/models?key=AIza-dummy",
  );
  expect(models).toEqual([
    {
      modelKey: "gemini-2.5-flash",
      displayName: null,
      // The endpoint reports the deployment limit; the catalog fills what it omits.
      contextLimit: 500_000,
      maxTokens: 65_536,
      capabilities: { text: true, image: true, pdf: true, video: true },
    },
  ]);
});

test("ai client: discovery falls back when the catalog is unavailable", async () => {
  const offline = createBuiltInHarness(geminiListing(), catalogBoundary({ fail: true }));
  const offlineModels = await offline.client.discoverModels(geminiDiscoveryInput);
  expect(offlineModels).toEqual([
    {
      modelKey: "gemini-2.5-flash",
      displayName: null,
      contextLimit: null,
      maxTokens: null,
      capabilities: { text: true, image: true, pdf: true, video: true },
    },
  ]);

  const staleCache = JSON.stringify({
    fetchedAt: 1_000_000 - DAY_MS,
    models: {
      "google/gemini-2.5-flash": {
        text: true,
        image: true,
        pdf: true,
        video: false,
        contextLimit: 1_048_576,
        maxTokens: 65_536,
      },
    },
  });
  const stale = createBuiltInHarness(
    geminiListing(),
    catalogBoundary({ fail: true, cache: staleCache }),
  );
  const staleModels = await stale.client.discoverModels(geminiDiscoveryInput);
  expect(staleModels).toEqual([
    {
      modelKey: "gemini-2.5-flash",
      displayName: null,
      contextLimit: 1_048_576,
      maxTokens: 65_536,
      capabilities: { text: true, image: true, pdf: true, video: false },
    },
  ]);
});

test("ai client: a manual model resolves best-effort catalog facts", async () => {
  const harness = createBuiltInHarness(undefined, catalogBoundary({ body: GEMINI_CATALOG }));

  expect(
    await harness.client.resolveModelFacts({
      providerTypeId: "gemini",
      modelKey: "gemini-2.5-flash",
    }),
  ).toEqual({
    capabilities: { text: true, image: true, pdf: true, video: true },
    contextLimit: 1_048_576,
    maxTokens: 65_536,
  });

  expect(
    await harness.client.resolveModelFacts({ providerTypeId: "gemini", modelKey: "unknown-model" }),
  ).toBeNull();
});

test("ai client: cancellation after metadata prevents a result", async () => {
  let release: () => void = () => {};
  const pendingCatalog = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  const harness = createBuiltInHarness(geminiListing(), () => pendingCatalog);

  const controller = new AbortController();
  const call = harness.client.discoverModels(geminiDiscoveryInput, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  release();

  await expect(call).rejects.toMatchObject({
    kind: "cancelled",
    message: t("protocol.error.cancelled"),
  });
});
