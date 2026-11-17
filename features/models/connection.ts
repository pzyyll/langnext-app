export interface ConnectionUrlCheck {
  ok: boolean;
  normalizedBaseUrl: string | null;
  isInsecureHttp: boolean;
  error: string | null;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  return false;
}

/** Validates an optional base URL and flags non-loopback `http://` endpoints. */
export function inspectBaseUrl(rawValue: string): ConnectionUrlCheck {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return {
      ok: true,
      normalizedBaseUrl: null,
      isInsecureHttp: false,
      error: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      normalizedBaseUrl: null,
      isInsecureHttp: false,
      error: "Enter a valid http:// or https:// base URL.",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      normalizedBaseUrl: null,
      isInsecureHttp: false,
      error: "Base URL must start with https:// or http://.",
    };
  }

  if (!parsed.hostname) {
    return {
      ok: false,
      normalizedBaseUrl: null,
      isInsecureHttp: false,
      error: "Base URL must include a host name.",
    };
  }

  const normalized = trimmed.replace(/\/+$/, "");
  const isInsecureHttp = parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname);

  return {
    ok: true,
    normalizedBaseUrl: normalized,
    isInsecureHttp,
    error: null,
  };
}
