// ABOUTME: Client-side request id generator for translate stream and detect flows.
// ABOUTME: Prefers crypto.randomUUID; falls back to a time+random string with a prefix.
/**
 * Create a unique client request id for cancel/filter correlation.
 * @param fallbackPrefix Used only when `crypto.randomUUID` is unavailable.
 */
export function newClientRequestId(fallbackPrefix = "req"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${fallbackPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
