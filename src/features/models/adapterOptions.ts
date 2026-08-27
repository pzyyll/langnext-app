// ABOUTME: Adapter option and transport identity derivation for provider/model UI.
// ABOUTME: Installed signed package catalog metadata is the only adapter definition source.
import type { AuthSchemeV1, BaseUrlSource, CredentialKind, ProviderRuntimeCatalogEntryDto } from "../../storage/types";

export type AdapterOption = {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
};

/**
 * Adapter options derived from installed provider packages (package-only). Each signed
 * catalog entry declares the adapter aliases (`legacy_aliases`) its verified manifest owns;
 * an alias with no installed package is never presented as a create option.
 */
export function listPackageAdapterOptions(
  catalog: readonly ProviderRuntimeCatalogEntryDto[],
): readonly AdapterOption[] {
  const options: AdapterOption[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    for (const alias of entry.legacyAliases) {
      if (seen.has(alias)) {
        continue;
      }
      seen.add(alias);
      options.push({
        id: alias,
        label: `${entry.pluginId} (${alias})`,
        defaultBaseUrl: null,
      });
    }
  }
  options.sort((a, b) => a.id.localeCompare(b.id));
  return options;
}

/**
 * Adapter options for attached runtime interface bindings (multi-interface). Runtime-only
 * API types are labeled from the verified signed catalog metadata; an uninstalled or
 * inactive binding is never presented as an option here.
 */
export function listRuntimeAdapterOptions(
  runtimeBindings: readonly { adapterId: string; runtimeKind: string; state: string; packageDigest: string | null }[],
  catalog: readonly ProviderRuntimeCatalogEntryDto[],
): readonly AdapterOption[] {
  const options: AdapterOption[] = [];
  for (const binding of runtimeBindings) {
    if (binding.runtimeKind !== "wasm-component" || binding.state !== "active") {
      continue;
    }
    const entry = catalog.find((candidate) => candidate.packageDigest === binding.packageDigest);
    options.push({
      id: binding.adapterId,
      label: entry ? `${entry.pluginId} (${binding.adapterId})` : binding.adapterId,
      defaultBaseUrl: null,
    });
  }
  options.sort((a, b) => a.id.localeCompare(b.id));
  return options;
}

/**
 * Resolve effective Base URL and source for create/edit writes.
 * Empty input uses the package default destination (`plugin_default`); a non-empty input is
 * a custom destination. Package-first activation rejects authority expansion, so a custom
 * destination requires the matching policy on the backend.
 */
export function resolveBaseUrlFields(
  _adapterId: string,
  rawBaseUrl: string,
): { baseUrl: string; baseUrlSource: BaseUrlSource } | { error: "base_url_required" } {
  const trimmed = rawBaseUrl.trim();
  if (trimmed) {
    return { baseUrl: trimmed, baseUrlSource: "custom" };
  }
  return { baseUrl: "", baseUrlSource: "plugin_default" };
}

/** Host-owned conservative auth scheme matrix; real auth stays in the package broker. */
export function resolveAuthScheme(_adapterId: string, credentialKind: CredentialKind): AuthSchemeV1 {
  if (credentialKind === "none") {
    return { schemaVersion: 1, type: "none" };
  }
  return { schemaVersion: 1, type: "bearer" };
}

/** Adapter label fallback: the persisted API type id (catalog labels come from options lists). */
export function getAdapterLabel(adapterId: string): string {
  return adapterId;
}

/** No static host defaults exist in package-only mode; destinations live in package metadata. */
export function getDefaultBaseUrl(adapterId: string): string | null {
  void adapterId;
  return null;
}
