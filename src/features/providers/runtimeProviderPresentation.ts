// ABOUTME: Pure sanitized provider runtime status mapping for lifecycle UI.
// ABOUTME: Exposes only label keys, runtime kind/version, safe state, and explicit actions.
import type {
  ProviderInstanceDto,
  ProviderRuntimeBindingDto,
  ProviderRuntimeCatalogEntryDto,
  ProviderRuntimeKind,
  ProviderRuntimeState,
} from "../../storage/types";

/** Short localized status label keys; the UI resolves these through i18n. */
export type ProviderRuntimeStateLabelKey = "legacy" | "activeRuntime" | "unavailableRuntime" | "pendingActivation";

/** Sanitized runtime presentation: never package bytes, grants, snapshots, or secret material. */
export interface ProviderRuntimePresentation {
  labelKey: ProviderRuntimeStateLabelKey;
  runtimeKind: ProviderRuntimeKind;
  /** Catalog package version for the bound package; null for legacy or missing entries. */
  version: string | null;
  state: ProviderRuntimeState;
  actions: {
    /** Preview an upgrade is possible only from a legacy binding with a matching catalog package. */
    canPreview: boolean;
    /** A pending activation can be applied. */
    canApply: boolean;
    /** A package binding can be rolled back to the legacy executor. */
    canRollback: boolean;
  };
}

/**
 * Map one provider's sanitized runtime binding to a safe status view.
 * `catalogEntry` must be the catalog entry matching the binding's package digest
 * (or a matching-alias candidate for legacy bindings); the mapper never resolves it.
 */
export function presentProviderRuntime(input: {
  provider: Pick<ProviderInstanceDto, "adapterId" | "runtime">;
  catalogEntry: ProviderRuntimeCatalogEntryDto | null;
}): ProviderRuntimePresentation {
  const { provider, catalogEntry } = input;
  const binding = provider.runtime;

  if (binding.runtimeKind === "legacy-frontend-provider") {
    return {
      labelKey: "legacy",
      runtimeKind: "legacy-frontend-provider",
      version: null,
      state: binding.state,
      actions: { canPreview: catalogEntry != null, canApply: false, canRollback: false },
    };
  }

  const version = catalogEntry?.version ?? null;
  const rollbackOnly = { canPreview: false, canApply: false, canRollback: true } as const;
  if (binding.state === "pending_activation") {
    return {
      labelKey: "pendingActivation",
      runtimeKind: "wasm-component",
      version,
      state: binding.state,
      actions: { canPreview: false, canApply: true, canRollback: true },
    };
  }
  if (binding.state === "active") {
    return {
      labelKey: catalogEntry ? "activeRuntime" : "unavailableRuntime",
      runtimeKind: "wasm-component",
      version,
      state: binding.state,
      actions: rollbackOnly,
    };
  }
  return {
    labelKey: "unavailableRuntime",
    runtimeKind: "wasm-component",
    version,
    state: binding.state,
    actions: rollbackOnly,
  };
}

/** Per-interface presentation for the multi-interface runtime section. */
export interface ProviderInterfaceBindingPresentation {
  binding: ProviderRuntimeBindingDto;
  /** Catalog entry matching the binding's package digest; null when missing/legacy. */
  catalogEntry: ProviderRuntimeCatalogEntryDto | null;
  labelKey: ProviderRuntimeStateLabelKey;
  version: string | null;
  actions: {
    /** An active package binding can be rolled back or detached. */
    canRollback: boolean;
    canDetach: boolean;
  };
}

/**
 * Project every adapter-keyed interface binding of one Provider. A partially available
 * Provider stays visible: one unavailable interface never hides another active/legacy type.
 */
export function presentProviderInterfaceBindings(
  provider: Pick<ProviderInstanceDto, "adapterId" | "runtimeBindings">,
  catalog: readonly ProviderRuntimeCatalogEntryDto[],
): ProviderInterfaceBindingPresentation[] {
  return provider.runtimeBindings.map((binding) => {
    const catalogEntry =
      binding.runtimeKind === "wasm-component"
        ? (catalog.find((entry) => entry.packageDigest === binding.packageDigest) ?? null)
        : null;
    const wasmActive = binding.runtimeKind === "wasm-component" && binding.state === "active";
    return {
      binding,
      catalogEntry,
      labelKey:
        binding.runtimeKind === "legacy-frontend-provider"
          ? "legacy"
          : wasmActive
            ? "activeRuntime"
            : "unavailableRuntime",
      version: catalogEntry?.version ?? null,
      actions: {
        canRollback: wasmActive,
        canDetach: wasmActive,
      },
    };
  });
}

/** One attachable catalog alias not yet bound to the Provider (explicit opt-in per interface). */
export interface AttachableRuntimeInterface {
  adapterId: string;
  packageDigest: string;
  pluginId: string;
  version: string;
  /** Signed publisher identity; shown so same-adapter candidates stay distinguishable. */
  publisher: { keyId: string; keyFingerprint: string };
  /** True when the adapter is already bound to a different package and this is a replace. */
  isReplace: boolean;
}

/** Digest prefix length for compact package/publisher identity display. */
const DIGEST_SHORT_LENGTH = 8;

/** Stable short digest prefix; unchanged when already short. */
export function shortPackageDigest(packageDigest: string): string {
  return packageDigest.length > DIGEST_SHORT_LENGTH ? packageDigest.slice(0, DIGEST_SHORT_LENGTH) : packageDigest;
}

/** Human-readable publisher identity: the key id when present, else the fingerprint prefix. */
export function publisherLabel(publisher: { keyId: string; keyFingerprint: string }): string {
  const keyId = publisher.keyId.trim();
  return keyId ? keyId : shortPackageDigest(publisher.keyFingerprint);
}

/**
 * Enumerate catalog aliases the Provider may preview/apply. Unbound aliases are plain
 * attach candidates; an already-bound adapter stays visible as a REPLACE candidate when a
 * different package declares the same alias (the same preview/apply flow replaces it). The
 * package that already owns the adapter is never offered again. Visibility is never authority.
 */
export function listAttachableRuntimeInterfaces(
  provider: Pick<ProviderInstanceDto, "runtimeBindings">,
  catalog: readonly ProviderRuntimeCatalogEntryDto[],
): AttachableRuntimeInterface[] {
  const boundByPackage = new Map(
    provider.runtimeBindings.map((binding) => [binding.adapterId, binding.packageDigest] as const),
  );
  const attachable: AttachableRuntimeInterface[] = [];
  for (const entry of catalog) {
    for (const alias of entry.legacyAliases) {
      const boundPackageDigest = boundByPackage.get(alias);
      if (boundPackageDigest != null) {
        if (boundPackageDigest === entry.packageDigest) {
          continue;
        }
        attachable.push({
          adapterId: alias,
          packageDigest: entry.packageDigest,
          pluginId: entry.pluginId,
          version: entry.version,
          publisher: entry.publisher,
          isReplace: true,
        });
        continue;
      }
      attachable.push({
        adapterId: alias,
        packageDigest: entry.packageDigest,
        pluginId: entry.pluginId,
        version: entry.version,
        publisher: entry.publisher,
        isReplace: false,
      });
    }
  }
  attachable.sort((a, b) => a.adapterId.localeCompare(b.adapterId) || a.packageDigest.localeCompare(b.packageDigest));
  return attachable;
}
