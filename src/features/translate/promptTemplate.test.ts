// ABOUTME: Tests for translation prompt template rendering and default system prompt.
// ABOUTME: Covers plan placeholders, legacy names, and unknown placeholder passthrough.
import { describe, expect, test } from "bun:test";
import { buildDefaultTranslateSystemPrompt, renderPromptTemplate } from "./promptTemplate";

describe("renderPromptTemplate", () => {
  test("renders plan and legacy placeholders", () => {
    expect(renderPromptTemplate("{{sourceLang}}->{{targetLang}}: {{text}}", "en", "zh", "hi")).toBe("en->zh: hi");
    expect(renderPromptTemplate("{{source_language}}/{{target_language}} {{text}}", "en", "zh", "hi")).toBe("en/zh hi");
  });

  test("keeps unknown placeholders intact", () => {
    expect(renderPromptTemplate("{{unknown}} {{text}}", "en", "zh", "x")).toBe("{{unknown}} x");
  });
});

describe("buildDefaultTranslateSystemPrompt", () => {
  test("includes language pair", () => {
    expect(buildDefaultTranslateSystemPrompt("English", "Chinese")).toContain("English");
    expect(buildDefaultTranslateSystemPrompt("English", "Chinese")).toContain("Chinese");
  });
});
