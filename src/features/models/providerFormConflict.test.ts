// ABOUTME: Contract tests for provider dirty-form remote conflict helpers.
// ABOUTME: Covers detection and banner dismissal against advancing remote versions.
import { describe, expect, test } from "bun:test";
import { hasRemoteProviderConflict, shouldShowConflictBanner } from "./providerFormConflict";

describe("hasRemoteProviderConflict", () => {
  test("clean form never conflicts even when remote advances", () => {
    expect(hasRemoteProviderConflict(false, "t1", "t2")).toBe(false);
  });

  test("dirty form with matching baseline is not a conflict", () => {
    expect(hasRemoteProviderConflict(true, "t1", "t1")).toBe(false);
  });

  test("dirty form with divergent remote version is a conflict", () => {
    expect(hasRemoteProviderConflict(true, "t1", "t2")).toBe(true);
  });
});

describe("shouldShowConflictBanner", () => {
  test("hidden when there is no conflict", () => {
    expect(shouldShowConflictBanner(false, "t2", null)).toBe(false);
  });

  test("shown for a new remote version", () => {
    expect(shouldShowConflictBanner(true, "t2", null)).toBe(true);
    expect(shouldShowConflictBanner(true, "t2", "t1")).toBe(true);
  });

  test("hidden after user dismisses the same remote version", () => {
    expect(shouldShowConflictBanner(true, "t2", "t2")).toBe(false);
  });

  test("shown again when remote advances past the dismissed version", () => {
    expect(shouldShowConflictBanner(true, "t3", "t2")).toBe(true);
  });
});
