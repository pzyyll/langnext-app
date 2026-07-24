// ABOUTME: Focused tests for post-import invalidation keys and re-auth warning kinds.
// ABOUTME: Covers provider, integration, proxy, and combined authentication requirements.
import { describe, expect, test } from "bun:test";
import { integrationKeys, modelKeys, profileKeys, providerKeys } from "../../query/keys";
import type { ImportPreview } from "../../storage/types";
import { IMPORT_INVALIDATION_KEYS, importAuthWarningKind, importRequiresAuthentication } from "./importAcceptance";

function preview(
  overrides: Partial<
    Pick<ImportPreview, "requiresAuthentication" | "integrationRequiresAuthentication" | "proxyRequiresAuthentication">
  > = {},
): Pick<ImportPreview, "requiresAuthentication" | "integrationRequiresAuthentication" | "proxyRequiresAuthentication"> {
  return {
    requiresAuthentication: [],
    integrationRequiresAuthentication: [],
    proxyRequiresAuthentication: false,
    ...overrides,
  };
}

describe("IMPORT_INVALIDATION_KEYS", () => {
  test("includes provider, model, profile, and integration prefixes", () => {
    expect(IMPORT_INVALIDATION_KEYS).toEqual([providerKeys.all, modelKeys.all, profileKeys.all, integrationKeys.all]);
  });
});

describe("importRequiresAuthentication", () => {
  test("is false when nothing needs auth", () => {
    expect(importRequiresAuthentication(preview())).toBe(false);
  });

  test("is true for provider auth requirements", () => {
    expect(importRequiresAuthentication(preview({ requiresAuthentication: ["provider-1"] }))).toBe(true);
  });

  test("is true for integration auth requirements", () => {
    expect(importRequiresAuthentication(preview({ integrationRequiresAuthentication: ["integration-1"] }))).toBe(true);
  });

  test("is true for proxy auth requirement", () => {
    expect(importRequiresAuthentication(preview({ proxyRequiresAuthentication: true }))).toBe(true);
  });

  test("treats missing integrationRequiresAuthentication as empty", () => {
    expect(
      importRequiresAuthentication({
        requiresAuthentication: [],
        proxyRequiresAuthentication: false,
      }),
    ).toBe(false);
  });
});

describe("importAuthWarningKind", () => {
  test("returns none when no credentials are required", () => {
    expect(importAuthWarningKind(preview())).toBe("none");
  });

  test("returns providers for channel/proxy re-auth only", () => {
    expect(importAuthWarningKind(preview({ requiresAuthentication: ["p1"] }))).toBe("providers");
    expect(importAuthWarningKind(preview({ proxyRequiresAuthentication: true }))).toBe("providers");
  });

  test("returns integrations for integration re-auth only", () => {
    expect(importAuthWarningKind(preview({ integrationRequiresAuthentication: ["i1"] }))).toBe("integrations");
  });

  test("returns both when providers and integrations need re-auth", () => {
    expect(
      importAuthWarningKind(
        preview({
          requiresAuthentication: ["p1"],
          integrationRequiresAuthentication: ["i1"],
        }),
      ),
    ).toBe("both");
  });
});
