import { expect, test } from "nsh/test";
import {
  buildDictionaryPrompt,
  dictionaryFailureKey,
  parseDictionaryResponse,
} from "../../integrations/dictionary/types";
import { formatDictionaryAnkiNote } from "./anki-format";
import {
  extractContextSentence,
  isInlineLexicalQuery,
  isSelectionLookupCandidate,
  normalizeLookupTerm,
} from "./lexical-query";

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
