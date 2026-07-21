// ABOUTME: Pure mapping from translate stream failure codes to user-facing copy.
// ABOUTME: Shared by main translate and quick-translate; labels are injected by callers.
/**
 * Map a known backend error code to localized copy, otherwise prefer the server
 * message and fall back to the caller-supplied default prefix.
 */
export function resolveTranslateFailureMessage(
  errorCode: string | null | undefined,
  message: string | undefined,
  labels: { timeout: string; fallback: string },
): string {
  if (errorCode === "timeout") {
    return labels.timeout;
  }
  return message || labels.fallback;
}
