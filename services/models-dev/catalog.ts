// ABOUTME: Client for the models.dev catalog that seeds model capabilities and token limits.
// ABOUTME: Refreshes https://models.dev/models.json once per 24h; the bundled snapshot answers when it cannot.
import { Storage } from "nsh";
import bundledCatalogUrl from "../../assets/catalog/models.dev.json?url";
import { createHttpFetch } from "../http";
import { createLogger } from "../log";

/** Provider-agnostic model metadata published from https://github.com/anomalyco/models.dev. */
const CATALOG_URL = "https://models.dev/models.json";
/** The copy of that catalog the app ships, refreshed by `mise run catalog`. */
const BUNDLED_CATALOG_URL = bundledCatalogUrl;
/** Storage key holding the derived catalog cache. */
export const CATALOG_CACHE_KEY = "models.dev.catalog.v1";
/** Refresh the remote catalog only after this age (24h). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound the catalog request so model discovery is not blocked indefinitely. */
const FETCH_TIMEOUT_MS = 15_000;
/** Soft cap on an accepted catalog body (10 Mi characters). */
const MAX_CATALOG_CHARS = 10 * 1024 * 1024;
/** Highest accepted token count, matching the catalog's 32-bit limits. */
const MAX_TOKEN_COUNT = 4_294_967_295;

const log = createLogger("models-dev/catalog");
const httpFetch = createHttpFetch({ scope: "models-dev/catalog" });
/** Local asset reads have nothing to abort. */
const NEVER_ABORTED = new AbortController().signal;

/** Capability flags and token limits the catalog reports for one model. */
export interface CatalogFacts {
  text: boolean;
  image: boolean;
  pdf: boolean;
  video: boolean;
  contextLimit: number | null;
  maxTokens: number | null;
}

/** Lookup index over one catalog snapshot, keyed by full and bare model IDs. */
export interface CatalogIndex {
  /** Resolves a model by `provider/model` when the provider is known, then by bare model ID. */
  lookup(modelKey: string, providerId: string | null): CatalogFacts | null;
}

/** Disk cache envelope so the refresh age survives restarts. */
interface CatalogCache {
  fetchedAt: number;
  models: Record<string, CatalogFacts>;
}

/** Injected dependencies, replaced in tests to avoid the network and app storage. */
export interface CatalogDeps {
  now: () => number;
  readCache: () => Promise<string | null>;
  writeCache: (value: string) => Promise<void>;
  fetchCatalog: () => Promise<string>;
  readBundledCatalog: () => Promise<string>;
}

/** Cached access to the models.dev catalog. */
export interface Catalog {
  /** Returns the catalog index, or `null` when the network, the cache and the bundle all fail. Never rejects. */
  load: () => Promise<CatalogIndex | null>;
}

/** Minimal models.dev entry shape; every other field is ignored. */
interface RawCatalogEntry {
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
}

/** Creates a catalog reader over the given dependencies, defaulting to the app's storage and network. */
export function createCatalog(deps: Partial<CatalogDeps> = {}): Catalog {
  const resolved: CatalogDeps = {
    now: deps.now ?? (() => Date.now()),
    readCache: deps.readCache ?? (() => Storage.getItem(CATALOG_CACHE_KEY)),
    writeCache: deps.writeCache ?? ((value) => Storage.setItem(CATALOG_CACHE_KEY, value)),
    fetchCatalog: deps.fetchCatalog ?? fetchCatalogBody,
    readBundledCatalog: deps.readBundledCatalog ?? fetchBundledCatalogBody,
  };
  let inFlight: Promise<CatalogIndex | null> | null = null;
  let bundledIndex: Promise<CatalogIndex | null> | null = null;

  const readBundledIndex = (): Promise<CatalogIndex | null> => {
    bundledIndex ??= (async () => {
      try {
        return buildIndex(parseCatalogBody(await resolved.readBundledCatalog()));
      } catch (error) {
        log.warn("Could not read the bundled models.dev catalog.", error);
        return null;
      }
    })();
    return bundledIndex;
  };

  const readCachedIndex = async (): Promise<{ index: CatalogIndex; fetchedAt: number } | null> => {
    let raw: string | null;
    try {
      raw = await resolved.readCache();
    } catch (error) {
      log.warn("Could not read the models.dev catalog cache.", error);
      return null;
    }
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const cache = parsed as Partial<CatalogCache>;
      if (
        typeof cache.fetchedAt !== "number" ||
        !cache.models ||
        typeof cache.models !== "object"
      ) {
        return null;
      }
      return { index: buildIndex(coerceCachedModels(cache.models)), fetchedAt: cache.fetchedAt };
    } catch (error) {
      log.warn("Could not parse the models.dev catalog cache.", error);
      return null;
    }
  };

  return {
    load: async () => {
      const cached = await readCachedIndex();
      const now = resolved.now();
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.index;
      }
      if (inFlight) {
        return inFlight;
      }

      const pending = (async (): Promise<CatalogIndex | null> => {
        try {
          const body = await resolved.fetchCatalog();
          const models = parseCatalogBody(body);
          try {
            await resolved.writeCache(JSON.stringify({ fetchedAt: now, models }));
          } catch (error) {
            log.warn("Could not cache the models.dev catalog.", error);
          }
          return buildIndex(models);
        } catch (error) {
          log.warn("Could not refresh the models.dev catalog.", error);
          // A stale cache is newer than the bundle, and the bundle is the last resort.
          return cached?.index ?? (await readBundledIndex());
        } finally {
          inFlight = null;
        }
      })();
      inFlight = pending;
      return pending;
    },
  };
}

const defaultCatalog = createCatalog();

/** Loads the shared catalog index, or `null` when the network, the cache and the bundle all fail. */
export function loadCatalog(): Promise<CatalogIndex | null> {
  return defaultCatalog.load();
}

/** Builds the lookup index from catalog facts keyed by full model ID. */
function buildIndex(models: Record<string, CatalogFacts>): CatalogIndex {
  const byFullId = new Map<string, CatalogFacts>();
  const byBareId = new Map<string, CatalogFacts>();

  for (const [fullId, facts] of Object.entries(models)) {
    byFullId.set(fullId.toLowerCase(), facts);
    mergeFacts(byBareId, bareModelId(fullId).toLowerCase(), facts);
  }

  return {
    lookup: (modelKey, providerId) => {
      const key = modelKey.trim();
      if (!key) return null;
      if (providerId) {
        const full = byFullId.get(`${providerId}/${key}`.toLowerCase());
        if (full) return full;
      }
      return byBareId.get(bareModelId(key).toLowerCase()) ?? null;
    },
  };
}

function bareModelId(fullId: string): string {
  const parts = fullId.split("/");
  return parts[parts.length - 1] ?? fullId;
}

function mergeFacts(target: Map<string, CatalogFacts>, key: string, facts: CatalogFacts): void {
  const existing = target.get(key);
  if (!existing) {
    target.set(key, facts);
    return;
  }
  target.set(key, {
    text: existing.text || facts.text,
    image: existing.image || facts.image,
    pdf: existing.pdf || facts.pdf,
    video: existing.video || facts.video,
    contextLimit: maxLimit(existing.contextLimit, facts.contextLimit),
    maxTokens: maxLimit(existing.maxTokens, facts.maxTokens),
  });
}

function maxLimit(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function parseCatalogBody(body: string): Record<string, CatalogFacts> {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.dev catalog must be an object");
  }
  return coerceModels(parsed as Record<string, unknown>);
}

/** Reads catalog facts from a raw `full_id -> entry` map, tolerating missing fields. */
function coerceModels(entries: Record<string, unknown>): Record<string, CatalogFacts> {
  const models: Record<string, CatalogFacts> = {};
  for (const [fullId, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object") continue;
    models[fullId] = factsFromEntry(raw as RawCatalogEntry);
  }
  return models;
}

/** Reads the derived facts kept in the cache, which omit the raw catalog fields. */
function coerceCachedModels(entries: Record<string, unknown>): Record<string, CatalogFacts> {
  const models: Record<string, CatalogFacts> = {};
  for (const [fullId, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object") continue;
    const cached = raw as Partial<CatalogFacts>;
    models[fullId] = {
      text: typeof cached.text === "boolean" ? cached.text : true,
      image: cached.image === true,
      pdf: cached.pdf === true,
      video: cached.video === true,
      contextLimit: positiveTokenCount(cached.contextLimit),
      maxTokens: positiveTokenCount(cached.maxTokens),
    };
  }
  return models;
}

function factsFromEntry(entry: RawCatalogEntry): CatalogFacts {
  const inputs = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((item): item is string => typeof item === "string")
    : [];
  const lower = inputs.map((item) => item.toLowerCase());
  return {
    // Entries without input modalities still describe a text model.
    text: inputs.length === 0 || lower.includes("text"),
    image: lower.includes("image"),
    pdf: lower.includes("pdf"),
    video: lower.includes("video"),
    contextLimit: positiveTokenCount(entry.limit?.context),
    maxTokens: positiveTokenCount(entry.limit?.output),
  };
}

function positiveTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  if (rounded <= 0) return null;
  return Math.min(rounded, MAX_TOKEN_COUNT);
}

/** Reads the catalog snapshot the app ships; an `asset:` fetch needs no network. */
async function fetchBundledCatalogBody(): Promise<string> {
  const response = await httpFetch(BUNDLED_CATALOG_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: NEVER_ABORTED,
  });
  if (!response.ok) {
    throw new Error(`bundled models.dev catalog responded ${response.status}`);
  }
  if (!response.text) throw new Error("bundled models.dev catalog has no text body");
  return await response.text();
}

async function fetchCatalogBody(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await httpFetch(CATALOG_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`models.dev responded ${response.status}`);
    }
    if (!response.text) throw new Error("models.dev answered no text body");
    const body = await response.text();
    if (body.length > MAX_CATALOG_CHARS) {
      throw new Error(`models.dev catalog too large: ${body.length} characters`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
