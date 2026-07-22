// ABOUTME: Tests for frontend detectLanguage soft failures and model resolution.
// ABOUTME: Covers empty text and missing model configuration without network.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { detectLanguageFlow } from "./detectLanguageFlow";

const emptyContext = {
  providersById: new Map(),
  modelsById: new Map(),
  profile: null,
};

describe("detectLanguageFlow", () => {
  test("empty text returns soft validation failure", async () => {
    const result = await Effect.runPromise(detectLanguageFlow({ text: "   " }, undefined, emptyContext));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("validation_failed");
  });

  test("missing model returns soft validation failure", async () => {
    const result = await Effect.runPromise(detectLanguageFlow({ text: "bonjour" }, "d1", emptyContext));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("validation_failed");
    expect(result.message).toMatch(/detection model/i);
  });
});
