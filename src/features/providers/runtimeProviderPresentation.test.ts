// ABOUTME: Pure sanitized provider runtime presentation mapping tests.
// ABOUTME: Asserts only label keys, runtime kind/version, safe state, and explicit actions.
import { describe, expect, test } from "bun:test";
import type {
  ProviderInstanceDto,
  ProviderRuntimeBindingDto,
  ProviderRuntimeCatalogEntryDto,
} from "../../storage/types";
import {
  listAttachableRuntimeInterfaces,
  presentProviderRuntime,
  shortPackageDigest,
  type ProviderRuntimeStateLabelKey,
} from "./runtimeProviderPresentation";

function acceptPackageOnlyLabelKey(key: "activeRuntime" | "unavailableRuntime" | "pendingActivation"): void {
  void key;
}

function assertPackageOnlyLabelKey(key: ProviderRuntimeStateLabelKey): void {
  acceptPackageOnlyLabelKey(key);
}

const CATALOG_ENTRY = {
  pluginId: "langnext.conformance.llm-provider",
  version: "1.0.0",
  packageDigest: "digest-1",
  legacyAliases: ["openai-compatible"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "a" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "b" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

const CATALOG_ENTRY_B = {
  pluginId: "com.langnext.provider.openai-v2",
  version: "1.1.0",
  packageDigest: "digest-2",
  legacyAliases: ["openai-compatible"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "c" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "d" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

const CATALOG_ENTRY_C = {
  pluginId: "com.langnext.provider.openai-v3",
  version: "2.0.0",
  packageDigest: "digest-3",
  legacyAliases: ["openai-compatible"],
  capabilities: [
    { capabilityId: "llm.models.list@1", artifactPath: "fixtures/llm-models.wasm", artifactDigest: "e" },
    { capabilityId: "llm.chat@1", artifactPath: "fixtures/llm-chat.wasm", artifactDigest: "f" },
  ],
  detection: null,
} satisfies ProviderRuntimeCatalogEntryDto;

function binding(partial: Partial<ProviderRuntimeBindingDto>): ProviderRuntimeBindingDto {
  return {
    runtimeKind: "wasm-component",
    packageDigest: null,
    grantSetRevision: null,
    state: "active",
    errorCode: null,
    errorMessage: null,
    updatedAt: "t",
    ...partial,
  };
}

function provider(partial: Partial<ProviderInstanceDto> & Pick<ProviderInstanceDto, "runtime">): ProviderInstanceDto {
  return {
    id: "p1",
    adapterId: "openai-compatible",
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
    createdAt: "t",
    updatedAt: "t",
    ...partial,
  };
}

describe("presentProviderRuntime", () => {
  test("unavailable runtime binding without a package exposes no actions", () => {
    const view = presentProviderRuntime({
      provider: provider({ runtime: binding({ state: "unavailable" }) }),
      catalogEntry: null,
    });
    expect(view.labelKey).toBe("unavailableRuntime");
    assertPackageOnlyLabelKey(view.labelKey);
    expect(view.actions).toEqual({ canApply: false, canRollback: false });
  });

  test("active wasm binding projects the catalog package version and rollback", () => {
    const view = presentProviderRuntime({
      provider: provider({
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          grantSetRevision: 1,
        }),
      }),
      catalogEntry: CATALOG_ENTRY,
    });
    expect(view).toEqual({
      labelKey: "activeRuntime",
      runtimeKind: "wasm-component",
      version: "1.0.0",
      state: "active",
      disableReadyActions: false,
      actions: { canApply: false, canRollback: true },
    });
    assertPackageOnlyLabelKey(view.labelKey);
  });

  test("active wasm binding without a catalog entry is presented as unavailable", () => {
    const view = presentProviderRuntime({
      provider: provider({
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "missing-digest",
          grantSetRevision: 1,
        }),
      }),
      catalogEntry: null,
    });
    expect(view.labelKey).toBe("unavailableRuntime");
    assertPackageOnlyLabelKey(view.labelKey);
    expect(view.version).toBeNull();
    expect(view.disableReadyActions).toBe(true);
    // The active binding may still roll back to a retained package snapshot.
    expect(view.actions).toEqual({ canApply: false, canRollback: true });
  });

  test("unavailable runtime binding keeps the provider identity without actions", () => {
    const view = presentProviderRuntime({
      provider: provider({
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          state: "unavailable",
          errorCode: "plugin_unavailable",
        }),
      }),
      catalogEntry: CATALOG_ENTRY,
    });
    expect(view.labelKey).toBe("unavailableRuntime");
    assertPackageOnlyLabelKey(view.labelKey);
    expect(view.state).toBe("unavailable");
    expect(view.disableReadyActions).toBe(true);
    expect(view.actions).toEqual({ canApply: false, canRollback: false });
  });

  test("pending activation exposes an apply action and disables ready actions", () => {
    const view = presentProviderRuntime({
      provider: provider({
        runtime: binding({
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          grantSetRevision: 1,
          state: "pending_activation",
        }),
      }),
      catalogEntry: CATALOG_ENTRY,
    });
    expect(view.labelKey).toBe("pendingActivation");
    assertPackageOnlyLabelKey(view.labelKey);
    expect(view.disableReadyActions).toBe(true);
    expect(view.actions).toEqual({ canApply: true, canRollback: true });
  });
});

describe("listAttachableRuntimeInterfaces replace candidates", () => {
  test("another package declaring an already-bound adapter is a replace candidate, not excluded", () => {
    const boundProvider = provider({
      runtime: binding({
        adapterId: "openai-compatible",
        runtimeKind: "wasm-component",
        packageDigest: "digest-1",
        grantSetRevision: 1,
      }),
      runtimeBindings: [
        binding({
          adapterId: "openai-compatible",
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          grantSetRevision: 1,
        }),
      ],
    });
    const candidates = listAttachableRuntimeInterfaces(boundProvider, [CATALOG_ENTRY, CATALOG_ENTRY_B]);
    expect(candidates).toContainEqual({
      adapterId: "openai-compatible",
      packageDigest: "digest-2",
      pluginId: "com.langnext.provider.openai-v2",
      version: "1.1.0",
      isReplace: true,
    });
    // The package that already owns the adapter is never offered again.
    expect(
      candidates.some(
        (candidate) => candidate.packageDigest === "digest-1" && candidate.adapterId === "openai-compatible",
      ),
    ).toBe(false);
  });

  test("unbound aliases stay plain attach candidates", () => {
    const candidate = listAttachableRuntimeInterfaces(
      provider({
        runtime: binding({ adapterId: "openai-compatible" }),
        runtimeBindings: [binding({ adapterId: "openai-compatible" })],
      }),
      [CATALOG_ENTRY_B],
    );
    expect(candidate).toEqual([
      {
        adapterId: "openai-compatible",
        packageDigest: "digest-2",
        pluginId: "com.langnext.provider.openai-v2",
        version: "1.1.0",
        isReplace: false,
      },
    ]);
  });

  test("replace candidates for one adapter carry distinct plugin and digest identity", () => {
    const boundProvider = provider({
      runtime: binding({ adapterId: "openai-compatible" }),
      runtimeBindings: [
        binding({
          adapterId: "openai-compatible",
          runtimeKind: "wasm-component",
          packageDigest: "digest-1",
          grantSetRevision: 1,
        }),
      ],
    });
    const replaceCandidates = listAttachableRuntimeInterfaces(boundProvider, [
      CATALOG_ENTRY,
      CATALOG_ENTRY_B,
      CATALOG_ENTRY_C,
    ]).filter((candidate) => candidate.isReplace);
    expect(replaceCandidates).toHaveLength(2);
    const identities = new Set(
      replaceCandidates.map((candidate) => `${candidate.pluginId}:${candidate.version}:${candidate.packageDigest}`),
    );
    expect(identities.size).toBe(2);
  });
});

describe("package identity presentation", () => {
  test("shortPackageDigest keeps a stable 8-character prefix for long digests", () => {
    expect(shortPackageDigest("0123456789abcdef")).toBe("01234567");
    expect(shortPackageDigest("short")).toBe("short");
  });
});
