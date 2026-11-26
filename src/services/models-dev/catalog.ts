// ABOUTME: Client for the models.dev catalog that seeds model capabilities and token limits.
// ABOUTME: Refreshes https://models.dev/models.json once per 24h into the app data directory; the bundled snapshot answers when it cannot.
import { Storage } from "nsh";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { join } from "path";
import bundledCatalogUrl from "../../../assets/catalog/models.dev.json?url";
import { appDataDirectory } from "../app-data";
import { createHttpFetch } from "../http";
import { createLogger } from "../log";

/** Provider-agnostic model metadata published from https://github.com/anomalyco/models.dev. */
const CATALOG_URL = "https://models.dev/models.json";
/** The copy of that catalog the app ships, refreshed by `mise run catalog`. */
const BUNDLED_CATALOG_URL = bundledCatalogUrl;
/** Directory under the app data directory that holds the downloaded catalog. */
const DOWNLOADED_CATALOG_DIRECTORY = "catalog";
/** Raw models.dev document, the same shape as `assets/catalog/models.dev.json`. */
const DOWNLOADED_CATALOG_FILE_NAME = "models.dev.json";
/** Earlier builds kept derived facts in app storage. Drop that entry so it no longer uses the quota. */
const LEGACY_CATALOG_STORAGE_KEY = "models.dev.catalog.v1";
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

/** One downloaded models.dev document and the time it was written. */
export interface DownloadedCatalog {
  /** Raw models.dev JSON, the same document shape as the bundled snapshot. */
  body: string;
  /** When that file was written, in milliseconds since the Unix epoch. */
  fetchedAt: number;
}

/** Injected dependencies, replaced in tests to avoid the network and the data directory. */
export interface CatalogDeps {
  now: () => number;
  readDownloadedCatalog: () => Promise<DownloadedCatalog | null>;
  writeDownloadedCatalog: (body: string) => Promise<void>;
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

/** Creates a catalog reader over the given dependencies, defaulting to the app data directory and network. */
export function createCatalog(deps: Partial<CatalogDeps> = {}): Catalog {
  const resolved: CatalogDeps = {
    now: deps.now ?? (() => Date.now()),
    readDownloadedCatalog: deps.readDownloadedCatalog ?? readDownloadedCatalogFile,
    writeDownloadedCatalog: deps.writeDownloadedCatalog ?? writeDownloadedCatalogFile,
    fetchCatalog: deps.fetchCatalog ?? fetchCatalogBody,
    readBundledCatalog: deps.readBundledCatalog ?? fetchBundledCatalogBody,
  };
  let inFlight: Promise<CatalogIndex | null> | null = null;
  let bundledIndex: Promise<CatalogIndex | null> | null = null;

  const readBundledIndex = (): Promise<CatalogIndex | null> => {
    bundledIndex ??= (async () => {
      try {
        return indexFromCatalogBody(await resolved.readBundledCatalog());
      } catch (error) {
        log.warn("Could not read the bundled models.dev catalog.", error);
        return null;
      }
    })();
    return bundledIndex;
  };

  const readDownloadedIndex = async (): Promise<{
    index: CatalogIndex;
    fetchedAt: number;
  } | null> => {
    let downloaded: DownloadedCatalog | null;
    try {
      downloaded = await resolved.readDownloadedCatalog();
    } catch (error) {
      log.warn("Could not read the downloaded models.dev catalog.", error);
      return null;
    }
    if (!downloaded) return null;
    try {
      return { index: indexFromCatalogBody(downloaded.body), fetchedAt: downloaded.fetchedAt };
    } catch (error) {
      log.warn("Could not parse the downloaded models.dev catalog.", error);
      return null;
    }
  };

  return {
    load: async () => {
      const downloaded = await readDownloadedIndex();
      const now = resolved.now();
      if (downloaded && now - downloaded.fetchedAt < CACHE_TTL_MS) {
        return downloaded.index;
      }
      if (inFlight) {
        return inFlight;
      }

      const pending = (async (): Promise<CatalogIndex | null> => {
        try {
          const body = await resolved.fetchCatalog();
          const index = indexFromCatalogBody(body);
          try {
            await resolved.writeDownloadedCatalog(body);
          } catch (error) {
            log.warn("Could not save the downloaded models.dev catalog.", error);
          }
          return index;
        } catch (error) {
          log.warn("Could not refresh the models.dev catalog.", error);
          // A stale download is newer than the bundle, and the bundle is the last resort.
          return downloaded?.index ?? (await readBundledIndex());
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
let legacyStorageCleared = false;

/** Drops the derived catalog that older builds stored in `storage.json`. */
function releaseLegacyCatalogStorage(): void {
  if (legacyStorageCleared) return;
  legacyStorageCleared = true;
  void Storage.removeItem(LEGACY_CATALOG_STORAGE_KEY).catch((error) => {
    log.warn("Could not remove the models.dev catalog from app storage.", error);
  });
}

/** Loads the shared catalog index, or `null` when the network, the download and the bundle all fail. */
export function loadCatalog(): Promise<CatalogIndex | null> {
  releaseLegacyCatalogStorage();
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

function indexFromCatalogBody(body: string): CatalogIndex {
  return buildIndex(parseCatalogBody(body));
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

function downloadedCatalogPath(): string | null {
  const root = appDataDirectory();
  if (root === null) return null;
  return join(root, DOWNLOADED_CATALOG_DIRECTORY, DOWNLOADED_CATALOG_FILE_NAME);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readDownloadedCatalogFile(): Promise<DownloadedCatalog | null> {
  const filePath = downloadedCatalogPath();
  if (filePath === null) return null;
  try {
    const [body, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    if (typeof info.mtimeMs !== "number" || !Number.isFinite(info.mtimeMs)) return null;
    return { body, fetchedAt: info.mtimeMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    log.warn("Could not read the downloaded models.dev catalog.", error);
    return null;
  }
}

async function writeDownloadedCatalogFile(body: string): Promise<void> {
  const filePath = downloadedCatalogPath();
  const root = appDataDirectory();
  if (filePath === null || root === null) throw new Error("The app has no data directory.");
  const directory = join(root, DOWNLOADED_CATALOG_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${DOWNLOADED_CATALOG_FILE_NAME}.tmp`);
  await writeFile(temporary, body);
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await rename(temporary, filePath);
}
