/** The last path segment of the DLX v1 translation route. */
const TRANSLATE_SUFFIX = "/translate";

/** Compatibility routes that DLX v1 does not serve. */
const PRO_ROUTE = /\/(?:v1|v2)\/translate$/i;

/** Hosts that may use plain HTTP because the request never leaves the machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalizes a DLX v1 endpoint to `origin + path`, or returns null when it cannot be used.
 * The path must end in `/translate`; a mount prefix is allowed. Query strings, fragments,
 * URL credentials, the Pro routes, and plain HTTP on a non-loopback host are rejected.
 */
export function normalizeDeepLXEndpoint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;

  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(TRANSLATE_SUFFIX) || PRO_ROUTE.test(path)) return null;
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;

  return `${url.origin}${path}`;
}
