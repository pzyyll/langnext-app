// ABOUTME: Unit tests for the user archive inspect/install Effect workflow Promise runners.
// ABOUTME: Mocks dialog and IPC; asserts cancel, inspect, exact-digest install, and discard.
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const openMock = mock(async (): Promise<string | null> => null);
const invokeMock = mock(async (): Promise<unknown> => {
  throw new Error("invoke not stubbed");
});

let runDiscardUserPluginPackagePreview: typeof import("./installPluginPackageFlow").runDiscardUserPluginPackagePreview;
let runInstallUserPluginPackage: typeof import("./installPluginPackageFlow").runInstallUserPluginPackage;
let runSelectAndPreviewUserPluginPackage: typeof import("./installPluginPackageFlow").runSelectAndPreviewUserPluginPackage;

beforeAll(async () => {
  // Re-bind host seams. Keep the full core export surface so later suites can still import Channel.
  mock.module("@tauri-apps/plugin-dialog", () => ({
    open: openMock,
  }));
  mock.module("@tauri-apps/api/core", () => ({
    invoke: invokeMock,
    Channel: class Channel {},
    Resource: class Resource {},
    transformCallback: () => "",
    convertFileSrc: (path: string) => path,
    isTauri: () => false,
    IS_TAURI: false,
  }));
  // Sibling suites may have replaced this module; cache-bust to load the real runners.
  const flow = await import(`./installPluginPackageFlow?suite=${Date.now()}`);
  runDiscardUserPluginPackagePreview = flow.runDiscardUserPluginPackagePreview;
  runInstallUserPluginPackage = flow.runInstallUserPluginPackage;
  runSelectAndPreviewUserPluginPackage = flow.runSelectAndPreviewUserPluginPackage;
});

describe("installPluginPackageFlow", () => {
  beforeEach(() => {
    openMock.mockReset();
    invokeMock.mockReset();
  });

  test("select cancel returns null without inspect IPC", async () => {
    openMock.mockResolvedValueOnce(null);
    const result = await runSelectAndPreviewUserPluginPackage();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("select then inspect returns the sanitized permission review", async () => {
    openMock.mockResolvedValueOnce("C:\\\\pkg\\\\user.lnplugin");
    invokeMock.mockImplementation(async (cmd: string) => {
      expect(cmd).toBe("preview_user_plugin_package");
      return {
        previewId: "preview-1",
        contentDigest: "a".repeat(64),
        pluginId: "com.example.translate",
        version: "1.0.0",
        runtimeKind: "wasm-component",
        capabilities: ["translate.text@1"],
        configurationSchema: null,
        network: [],
        authPolicies: [],
        credentialSlots: [],
        fileCount: 3,
        totalBytes: 2048,
        permissionDifferences: [],
        warnings: ["user plugin content has no authenticated publisher identity"],
        expiresAt: "2099-01-01T00:00:00Z",
      };
    });
    const result = await runSelectAndPreviewUserPluginPackage();
    expect(result?.previewId).toBe("preview-1");
    expect(result?.contentDigest).toHaveLength(64);
    expect(result?.warnings[0]).toContain("no authenticated publisher");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("install sends the exact digest and discard uses the opaque preview id", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "install_user_plugin_package") {
        return {
          entry: {
            pluginId: "com.example.translate",
            version: "1.0.0",
            source: "user",
            contentKind: "archive",
            contentDigest: "a".repeat(64),
            runtimeKind: "wasm-component",
            pluginApiVersion: "1.0",
            capabilities: [],
            configurationSchema: null,
            network: [],
            authPolicies: [],
            credentialSlots: [],
            fileCount: 3,
            totalBytes: 2048,
            isDefault: false,
            inUse: false,
            removable: true,
            reloadable: false,
          },
        };
      }
      if (cmd === "discard_user_plugin_package_preview") {
        return undefined;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    const installed = await runInstallUserPluginPackage({
      previewId: "preview-1",
      contentDigest: "a".repeat(64),
      acknowledgePermissions: true,
    });
    expect(installed.entry.contentDigest).toBe("a".repeat(64));

    await runDiscardUserPluginPackagePreview("preview-1");
    const cmds = invokeMock.mock.calls.map((call) => call[0]);
    expect(cmds).toEqual(["install_user_plugin_package", "discard_user_plugin_package_preview"]);
    expect(invokeMock.mock.calls[0][1]).toEqual({
      input: { previewId: "preview-1", contentDigest: "a".repeat(64), acknowledgePermissions: true },
    });
  });
});
