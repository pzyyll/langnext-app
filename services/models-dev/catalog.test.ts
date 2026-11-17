import { expect, test } from "nsh/test";
import { CATALOG_CACHE_KEY, createCatalog, type CatalogDeps } from "./catalog";

const DAY_MS = 24 * 60 * 60 * 1000;

const SAMPLE_CATALOG = JSON.stringify({
  "openai/gpt-4o-mini": {
    modalities: { input: ["text", "image", "pdf"] },
    limit: { context: 128_000, output: 16_384 },
  },
  "anthropic/claude-sonnet-4-5": {
    modalities: { input: ["text", "image", "pdf"] },
    limit: { context: 200_000, output: 64_000 },
  },
  "google/gemini-2.5-pro": {
    modalities: { input: ["text", "image", "pdf", "video"] },
    limit: { context: 1_048_576, output: 65_536 },
  },
  "deepseek/deepseek-chat": {
    modalities: { input: ["text"] },
    limit: { context: 128_000, output: 8_192 },
  },
});

interface Harness {
  catalog: ReturnType<typeof createCatalog>;
  fetches: () => number;
  stored: () => string | null;
}

function createHarness(
  options: { cache?: string | null; fetchBody?: string; failFetch?: boolean } = {},
): Harness {
  let fetches = 0;
  let cache = options.cache ?? null;
  const deps: Partial<CatalogDeps> = {
    now: () => 1_000_000,
    readCache: async () => cache,
    writeCache: async (value) => {
      cache = value;
    },
    fetchCatalog: async () => {
      fetches += 1;
      if (options.failFetch) {
        throw new Error("offline");
      }
      return options.fetchBody ?? SAMPLE_CATALOG;
    },
  };
  return {
    catalog: createCatalog(deps),
    fetches: () => fetches,
    stored: () => cache,
  };
}

test("models.dev catalog: looks up full, bare, and case-insensitive model IDs", async () => {
  const { catalog } = createHarness();
  const index = await catalog.load();
  expect(index).not.toBeNull();

  expect(index!.lookup("gpt-4o-mini", "openai")).toMatchObject({
    text: true,
    image: true,
    pdf: true,
    video: false,
    contextLimit: 128_000,
    maxTokens: 16_384,
  });
  expect(index!.lookup("openai/gpt-4o-mini", null)).toMatchObject({ contextLimit: 128_000 });
  expect(index!.lookup("GPT-4O-MINI", null)).toMatchObject({ image: true });
  expect(index!.lookup("claude-sonnet-4-5", "anthropic")).toMatchObject({
    contextLimit: 200_000,
    maxTokens: 64_000,
  });
  expect(index!.lookup("unknown-model", "openai")).toBeNull();
  expect(index!.lookup("   ", null)).toBeNull();
});

test("models.dev catalog: provider lookup wins over another provider's bare ID", async () => {
  const body = JSON.stringify({
    "openai/shared-model": { modalities: { input: ["text"] }, limit: { context: 8_000 } },
    "other/shared-model": {
      modalities: { input: ["text", "image"] },
      limit: { context: 32_000 },
    },
  });
  const { catalog } = createHarness({ fetchBody: body });
  const index = await catalog.load();

  expect(index!.lookup("shared-model", "openai")).toMatchObject({
    image: false,
    contextLimit: 8_000,
  });
  expect(index!.lookup("shared-model", "other")).toMatchObject({
    image: true,
    contextLimit: 32_000,
  });
});

test("models.dev catalog: merges duplicate bare IDs across providers", async () => {
  const body = JSON.stringify({
    "vendora/vision-model": {
      modalities: { input: ["text", "image"] },
      limit: { context: 100_000, output: 4_096 },
    },
    "vendorb/vision-model": {
      modalities: { input: ["text", "pdf"] },
      limit: { context: 200_000 },
    },
  });
  const { catalog } = createHarness({ fetchBody: body });
  const facts = (await catalog.load())!.lookup("vision-model", null);

  expect(facts).toMatchObject({
    text: true,
    image: true,
    pdf: true,
    video: false,
    contextLimit: 200_000,
    maxTokens: 4_096,
  });
});

test("models.dev catalog: treats missing modalities as text and drops empty limits", async () => {
  const body = JSON.stringify({
    "provider/bare-entry": {},
    "provider/zero-limits": { limit: { context: 0, output: -5 } },
  });
  const { catalog } = createHarness({ fetchBody: body });
  const index = await catalog.load();

  expect(index!.lookup("bare-entry", "provider")).toEqual({
    text: true,
    image: false,
    pdf: false,
    video: false,
    contextLimit: null,
    maxTokens: null,
  });
  expect(index!.lookup("zero-limits", "provider")).toMatchObject({
    contextLimit: null,
    maxTokens: null,
  });
});

test("models.dev catalog: caches derived facts and skips the network within the TTL", async () => {
  const harness = createHarness();
  await harness.catalog.load();
  expect(harness.fetches()).toBe(1);

  const cache = JSON.parse(harness.stored()!) as {
    fetchedAt: number;
    models: Record<string, unknown>;
  };
  expect(cache.fetchedAt).toBe(1_000_000);
  expect(Object.keys(cache.models)).toContain("openai/gpt-4o-mini");
  // The cache keeps derived facts only, not the raw catalog body.
  expect(cache.models["openai/gpt-4o-mini"]).toEqual({
    text: true,
    image: true,
    pdf: true,
    video: false,
    contextLimit: 128_000,
    maxTokens: 16_384,
  });

  const second = createHarness({ cache: harness.stored() });
  const facts = (await second.catalog.load())!.lookup("gpt-4o-mini", "openai");
  expect(facts).toMatchObject({ contextLimit: 128_000 });
  expect(second.fetches()).toBe(0);
});

test("models.dev catalog: refreshes an expired cache and falls back to it when offline", async () => {
  const expired = JSON.stringify({
    fetchedAt: 1_000_000 - DAY_MS,
    models: {
      "openai/gpt-4o-mini": {
        text: true,
        image: true,
        pdf: true,
        video: false,
        contextLimit: 128_000,
        maxTokens: 16_384,
      },
    },
  });

  const refreshed = createHarness({ cache: expired });
  expect((await refreshed.catalog.load())!.lookup("gpt-4o-mini", "openai")).toMatchObject({
    maxTokens: 16_384,
  });
  expect(refreshed.fetches()).toBe(1);

  const offline = createHarness({ cache: expired, failFetch: true });
  expect((await offline.catalog.load())!.lookup("gpt-4o-mini", "openai")).toMatchObject({
    contextLimit: 128_000,
  });
  expect(offline.fetches()).toBe(1);

  const empty = createHarness({ failFetch: true });
  expect(await empty.catalog.load()).toBeNull();
});

test("models.dev catalog: ignores a corrupt cache and refetches", async () => {
  const { catalog, fetches } = createHarness({ cache: "{not json" });
  const index = await catalog.load();

  expect(index!.lookup("gpt-4o-mini", "openai")).toMatchObject({ image: true });
  expect(fetches()).toBe(1);
});

test("models.dev catalog: shares one refresh between concurrent loads", async () => {
  const { catalog, fetches } = createHarness();
  const [first, second] = await Promise.all([catalog.load(), catalog.load()]);

  expect(fetches()).toBe(1);
  expect(first).toBe(second);
});

test("models.dev catalog: cache key is namespaced for the model metadata", () => {
  expect(CATALOG_CACHE_KEY).toBe("models.dev.catalog.v1");
});
