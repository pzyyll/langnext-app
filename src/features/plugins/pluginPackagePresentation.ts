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

/**
 * Key hex forwarded to `approve_plugin_package`. Uses the package's self-authenticating
 * `publisher.pub` (auto-resolved by the backend) when present; falls back to user-entered
 * manual input otherwise. The resolved key is never editable and is forwarded as-is.
 */
export function publisherApprovalKeyHex(
  preview: Pick<PluginPackagePreviewDto, "resolvedPublisherPublicKeyHex">,
  manualInput: string,
): string {
  return preview.resolvedPublisherPublicKeyHex ?? manualInput.trim();
}

/** Whether the manual publisher-key input should be shown (only when no resolved `publisher.pub`). */
export function shouldShowManualPublisherKeyInput(
  preview: Pick<PluginPackagePreviewDto, "resolvedPublisherPublicKeyHex">,
): boolean {
  return !preview.resolvedPublisherPublicKeyHex;
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

/** Whether the installed package runtime is supported by the host executor. */
export function isPackageExecutionEnabled(version: Pick<InstalledPluginVersionDto, "runtimeKind">): boolean {
  return version.runtimeKind === "wasm-component";
}
