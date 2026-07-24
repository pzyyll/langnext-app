// ABOUTME: Pure mapping from translate stream failure codes to user-facing copy.
// ABOUTME: Shared by main translate and quick-translate; labels are injected by callers.

export type TranslateFailureLabels = {
  timeout: string;
  /** Protocol / malformed provider payload (never surface raw parse text). */
  invalidResponse: string;
  fallback: string;
  /** Plugin Profile runtime states that fail closed with /plugins recovery. */
  integrationDisabled?: string;
  integrationUnconfigured?: string;
  integrationUnvalidated?: string;
  integrationDegraded?: string;
  pluginMissing?: string;
  invalidConfiguration?: string;
  /** Service Translate called without concrete language ids after Auto resolution. */
  languageUnresolved?: string;
};

/** Recovery control for plugin runtime failures. */
export type TranslateFailureRecovery = {
  path: "/plugins";
};

const PLUGINS_RECOVERY_ERROR_CODES = new Set([
  "plugin_missing",
  "integration_disabled",
  "integration_unconfigured",
  "integration_unvalidated",
  "integration_degraded",
  // Rust Profile IPC maps disabled/non-ready instances to this code.
  "invalid_configuration",
]);

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
  if (errorCode === "integration_disabled" && labels.integrationDisabled) {
    return labels.integrationDisabled;
  }
  if (errorCode === "integration_unconfigured" && labels.integrationUnconfigured) {
    return labels.integrationUnconfigured;
  }
  if (errorCode === "integration_unvalidated" && labels.integrationUnvalidated) {
    return labels.integrationUnvalidated;
  }
  if (errorCode === "integration_degraded" && labels.integrationDegraded) {
    return labels.integrationDegraded;
  }
  if (errorCode === "plugin_missing" && labels.pluginMissing) {
    return labels.pluginMissing;
  }
  if (errorCode === "invalid_configuration" && labels.invalidConfiguration) {
    return labels.invalidConfiguration;
  }
  if (errorCode === "validation_failed" && labels.languageUnresolved && message?.includes("language id")) {
    return labels.languageUnresolved;
  }
  return message || labels.fallback;
}

/** True when the failure should offer a /plugins recovery control. */
export function resolveTranslateFailureRecovery(errorCode: string | null | undefined): TranslateFailureRecovery | null {
  if (!errorCode || !PLUGINS_RECOVERY_ERROR_CODES.has(errorCode)) {
    return null;
  }
  return { path: "/plugins" };
}
