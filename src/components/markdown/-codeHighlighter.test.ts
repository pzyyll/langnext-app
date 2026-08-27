// ABOUTME: Contract tests for the allowlisted Streamdown Markdown code highlighter.
// ABOUTME: Covers canonical languages, aliases, async highlighting, cache, and unknown-language fallback.
import { describe, expect, test } from "bun:test";
import { createMarkdownCodeHighlighter } from "./-codeHighlighter";
import type { CanonicalMarkdownLanguage, MarkdownLanguageLoader } from "./-codeHighlighter";
import type { HighlightOptions, HighlightResult } from "streamdown";

const PACKAGE_JSON_PATH = new URL("../../../package.json", import.meta.url);
const HIGHLIGHTER_SOURCE_PATH = new URL("./-codeHighlighter.ts", import.meta.url);
const FORBIDDEN_CODE_PACKAGE = "@streamdown/code";
const GITHUB_LIGHT_KEYWORD_COLOR = "#D73A49";
const GITHUB_DARK_KEYWORD_COLOR = "#F97583";

const CANONICAL_LANGUAGES = ["javascript", "typescript", "json", "markdown", "python", "rust", "bash", "sql"] as const;

const LANGUAGE_ALIASES: Record<string, (typeof CANONICAL_LANGUAGES)[number]> = {
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
const JAVASCRIPT_SNIPPET = "const value = 1;";
const UNKNOWN_LANGUAGE_NAME = "emacs-lisp";
const ARBITRARY_UNKNOWN_LANGUAGE_NAME = "not-a-real-language";
const HIGHLIGHT_CALLBACK_TIMEOUT_MS = 15_000;

function highlightOptions(language: string, code = JAVASCRIPT_SNIPPET): HighlightOptions {
  return {
    code,
    language: language as HighlightOptions["language"],
    themes: [...CODE_SHIKI_THEMES],
  };
}

async function waitForHighlight(
  plugin: ReturnType<typeof createMarkdownCodeHighlighter>,
  options: HighlightOptions,
): Promise<{ immediate: HighlightResult | null; tokens: HighlightResult }> {
  const immediateHolder: { value: HighlightResult | null | undefined } = { value: undefined };
  const tokens = await new Promise<HighlightResult>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`highlight callback timed out after ${HIGHLIGHT_CALLBACK_TIMEOUT_MS}ms`));
    }, HIGHLIGHT_CALLBACK_TIMEOUT_MS);
    immediateHolder.value = plugin.highlight(options, (result) => {
      clearTimeout(timeoutId);
      resolve(result);
    });
    if (immediateHolder.value) {
      clearTimeout(timeoutId);
      resolve(immediateHolder.value);
    }
  });
  return { immediate: immediateHolder.value ?? null, tokens };
}

describe("createMarkdownCodeHighlighter language policy", () => {
  test("lists the eight canonical languages and accepts documented aliases", () => {
    const plugin = createMarkdownCodeHighlighter();
    expect(plugin.getSupportedLanguages()).toEqual([...CANONICAL_LANGUAGES]);

    for (const language of CANONICAL_LANGUAGES) {
      expect(plugin.supportsLanguage(language)).toBe(true);
    }
    for (const alias of Object.keys(LANGUAGE_ALIASES)) {
      expect(plugin.supportsLanguage(alias as HighlightOptions["language"])).toBe(true);
    }
  });

  test("rejects emacs-lisp, empty names, and unknown languages", () => {
    const plugin = createMarkdownCodeHighlighter();
    expect(plugin.supportsLanguage(UNKNOWN_LANGUAGE_NAME)).toBe(false);
    expect(plugin.supportsLanguage("" as HighlightOptions["language"])).toBe(false);
    expect(plugin.supportsLanguage(ARBITRARY_UNKNOWN_LANGUAGE_NAME as HighlightOptions["language"])).toBe(false);
  });
});

describe("createMarkdownCodeHighlighter highlight contract", () => {
  test("returns null while javascript loads, then caches token lines", async () => {
    const plugin = createMarkdownCodeHighlighter();
    const options = highlightOptions("javascript");
    const { immediate, tokens } = await waitForHighlight(plugin, options);

    expect(immediate).toBeNull();
    expect(tokens.tokens.length).toBeGreaterThan(0);
    expect(tokens.tokens.some((line) => line.some((token) => token.content.length > 0))).toBe(true);

    const cached = plugin.highlight(options);
    expect(cached).not.toBeNull();
    expect(cached).toEqual(tokens);
  });

  test("does not invoke a grammar loader for an unknown fence language", () => {
    let loaderCalls = 0;
    const languageLoaders = Object.fromEntries(
      CANONICAL_LANGUAGES.map((language) => [
        language,
        async () => {
          loaderCalls += 1;
          throw new Error(`unexpected grammar load for ${language}`);
        },
      ]),
    ) as Parameters<typeof createMarkdownCodeHighlighter>[0]["languageLoaders"];

    const plugin = createMarkdownCodeHighlighter({ languageLoaders });
    expect(plugin.supportsLanguage(UNKNOWN_LANGUAGE_NAME)).toBe(false);
    expect(plugin.highlight(highlightOptions(UNKNOWN_LANGUAGE_NAME, "(+ 1 2)"))).toBeNull();
    expect(loaderCalls).toBe(0);
  });

  test("tokenizes javascript with both configured GitHub themes", async () => {
    const plugin = createMarkdownCodeHighlighter();
    const { tokens } = await waitForHighlight(plugin, highlightOptions("javascript"));
    const constToken = tokens.tokens[0]?.find((token) => token.content === "const");
    expect(constToken).toBeDefined();
    expect(constToken?.htmlStyle?.color).toBe(GITHUB_LIGHT_KEYWORD_COLOR);
    expect(constToken?.htmlStyle?.["--shiki-dark"]).toBe(GITHUB_DARK_KEYWORD_COLOR);
    expect(plugin.getThemes()).toEqual([...CODE_SHIKI_THEMES]);
  });
});

function importedPackageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (!scope || !name) {
      return null;
    }
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0] ?? null;
}

describe("highlighter dependency policy", () => {
  test("package.json lists highlighter imports and does not list @streamdown/code", async () => {
    const packageJson = (await Bun.file(PACKAGE_JSON_PATH).json()) as {
      dependencies?: Record<string, string>;
    };
    const source = await Bun.file(HIGHLIGHTER_SOURCE_PATH).text();
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    const importedPackages = [
      ...new Set(
        specifiers.map((specifier) => importedPackageName(specifier)).filter((name): name is string => Boolean(name)),
      ),
    ];
    const directDependencies = packageJson.dependencies ?? {};

    expect(directDependencies[FORBIDDEN_CODE_PACKAGE]).toBeUndefined();
    expect(importedPackages.length).toBeGreaterThan(0);
    for (const packageName of importedPackages) {
      expect(directDependencies[packageName]).toBeDefined();
    }
  });
});

const MAX_TOKEN_CACHE_ENTRIES = 128;
const MAX_FAILED_CACHE_ENTRIES = 128;
const MAX_HIGHLIGHTER_CACHE_ENTRIES = 16;
const COLLISION_PREFIX = "P".repeat(100);
const COLLISION_SUFFIX = "S".repeat(100);
const COLLISION_MIDDLE_ALPHA = "TOKEN_ALPHA";
const COLLISION_MIDDLE_BRAVO = "TOKEN_BRAVO";
const COLLISION_CODE_ALPHA = `${COLLISION_PREFIX}${COLLISION_MIDDLE_ALPHA}${COLLISION_SUFFIX}`;
const COLLISION_CODE_BRAVO = `${COLLISION_PREFIX}${COLLISION_MIDDLE_BRAVO}${COLLISION_SUFFIX}`;
const ORDERED_GITHUB_THEME_PAIRS: [string, string][] = [
  ["github-light", "github-dark"],
  ["github-dark", "github-light"],
  ["github-light", "github-light"],
  ["github-dark", "github-dark"],
];

function tokenText(result: HighlightResult): string {
  return result.tokens.map((line) => line.map((token) => token.content).join("")).join("\n");
}

function customTheme(name: string, foreground: string, type: "light" | "dark") {
  return {
    name,
    type,
    colors: {},
    settings: [{ settings: { foreground } }],
  } as HighlightOptions["themes"][number];
}

function firstTokenColors(result: HighlightResult): { light: string | undefined; dark: string | undefined } {
  const token = result.tokens[0]?.[0];
  return {
    light: token?.htmlStyle?.color,
    dark: token?.htmlStyle?.["--shiki-dark"],
  };
}

function stubGrammar(language: CanonicalMarkdownLanguage) {
  return {
    name: language,
    displayName: language,
    scopeName: `source.${language}`,
    patterns: [{ match: "[\\s\\S]+", name: "source" }],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > HIGHLIGHT_CALLBACK_TIMEOUT_MS) {
      throw new Error(`${label} timed out after ${HIGHLIGHT_CALLBACK_TIMEOUT_MS}ms`);
    }
    await Bun.sleep(1);
  }
}

function highlightWithThemes(
  language: string,
  code: string,
  themes: [string, string] = [...CODE_SHIKI_THEMES],
): HighlightOptions {
  return {
    code,
    language: language as HighlightOptions["language"],
    themes,
  };
}

function createCountingStubLoaders(loaderCalls: Map<CanonicalMarkdownLanguage, number>) {
  return Object.fromEntries(
    CANONICAL_LANGUAGES.map((language) => [
      language,
      async () => {
        loaderCalls.set(language, (loaderCalls.get(language) ?? 0) + 1);
        return stubGrammar(language);
      },
    ]),
  ) as Partial<Record<CanonicalMarkdownLanguage, MarkdownLanguageLoader>>;
}

type LoaderCounters = {
  calls: number;
  rejections: number;
};

function createRejectingLoader(counters: LoaderCounters): MarkdownLanguageLoader {
  return async () => {
    counters.calls += 1;
    try {
      throw new Error("grammar load failed");
    } finally {
      counters.rejections += 1;
    }
  };
}

async function waitForLoaderRejection(counters: LoaderCounters, rejectionsBefore: number): Promise<void> {
  await waitUntil(() => counters.rejections > rejectionsBefore, "loader rejection");
  await Promise.resolve();
  await Promise.resolve();
  await Bun.sleep(1);
}

async function waitForCachedFailure(
  plugin: ReturnType<typeof createMarkdownCodeHighlighter>,
  options: HighlightOptions,
  counters: LoaderCounters,
): Promise<void> {
  const rejectionsBefore = counters.rejections;
  expect(plugin.highlight(options)).toBeNull();
  await waitForLoaderRejection(counters, rejectionsBefore);
  const callsNow = counters.calls;
  expect(plugin.highlight(options)).toBeNull();
  expect(counters.calls).toBe(callsNow);
}

describe("createMarkdownCodeHighlighter request identity", () => {
  test("keeps distinct tokens for same-length javascript that shares prefix and suffix", async () => {
    expect(COLLISION_CODE_ALPHA.length).toBe(COLLISION_CODE_BRAVO.length);
    expect(COLLISION_CODE_ALPHA.slice(0, 100)).toBe(COLLISION_CODE_BRAVO.slice(0, 100));
    expect(COLLISION_CODE_ALPHA.slice(-100)).toBe(COLLISION_CODE_BRAVO.slice(-100));
    expect(COLLISION_CODE_ALPHA).not.toBe(COLLISION_CODE_BRAVO);

    const grammar = stubGrammar("javascript");
    const deferred = createDeferred<typeof grammar>();
    let loaderCalls = 0;
    const plugin = createMarkdownCodeHighlighter({
      languageLoaders: {
        javascript: async () => {
          loaderCalls += 1;
          return deferred.promise;
        },
      },
    });

    let resultAlpha: HighlightResult | undefined;
    let resultBravo: HighlightResult | undefined;
    const optionsAlpha = highlightOptions("javascript", COLLISION_CODE_ALPHA);
    const optionsBravo = highlightOptions("javascript", COLLISION_CODE_BRAVO);

    expect(
      plugin.highlight(optionsAlpha, (result) => {
        resultAlpha = result;
      }),
    ).toBeNull();
    expect(
      plugin.highlight(optionsBravo, (result) => {
        resultBravo = result;
      }),
    ).toBeNull();

    deferred.resolve(grammar);
    await waitUntil(() => resultAlpha !== undefined && resultBravo !== undefined, "collision callbacks");

    expect(loaderCalls).toBe(1);
    expect(tokenText(resultAlpha!)).toContain(COLLISION_MIDDLE_ALPHA);
    expect(tokenText(resultAlpha!)).not.toContain(COLLISION_MIDDLE_BRAVO);
    expect(tokenText(resultBravo!)).toContain(COLLISION_MIDDLE_BRAVO);
    expect(tokenText(resultBravo!)).not.toContain(COLLISION_MIDDLE_ALPHA);

    expect(plugin.highlight(optionsAlpha)).toBe(resultAlpha);
    expect(plugin.highlight(optionsBravo)).toBe(resultBravo);
  });

  test("separates custom theme tuples whose colon-joined names collide", async () => {
    const lightAlpha = "#101112";
    const darkAlpha = "#131415";
    const lightBravo = "#202122";
    const darkBravo = "#232425";

    const tupleAlpha: HighlightOptions["themes"] = [
      customTheme("pair:a", lightAlpha, "light"),
      customTheme("tail", darkAlpha, "dark"),
    ];
    const tupleBravo: HighlightOptions["themes"] = [
      customTheme("pair", lightBravo, "light"),
      customTheme("a:tail", darkBravo, "dark"),
    ];

    // The old highlighterCacheKey joined language and theme names with ":"; both custom
    // tuples therefore produce the identical text `javascript:pair:a:tail`.
    expect(["javascript", "pair:a", "tail"].join(":")).toBe(["javascript", "pair", "a:tail"].join(":"));

    const plugin = createMarkdownCodeHighlighter();

    let resultAlpha: HighlightResult | undefined;
    let resultBravo: HighlightResult | undefined;
    const optionsAlpha: HighlightOptions = {
      code: JAVASCRIPT_SNIPPET,
      language: "javascript",
      themes: tupleAlpha,
    };
    const optionsBravo: HighlightOptions = {
      code: JAVASCRIPT_SNIPPET,
      language: "javascript",
      themes: tupleBravo,
    };

    expect(
      plugin.highlight(optionsAlpha, (result) => {
        resultAlpha = result;
      }),
    ).toBeNull();
    expect(
      plugin.highlight(optionsBravo, (result) => {
        resultBravo = result;
      }),
    ).toBeNull();

    await waitUntil(() => resultAlpha !== undefined && resultBravo !== undefined, "colliding custom theme callbacks");

    expect(firstTokenColors(resultAlpha!)).toEqual({ light: lightAlpha, dark: darkAlpha });
    expect(firstTokenColors(resultBravo!)).toEqual({ light: lightBravo, dark: darkBravo });
  });
});

describe("createMarkdownCodeHighlighter cache bounds", () => {
  test("evicts the least-recent successful entry after 128 hits", async () => {
    const loaderCalls = new Map<CanonicalMarkdownLanguage, number>();
    const plugin = createMarkdownCodeHighlighter({
      languageLoaders: createCountingStubLoaders(loaderCalls),
    });
    const entries = Array.from({ length: MAX_TOKEN_CACHE_ENTRIES }, (_, index) =>
      highlightOptions("javascript", `success-entry-${index}`),
    );

    const results: HighlightResult[] = [];
    for (const options of entries) {
      const { tokens } = await waitForHighlight(plugin, options);
      results.push(tokens);
    }

    const touched = plugin.highlight(entries[0]!);
    expect(touched).toBe(results[0]);

    const overflowOptions = highlightOptions("javascript", "success-entry-overflow");
    const { tokens: overflowTokens } = await waitForHighlight(plugin, overflowOptions);
    expect(tokenText(overflowTokens)).toContain("success-entry-overflow");

    let reloaded: HighlightResult | undefined;
    const evictedImmediate = plugin.highlight(entries[1]!, (result) => {
      reloaded = result;
    });
    expect(evictedImmediate).toBeNull();
    await waitUntil(() => reloaded !== undefined, "evicted success reload");
    expect(tokenText(reloaded!)).toContain("success-entry-1");
    expect(plugin.highlight(entries[0]!)).toBe(touched);
  });

  test("evicts the least-recent failure and retries that request", async () => {
    const counters: LoaderCounters = { calls: 0, rejections: 0 };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const plugin = createMarkdownCodeHighlighter({
        languageLoaders: {
          javascript: createRejectingLoader(counters),
        },
      });

      const failing = Array.from({ length: MAX_FAILED_CACHE_ENTRIES + 1 }, (_, index) =>
        highlightOptions("javascript", `failure-entry-${index}`),
      );
      for (const options of failing) {
        await waitForCachedFailure(plugin, options, counters);
      }

      const callsAfterFill = counters.calls;
      expect(plugin.highlight(failing[1]!)).toBeNull();
      expect(counters.calls).toBe(callsAfterFill);

      let retried: HighlightResult | undefined;
      const oldestImmediate = plugin.highlight(failing[0]!, (result) => {
        retried = result;
      });
      expect(oldestImmediate).toBeNull();
      await waitUntil(() => counters.calls > callsAfterFill, "evicted failure retries loader");
      expect(retried).toBeUndefined();
    } finally {
      console.error = originalError;
    }
  });

  test("failure entries do not evict successful tokens", async () => {
    const failCounters: LoaderCounters = { calls: 0, rejections: 0 };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const plugin = createMarkdownCodeHighlighter({
        languageLoaders: {
          javascript: async () => stubGrammar("javascript"),
          typescript: createRejectingLoader(failCounters),
        },
      });
      const successOptions = highlightOptions("javascript", "keep-success");
      const { tokens } = await waitForHighlight(plugin, successOptions);

      for (let index = 0; index < MAX_FAILED_CACHE_ENTRIES; index += 1) {
        await waitForCachedFailure(plugin, highlightOptions("typescript", `ts-failure-${index}`), failCounters);
      }

      expect(plugin.highlight(successOptions)).toBe(tokens);
    } finally {
      console.error = originalError;
    }
  });
});

describe("createMarkdownCodeHighlighter in-flight callbacks", () => {
  test("identical in-flight requests share one loader and the same result object", async () => {
    const grammar = stubGrammar("javascript");
    const deferred = createDeferred<typeof grammar>();
    let loaderCalls = 0;
    const plugin = createMarkdownCodeHighlighter({
      languageLoaders: {
        javascript: async () => {
          loaderCalls += 1;
          return deferred.promise;
        },
      },
    });
    const options = highlightOptions("javascript", "shared-inflight");
    const received: HighlightResult[] = [];

    expect(
      plugin.highlight(options, (result) => {
        received.push(result);
      }),
    ).toBeNull();
    expect(
      plugin.highlight(options, (result) => {
        received.push(result);
      }),
    ).toBeNull();
    expect(
      plugin.highlight(options, (result) => {
        received.push(result);
      }),
    ).toBeNull();
    expect(loaderCalls).toBe(1);

    deferred.resolve(grammar);
    await waitUntil(() => received.length === 3, "shared in-flight callbacks");
    expect(received[0]).toBe(received[1]);
    expect(received[1]).toBe(received[2]);
    expect(plugin.highlight(options)).toBe(received[0]);
  });

  test("failed in-flight callbacks are dropped and only the retry callback runs", async () => {
    let shouldFail = true;
    const counters: LoaderCounters = { calls: 0, rejections: 0 };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const plugin = createMarkdownCodeHighlighter({
        languageLoaders: {
          javascript: async () => {
            counters.calls += 1;
            if (shouldFail) {
              try {
                throw new Error("grammar load failed");
              } finally {
                counters.rejections += 1;
              }
            }
            return stubGrammar("javascript");
          },
        },
      });

      const oldest = highlightOptions("javascript", "stale-callback-oldest");
      let staleCalls = 0;
      const rejectionsBeforeOldest = counters.rejections;
      expect(
        plugin.highlight(oldest, () => {
          staleCalls += 1;
        }),
      ).toBeNull();
      await waitForLoaderRejection(counters, rejectionsBeforeOldest);
      const callsAfterOldest = counters.calls;
      expect(plugin.highlight(oldest)).toBeNull();
      expect(counters.calls).toBe(callsAfterOldest);

      for (let index = 0; index < MAX_FAILED_CACHE_ENTRIES; index += 1) {
        await waitForCachedFailure(plugin, highlightOptions("javascript", `stale-callback-fill-${index}`), counters);
      }

      shouldFail = false;
      let retryCalls = 0;
      let retryResult: HighlightResult | undefined;
      expect(
        plugin.highlight(oldest, (result) => {
          retryCalls += 1;
          retryResult = result;
        }),
      ).toBeNull();
      await waitUntil(() => retryResult !== undefined, "successful retry callback");
      expect(staleCalls).toBe(0);
      expect(retryCalls).toBe(1);
      expect(tokenText(retryResult!)).toContain("stale-callback-oldest");
    } finally {
      console.error = originalError;
    }
  });
});

describe("createMarkdownCodeHighlighter highlighter promise LRU", () => {
  test("evicts the least-recent highlighter after 16 language/theme pairs", async () => {
    const loaderCalls = new Map<CanonicalMarkdownLanguage, number>();
    const plugin = createMarkdownCodeHighlighter({
      languageLoaders: createCountingStubLoaders(loaderCalls),
    });
    const pairs = CANONICAL_LANGUAGES.flatMap((language) =>
      ORDERED_GITHUB_THEME_PAIRS.map((themes) => ({ language, themes })),
    ).slice(0, MAX_HIGHLIGHTER_CACHE_ENTRIES + 1);

    expect(pairs).toHaveLength(MAX_HIGHLIGHTER_CACHE_ENTRIES + 1);

    for (const [index, pair] of pairs.slice(0, MAX_HIGHLIGHTER_CACHE_ENTRIES).entries()) {
      await waitForHighlight(plugin, highlightWithThemes(pair.language, `highlighter-pair-${index}`, pair.themes));
    }

    const touched = pairs[0]!;
    expect(
      plugin.highlight(highlightWithThemes(touched.language, "highlighter-pair-0", touched.themes)),
    ).not.toBeNull();

    const overflow = pairs[MAX_HIGHLIGHTER_CACHE_ENTRIES]!;
    await waitForHighlight(
      plugin,
      highlightWithThemes(overflow.language, "highlighter-pair-overflow", overflow.themes),
    );

    const evicted = pairs[1]!;
    const callsBeforeReload = loaderCalls.get(evicted.language) ?? 0;
    const { immediate } = await waitForHighlight(
      plugin,
      highlightWithThemes(evicted.language, "highlighter-pair-evicted-uncached", evicted.themes),
    );
    expect(immediate).toBeNull();
    expect(loaderCalls.get(evicted.language) ?? 0).toBeGreaterThan(callsBeforeReload);
  });
});
