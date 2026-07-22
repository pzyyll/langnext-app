// ABOUTME: Tests for frontend-owned startTranslateStream workflow wiring.
// ABOUTME: Mocks providerFetchStream path via workflow options; covers early validation.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { TranslateInput } from "../../storage/types";
import { startTranslateStream } from "./translateStream";
import type { TranslationContextSnapshots } from "./translationContext";

const sampleInput: TranslateInput = {
  modelId: "m1",
  sourceLang: "English",
  targetLang: "Chinese",
  text: "hello",
};

const emptySnapshots: TranslationContextSnapshots = {
  providersById: new Map(),
  modelsById: new Map(),
  profile: null,
};

describe("startTranslateStream", () => {
  test("early validation surfaces through onError without throwing", async () => {
    let errorCode: string | null = null;
    await Effect.runPromise(
      startTranslateStream(sampleInput, "req-1", {
        snapshots: emptySnapshots,
        handlers: {
          onChunk: () => {},
          onReset: () => {},
          onDone: () => {},
          onError: (result) => {
            errorCode = result.errorCode ?? null;
          },
        },
      }),
    );
    expect(errorCode).toBe("validation_failed");
  });
});
