// ABOUTME: Unit tests for catalog presentation helpers.
// ABOUTME: Covers digest formatting, source labels, removal gating, and permission summaries.
import { describe, expect, test } from "bun:test";
import {
  confirmationDigest,
  formatContentSize,
  formatPackageDigestShort,
  isPackageExecutionEnabled,
  isReloadableEntry,
  isRemovableEntry,
  isTrustedSource,
  isUserInstallableRuntime,
  pluginSourceLabelKey,
  requiresUserContentWarning,
  summarizeArchiveFiles,
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

  test("pluginSourceLabelKey covers every catalog source", () => {
    expect(pluginSourceLabelKey("built_in")).toContain("builtIn");
    expect(pluginSourceLabelKey("development")).toContain("development");
    expect(pluginSourceLabelKey("user")).toContain("user");
  });

  test("only built-in content is trusted by location", () => {
    expect(isTrustedSource("built_in")).toBe(true);
    expect(isTrustedSource("development")).toBe(false);
    expect(isTrustedSource("user")).toBe(false);
  });

  test("user content always shows the unknown-publisher warning", () => {
    expect(requiresUserContentWarning({ source: "user" })).toBe(true);
    expect(requiresUserContentWarning({ source: "development" })).toBe(false);
    expect(requiresUserContentWarning({ source: "built_in" })).toBe(false);
  });

  test("only Wasm archives are user-installable", () => {
    expect(isUserInstallableRuntime("wasm-component")).toBe(true);
    expect(isUserInstallableRuntime("trusted-native-worker")).toBe(false);
  });

  test("package execution is enabled only for supported runtimes", () => {
    expect(isPackageExecutionEnabled({ runtimeKind: "wasm-component" })).toBe(true);
    expect(isPackageExecutionEnabled({ runtimeKind: "trusted-native-worker" })).toBe(true);
    expect(isPackageExecutionEnabled({ runtimeKind: "bundled-rust" })).toBe(false);
    expect(isPackageExecutionEnabled({ runtimeKind: "unknown" })).toBe(false);
  });

  test("removal requires removable content that is not in use", () => {
    expect(isRemovableEntry({ removable: true, inUse: false })).toBe(true);
    expect(isRemovableEntry({ removable: true, inUse: true })).toBe(false);
    expect(isRemovableEntry({ removable: false, inUse: false })).toBe(false);
  });

  test("reload is limited to reloadable content", () => {
    expect(isReloadableEntry({ reloadable: true })).toBe(true);
    expect(isReloadableEntry({ reloadable: false })).toBe(false);
  });

  test("summarizeNetworkPermissions formats methods and origins", () => {
    const summary = summarizeNetworkPermissions([
      { id: "api", origins: ["https://api.example.com"], methods: ["POST", "GET"] },
    ]);
    expect(summary).toEqual([{ id: "api", summary: "POST, GET → https://api.example.com" }]);
  });

  test("summarizeNetworkPermissions names instance-configured origins", () => {
    const summary = summarizeNetworkPermissions([{ id: "proxy", origins: [], methods: ["GET"] }]);
    expect(summary).toEqual([{ id: "proxy", summary: "GET → instance-configured origin" }]);
  });

  test("formatContentSize scales units", () => {
    expect(formatContentSize(512)).toBe("512 B");
    expect(formatContentSize(2048)).toBe("2 KiB");
    expect(formatContentSize(1024 * 1024 * 3)).toBe("3 MiB");
  });

  test("summarizeArchiveFiles joins count and size", () => {
    expect(summarizeArchiveFiles({ fileCount: 3, totalBytes: 2048 })).toBe("3 files · 2 KiB");
  });

  test("confirmationDigest is the preview content digest", () => {
    expect(confirmationDigest({ contentDigest: "a".repeat(64) })).toBe("a".repeat(64));
  });
});
