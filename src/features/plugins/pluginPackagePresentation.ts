// ABOUTME: Pure presentation helpers for the source-based plugin catalog UI.
// ABOUTME: Formats digests, source labels, and permission summaries without IPC or React.
import type {
  PluginCatalogEntryDto,
  PluginDescriptorDto,
  PluginSource,
  UserPackagePreviewDto,
} from "../../storage/types";

/** Shorten a content digest for dense table display (prefix…suffix). */
export function formatPackageDigestShort(digest: string, head = 8, tail = 6): string {
  if (digest.length <= head + tail + 1) {
    return digest;
  }
  return `${digest.slice(0, head)}…${digest.slice(-tail)}`;
}

export type PluginSourceTranslationKey =
  | "plugins.packages.source.builtIn"
  | "plugins.packages.source.development"
  | "plugins.packages.source.user";

/** Map a catalog source to its short i18n key under plugins.packages.source.* */
export function pluginSourceLabelKey(source: PluginSource): PluginSourceTranslationKey {
  switch (source) {
    case "built_in":
      return "plugins.packages.source.builtIn";
    case "development":
      return "plugins.packages.source.development";
    case "user":
      return "plugins.packages.source.user";
  }
}

/** Built-in content is trusted by application resource location; the other sources are not. */
export function isTrustedSource(source: PluginSource): boolean {
  return source === "built_in";
}

/** Only user archives can be removed. */
export function isRemovableEntry(entry: Pick<PluginCatalogEntryDto, "removable" | "inUse">): boolean {
  return entry.removable && !entry.inUse;
}

/** Only development content can be reloaded from its source directory. */
export function isReloadableEntry(entry: Pick<PluginCatalogEntryDto, "reloadable">): boolean {
  return entry.reloadable;
}

/** Whether the UI must show the unknown-publisher warning for user content. */
export function requiresUserContentWarning(entry: Pick<PluginDescriptorDto, "source">): boolean {
  return entry.source === "user";
}

/** Whether a user archive may be installed at all: Wasm only, never a native worker. */
export function isUserInstallableRuntime(runtimeKind: string): boolean {
  return runtimeKind === "wasm-component";
}

/** Whether a catalog entry's runtime is executable by the host. */
export function isPackageExecutionEnabled(entry: Pick<PluginDescriptorDto, "runtimeKind">): boolean {
  return entry.runtimeKind === "wasm-component" || entry.runtimeKind === "trusted-native-worker";
}

/** Human-readable content size for the permission review. */
export function formatContentSize(totalBytes: number): string {
  const units = ["B", "KiB", "MiB"];
  let value = totalBytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Summarize requested network permissions for review. */
export function summarizeNetworkPermissions(
  network: PluginDescriptorDto["network"],
): ReadonlyArray<{ id: string; summary: string }> {
  return network.map((endpoint) => ({
    id: endpoint.id,
    summary: `${endpoint.methods.join(", ")} → ${endpoint.origins.join(", ") || "instance-configured origin"}`,
  }));
}

/** File summary line for the install review. */
export function summarizeArchiveFiles(preview: Pick<UserPackagePreviewDto, "fileCount" | "totalBytes">): string {
  return `${preview.fileCount} files · ${formatContentSize(preview.totalBytes)}`;
}

/** The digest the user must confirm. It is the preview's exact content identity. */
export function confirmationDigest(preview: Pick<UserPackagePreviewDto, "contentDigest">): string {
  return preview.contentDigest;
}
