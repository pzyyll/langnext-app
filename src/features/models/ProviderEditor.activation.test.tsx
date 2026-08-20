// ABOUTME: Pure readiness-gating contract for ProviderEditor Get Models / connection actions.
// ABOUTME: Asserts pending and unavailable bindings disable remote ready actions only.
import { describe, expect, test } from "bun:test";
import type {
  ProviderInstanceDto,
  ProviderRuntimeBindingDto,
  ProviderRuntimeCatalogEntryDto,
} from "../../storage/types";
import { presentProviderRuntime } from "../providers/runtimeProviderPresentation";

const CATALOG_ENTRY: ProviderRuntimeCatalogEntryDto = {
  pluginId: "com.example.provider",
  packageDigest: "digest-1",
  version: "1.0.0",
  runtimeKind: "wasm-component",
  legacyAliases: ["openai"],
  publisher: { keyId: "pub-1", keyFingerprint: "fp-1" },
  contentAvailable: true,
};

function binding(overrides: Partial<ProviderRuntimeBindingDto> = {}): ProviderRuntimeBindingDto {
  return {
    providerId: "provider-1",
    adapterId: "openai",
    runtimeKind: "legacy-frontend-provider",
    packageDigest: null,
    grantSetRevision: null,
    state: "active",
    errorCode: null,
    errorMessage: null,
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderInstanceDto> = {}): ProviderInstanceDto {
  const runtime = overrides.runtime ?? binding({});
  return {
    id: "provider-1",
    name: "Provider",
    adapterId: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiType: "openai_chat",
    responseMode: "openai_compatible",
    credentialKind: "bearer",
    hasCredential: true,
    models: [],
    modelCount: 0,
    runtime,
    runtimeBindings: [runtime],
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Mirror ProviderEditor `remoteActionsDisabled` for Get Models / connection test.
 * Keep in sync with ProviderEditor remote action disable expression.
 */
function remoteActionsDisabled(input: {
  connectionDirty: boolean;
  connectionTestPending: boolean;
  syncPending: boolean;
  savePending: boolean;
  modelsLoading: boolean;
  runtime: ProviderRuntimeBindingDto;
  catalogEntry: ProviderRuntimeCatalogEntryDto | null;
}): boolean {
  const presentation = presentProviderRuntime({
    provider: provider({ runtime: input.runtime }),
    catalogEntry: input.catalogEntry,
  });
  return (
    input.connectionDirty ||
    input.connectionTestPending ||
    input.syncPending ||
    input.savePending ||
    input.modelsLoading ||
    presentation.disableReadyActions
  );
}

describe("ProviderEditor Get Models readiness gating", () => {
  const readyBase = {
    connectionDirty: false,
    connectionTestPending: false,
    syncPending: false,
    savePending: false,
    modelsLoading: false,
  };

  test("disables Get Models while package activation is pending", () => {
    expect(
      remoteActionsDisabled({
        ...readyBase,
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          state: "pending_activation",
        }),
        catalogEntry: CATALOG_ENTRY,
      }),
    ).toBe(true);
  });

  test("disables Get Models while runtime is unavailable", () => {
    expect(
      remoteActionsDisabled({
        ...readyBase,
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          state: "unavailable",
        }),
        catalogEntry: CATALOG_ENTRY,
      }),
    ).toBe(true);
  });

  test("enables Get Models for active package binding when ordinary blockers are false", () => {
    expect(
      remoteActionsDisabled({
        ...readyBase,
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          state: "active",
          grantSetRevision: 1,
        }),
        catalogEntry: CATALOG_ENTRY,
      }),
    ).toBe(false);
  });

  test("enables Get Models for legacy-ready bindings", () => {
    expect(
      remoteActionsDisabled({
        ...readyBase,
        runtime: binding({}),
        catalogEntry: CATALOG_ENTRY,
      }),
    ).toBe(false);
  });
});
