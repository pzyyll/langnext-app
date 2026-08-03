// ABOUTME: Connection-test workflow executor-selection tests.
// ABOUTME: Asserts runtime aggregate listing and bounded failure mapping at the public seam.
import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderInstanceDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import { testProviderConnectionFrontend } from "./providerConnection";

installTauriInvokeMock();

const PROVIDER_ID = "provider-1";
const PACKAGE_DIGEST = "digest-1";

const CATALOG_ENTRY = {
  pluginId: "langnext.conformance.llm-provider",
  version: "1.0.0",
  packageDigest: PACKAGE_DIGEST,
  publisher: { keyId: "key-1", keyFingerprint: "fp-1" },
  legacyAliases: ["openai-compatible"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "a" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "b" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

function provider(
  partial: Partial<ProviderInstanceDto> & Pick<ProviderInstanceDto, "id" | "adapterId">,
): ProviderInstanceDto {
  return {
    displayName: "P",
    baseUrl: "https://api.openai.com/v1",
    baseUrlSource: "custom",
    authScheme: { schemaVersion: 1, type: "bearer" },
    credentialKind: "api_key",
    hasCredential: true,
    enabled: true,
    proxyMode: "inherit",
    insecureHttpConfirmedAt: null,
    modelsSyncedAt: null,
    modelsSyncStatus: "never",
    modelsSyncErrorCode: null,
    runtime: {
      adapterId: "openai-compatible",
      runtimeKind: "legacy-frontend-provider",
      packageDigest: null,
      grantSetRevision: null,
      state: "active",
      errorCode: null,
      errorMessage: null,
      updatedAt: "t",
    },
    runtimeBindings: [
      {
        adapterId: "openai-compatible",
        runtimeKind: "legacy-frontend-provider",
        packageDigest: null,
        grantSetRevision: null,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
    ],
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

function runtimeProvider(): ProviderInstanceDto {
  return provider({
    id: PROVIDER_ID,
    adapterId: "openai-compatible",
    runtime: {
      adapterId: "openai-compatible",
      runtimeKind: "wasm-component",
      packageDigest: PACKAGE_DIGEST,
      grantSetRevision: 1,
      state: "active",
      errorCode: null,
      errorMessage: null,
      updatedAt: "t",
    },
    runtimeBindings: [
      {
        adapterId: "openai-compatible",
        runtimeKind: "wasm-component",
        packageDigest: PACKAGE_DIGEST,
        grantSetRevision: 1,
        state: "active",
        errorCode: null,
        errorMessage: null,
        updatedAt: "t",
      },
    ],
  });
}

function legacyTransportCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_http_request" || cmd === "provider_http_stream");
}

afterEach(() => {
  resetInvokeMock();
});

describe("runtime_executor_connection_uses_persisted_executor", () => {
  test("runtime provider connection counts the bounded aggregate list without legacy HTTP", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_runtime_models_list") {
        return {
          models: [
            { id: "gpt-4o-mini", label: "GPT-4o mini" },
            { id: "gpt-4o" },
            { id: "gpt-4o-mini", label: "GPT-4o mini" },
          ],
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await testProviderConnectionFrontend(runtimeProvider(), [CATALOG_ENTRY]);
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(result.providerUpdatedAt).toBe("t");
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("runtime provider connection failure maps to a bounded code without legacy HTTP", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_runtime_models_list") {
        throw { code: "network", message: "upstream unreachable" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const result = await testProviderConnectionFrontend(runtimeProvider(), [CATALOG_ENTRY]);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("network");
    expect(result.modelCount).toBeNull();
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("unavailable runtime binding surfaces a bounded connection error", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("no transport expected");
    });
    const unavailable = provider({
      id: PROVIDER_ID,
      adapterId: "openai-compatible",
      runtime: {
        adapterId: "openai-compatible",
        runtimeKind: "wasm-component",
        packageDigest: PACKAGE_DIGEST,
        grantSetRevision: 1,
        state: "unavailable",
        errorCode: "plugin_unavailable",
        errorMessage: "package missing",
        updatedAt: "t",
      },
      runtimeBindings: [
        {
          adapterId: "openai-compatible",
          runtimeKind: "wasm-component",
          packageDigest: PACKAGE_DIGEST,
          grantSetRevision: 1,
          state: "unavailable",
          errorCode: "plugin_unavailable",
          errorMessage: "package missing",
          updatedAt: "t",
        },
      ],
    });
    const result = await testProviderConnectionFrontend(unavailable, []);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_response");
    expect(invokeMock.mock.calls).toHaveLength(0);
  });
});
