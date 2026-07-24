// ABOUTME: Unit tests for shared translate failure message mapping.
// ABOUTME: Covers timeout/protocol codes, server message preference, and fallback labels.
import { describe, expect, test } from "bun:test";
import { resolveTranslateFailureMessage, resolveTranslateFailureRecovery } from "./resolveTranslateFailureMessage";

const labels = {
  timeout: "Request timed out",
  invalidResponse: "Invalid model response",
  fallback: "Translation failed",
  integrationDisabled: "Integration disabled",
  integrationUnconfigured: "Integration unconfigured",
  integrationUnvalidated: "Integration unvalidated",
  integrationDegraded: "Integration degraded",
  pluginMissing: "Plugin missing",
  invalidConfiguration: "Integration not ready",
  languageUnresolved: "Languages unresolved",
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

  test("maps plugin runtime codes to state-specific labels", () => {
    expect(resolveTranslateFailureMessage("integration_disabled", "raw", labels)).toBe("Integration disabled");
    expect(resolveTranslateFailureMessage("integration_unconfigured", "raw", labels)).toBe("Integration unconfigured");
    expect(resolveTranslateFailureMessage("integration_unvalidated", "raw", labels)).toBe("Integration unvalidated");
    expect(resolveTranslateFailureMessage("integration_degraded", "raw", labels)).toBe("Integration degraded");
    expect(resolveTranslateFailureMessage("plugin_missing", "raw", labels)).toBe("Plugin missing");
    expect(resolveTranslateFailureMessage("invalid_configuration", "raw", labels)).toBe("Integration not ready");
  });
});

describe("resolveTranslateFailureRecovery", () => {
  test("maps plugin runtime failures to /plugins recovery action", () => {
    for (const code of [
      "plugin_missing",
      "integration_disabled",
      "integration_unconfigured",
      "integration_unvalidated",
      "integration_degraded",
      "invalid_configuration",
    ]) {
      expect(resolveTranslateFailureRecovery(code)).toEqual({ path: "/plugins" });
    }
  });

  test("does not attach recovery for ordinary provider failures", () => {
    expect(resolveTranslateFailureRecovery("timeout")).toBeNull();
    expect(resolveTranslateFailureRecovery("provider_error")).toBeNull();
    expect(resolveTranslateFailureRecovery(null)).toBeNull();
  });
});
