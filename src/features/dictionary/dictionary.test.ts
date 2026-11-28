import { expect, test } from "nsh/test";
import {
  createChannelCollection,
  createCredentialVault,
  createIntegrationRegistry,
  setIntegrationRegistry,
  type CapabilityChannelDefinition,
} from "../../framework/integrations";
import {
  aiDictionaryChannel,
  buildDictionaryPrompt,
  dictionaryFailureKey,
  parseDictionaryResponse,
  registerDictionaryIntegrations,
  type DictionaryLookupInput,
  type DictionaryLookupResult,
} from "../../integrations/dictionary";
import { formatDictionaryAnkiNote } from "./anki-format";
import {
  extractContextSentence,
  isInlineLexicalQuery,
  isSelectionLookupCandidate,
  normalizeLookupTerm,
} from "./lexical-query";
import {
  clearDictionaryCache,
  isDictionaryConfigured,
  lookupWord,
  type LookupWordOptions,
} from "./lookup";
import { DICTIONARY_CHANNELS_STORAGE_KEY, createDictionaryChannels } from "./store";

test("dictionary lexical: normalizeLookupTerm trims outer punctuation and collapses spaces", () => {
  expect(normalizeLookupTerm("  “ephemeral,”  ")).toBe("ephemeral");
  expect(normalizeLookupTerm("  (take   over)! ")).toBe("take over");
  expect(normalizeLookupTerm("「well-being」")).toBe("well-being");
  expect(normalizeLookupTerm("  don't  ")).toBe("don't");
  expect(normalizeLookupTerm("C++")).toBe("C++");
  expect(normalizeLookupTerm("   ...   ")).toBe("");
});

test("dictionary lexical: isInlineLexicalQuery accepts words/short phrases and rejects sentences or non-terms", () => {
  expect(isInlineLexicalQuery("ephemeral")).toBe(true);
  expect(isInlineLexicalQuery("  well-being  ")).toBe(true);
  expect(isInlineLexicalQuery("take over")).toBe(true);
  expect(isInlineLexicalQuery("in spite of")).toBe(true);
  expect(isInlineLexicalQuery("词典")).toBe(true);
  expect(isInlineLexicalQuery("人工智能")).toBe(true);

  expect(isInlineLexicalQuery("")).toBe(false);
  expect(isInlineLexicalQuery("   ")).toBe(false);
  expect(isInlineLexicalQuery("12345")).toBe(false);
  expect(isInlineLexicalQuery("https://example.com/word")).toBe(false);
  expect(isInlineLexicalQuery("hello\nworld")).toBe(false);
  expect(isInlineLexicalQuery("Hello, world.")).toBe(false);
  expect(isInlineLexicalQuery("How are you today")).toBe(false);
  expect(isInlineLexicalQuery("ephemeral.")).toBe(false);
  expect(isInlineLexicalQuery("今天天气很好我们去散步")).toBe(false);
});

test("dictionary lexical: isSelectionLookupCandidate tolerates edge punctuation and rejects long/clause spans", () => {
  expect(isSelectionLookupCandidate("ephemeral,")).toBe(true);
  expect(isSelectionLookupCandidate("“resilience”.")).toBe(true);
  expect(isSelectionLookupCandidate("cut down on")).toBe(true);
  expect(isSelectionLookupCandidate("认知偏差")).toBe(true);

  expect(isSelectionLookupCandidate("")).toBe(false);
  expect(isSelectionLookupCandidate("12345")).toBe(false);
  expect(isSelectionLookupCandidate("https://example.com")).toBe(false);
  expect(isSelectionLookupCandidate("two\nlines")).toBe(false);
  expect(isSelectionLookupCandidate("Hello, world")).toBe(false);
  expect(isSelectionLookupCandidate("this sentence clearly has more than five words")).toBe(false);
});

test("dictionary lexical: extractContextSentence isolates the surrounding sentence or returns undefined for standalone terms", () => {
  const paragraph = "First sentence here. Beauty can be ephemeral in spring! Third sentence.";
  const start = paragraph.indexOf("ephemeral");
  const end = start + "ephemeral".length;

  expect(
    extractContextSentence({
      fullText: paragraph,
      start,
      end,
      term: "ephemeral",
    }),
  ).toBe("Beauty can be ephemeral in spring!");

  expect(
    extractContextSentence({
      fullText: "这一刻充满了短暂的惊喜。下一句开始了。",
      term: "短暂",
    }),
  ).toBe("这一刻充满了短暂的惊喜。");

  expect(
    extractContextSentence({
      fullText: "ephemeral",
      start: 0,
      end: 9,
      term: "ephemeral",
    }),
  ).toBeUndefined();
});

test("dictionary prompt and parser: buildDictionaryPrompt includes explanation language and optional context sentence", () => {
  const withContext = buildDictionaryPrompt({
    term: "ephemeral",
    contextSentence: "Fame on the internet is often ephemeral.",
    sourceLanguage: "en",
    explanationLanguage: "zh-CN",
  });

  expect(withContext.system).toContain("JSON");
  expect(withContext.system).toContain("Simplified Chinese");
  expect(withContext.user).toContain("ephemeral");
  expect(withContext.user).toContain("Fame on the internet is often ephemeral.");
  expect(withContext.user).toContain("contextSenseSummary");

  const withoutContext = buildDictionaryPrompt({
    term: "ephemeral",
    explanationLanguage: "en",
  });

  expect(withoutContext.system).toContain("English");
  expect(withoutContext.user).toContain("ephemeral");
  expect(withoutContext.user).not.toContain("Context sentence:");
});

test("dictionary prompt and parser: parseDictionaryResponse parses valid JSON, markdown-fenced JSON, and not_found", () => {
  const direct = parseDictionaryResponse(
    JSON.stringify({
      found: true,
      term: "ephemeral",
      phonetics: [
        { label: "US", ipa: "/ɪˈfɛmərəl/" },
        { label: "UK", ipa: "/ɪˈfɛmərəl/" },
      ],
      senses: [
        {
          partOfSpeech: "adj.",
          glosses: ["短暂的", "转瞬即逝的"],
          example: "Fashion is by nature ephemeral.",
          exampleTranslation: "时尚本质上是转瞬即逝的。",
        },
      ],
      forms: [{ label: "noun", value: "ephemerality" }],
      synonyms: ["fleeting", "transient"],
      contextSenseSummary: "此处指“转瞬即逝的”。",
      contextNote: "常形容流行或热度维持时间极短。",
    }),
    "ephemeral",
  );

  expect(direct).toEqual({
    kind: "entry",
    entry: {
      found: true,
      term: "ephemeral",
      phonetics: [
        { label: "US", ipa: "/ɪˈfɛmərəl/" },
        { label: "UK", ipa: "/ɪˈfɛmərəl/" },
      ],
      senses: [
        {
          partOfSpeech: "adj.",
          glosses: ["短暂的", "转瞬即逝的"],
          example: "Fashion is by nature ephemeral.",
          exampleTranslation: "时尚本质上是转瞬即逝的。",
        },
      ],
      forms: [{ label: "noun", value: "ephemerality" }],
      synonyms: ["fleeting", "transient"],
      contextSenseSummary: "此处指“转瞬即逝的”。",
      contextNote: "常形容流行或热度维持时间极短。",
    },
  });

  const fenced = parseDictionaryResponse(
    "Here is the entry:\n```json\n" +
      JSON.stringify({
        found: true,
        term: "",
        phonetics: [{ label: "", ipa: " /rʌn/ " }],
        senses: [{ partOfSpeech: "v.", glosses: ["跑", " "] }],
      }) +
      "\n```",
    "run",
  );

  expect(fenced).toEqual({
    kind: "entry",
    entry: {
      found: true,
      term: "run",
      phonetics: [{ label: "IPA", ipa: "/rʌn/" }],
      senses: [{ partOfSpeech: "v.", glosses: ["跑"] }],
    },
  });

  expect(
    parseDictionaryResponse(JSON.stringify({ found: false, term: "asdfqwer" }), "asdfqwer"),
  ).toEqual({
    kind: "not_found",
    term: "asdfqwer",
  });
});

test("dictionary prompt and parser: parseDictionaryResponse rejects malformed or empty-sense responses", () => {
  expect(parseDictionaryResponse("not json at all", "test")).toBeNull();
  expect(parseDictionaryResponse(JSON.stringify({ found: true, senses: [] }), "test")).toBeNull();
  expect(
    parseDictionaryResponse(
      JSON.stringify({ found: true, senses: [{ partOfSpeech: "n.", glosses: [] }] }),
      "test",
    ),
  ).toBeNull();
  expect(dictionaryFailureKey("invalid_response")).toBe("dictionary.error.invalid_response");
  expect(dictionaryFailureKey("auth")).toBe("dictionary.error.auth");
});

test("dictionary anki format: formats term, phonetics, senses, and context sentence cleanly", () => {
  const formattedWithContext = formatDictionaryAnkiNote(
    {
      found: true,
      term: "ephemeral",
      phonetics: [
        { label: "US", ipa: "/ɪˈfɛmərəl/" },
        { label: "UK", ipa: "/ɪˈfɛmərəl/" },
      ],
      senses: [
        {
          partOfSpeech: "adj.",
          glosses: ["短暂的", "转瞬即逝的"],
          example: "Fashion is ephemeral.",
          exampleTranslation: "时尚转瞬即逝。",
        },
        {
          partOfSpeech: "n.",
          glosses: ["短生植物"],
        },
      ],
      contextSenseSummary: "此处意为“转瞬即逝的”。",
    },
    "  Fame on the internet is often ephemeral.  ",
  );

  expect(formattedWithContext.sourceText).toBe("ephemeral");
  expect(formattedWithContext.translatedText).toContain("US /ɪˈfɛmərəl/ · UK /ɪˈfɛmərəl/");
  expect(formattedWithContext.translatedText).toContain("adj. 短暂的; 转瞬即逝的");
  expect(formattedWithContext.translatedText).toContain("n. 短生植物");
  expect(formattedWithContext.translatedText).toContain("Fame on the internet is often ephemeral.");
  expect(formattedWithContext.translatedText).not.toContain("Fashion is ephemeral.");

  const formattedWithoutContext = formatDictionaryAnkiNote({
    found: true,
    term: "ephemeral",
    phonetics: [],
    senses: [
      {
        partOfSpeech: "adj.",
        glosses: ["short-lived"],
        example: "Mayflies are ephemeral.",
      },
    ],
  });

  expect(formattedWithoutContext).toEqual({
    sourceText: "ephemeral",
    translatedText: "adj. short-lived\nMayflies are ephemeral.",
  });
});

function memoryVaultStorage(seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    store,
    storage: {
      getItem: async (key: string) => store[key] ?? null,
      setItem: async (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: async (key: string) => {
        delete store[key];
      },
    },
  };
}

function fakeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("dictionary lookup: reports unconfigured when no dictionary channel is enabled", async () => {
  clearDictionaryCache();
  const { storage } = memoryVaultStorage();
  const channels = createDictionaryChannels(storage);
  await channels.load();

  expect(isDictionaryConfigured(channels)).toBe(false);
  const outcome = await lookupWord({ term: "ephemeral", explanationLanguage: "zh" }, { channels });
  expect(outcome).toEqual({ ok: false, failure: "unconfigured" });
});

test("dictionary lookup: caches normalized queries and invalidates on context or channel change", async () => {
  clearDictionaryCache();
  const registry = createIntegrationRegistry();
  registerDictionaryIntegrations(registry);
  setIntegrationRegistry(registry);

  const { storage } = memoryVaultStorage({
    [DICTIONARY_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["ai"],
      channels: {
        ai: { enabled: true, configured: true, config: { modelId: "m1" }, credentialRef: null },
      },
    }),
  });
  const channels = createDictionaryChannels(storage);
  await channels.load();
  expect(isDictionaryConfigured(channels)).toBe(true);

  let modelCalls = 0;
  const options: LookupWordOptions = {
    channels,
    resolveSavedModelRequest: async (modelId) => ({
      ok: true,
      modelId,
      connection: {
        providerTypeId: "openai",
        protocolId: "openai-responses",
        baseUrl: "https://api.example.com/v1",
        credential: "sk-test",
      },
      modelKey: modelId === "m2" ? "gpt-4.1" : "gpt-4.1-mini",
    }),
    generateText: async (_conn, req) => {
      modelCalls += 1;
      return JSON.stringify({
        found: true,
        term: "ephemeral",
        phonetics: [{ label: "US", ipa: "/ɪˈfɛmərəl/" }],
        senses: [{ partOfSpeech: "adj.", glosses: [`gloss-${req.modelId}-${modelCalls}`] }],
      });
    },
  };

  const first = await lookupWord({ term: "ephemeral", explanationLanguage: "zh" }, options);
  const second = await lookupWord({ term: "  “EPHEMERAL,”  ", explanationLanguage: "zh" }, options);
  expect(first.ok).toBe(true);
  expect(second).toEqual(first);
  expect(modelCalls).toBe(1);

  const withContext = await lookupWord(
    { term: "ephemeral", contextSentence: "Youth is ephemeral.", explanationLanguage: "zh" },
    options,
  );
  expect(withContext.ok).toBe(true);
  expect(modelCalls).toBe(2);

  await channels.save("ai", { modelId: "m2" }, { mode: "keep" });
  const afterConfigChange = await lookupWord(
    { term: "ephemeral", explanationLanguage: "zh" },
    options,
  );
  expect(afterConfigChange.ok).toBe(true);
  expect(modelCalls).toBe(3);
  if (afterConfigChange.ok && afterConfigChange.result.kind === "entry") {
    expect(afterConfigChange.result.entry.senses[0]!.glosses[0]).toBe("gloss-gpt-4.1-3");
  }
});

test("dictionary lookup: deduplicates concurrent in-flight identical requests", async () => {
  clearDictionaryCache();
  const registry = createIntegrationRegistry();
  registerDictionaryIntegrations(registry);
  setIntegrationRegistry(registry);

  const { storage } = memoryVaultStorage({
    [DICTIONARY_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["ai"],
      channels: {
        ai: { enabled: true, configured: true, config: { modelId: "m1" }, credentialRef: null },
      },
    }),
  });
  const channels = createDictionaryChannels(storage);
  await channels.load();

  const gate = fakeDeferred<string>();
  let calls = 0;
  const options: LookupWordOptions = {
    channels,
    resolveSavedModelRequest: async (modelId) => ({
      ok: true,
      modelId,
      connection: {
        providerTypeId: "openai",
        protocolId: "openai-responses",
        baseUrl: "https://api.example.com/v1",
        credential: "sk-test",
      },
      modelKey: "gpt-4.1-mini",
    }),
    generateText: () => {
      calls += 1;
      return gate.promise;
    },
  };

  const p1 = lookupWord({ term: "resilience", explanationLanguage: "zh" }, options);
  const p2 = lookupWord({ term: "  resilience  ", explanationLanguage: "zh" }, options);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(1);

  gate.resolve(
    JSON.stringify({
      found: true,
      term: "resilience",
      phonetics: [],
      senses: [{ partOfSpeech: "n.", glosses: ["韧性"] }],
    }),
  );

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toEqual(r2);
  expect(calls).toBe(1);
});

test("dictionary lookup: falls back along enabled channel priority and never caches failures", async () => {
  clearDictionaryCache();
  const attempts: string[] = [];

  const primary: CapabilityChannelDefinition<
    { fail: boolean },
    DictionaryLookupInput,
    DictionaryLookupResult
  > = {
    id: "primary",
    capability: "dictionary",
    labelKey: "settings.dictionary.ai",
    icon: aiDictionaryChannel.icon,
    configurable: false,
    config: { parse: () => ({ fail: true }), defaults: () => ({ fail: true }) },
    credential: null,
    describe: () => "Primary",
    readiness: async () => ({ ready: true }),
    execute: async (_binding, input) => {
      attempts.push("primary");
      if (input.term === "cancel-me") {
        const { DictionaryChannelError } = await import("../../integrations/dictionary/types");
        throw new DictionaryChannelError("cancelled");
      }
      const { DictionaryChannelError } = await import("../../integrations/dictionary/types");
      throw new DictionaryChannelError("rate_limit");
    },
    failureKey: dictionaryFailureKey,
  };

  const backup: CapabilityChannelDefinition<
    Record<string, never>,
    DictionaryLookupInput,
    DictionaryLookupResult
  > = {
    id: "backup",
    capability: "dictionary",
    labelKey: "settings.dictionary.ai",
    icon: aiDictionaryChannel.icon,
    configurable: false,
    config: { parse: () => ({}), defaults: () => ({}) },
    credential: null,
    describe: () => "Backup",
    readiness: async () => ({ ready: true }),
    execute: async (_binding, input) => {
      attempts.push("backup");
      return {
        kind: "entry",
        entry: {
          found: true,
          term: input.term,
          phonetics: [],
          senses: [{ partOfSpeech: "n.", glosses: ["备用释义"] }],
        },
      };
    },
    failureKey: dictionaryFailureKey,
  };

  const definitions = [
    primary as unknown as CapabilityChannelDefinition<unknown, unknown, unknown>,
    backup as unknown as CapabilityChannelDefinition<unknown, unknown, unknown>,
  ];
  const { storage } = memoryVaultStorage({
    [DICTIONARY_CHANNELS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      order: ["primary", "backup"],
      channels: {
        primary: { enabled: true, configured: true, config: {}, credentialRef: null },
        backup: { enabled: true, configured: true, config: {}, credentialRef: null },
      },
    }),
  });
  const channels = createChannelCollection({
    capability: "dictionary",
    storage,
    storageKey: DICTIONARY_CHANNELS_STORAGE_KEY,
    vault: createCredentialVault({ storage, namespace: "secret.dict.test" }),
    definitions: () => definitions,
    policy: { enableOnFirstSave: true },
  });
  await channels.load();

  const fallbackResult = await lookupWord(
    { term: "Fallback", explanationLanguage: "zh" },
    { channels },
  );
  expect(attempts).toEqual(["primary", "backup"]);
  expect(fallbackResult.ok).toBe(true);

  attempts.length = 0;
  const cancelledResult = await lookupWord(
    { term: "cancel-me", explanationLanguage: "zh" },
    { channels },
  );
  expect(attempts).toEqual(["primary"]);
  expect(cancelledResult).toEqual({ ok: false, failure: "cancelled" });

  // Retrying after failure must attempt again (failures are not cached).
  await lookupWord({ term: "cancel-me", explanationLanguage: "zh" }, { channels });
  expect(attempts).toEqual(["primary", "primary"]);
});
