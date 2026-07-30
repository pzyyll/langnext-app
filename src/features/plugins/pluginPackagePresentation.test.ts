// ABOUTME: Unit tests for plugin package presentation helpers.
// ABOUTME: Covers digest formatting, trust keys, uninstall gating, and permission summaries.
import { describe, expect, test } from "bun:test";
import {
  formatPackageDigestShort,
  isPackageExecutionEnabled,
  isUninstallDisabled,
  publisherApprovalKeyHex,
  publisherTrustLabelKey,
  requiresPublisherApproval,
  shouldShowManualPublisherKeyInput,
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

  test("package execution is enabled only for the supported Wasm runtime", () => {
    expect(isPackageExecutionEnabled({ runtimeKind: "wasm-component" })).toBe(true);
    expect(isPackageExecutionEnabled({ runtimeKind: "bundled-rust" })).toBe(false);
    expect(isPackageExecutionEnabled({ runtimeKind: "unknown" })).toBe(false);
  });

  test("publisherApprovalKeyHex forwards the resolved publisher.pub key as-is", () => {
    const resolved = { resolvedPublisherPublicKeyHex: "ab".repeat(32) };
    expect(publisherApprovalKeyHex(resolved, "ignored manual input")).toBe("ab".repeat(32));
  });

  test("publisherApprovalKeyHex falls back to trimmed manual input when no resolved key", () => {
    const noResolved = { resolvedPublisherPublicKeyHex: null };
    expect(publisherApprovalKeyHex(noResolved, "  deadbeef  ")).toBe("deadbeef");
    expect(publisherApprovalKeyHex(noResolved, "")).toBe("");
  });

  test("shouldShowManualPublisherKeyInput hides input when publisher.pub is resolved", () => {
    expect(shouldShowManualPublisherKeyInput({ resolvedPublisherPublicKeyHex: "ab".repeat(32) })).toBe(false);
    expect(shouldShowManualPublisherKeyInput({ resolvedPublisherPublicKeyHex: null })).toBe(true);
    expect(shouldShowManualPublisherKeyInput({ resolvedPublisherPublicKeyHex: undefined })).toBe(true);
  });
});
