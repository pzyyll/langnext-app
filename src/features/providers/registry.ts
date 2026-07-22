// ABOUTME: Provider plugin registration, lookup, and auth-compatibility helpers.
// ABOUTME: Duplicate IDs fail during registration; missing plugins stay visible but unusable.
import type { AuthSchemeV1, CredentialKind } from "../../storage/types";
import type { ProviderPlugin, ProviderPluginManifest } from "./types";

const pluginsById = new Map<string, ProviderPlugin>();
let registrationOrder: string[] = [];

export class PluginUnavailableError extends Error {
  readonly code = "plugin_unavailable" as const;
  readonly pluginId: string;

  constructor(pluginId: string) {
    super(`Plugin unavailable: ${pluginId}`);
    this.name = "PluginUnavailableError";
    this.pluginId = pluginId;
  }
}

/** Register a plugin. Duplicate IDs throw. */
export function registerProviderPlugin(plugin: ProviderPlugin): void {
  const id = plugin.manifest.id;
  if (pluginsById.has(id)) {
    throw new Error(`Duplicate provider plugin id: ${id}`);
  }
  pluginsById.set(id, plugin);
  registrationOrder.push(id);
}

/** Clear all registrations (tests only). */
export function clearProviderPlugins(): void {
  pluginsById.clear();
  registrationOrder = [];
}

export function getProviderPlugin(id: string): ProviderPlugin | null {
  return pluginsById.get(id) ?? null;
}

export function requireProviderPlugin(id: string): ProviderPlugin {
  const plugin = getProviderPlugin(id);
  if (!plugin) {
    throw new PluginUnavailableError(id);
  }
  return plugin;
}

/** Stable list ordered by registration. */
export function listProviderPlugins(): ProviderPlugin[] {
  return registrationOrder
    .map((id) => pluginsById.get(id))
    .filter((plugin): plugin is ProviderPlugin => plugin != null);
}

export function listProviderManifests(): ProviderPluginManifest[] {
  return listProviderPlugins().map((plugin) => plugin.manifest);
}

export function resolvePluginAuthScheme(pluginId: string, credentialKind: CredentialKind): AuthSchemeV1 | null {
  const plugin = getProviderPlugin(pluginId);
  if (!plugin) {
    return null;
  }
  return plugin.resolveAuthScheme(credentialKind);
}

export function authSchemesCompatible(a: AuthSchemeV1, b: AuthSchemeV1): boolean {
  if (a.type !== b.type || a.schemaVersion !== b.schemaVersion) {
    return false;
  }
  if (a.type === "header" && b.type === "header") {
    return a.name.toLowerCase() === b.name.toLowerCase();
  }
  if (a.type === "query" && b.type === "query") {
    return a.name.toLowerCase() === b.name.toLowerCase();
  }
  return true;
}

/**
 * Model API Type override is executable when auth schemes match and either:
 * - provider uses a custom Base URL, or
 * - override plugin id equals the provider plugin id.
 */
export function isModelApiTypeExecutable(input: {
  providerPluginId: string;
  modelPluginId: string;
  providerAuthScheme: AuthSchemeV1;
  modelAuthScheme: AuthSchemeV1;
  baseUrlSource: "plugin_default" | "custom";
}): boolean {
  if (!authSchemesCompatible(input.providerAuthScheme, input.modelAuthScheme)) {
    return false;
  }
  if (input.baseUrlSource === "custom") {
    return true;
  }
  return input.providerPluginId === input.modelPluginId;
}

export function getPluginLabel(pluginId: string): string {
  return getProviderPlugin(pluginId)?.manifest.label ?? pluginId;
}

export function getPluginDefaultBaseUrl(pluginId: string): string | null {
  return getProviderPlugin(pluginId)?.manifest.defaultBaseUrl ?? null;
}

export function isPluginRegistered(pluginId: string): boolean {
  return pluginsById.has(pluginId);
}
