// ABOUTME: Pure helpers for provider editor remote-version conflict detection.
// ABOUTME: Keeps dirty-form vs remote updatedAt rules unit-testable without React.

/**
 * True when the form has local edits and the remote provider row version
 * no longer matches the baseline the form was loaded/synced against.
 */
export function hasRemoteProviderConflict(
  formDirty: boolean,
  formBaselineUpdatedAt: string,
  remoteUpdatedAt: string,
): boolean {
  return formDirty && formBaselineUpdatedAt !== remoteUpdatedAt;
}

/**
 * Whether to show the conflict banner. After the user chooses "keep local draft"
 * for a given remote version, the banner stays hidden until the remote version
 * advances again.
 */
export function shouldShowConflictBanner(
  hasConflict: boolean,
  remoteUpdatedAt: string,
  dismissedRemoteUpdatedAt: string | null,
): boolean {
  return hasConflict && dismissedRemoteUpdatedAt !== remoteUpdatedAt;
}
