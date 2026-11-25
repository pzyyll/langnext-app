import { t } from "nsh/i18n";

export interface ConnectionUrlCheck {
  ok: boolean;
  normalizedBaseUrl: string | null;
  isInsecureHttp: boolean;
  error: string | null;
}

const LOOPBACK_IPV4_PATTERN = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return LOOPBACK_IPV4_PATTERN.test(host);
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
      error: t("models.error.baseUrlInvalid"),
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      normalizedBaseUrl: null,
      isInsecureHttp: false,
      error: t("models.error.baseUrlScheme"),
    };
  }

  if (!parsed.hostname) {
    return {
      ok: false,
      normalizedBaseUrl: null,
      isInsecureHttp: false,
      error: t("models.error.baseUrlHost"),
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

/** Returns whether explicit insecure HTTP consent applies to the current URL root. */
export function isInsecureHttpConfirmed(rawUrl: string, confirmedUrl: string | null): boolean {
  const check = inspectBaseUrl(rawUrl);
  return Boolean(
    check.isInsecureHttp && confirmedUrl !== null && check.normalizedBaseUrl === confirmedUrl,
  );
}

/** Returns the normalized URL to retain when insecure HTTP consent is toggled. */
export function resolveConfirmedInsecureUrl(rawUrl: string, accepted: boolean): string | null {
  if (!accepted) return null;
  const check = inspectBaseUrl(rawUrl);
  return check.isInsecureHttp ? check.normalizedBaseUrl : null;
}
