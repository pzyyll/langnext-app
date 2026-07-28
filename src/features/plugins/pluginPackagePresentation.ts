// ABOUTME: Pure presentation helpers for installed plugin package management UI.
// ABOUTME: Formats digests, trust labels, and install warnings without IPC or React.
import type { InstalledPluginVersionDto, PluginPackagePreviewDto, PublisherTrustState } from "../../storage/types";

/** Shorten a package digest for dense table display (prefix…suffix). */
export function formatPackageDigestShort(digest: string, head = 8, tail = 6): string {
  if (digest.length <= head + tail + 1) {
    return digest;
  }
  return `${digest.slice(0, head)}…${digest.slice(-tail)}`;
}

/** Map publisher trust state to a short i18n key suffix under plugins.packages.trust.* */
export function publisherTrustLabelKey(trust: PublisherTrustState): string {
  switch (trust) {
    case "trusted_vendor":
      return "plugins.packages.trust.trustedVendor";
    case "trusted_user":
      return "plugins.packages.trust.trustedUser";
    case "unknown":
      return "plugins.packages.trust.unknown";
    case "revoked":
      return "plugins.packages.trust.revoked";
    case "disabled":
      return "plugins.packages.trust.disabled";
  }
}

/** Whether uninstall should be disabled in the UI (backend `in_use` remains authoritative). */
export function isUninstallDisabled(version: Pick<InstalledPluginVersionDto, "inUse">): boolean {
  return version.inUse;
}

/** Whether a preview requires an extra publisher-approval checkbox. */
export function requiresPublisherApproval(
  preview: Pick<PluginPackagePreviewDto, "requiresPublisherApproval">,
): boolean {
  return preview.requiresPublisherApproval;
}

/** Summarize requested network permissions for review. */
export function summarizeNetworkPermissions(
  network: PluginPackagePreviewDto["network"],
): ReadonlyArray<{ id: string; summary: string }> {
  return network.map((endpoint) => ({
    id: endpoint.id,
    summary: `${endpoint.methods.join(", ")} → ${endpoint.origins.join(", ")}`,
  }));
}

/** Execution is always disabled for external packages in Phase 3. */
export function isPackageExecutionEnabled(version: Pick<InstalledPluginVersionDto, "runtimeKind">): boolean {
  void version.runtimeKind;
  return false;
}
