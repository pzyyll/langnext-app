// ABOUTME: Unit tests for the install-package Effect workflow Promise runners.
// ABOUTME: Mocks dialog and IPC; asserts cancel, preview, approve, and discard sequencing.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const openMock = mock(async (): Promise<string | null> => null);
const invokeMock = mock(async (): Promise<unknown> => {
  throw new Error("invoke not stubbed");
});

mock.module("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
}));

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const { runApprovePluginPackage, runDiscardPluginPackagePreview, runSelectAndPreviewPluginPackage } =
  await import("./installPluginPackageFlow");

describe("installPluginPackageFlow", () => {
  beforeEach(() => {
    openMock.mockReset();
    invokeMock.mockReset();
  });

  test("select cancel returns null without preview IPC", async () => {
    openMock.mockResolvedValueOnce(null);
    const result = await runSelectAndPreviewPluginPackage();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("select then preview returns sanitized DTO", async () => {
    openMock.mockResolvedValueOnce("C:\\\\pkg\\\\signed-valid.lnplugin");
    invokeMock.mockImplementation(async (cmd: string) => {
      expect(cmd).toBe("preview_plugin_package");
      return {
        previewId: "preview-1",
        packageDigest: "a".repeat(64),
        pluginId: "com.example.translate",
        version: "1.0.0",
        publisherKeyId: "com.example.keys.1",
        publisherFingerprint: "b".repeat(64),
        publisherTrust: "trusted_user",
        requiresPublisherApproval: false,
        runtimeKind: "wasm-component",
        capabilities: ["translate.text@1"],
        configurationSchema: null,
        network: [],
        authPolicies: [],
        permissionRequestDigest: "c".repeat(64),
        permissionDifferences: [],
        warnings: [],
        expiresAt: "2099-01-01T00:00:00Z",
      };
    });
    const result = await runSelectAndPreviewPluginPackage();
    expect(result?.previewId).toBe("preview-1");
    expect(result?.publisherFingerprint).toHaveLength(64);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("approve and discard call the correct commands", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "approve_plugin_package") {
        return {
          version: {
            packageDigest: "a".repeat(64),
            pluginId: "com.example.translate",
            version: "1.0.0",
            publisherKeyId: "com.example.keys.1",
            publisherFingerprint: "b".repeat(64),
            runtimeKind: "wasm-component",
            permissionRequestDigest: "c".repeat(64),
            contentAvailable: true,
            isDefault: false,
            inUse: false,
            installedAt: "2099-01-01T00:00:00Z",
            capabilities: [],
          },
          approvalId: "approval-1",
          approvalRevision: 1,
        };
      }
      if (cmd === "discard_plugin_package_preview") {
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const approved = await runApprovePluginPackage({
      previewId: "preview-1",
      acknowledgePermissions: true,
      approvePublisher: false,
      setAsDefault: false,
    });
    expect(approved.approvalId).toBe("approval-1");

    await runDiscardPluginPackagePreview("preview-1");
    const cmds = invokeMock.mock.calls.map((call) => call[0]);
    expect(cmds).toEqual(["approve_plugin_package", "discard_plugin_package_preview"]);
  });
});
