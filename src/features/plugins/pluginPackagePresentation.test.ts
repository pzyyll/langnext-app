// ABOUTME: Unit tests for plugin package presentation helpers.
// ABOUTME: Covers digest formatting, trust keys, uninstall gating, and permission summaries.
import { describe, expect, test } from "bun:test";
import {
  formatPackageDigestShort,
  isPackageExecutionEnabled,
  isUninstallDisabled,
  publisherTrustLabelKey,
  requiresPublisherApproval,
  summarizeNetworkPermissions,
} from "./pluginPackagePresentation";

describe("pluginPackagePresentation", () => {
  test("formatPackageDigestShort keeps short digests intact", () => {
    expect(formatPackageDigestShort("abcdef")).toBe("abcdef");
  });

  test("formatPackageDigestShort truncates long digests", () => {
    const digest = "a".repeat(64);
    expect(formatPackageDigestShort(digest)).toBe(`${"a".repeat(8)}…${"a".repeat(6)}`);
  });

  test("publisherTrustLabelKey covers every trust state", () => {
    expect(publisherTrustLabelKey("trusted_vendor")).toContain("trustedVendor");
    expect(publisherTrustLabelKey("trusted_user")).toContain("trustedUser");
    expect(publisherTrustLabelKey("unknown")).toContain("unknown");
    expect(publisherTrustLabelKey("revoked")).toContain("revoked");
    expect(publisherTrustLabelKey("disabled")).toContain("disabled");
  });

  test("uninstall disabled only when backend reports in_use", () => {
    expect(isUninstallDisabled({ inUse: true })).toBe(true);
    expect(isUninstallDisabled({ inUse: false })).toBe(false);
  });

  test("requiresPublisherApproval mirrors preview flag", () => {
    expect(requiresPublisherApproval({ requiresPublisherApproval: true })).toBe(true);
    expect(requiresPublisherApproval({ requiresPublisherApproval: false })).toBe(false);
  });

  test("summarizeNetworkPermissions formats methods and origins", () => {
    const summary = summarizeNetworkPermissions([
      { id: "api", origins: ["https://api.example.com"], methods: ["POST", "GET"] },
    ]);
    expect(summary).toEqual([{ id: "api", summary: "POST, GET → https://api.example.com" }]);
  });

  test("package execution remains disabled in Phase 3", () => {
    expect(isPackageExecutionEnabled({ runtimeKind: "wasm-component" })).toBe(false);
  });
});
