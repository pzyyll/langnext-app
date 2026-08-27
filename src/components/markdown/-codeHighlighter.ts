// ABOUTME: Allowlisted Streamdown code highlighter using fine-grained Shiki loaders.
// ABOUTME: Unknown fence languages stay unhighlighted and never load a grammar.
import { createBundledHighlighter } from "shiki/core";
import type { LanguageInput, ThemeInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";

type HighlightCallback = NonNullable<Parameters<CodeHighlighterPlugin["highlight"]>[1]>;
type HighlightResult = Parameters<HighlightCallback>[0];

const CANONICAL_LANGUAGES = ["javascript", "typescript", "json", "markdown", "python", "rust", "bash", "sql"] as const;

export type CanonicalMarkdownLanguage = (typeof CANONICAL_LANGUAGES)[number];

const CANONICAL_LANGUAGE_SET: ReadonlySet<string> = new Set(CANONICAL_LANGUAGES);

const LANGUAGE_ALIASES: Record<string, CanonicalMarkdownLanguage> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
};

const CODE_SHIKI_THEMES = ["github-light", "github-dark"] as const;
type MarkdownShikiTheme = (typeof CODE_SHIKI_THEMES)[number];

const CUSTOM_THEME_NAME = "custom";
const HIGHLIGHT_ERROR_LOG_PREFIX = "[MarkdownOutput]";
const PLUGIN_NAME = "shiki" as const;
const PLUGIN_TYPE = "code-highlighter" as const;
const JAVASCRIPT_REGEX_ENGINE_FORGIVING = true;
const MAX_TOKEN_CACHE_ENTRIES = 128;
const MAX_FAILED_CACHE_ENTRIES = 128;
const MAX_HIGHLIGHTER_CACHE_ENTRIES = 16;

export type MarkdownLanguageLoader = LanguageInput;

export type MarkdownCodeHighlighterOptions = {
  languageLoaders?: Partial<Record<CanonicalMarkdownLanguage, MarkdownLanguageLoader>>;
};

const DEFAULT_LANGUAGE_LOADERS: Record<CanonicalMarkdownLanguage, MarkdownLanguageLoader> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  bash: () => import("@shikijs/langs/bash"),
  sql: () => import("@shikijs/langs/sql"),
};

const THEME_LOADERS: Record<MarkdownShikiTheme, ThemeInput> = {
  "github-light": () => import("@shikijs/themes/github-light"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
};

// A resolved theme keeps both the stable identity name and the original Shiki input so that
// inline custom theme objects reach createHighlighter while names stay collision-free keys.
type ResolvedTheme = {
  name: string;
  input: ThemeInput | string;
};

type ThemeNames = [string, string];

// Tuple identities are JSON-encoded instead of delimiter-joined so a name containing ":" or
// "\0" can never alias a different (language, light theme, dark theme) tuple.
type ThemeKey = string;

type CacheEntry =
  | { kind: "success"; result: HighlightResult; lastAccess: number }
  | { kind: "failure"; lastAccess: number };

type CacheBucket = Map<string, CacheEntry>;

type HighlightCache = Map<CanonicalMarkdownLanguage, Map<ThemeKey, CacheBucket>>;

// In-flight state is promise-owned: a request record is registered before any Shiki work can
// settle, and the finally handler of that exact promise removes it. A settled promise never
// leaves a stale owner, and an older promise can never delete a newer record for the same key.
type InflightRequest = {
  promise: Promise<void>;
  callbacks: Set<HighlightCallback>;
};

type InflightBucket = Map<string, InflightRequest>;

type InflightRequestCache = Map<CanonicalMarkdownLanguage, Map<ThemeKey, InflightBucket>>;

type HighlighterRecord<P> = {
  promise: P;
  lastAccess: number;
};

function normalizeLanguage(language: string): CanonicalMarkdownLanguage | undefined {
  const normalized = language.trim().toLowerCase();
  if (CANONICAL_LANGUAGE_SET.has(normalized)) {
    return normalized as CanonicalMarkdownLanguage;
  }
  return LANGUAGE_ALIASES[normalized];
}

function resolveTheme(theme: HighlightOptions["themes"][number]): ResolvedTheme {
  if (typeof theme === "string") {
    return { name: theme, input: theme };
  }
  if (theme && typeof theme === "object" && "name" in theme && typeof theme.name === "string") {
    return { name: theme.name, input: theme };
  }
  return { name: CUSTOM_THEME_NAME, input: theme };
}

function themeNames(themes: readonly [ResolvedTheme, ResolvedTheme]): ThemeNames {
  return [themes[0].name, themes[1].name];
}

function themeCacheKey(names: ThemeNames): ThemeKey {
  return JSON.stringify(names);
}

function highlighterCacheKey(language: CanonicalMarkdownLanguage, names: ThemeNames): string {
  return JSON.stringify([language, names[0], names[1]]);
}

function nestedGet<K, V>(parent: Map<K, V>, key: K, create: false): V | undefined;
function nestedGet<K, V>(parent: Map<K, V>, key: K, create: true, factory: () => V): V;
function nestedGet<K, V>(parent: Map<K, V>, key: K, create: boolean, factory?: () => V): V | undefined {
  const existing = parent.get(key);
  if (existing) {
    return existing;
  }
  if (!create || !factory) {
    return undefined;
  }
  const created = factory();
  parent.set(key, created);
  return created;
}

export function createMarkdownCodeHighlighter(options: MarkdownCodeHighlighterOptions = {}): CodeHighlighterPlugin {
  const languageLoaders = {
    ...DEFAULT_LANGUAGE_LOADERS,
    ...options.languageLoaders,
  };
  const createHighlighter = createBundledHighlighter({
    langs: languageLoaders,
    themes: THEME_LOADERS,
    engine: () => createJavaScriptRegexEngine({ forgiving: JAVASCRIPT_REGEX_ENGINE_FORGIVING }),
  });

  const highlightCache: HighlightCache = new Map();
  const inflightRequests: InflightRequestCache = new Map();
  const highlighterByKey = new Map<string, HighlighterRecord<ReturnType<typeof createHighlighter>>>();
  let accessGeneration = 0;

  function nextAccess(): number {
    accessGeneration += 1;
    return accessGeneration;
  }

  function getCacheBucket(
    language: CanonicalMarkdownLanguage,
    names: ThemeNames,
    create: boolean,
  ): CacheBucket | undefined {
    const themeKey = themeCacheKey(names);
    if (!create) {
      return highlightCache.get(language)?.get(themeKey);
    }
    const byTheme = nestedGet(highlightCache, language, true, () => new Map<ThemeKey, CacheBucket>());
    return nestedGet(byTheme, themeKey, true, () => new Map<string, CacheEntry>());
  }

  function lookupCacheEntry(
    language: CanonicalMarkdownLanguage,
    names: ThemeNames,
    code: string,
  ): CacheEntry | undefined {
    return getCacheBucket(language, names, false)?.get(code);
  }

  function deleteCacheEntry(language: CanonicalMarkdownLanguage, names: ThemeNames, code: string): void {
    const themeKey = themeCacheKey(names);
    const byTheme = highlightCache.get(language);
    const bucket = byTheme?.get(themeKey);
    if (!bucket) {
      return;
    }
    bucket.delete(code);
    if (bucket.size === 0) {
      byTheme?.delete(themeKey);
    }
    if (byTheme && byTheme.size === 0) {
      highlightCache.delete(language);
    }
  }

  function countCacheEntries(kind: CacheEntry["kind"]): number {
    let count = 0;
    for (const byTheme of highlightCache.values()) {
      for (const bucket of byTheme.values()) {
        for (const entry of bucket.values()) {
          if (entry.kind === kind) {
            count += 1;
          }
        }
      }
    }
    return count;
  }

  function evictLeastRecentlyUsed(kind: CacheEntry["kind"]): void {
    let oldest:
      | {
          language: CanonicalMarkdownLanguage;
          names: ThemeNames;
          code: string;
          lastAccess: number;
        }
      | undefined;
    for (const [language, byTheme] of highlightCache) {
      for (const [themeKey, bucket] of byTheme) {
        const names = JSON.parse(themeKey) as ThemeNames;
        for (const [code, entry] of bucket) {
          if (entry.kind !== kind) {
            continue;
          }
          if (!oldest || entry.lastAccess < oldest.lastAccess) {
            oldest = { language, names, code, lastAccess: entry.lastAccess };
          }
        }
      }
    }
    if (oldest) {
      deleteCacheEntry(oldest.language, oldest.names, oldest.code);
    }
  }

  function touchCacheEntry(entry: CacheEntry): void {
    entry.lastAccess = nextAccess();
  }

  function rememberSuccess(
    language: CanonicalMarkdownLanguage,
    names: ThemeNames,
    code: string,
    result: HighlightResult,
  ): void {
    const existing = lookupCacheEntry(language, names, code);
    if (existing?.kind === "success") {
      existing.result = result;
      touchCacheEntry(existing);
      return;
    }
    if (existing) {
      deleteCacheEntry(language, names, code);
    }
    while (countCacheEntries("success") >= MAX_TOKEN_CACHE_ENTRIES) {
      evictLeastRecentlyUsed("success");
    }
    const bucket = getCacheBucket(language, names, true);
    bucket?.set(code, { kind: "success", result, lastAccess: nextAccess() });
  }

  function rememberFailure(language: CanonicalMarkdownLanguage, names: ThemeNames, code: string): void {
    const existing = lookupCacheEntry(language, names, code);
    if (existing?.kind === "failure") {
      touchCacheEntry(existing);
      return;
    }
    if (existing) {
      deleteCacheEntry(language, names, code);
    }
    while (countCacheEntries("failure") >= MAX_FAILED_CACHE_ENTRIES) {
      evictLeastRecentlyUsed("failure");
    }
    const bucket = getCacheBucket(language, names, true);
    bucket?.set(code, { kind: "failure", lastAccess: nextAccess() });
  }

  function lookupInflightRequest(
    language: CanonicalMarkdownLanguage,
    names: ThemeNames,
    code: string,
  ): InflightRequest | undefined {
    return inflightRequests.get(language)?.get(themeCacheKey(names))?.get(code);
  }

  function registerInflightRequest(
    language: CanonicalMarkdownLanguage,
    names: ThemeNames,
    code: string,
    request: InflightRequest,
  ): void {
    const themeKey = themeCacheKey(names);
    const byTheme = nestedGet(inflightRequests, language, true, () => new Map<ThemeKey, InflightBucket>());
    const bucket = nestedGet(byTheme, themeKey, true, () => new Map<string, InflightRequest>());
    bucket.set(code, request);
  }

  function deleteInflightRequest(language: CanonicalMarkdownLanguage, names: ThemeNames, code: string): void {
    const themeKey = themeCacheKey(names);
    const byTheme = inflightRequests.get(language);
    const bucket = byTheme?.get(themeKey);
    bucket?.delete(code);
    if (bucket && bucket.size === 0) {
      byTheme?.delete(themeKey);
    }
    if (byTheme && byTheme.size === 0) {
      inflightRequests.delete(language);
    }
  }

  function evictLeastRecentHighlighter(): void {
    let oldestKey: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, record] of highlighterByKey) {
      if (record.lastAccess < oldestAccess) {
        oldestAccess = record.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      highlighterByKey.delete(oldestKey);
    }
  }

  function touchHighlighter(language: CanonicalMarkdownLanguage, names: ThemeNames): void {
    const record = highlighterByKey.get(highlighterCacheKey(language, names));
    if (record) {
      record.lastAccess = nextAccess();
    }
  }

  function getHighlighter(
    language: CanonicalMarkdownLanguage,
    resolvedThemes: readonly [ResolvedTheme, ResolvedTheme],
  ): ReturnType<typeof createHighlighter> {
    const names = themeNames(resolvedThemes);
    const key = highlighterCacheKey(language, names);
    const existing = highlighterByKey.get(key);
    if (existing) {
      existing.lastAccess = nextAccess();
      return existing.promise;
    }
    while (highlighterByKey.size >= MAX_HIGHLIGHTER_CACHE_ENTRIES) {
      evictLeastRecentHighlighter();
    }
    const promise = createHighlighter({
      langs: [language],
      themes: [resolvedThemes[0].input, resolvedThemes[1].input],
    });
    highlighterByKey.set(key, { promise, lastAccess: nextAccess() });
    return promise;
  }

  function queueHighlight(
    language: CanonicalMarkdownLanguage,
    code: string,
    resolvedThemes: readonly [ResolvedTheme, ResolvedTheme],
    callback?: HighlightCallback,
  ): Promise<void> {
    const names = themeNames(resolvedThemes);
    const existing = lookupInflightRequest(language, names, code);
    if (existing) {
      if (callback) {
        existing.callbacks.add(callback);
      }
      return existing.promise;
    }

    const highlighterPromise = getHighlighter(language, resolvedThemes);
    const callbacks = new Set<HighlightCallback>();
    if (callback) {
      callbacks.add(callback);
    }

    const promise = highlighterPromise
      .then(
        (highlighter) =>
          highlighter.codeToTokens(code, {
            lang: language,
            themes: {
              light: names[0],
              dark: names[1],
            },
          }),
        (error: unknown) => {
          // A rejected highlighter is released only while it still owns its cache entry;
          // an evicted or replaced promise for the same identity is left alone.
          const key = highlighterCacheKey(language, names);
          const current = highlighterByKey.get(key);
          if (current?.promise === highlighterPromise) {
            highlighterByKey.delete(key);
          }
          throw error;
        },
      )
      .then((tokens) => {
        rememberSuccess(language, names, code, tokens);
        for (const callback of callbacks) {
          callback(tokens);
        }
      })
      .catch((error: unknown) => {
        rememberFailure(language, names, code);
        console.error(HIGHLIGHT_ERROR_LOG_PREFIX, "Failed to highlight code", { language, error });
      });

    const request: InflightRequest = { promise, callbacks };
    // Register the request synchronously, before any microtask of the chain above can run,
    // so a duplicate highlight call in the same tick coalesces onto this exact promise.
    registerInflightRequest(language, names, code, request);

    // Remove only this exact request when it settles. If a newer request was registered for
    // the same identity since, its record must survive this handler.
    void promise.finally(() => {
      const current = lookupInflightRequest(language, names, code);
      if (current?.promise === promise) {
        deleteInflightRequest(language, names, code);
      }
    });

    return promise;
  }

  return {
    name: PLUGIN_NAME,
    type: PLUGIN_TYPE,
    getSupportedLanguages: () => [...CANONICAL_LANGUAGES],
    getThemes: () => [...CODE_SHIKI_THEMES],
    supportsLanguage: (language) => normalizeLanguage(language) !== undefined,
    highlight: (highlight, callback) => {
      const language = normalizeLanguage(highlight.language);
      if (!language) {
        return null;
      }

      const resolvedThemes: [ResolvedTheme, ResolvedTheme] = [
        resolveTheme(highlight.themes[0]),
        resolveTheme(highlight.themes[1]),
      ];
      const names = themeNames(resolvedThemes);
      const cached = lookupCacheEntry(language, names, highlight.code);
      if (cached?.kind === "success") {
        touchCacheEntry(cached);
        touchHighlighter(language, names);
        return cached.result;
      }
      if (cached?.kind === "failure") {
        touchCacheEntry(cached);
        return null;
      }
      queueHighlight(language, highlight.code, resolvedThemes, callback);
      return null;
    },
  };
}
