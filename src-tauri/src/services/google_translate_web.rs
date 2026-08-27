// ABOUTME: Google Web Translation proxy URL normalization for package-backed config.
// ABOUTME: Wasm packages own GTX and proxy request construction and response parsing.
use crate::domain::service_integration::GOOGLE_TRANSLATE_WEB_PROXY_URL_MAX_LEN;

/// Query parameter names that look like credentials and are rejected on proxy URLs.
const PROXY_FORBIDDEN_QUERY_KEYS: &[&str] = &[
  "api_key",
  "apikey",
  "access_token",
  "token",
  "authorization",
  "auth",
  "key",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
];

pub struct NormalizedProxyUrl {
  /// Origin only (`https://host[:port]`).
  pub origin: String,
  /// Relative path without leading slash (may be empty → use `.`).
  pub relative_path: String,
  /// Full normalized URL string persisted in config (origin + path, no query/fragment).
  pub canonical_url: String,
  /// Hostname shown in egress warnings.
  pub hostname: String,
}

/// Validate and normalize a user-configured HTTPS proxy URL.
pub fn normalize_proxy_url(raw: &str) -> Result<NormalizedProxyUrl, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err("proxy URL is required".into());
  }
  if trimmed.len() > GOOGLE_TRANSLATE_WEB_PROXY_URL_MAX_LEN {
    return Err(format!(
      "proxy URL exceeds {GOOGLE_TRANSLATE_WEB_PROXY_URL_MAX_LEN} characters"
    ));
  }
  let parsed = url::Url::parse(trimmed).map_err(|e| format!("invalid proxy URL: {e}"))?;
  if parsed.scheme() != "https" {
    return Err("proxy URL must use https".into());
  }
  if !parsed.username().is_empty() || parsed.password().is_some() {
    return Err("proxy URL must not include userinfo".into());
  }
  if parsed.fragment().is_some() {
    return Err("proxy URL must not include a fragment".into());
  }
  let host = match parsed.host() {
    Some(url::Host::Domain(domain)) => {
      let domain = domain.trim();
      if domain.is_empty() {
        return Err("proxy URL host is required".into());
      }
      domain.to_string()
    }
    Some(url::Host::Ipv4(addr)) => addr.to_string(),
    Some(url::Host::Ipv6(addr)) => addr.to_string(),
    None => return Err("proxy URL host is required".into()),
  };
  for (key, _value) in parsed.query_pairs() {
    let lower = key.to_ascii_lowercase();
    if PROXY_FORBIDDEN_QUERY_KEYS.contains(&lower.as_str()) || looks_like_secret_query_key(&lower) {
      return Err(format!(
        "proxy URL must not include credential-like query parameter '{key}'"
      ));
    }
  }
  // Drop query and fragment; persist origin + path only.
  let mut canonical = parsed.clone();
  canonical.set_query(None);
  canonical.set_fragment(None);
  let path = canonical.path();
  let relative_path = if path.is_empty() || path == "/" {
    ".".to_string()
  } else {
    path.trim_start_matches('/').to_string()
  };
  let origin = canonical.origin().ascii_serialization();
  // Rebuild path-only URL string without trailing slash unless root-only.
  let canonical_url = if relative_path == "." {
    origin.clone()
  } else {
    format!("{origin}/{relative_path}")
  };
  if canonical_url.len() > GOOGLE_TRANSLATE_WEB_PROXY_URL_MAX_LEN {
    return Err(format!(
      "proxy URL exceeds {GOOGLE_TRANSLATE_WEB_PROXY_URL_MAX_LEN} characters"
    ));
  }
  Ok(NormalizedProxyUrl {
    origin,
    relative_path,
    canonical_url,
    hostname: host,
  })
}

fn looks_like_secret_query_key(name: &str) -> bool {
  name.contains("token") || name.contains("secret") || name.contains("password") || name.contains("auth")
}
