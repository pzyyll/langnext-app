// ABOUTME: Provider runtime lifecycle action controller tests.
// ABOUTME: Asserts preview ordering, permission acknowledgement, cache invalidation, failure isolation.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { modelKeys, providerKeys, providerRuntimeKeys } from "../../query/keys";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import type {
  ProviderInstanceDto,
  ProviderRuntimeBindingDto,
  ProviderRuntimeRollbackPreviewDto,
  ProviderRuntimeUpgradePreviewDto,
} from "../../storage/types";
import { createRuntimeProviderActions } from "./runtimeProviderActions";

installTauriInvokeMock();

const LEGACY_BINDING = {
  runtimeKind: "legacy-frontend-provider",
  packageDigest: null,
  grantSetRevision: null,
  state: "active",
  errorCode: null,
  errorMessage: null,
  updatedAt: "t0",
} satisfies ProviderRuntimeBindingDto;

const TARGET_BINDING = {
  runtimeKind: "wasm-component",
  packageDigest: "digest-1",
  grantSetRevision: 1,
  state: "active",
  errorCode: null,
  errorMessage: null,
  updatedAt: "t2",
} satisfies ProviderRuntimeBindingDto;

const UPGRADE_PREVIEW = {
  previewId: "pv-1",
  providerId: "p1",
  source: LEGACY_BINDING,
  target: TARGET_BINDING,
  targetPluginVersion: "1.0.0",
  targetPublisher: { keyId: "key-1", keyFingerprint: "fp-1" },
  legacyAliases: ["openai-compatible"],
  requiresPermissionApproval: true,
  expiresAt: "t1",
} satisfies ProviderRuntimeUpgradePreviewDto;

const ROLLBACK_PREVIEW = {
  previewId: "rb-1",
  providerId: "p1",
  snapshotId: "snap-1",
  current: TARGET_BINDING,
  target: LEGACY_BINDING,
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

describe("runtime_provider_actions_preview_apply_rollback_and_invalidate", () => {
  test("preview is requested first; permission-expanding apply requires acknowledgement and invalidates caches", async () => {
    const applyCalls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "preview_provider_runtime_upgrade") {
        expect(args).toEqual({ providerId: "p1", targetPackageDigest: "digest-1" });
        return UPGRADE_PREVIEW;
      }
      if (cmd === "apply_provider_runtime_upgrade") {
        applyCalls.push(args);
        return { providerId: "p1", runtime: TARGET_BINDING, updatedAt: "t2" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });

    const preview = await actions.previewUpgrade({ providerId: "p1", targetPackageDigest: "digest-1" });
    expect(preview.previewId).toBe("pv-1");
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Permission-expanding apply without acknowledgement fails before IPC and invalidates nothing.
    await expect(actions.applyUpgrade({ preview, acknowledgePermissions: false })).rejects.toThrow(/acknowledg/i);
    expect(applyCalls).toHaveLength(0);
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Acknowledged apply succeeds and invalidates Provider and Provider-model caches.
    const applied = await actions.applyUpgrade({ preview, acknowledgePermissions: true });
    expect(applied.runtime).toEqual(TARGET_BINDING);
    expect(applyCalls).toEqual([{ input: { previewId: "pv-1", acknowledgePermissions: true } }]);
    const invalidatedKeys = invalidateSpy.mock.calls.map(([options]) => (options as { queryKey: unknown }).queryKey);
    expect(invalidatedKeys).toContainEqual(providerKeys.all);
    expect(invalidatedKeys).toContainEqual(modelKeys.all);
  });

  test("apply without permission expansion still requires the preview and invalidates on success", async () => {
    const applyCalls: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "apply_provider_runtime_upgrade") {
        applyCalls.push(args);
        return { providerId: "p1", runtime: TARGET_BINDING, updatedAt: "t2" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });
    const noPermissionPreview = { ...UPGRADE_PREVIEW, requiresPermissionApproval: false };
    const applied = await actions.applyUpgrade({ preview: noPermissionPreview, acknowledgePermissions: false });
    expect(applied.providerId).toBe("p1");
    expect(applyCalls).toEqual([{ input: { previewId: "pv-1", acknowledgePermissions: false } }]);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  test("failed or cancelled actions mutate neither cache nor runtime identity", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "apply_provider_runtime_upgrade" || cmd === "apply_provider_runtime_rollback") {
        throw { code: "conflict", message: "preview missing or expired" };
      }
      if (cmd === "preview_provider_runtime_rollback") {
        return ROLLBACK_PREVIEW;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await expect(
      actions.applyUpgrade({ preview: UPGRADE_PREVIEW, acknowledgePermissions: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Rollback preview exposes the stored identity without mutating anything.
    const rollbackPreview = await actions.previewRollback({ providerId: "p1" });
    expect(rollbackPreview.snapshotId).toBe("snap-1");
    expect(rollbackPreview.target).toEqual(LEGACY_BINDING);
    expect(invalidateSpy).not.toHaveBeenCalled();

    await expect(actions.applyRollback({ preview: rollbackPreview })).rejects.toMatchObject({ code: "conflict" });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("successful rollback invalidates Provider and Provider-model caches", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "apply_provider_runtime_rollback") {
        return { providerId: "p1", runtime: LEGACY_BINDING, updatedAt: "t3" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");
    const actions = createRuntimeProviderActions({ queryClient });
    const rolledBack = await actions.applyRollback({ preview: ROLLBACK_PREVIEW });
    expect(rolledBack.runtime).toEqual(LEGACY_BINDING);
    const invalidatedKeys = invalidateSpy.mock.calls.map(([options]) => (options as { queryKey: unknown }).queryKey);
    expect(invalidatedKeys).toContainEqual(providerKeys.all);
    expect(invalidatedKeys).toContainEqual(modelKeys.all);
  });

  test("rollback is exposed only when the provider holds a package binding", () => {
    const actions = createRuntimeProviderActions({ queryClient: new QueryClient() });
    expect(actions.isRollbackAvailable(provider({ runtime: LEGACY_BINDING }))).toBe(false);
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
