// ABOUTME: Model sync workflow executor-selection tests.
// ABOUTME: Asserts complete-snapshot apply, dedupe, failure preservation, and version races.
import { afterEach, describe, expect, test } from "bun:test";
import { registerBuiltinProviderPlugins } from "../providers/builtin";
import type {
  ProviderInstanceDto,
  ProviderModelDto,
  ProviderRuntimeCatalogEntryDto,
  SyncModelsResult,
} from "../../storage/types";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import { syncProviderModelsFrontend } from "./providerModelSync";

installTauriInvokeMock();
registerBuiltinProviderPlugins();

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

function currentModels(): ProviderModelDto[] {
  return [
    {
      id: "00000000-0000-7000-8000-000000000001",
      providerInstanceId: PROVIDER_ID,
      source: "remote",
      modelKey: "kept-1",
      remoteDisplayName: null,
      displayNameOverride: null,
      enabled: true,
      availability: "available",
      remoteMetadataJson: null,
      capabilityOverridesJson: null,
      adapterId: null,
      lastSeenAt: null,
      createdAt: "t",
      updatedAt: "t",
    },
  ];
}

function syncResultFixture(partial: Partial<SyncModelsResult>): SyncModelsResult {
  return {
    ok: false,
    errorCode: null,
    message: "ok",
    models: [],
    provider: runtimeProvider(),
    ...partial,
  };
}

function legacyTransportCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "provider_http_request" || cmd === "provider_http_stream");
}

afterEach(() => {
  resetInvokeMock();
});

describe("runtime_executor_connection_and_sync_preserve_complete_snapshot_semantics", () => {
  test("runtime sync passes every unique model once through the complete-snapshot apply path", async () => {
    const applyArgs: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_runtime_models_list") {
        return {
          models: [
            { id: "gpt-4o-mini", label: "GPT-4o mini" },
            { id: "gpt-4o" },
            { id: "gpt-4o-mini", label: "GPT-4o mini" },
          ],
        };
      }
      if (cmd === "apply_provider_model_sync") {
        applyArgs.push(args);
        return syncResultFixture({
          ok: true,
          errorCode: null,
          message: "synced",
          models: [],
          provider: runtimeProvider(),
        });
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const result = await syncProviderModelsFrontend(runtimeProvider(), [], [CATALOG_ENTRY]);
    expect(result.ok).toBe(true);
    expect(applyArgs).toHaveLength(1);
    const payload = applyArgs[0] as {
      providerInstanceId: string;
      expectedUpdatedAt: string;
      remoteModels: Array<{ modelKey: string; remoteDisplayName: string | null; remoteMetadataJson: unknown }>;
    };
    expect(payload.providerInstanceId).toBe(PROVIDER_ID);
    expect(payload.expectedUpdatedAt).toBe("t");
    expect(payload.remoteModels.map((m) => m.modelKey)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("runtime list failure preserves current model rows and provider identity", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_runtime_models_list") {
        throw { code: "network", message: "upstream unreachable" };
      }
      if (cmd === "apply_provider_model_sync_failure") {
        return syncResultFixture({ errorCode: "network", message: "upstream unreachable", models: currentModels() });
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const models = currentModels();
    const result = await syncProviderModelsFrontend(runtimeProvider(), models, [CATALOG_ENTRY]);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("network");
    expect(result.models).toEqual(models);
    expect(result.provider.id).toBe(PROVIDER_ID);
    expect(legacyTransportCalls()).toHaveLength(0);
  });

  test("changed updatedAt returns connection_changed without persistence", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "provider_runtime_models_list") {
        return { models: [{ id: "gpt-4o-mini" }] };
      }
      if (cmd === "apply_provider_model_sync") {
        return syncResultFixture({
          errorCode: "connection_changed",
          message: "connection changed",
          models: [],
        });
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const result = await syncProviderModelsFrontend(runtimeProvider(), [], [CATALOG_ENTRY]);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("connection_changed");
    const failureCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "apply_provider_model_sync_failure");
    expect(failureCalls).toHaveLength(0);
  });
});

describe("syncProviderModelsFrontend legacy behavior", () => {
  test("legacy provider dedupes and merges one complete snapshot into the apply path", async () => {
    const pageBody = JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] });
    const applyArgs: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_http_request") {
        const wire = (args.input as { wire: { relativePath: string } }).wire;
        if (wire.relativePath === "models") {
          return { status: 200, headers: {}, body: pageBody };
        }
        throw new Error(`unexpected wire path ${wire.relativePath}`);
      }
      if (cmd === "apply_provider_model_sync") {
        applyArgs.push(args);
        return syncResultFixture({ ok: true, errorCode: null, message: "synced", models: [] });
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const legacy = provider({ id: PROVIDER_ID, adapterId: "openai-compatible" });
    const result = await syncProviderModelsFrontend(legacy, [], []);
    expect(result.ok).toBe(true);
    const payload = applyArgs[0] as { remoteModels: Array<{ modelKey: string }> };
    expect(payload.remoteModels.map((m) => m.modelKey)).toEqual(["a", "b"]);
  });
});
