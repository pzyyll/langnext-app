// ABOUTME: Unit tests for shared translate failure message mapping.
// ABOUTME: Covers timeout/protocol codes, server message preference, and fallback labels.
import { describe, expect, test } from "bun:test";
import { resolveTranslateFailureMessage } from "./resolveTranslateFailureMessage";

const labels = {
  timeout: "Request timed out",
  invalidResponse: "Invalid model response",
  fallback: "Translation failed",
};

describe("resolveTranslateFailureMessage", () => {
  test("maps timeout error code to timeout label", () => {
    expect(resolveTranslateFailureMessage("timeout", "server said boom", labels)).toBe("Request timed out");
  });

  test("maps invalid_response to protocol label without raw message", () => {
    expect(resolveTranslateFailureMessage("invalid_response", "stream event is not JSON", labels)).toBe(
      "Invalid model response",
    );
  });

  test("prefers server message when error code is not a known protocol code", () => {
    expect(resolveTranslateFailureMessage("provider_error", "upstream 502", labels)).toBe("upstream 502");
  });

  test("uses fallback when message is empty or missing", () => {
    expect(resolveTranslateFailureMessage("provider_error", "", labels)).toBe("Translation failed");
    expect(resolveTranslateFailureMessage(null, undefined, labels)).toBe("Translation failed");
    expect(resolveTranslateFailureMessage(undefined, undefined, labels)).toBe("Translation failed");
  });
});
