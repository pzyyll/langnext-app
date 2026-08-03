// ABOUTME: Compatibility facade over the provider plugin registry for model UI.
// ABOUTME: Prefer registry selectors directly; this keeps existing call sites compiling.
import type { AuthSchemeV1, BaseUrlSource, CredentialKind, ProviderRuntimeCatalogEntryDto } from "../../storage/types";
import { registerBuiltinProviderPlugins } from "../providers/builtin";
import {
  getPluginDefaultBaseUrl,
  getPluginLabel,
  isPluginRegistered,
  listProviderManifests,
  resolvePluginAuthScheme,
} from "../providers/registry";

registerBuiltinProviderPlugins();

export type AdapterOption = {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
};

/** Registered plugin options for provider/model selectors. */
export function listAdapterOptions(): readonly AdapterOption[] {
  return listProviderManifests().map((manifest) => ({
    id: manifest.id,
    label: manifest.label,
    defaultBaseUrl: manifest.defaultBaseUrl,
  }));
}

/**
 * Adapter options for attached runtime interface bindings (multi-interface). Runtime-only
 * API types are labeled from the verified signed catalog metadata; an uninstalled or
 * inactive binding is never presented as an option here. Legacy registered plugins are
 * merged by the caller.
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

/** Look up the documented default Base URL for a plugin ID. */
export function getDefaultBaseUrl(adapterId: string): string | null {
  return getPluginDefaultBaseUrl(adapterId);
}

/** Look up a human-readable plugin label; falls back to the raw ID. */
export function getAdapterLabel(adapterId: string): string {
  if (!isPluginRegistered(adapterId)) {
    return `${adapterId} (missing)`;
  }
  return getPluginLabel(adapterId);
}

/** Derive the versioned auth scheme from a plugin and credential kind. */
export function resolveAuthScheme(adapterId: string, credentialKind: CredentialKind): AuthSchemeV1 {
  const scheme = resolvePluginAuthScheme(adapterId, credentialKind);
  if (scheme) {
    return scheme;
  }
  // Missing plugin: preserve a conservative bearer/none matrix for form writes.
  if (credentialKind === "none") {
    return { schemaVersion: 1, type: "none" };
  }
  return { schemaVersion: 1, type: "bearer" };
}

/**
 * Resolve effective Base URL and source for create/edit writes.
 * Empty input uses the plugin default when available; otherwise requires a custom URL.
 */
export function resolveBaseUrlFields(
  adapterId: string,
  rawBaseUrl: string,
): { baseUrl: string; baseUrlSource: BaseUrlSource } | { error: "base_url_required" } {
  const trimmed = rawBaseUrl.trim();
  if (trimmed) {
    return { baseUrl: trimmed, baseUrlSource: "custom" };
  }
  const defaultBaseUrl = getDefaultBaseUrl(adapterId);
  if (!defaultBaseUrl) {
    return { error: "base_url_required" };
  }
  return { baseUrl: defaultBaseUrl, baseUrlSource: "plugin_default" };
}
