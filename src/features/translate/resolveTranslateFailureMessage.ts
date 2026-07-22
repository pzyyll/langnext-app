// ABOUTME: Pure mapping from translate stream failure codes to user-facing copy.
// ABOUTME: Shared by main translate and quick-translate; labels are injected by callers.

export type TranslateFailureLabels = {
  timeout: string;
  /** Protocol / malformed provider payload (never surface raw parse text). */
  invalidResponse: string;
  fallback: string;
};

/**
 * Map a known backend error code to localized copy.
 * Protocol codes use labels only so technical parse messages stay out of the UI.
 */
export function resolveTranslateFailureMessage(
  errorCode: string | null | undefined,
  message: string | undefined,
  labels: TranslateFailureLabels,
): string {
  if (errorCode === "timeout") {
    return labels.timeout;
  }
  if (errorCode === "invalid_response") {
    return labels.invalidResponse;
  }
  return message || labels.fallback;
}
