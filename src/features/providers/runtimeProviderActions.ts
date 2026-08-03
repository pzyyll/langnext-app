// ABOUTME: Provider runtime lifecycle action controller consumed by ProviderEditor.
// ABOUTME: Preview/apply/rollback/detach IPC with cache invalidation only after successful mutation.
import type { QueryClient } from "@tanstack/react-query";
import { modelKeys, providerKeys, providerRuntimeKeys } from "../../query/keys";
import {
  applyProviderRuntimeInterfaceAttach,
  applyProviderRuntimeInterfaceRollback,
  applyProviderRuntimeRollback,
  applyProviderRuntimeUpgrade,
  detachProviderRuntimeInterface,
  discardProviderRuntimeSnapshot,
  previewProviderRuntimeInterfaceAttach,
  previewProviderRuntimeInterfaceRollback,
  previewProviderRuntimeRollback,
  previewProviderRuntimeUpgrade,
} from "../../storage/client";
import type {
  ApplyProviderRuntimeInterfaceAttachInput,
  ApplyProviderRuntimeInterfaceRollbackInput,
  PreviewProviderRuntimeInterfaceAttachInput,
  PreviewProviderRuntimeInterfaceRollbackInput,
  ProviderInstanceDto,
  ProviderRuntimeInterfaceDetachInput,
  ProviderRuntimeInterfaceDiscardSnapshotInput,
  ProviderRuntimeInterfaceLifecycleResultDto,
  ProviderRuntimeInterfacePreviewDto,
  ProviderRuntimeInterfaceRollbackPreviewDto,
  ProviderRuntimeLifecycleResultDto,
  ProviderRuntimeRollbackPreviewDto,
  ProviderRuntimeUpgradePreviewDto,
} from "../../storage/types";

/** Public lifecycle actions; ProviderEditor is a thin consumer of this controller. */
export interface RuntimeProviderActions {
  previewUpgrade(input: { providerId: string; targetPackageDigest: string }): Promise<ProviderRuntimeUpgradePreviewDto>;
  /** Applies one previewed upgrade; permission-expanding upgrades require acknowledgement. */
  applyUpgrade(input: {
    preview: ProviderRuntimeUpgradePreviewDto;
    acknowledgePermissions: boolean;
  }): Promise<ProviderRuntimeLifecycleResultDto>;
  previewRollback(input: { providerId: string }): Promise<ProviderRuntimeRollbackPreviewDto>;
  applyRollback(input: { preview: ProviderRuntimeRollbackPreviewDto }): Promise<ProviderRuntimeLifecycleResultDto>;
  /** Adapter-keyed interface lifecycle (multi-interface control plane). */
  previewInterfaceAttach(
    input: PreviewProviderRuntimeInterfaceAttachInput,
  ): Promise<ProviderRuntimeInterfacePreviewDto>;
  applyInterfaceAttach(
    input: ApplyProviderRuntimeInterfaceAttachInput,
  ): Promise<ProviderRuntimeInterfaceLifecycleResultDto>;
  previewInterfaceRollback(
    input: PreviewProviderRuntimeInterfaceRollbackInput,
  ): Promise<ProviderRuntimeInterfaceRollbackPreviewDto>;
  applyInterfaceRollback(
    input: ApplyProviderRuntimeInterfaceRollbackInput,
  ): Promise<ProviderRuntimeInterfaceLifecycleResultDto>;
  detachInterface(input: ProviderRuntimeInterfaceDetachInput): Promise<ProviderRuntimeInterfaceLifecycleResultDto>;
  discardSnapshot(input: ProviderRuntimeInterfaceDiscardSnapshotInput): Promise<void>;
  /** Rollback is exposed only while the provider holds a package binding. */
  isRollbackAvailable(provider: Pick<ProviderInstanceDto, "runtime">): boolean;
}

/** Controller dependencies; the Query client is the injected cache invalidator. */
export interface RuntimeProviderActionsDeps {
  queryClient: Pick<QueryClient, "invalidateQueries">;
}

/**
 * Create the lifecycle controller. Provider and Provider-model caches are invalidated only
 * after a successful apply/rollback/detach mutation; failed or cancelled actions change
 * neither.
 */
export function createRuntimeProviderActions(deps: RuntimeProviderActionsDeps): RuntimeProviderActions {
  function invalidateProviderAndModels(): void {
    void deps.queryClient.invalidateQueries({ queryKey: providerKeys.all });
    void deps.queryClient.invalidateQueries({ queryKey: modelKeys.all });
    // Attach/replace/detach/rollback/discard all mutate the rollback snapshot collection;
    // refresh it so the discard seam stays visible until the user cleans it up.
    void deps.queryClient.invalidateQueries({ queryKey: providerRuntimeKeys.all });
  }

  async function applyUpgrade(input: {
    preview: ProviderRuntimeUpgradePreviewDto;
    acknowledgePermissions: boolean;
  }): Promise<ProviderRuntimeLifecycleResultDto> {
    if (input.preview.requiresPermissionApproval && !input.acknowledgePermissions) {
      throw new Error("provider runtime upgrade requires permission acknowledgement");
    }
    const result = await applyProviderRuntimeUpgrade({
      previewId: input.preview.previewId,
      acknowledgePermissions: input.acknowledgePermissions,
    });
    invalidateProviderAndModels();
    return result;
  }

  async function applyRollback(input: {
    preview: ProviderRuntimeRollbackPreviewDto;
  }): Promise<ProviderRuntimeLifecycleResultDto> {
    const result = await applyProviderRuntimeRollback({ previewId: input.preview.previewId });
    invalidateProviderAndModels();
    return result;
  }

  async function applyInterfaceAttach(
    input: ApplyProviderRuntimeInterfaceAttachInput,
  ): Promise<ProviderRuntimeInterfaceLifecycleResultDto> {
    const result = await applyProviderRuntimeInterfaceAttach(input);
    invalidateProviderAndModels();
    return result;
  }

  async function applyInterfaceRollback(
    input: ApplyProviderRuntimeInterfaceRollbackInput,
  ): Promise<ProviderRuntimeInterfaceLifecycleResultDto> {
    const result = await applyProviderRuntimeInterfaceRollback(input);
    invalidateProviderAndModels();
    return result;
  }

  return {
    previewUpgrade: (input) => previewProviderRuntimeUpgrade(input.providerId, input.targetPackageDigest),
    applyUpgrade,
    previewRollback: (input) => previewProviderRuntimeRollback(input.providerId),
    applyRollback,
    previewInterfaceAttach: (input) => previewProviderRuntimeInterfaceAttach(input),
    applyInterfaceAttach,
    previewInterfaceRollback: (input) => previewProviderRuntimeInterfaceRollback(input),
    applyInterfaceRollback,
    detachInterface: async (input) => {
      const result = await detachProviderRuntimeInterface(input);
      invalidateProviderAndModels();
      return result;
    },
    discardSnapshot: async (input) => {
      await discardProviderRuntimeSnapshot(input);
      invalidateProviderAndModels();
    },
    isRollbackAvailable: (provider) => provider.runtime.runtimeKind === "wasm-component",
  };
}
