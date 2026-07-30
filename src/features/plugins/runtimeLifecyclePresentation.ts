// ABOUTME: Pure helpers for integration runtime pin / upgrade / rollback UX copy.
// ABOUTME: Keeps lifecycle presentation out of JSX and free of secrets or package bytes.
import type {
  IntegrationInstanceDto,
  PermissionDifferenceDto,
  PublisherIdentityDto,
  RuntimeIdentityDto,
  RuntimeUpgradePreviewDto,
} from "../../storage/types";

/** Pinned first-party GTX origin; any other network origin is third-party egress. */
const FIRST_PARTY_GTX_ORIGIN = "https://translate.google.com";

/** True when the instance cannot execute until a package is installed/activated. */
export function isRuntimeUnresolved(
  instance: Pick<IntegrationInstanceDto, "runtimeState" | "runtimeErrorCode" | "effectiveStatus">,
): boolean {
  if (instance.effectiveStatus === "plugin_missing") {
    return true;
  }
  if (instance.runtimeState === "unavailable" || instance.runtimeState === "pending_activation") {
    return true;
  }
  return instance.runtimeErrorCode === "plugin_missing";
}

/** Compact runtime identity label for status rows. */
export function formatRuntimeIdentity(identity: RuntimeIdentityDto): string {
  if (identity.packageDigest) {
    const short = identity.packageDigest.slice(0, 12);
    const rev = identity.executionGrantSetRevision != null ? ` r${identity.executionGrantSetRevision}` : "";
    return `${identity.runtimeKind} ${short}…${rev}`.trim();
  }
  return identity.runtimeKind;
}

/** Compact publisher identity for upgrade approval (key id + short fingerprint). */
export function formatPublisherIdentity(publisher: PublisherIdentityDto | null | undefined): string {
  if (!publisher) {
    return "unknown publisher";
  }
  const fp = publisher.keyFingerprint.slice(0, 12);
  return `${publisher.keyId} (${fp}…)`;
}

/** Structured permission difference line for the upgrade approval list. */
export function formatPermissionDifference(diff: PermissionDifferenceDto): string {
  const parts = [diff.summary];
  if (diff.resource) {
    parts.push(`resource=${diff.resource}`);
  }
  if (diff.origin) {
    parts.push(`origin=${diff.origin}`);
  }
  if (diff.method) {
    parts.push(`method=${diff.method}`);
  }
  if (diff.authPolicy) {
    parts.push(`auth=${diff.authPolicy}`);
  }
  return parts.join(" · ");
}

/** True when the preview surfaces details that must be shown before the ack checkbox. */
export function upgradeApprovalDetailsReady(preview: RuntimeUpgradePreviewDto): boolean {
  if (!upgradeRequiresAcknowledgement(preview)) {
    return true;
  }
  if (!preview.targetPublisher?.keyId || !preview.targetPublisher.keyFingerprint) {
    return false;
  }
  if (preview.requiresPermissionApproval && preview.permissionDifferences.length === 0) {
    return false;
  }
  return true;
}

/** Whether upgrade preview requires an explicit permission acknowledgement. */
export function upgradeRequiresAcknowledgement(preview: RuntimeUpgradePreviewDto): boolean {
  return preview.requiresPermissionApproval || preview.requiresPublisherReapproval;
}

/**
 * True when the upgrade adds or changes a network endpoint whose origin is NOT the pinned
 * first-party GTX origin - i.e. translated text will be sent to a third-party proxy server.
 * Used to surface an explicit third-party data-egress warning separate from the permission list.
 */
export function hasThirdPartyEgressChange(preview: RuntimeUpgradePreviewDto): boolean {
  return preview.permissionDifferences.some(
    (diff) => diff.kind === "network_endpoint_added" && diff.origin != null && diff.origin !== FIRST_PARTY_GTX_ORIGIN,
  );
}

/**
 * Value for `acknowledgePermissions` on apply.
 * Never auto-signs expansions: true only when the user checked the ack box after details are shown.
 */
export function acknowledgePermissionsForApply(preview: RuntimeUpgradePreviewDto, userAcknowledged: boolean): boolean {
  if (!upgradeRequiresAcknowledgement(preview)) {
    return false;
  }
  if (!upgradeApprovalDetailsReady(preview)) {
    return false;
  }
  return userAcknowledged;
}
