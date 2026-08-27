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

export type PackageTrustTranslationKey =
  | "plugins.packages.trust.trustedVendor"
  | "plugins.packages.trust.trustedUser"
  | "plugins.packages.trust.unknown"
  | "plugins.packages.trust.revoked"
  | "plugins.packages.trust.disabled"
  | "plugins.packages.trust.unsigned";

export type PackageSignatureTranslationKey =
  | "plugins.packages.signature.unsigned"
  | "plugins.packages.signature.signed";

/** Map publisher trust state to a short i18n key suffix under plugins.packages.trust.* */
export function publisherTrustLabelKey(trust: PublisherTrustState): PackageTrustTranslationKey {
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
    case "unsigned":
      return "plugins.packages.trust.unsigned";
  }
}

/** Whether preview requires the unsigned authenticity checkbox. */
export function requiresUnsignedRiskAcknowledgement(
  preview: Pick<PluginPackagePreviewDto, "requiresUnsignedRiskAcknowledgement" | "signatureStatus">,
): boolean {
  return preview.requiresUnsignedRiskAcknowledgement === true || preview.signatureStatus === "unsigned";
}

/** Whether preview requires the native process-risk checkbox. */
export function requiresNativeExecutionRiskAcknowledgement(
  preview: Pick<PluginPackagePreviewDto, "requiresNativeExecutionRiskAcknowledgement">,
): boolean {
  return preview.requiresNativeExecutionRiskAcknowledgement === true;
}

export function installedSignatureLabelKey(
  version: Pick<InstalledPluginVersionDto, "signatureStatus">,
): PackageSignatureTranslationKey {
  return version.signatureStatus === "unsigned"
    ? "plugins.packages.signature.unsigned"
    : "plugins.packages.signature.signed";
}

export function installedNativeRiskVisible(
  version: Pick<InstalledPluginVersionDto, "runtimeKind" | "nativeExecutionRiskAcknowledged">,
): boolean {
  return version.runtimeKind === "trusted-native-worker" && version.nativeExecutionRiskAcknowledged === true;
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
  return version.runtimeKind === "wasm-component" || version.runtimeKind === "trusted-native-worker";
}
