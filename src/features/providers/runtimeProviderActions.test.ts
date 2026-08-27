// ABOUTME: Provider runtime lifecycle action controller tests.
// ABOUTME: Asserts rollback, snapshot discard, cache invalidation, and failure isolation.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { modelKeys, providerKeys, providerRuntimeKeys } from "../../query/keys";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import type {
  ProviderInstanceDto,
  ProviderRuntimeBindingDto,
  ProviderRuntimeRollbackPreviewDto,
} from "../../storage/types";
import { createRuntimeProviderActions } from "./runtimeProviderActions";

installTauriInvokeMock();

const PREVIOUS_PACKAGE_BINDING = {
  adapterId: "openai-compatible",
  runtimeKind: "wasm-component",
  packageDigest: "digest-0",
  grantSetRevision: 1,
  state: "active",
  errorCode: null,
  errorMessage: null,
  updatedAt: "t0",
} satisfies ProviderRuntimeBindingDto;

const TARGET_BINDING = {
  adapterId: "openai-compatible",
  runtimeKind: "wasm-component",
  packageDigest: "digest-1",
  grantSetRevision: 1,
  state: "active",
  errorCode: null,
  errorMessage: null,
  updatedAt: "t2",
} satisfies ProviderRuntimeBindingDto;

const ROLLBACK_PREVIEW = {
  previewId: "rb-1",
  providerId: "p1",
  snapshotId: "snap-1",
  current: TARGET_BINDING,
  target: PREVIOUS_PACKAGE_BINDING,
  expiresAt: "t1",
} satisfies ProviderRuntimeRollbackPreviewDto;

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

afterEach(() => {
  resetInvokeMock();
});

describe("runtime_provider_actions_rollback_and_invalidate", () => {
  test("does not expose provider package-upgrade operations", () => {
    const actions = createRuntimeProviderActions({ queryClient: new QueryClient() });
    expect("previewUpgrade" in actions).toBe(false);
    expect("applyUpgrade" in actions).toBe(false);
  });

  test("failed or cancelled actions mutate neither cache nor runtime identity", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "apply_provider_runtime_rollback") {
        throw { code: "conflict", message: "preview missing or expired" };
      }
      if (cmd === "preview_provider_runtime_rollback") {
        return ROLLBACK_PREVIEW;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    // Rollback preview exposes the stored identity without mutating anything.
    const rollbackPreview = await actions.previewRollback({ providerId: "p1" });
    expect(rollbackPreview.snapshotId).toBe("snap-1");
    expect(rollbackPreview.target.runtimeKind).toBe("wasm-component");
    expect(rollbackPreview.target.packageDigest).toBe("digest-0");
    expect(rollbackPreview.target).toEqual(PREVIOUS_PACKAGE_BINDING);
    expect(invalidateSpy).not.toHaveBeenCalled();

    await expect(actions.applyRollback({ preview: rollbackPreview })).rejects.toMatchObject({ code: "conflict" });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("successful rollback invalidates Provider and Provider-model caches", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "apply_provider_runtime_rollback") {
        return { providerId: "p1", runtime: PREVIOUS_PACKAGE_BINDING, updatedAt: "t3" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });
    const rolledBack = await actions.applyRollback({ preview: ROLLBACK_PREVIEW });
    expect(rolledBack.runtime).toEqual(PREVIOUS_PACKAGE_BINDING);
    const invalidatedKeys = invalidateSpy.mock.calls.map(([options]) => (options as { queryKey: unknown }).queryKey);
    expect(invalidatedKeys).toContainEqual(providerKeys.all);
    expect(invalidatedKeys).toContainEqual(modelKeys.all);
  });

  test("rollback is exposed only when the provider holds a package binding", () => {
    const actions = createRuntimeProviderActions({ queryClient: new QueryClient() });
    expect(actions.isRollbackAvailable(provider({ runtime: PREVIOUS_PACKAGE_BINDING }))).toBe(true);
    expect(
      actions.isRollbackAvailable(
        provider({
          runtime: {
            ...TARGET_BINDING,
            state: "unavailable",
            errorCode: "plugin_unavailable",
            errorMessage: "package missing",
          },
        }),
      ),
    ).toBe(true);
  });

  test("discardSnapshot invalidates the provider runtime snapshot cache (cleanup seam)", async () => {
    const discardCalls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "discard_provider_runtime_snapshot") {
        discardCalls.push(args);
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });

    await actions.discardSnapshot({ providerId: "p1", snapshotId: "snap-1", expectedUpdatedAt: "t0" });
    expect(discardCalls).toEqual([{ input: { providerId: "p1", snapshotId: "snap-1", expectedUpdatedAt: "t0" } }]);
    const invalidatedKeys = invalidateSpy.mock.calls.map(([options]) => (options as { queryKey: unknown }).queryKey);
    expect(invalidatedKeys).toContainEqual(providerRuntimeKeys.all);
  });
});
