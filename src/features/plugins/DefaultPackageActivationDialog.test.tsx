// ABOUTME: Default package authorization flow tests for preview/authorize IPC.
// ABOUTME: Asserts acknowledgement-gated authorize input and no direct-set command.
import { beforeEach, describe, expect, mock, test } from "bun:test";
const SHA256_HEX_LEN = 64;

const invokeMock = mock(async (): Promise<unknown> => {
  throw new Error("invoke not stubbed");
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class Channel {},
  Resource: class Resource {},
  transformCallback: () => "",
  convertFileSrc: (path: string) => path,
  isTauri: () => false,
  IS_TAURI: false,
}));

const { runAuthorizeDefaultPluginPackage, runPreviewDefaultPackageActivation } =
  await import("./defaultPackageActivationFlow");

const PACKAGE_DIGEST = "a".repeat(SHA256_HEX_LEN);

describe("DefaultPackageActivationDialog flow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("preview then authorize send only opaque preview ID plus acknowledgement", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "preview_default_package_activation") {
        return {
          previewId: "preview-default-1",
          pluginId: "com.example.translate",
          packageDigest: PACKAGE_DIGEST,
          version: "1.0.0",
          publisherKeyId: "com.example.keys.1",
          publisherFingerprint: "b".repeat(SHA256_HEX_LEN),
          runtimeKind: "wasm-component",
          permissionRequestDigest: "c".repeat(SHA256_HEX_LEN),
          capabilities: ["translate.text@1"],
          fixedNetworkAuthority: [
            {
              capabilityId: "translate.text@1",
              endpointId: "translate",
              origin: "https://example.com",
              baseUrl: "https://example.com",
              method: "POST",
              authPolicy: "none",
              originKind: "fixed",
              responseBodyModes: "json",
              resourceLimits: {
                maxRequestBytes: 1024,
                maxResponseBytes: 2048,
                maxStreamBytes: 4096,
                timeoutMs: 5000,
              },
            },
          ],
          dynamicAuthorityWarnings: [],
          authPolicies: ["none"],
          resourceLimits: {
            maxRequestBytes: 1024,
            maxResponseBytes: 2048,
            maxStreamBytes: 4096,
            timeoutMs: 5000,
          },
          requiresInstanceConfirmationForDynamicOrigins: false,
          expiresAt: "2099-01-01T00:00:00Z",
        };
      }
      if (cmd === "authorize_default_plugin_package") {
        return {
          pluginId: "com.example.translate",
          packageDigest: PACKAGE_DIGEST,
          updatedAt: "2099-01-01T00:00:00Z",
        };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const preview = await runPreviewDefaultPackageActivation(PACKAGE_DIGEST);
    expect(preview.previewId).toBe("preview-default-1");
    expect(preview.publisherFingerprint).toHaveLength(64);
    expect(preview.packageDigest).toBe(PACKAGE_DIGEST);
    expect(preview.capabilities).toContain("translate.text@1");
    expect(preview.fixedNetworkAuthority[0]?.origin).toBe("https://example.com");
    expect(preview.fixedNetworkAuthority[0]?.resourceLimits?.maxRequestBytes).toBe(1024);
    expect(preview.fixedNetworkAuthority[0]?.resourceLimits?.maxResponseBytes).toBe(2048);
    expect(preview.fixedNetworkAuthority[0]?.resourceLimits?.maxStreamBytes).toBe(4096);
    expect(preview.fixedNetworkAuthority[0]?.resourceLimits?.timeoutMs).toBe(5000);
    expect(preview.resourceLimits?.maxRequestBytes).toBe(1024);

    // UI gates confirm on acknowledgement; only after that does authorize run.
    const authorized = await runAuthorizeDefaultPluginPackage({
      previewId: preview.previewId,
      acknowledgeFutureInstanceAuthority: true,
    });
    expect(authorized.packageDigest).toBe(PACKAGE_DIGEST);

    const cmds = invokeMock.mock.calls.map((call) => call[0]);
    expect(cmds).toEqual(["preview_default_package_activation", "authorize_default_plugin_package"]);
    expect(cmds).not.toContain("set_default_plugin_package");
    expect(invokeMock.mock.calls[1]?.[1]).toEqual({
      input: {
        previewId: "preview-default-1",
        acknowledgeFutureInstanceAuthority: true,
      },
    });
  });

  test("unsigned default forwards a separate exact-risk acknowledgement", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
      expect(cmd).toBe("authorize_default_plugin_package");
      expect(args).toEqual({
        input: {
          previewId: "unsigned-default-preview",
          acknowledgeFutureInstanceAuthority: true,
          acknowledgeUnsignedDefaultRisk: true,
        },
      });
      return {
        pluginId: "com.example.unsigned",
        packageDigest: PACKAGE_DIGEST,
        updatedAt: "2099-01-01T00:00:00Z",
      };
    });
    const result = await runAuthorizeDefaultPluginPackage({
      previewId: "unsigned-default-preview",
      acknowledgeFutureInstanceAuthority: true,
      acknowledgeUnsignedDefaultRisk: true,
    });
    expect(result.packageDigest).toBe(PACKAGE_DIGEST);
  });

  test("authorize without acknowledgement is rejected by the client contract", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "authorize_default_plugin_package") {
        throw new Error("acknowledgement required");
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    await expect(
      runAuthorizeDefaultPluginPackage({
        previewId: "preview-default-1",
        acknowledgeFutureInstanceAuthority: false,
      }),
    ).rejects.toBeTruthy();

    const cmds = invokeMock.mock.calls.map((call) => call[0]);
    expect(cmds).toEqual(["authorize_default_plugin_package"]);
    expect(cmds).not.toContain("set_default_plugin_package");
  });
});
