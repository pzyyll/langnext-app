// ABOUTME: Edge TTS capability handler (speech.synthesize@1) over a configurable OpenAI-compatible API.
// ABOUTME: Credential-free; routes bounded binary MP3 responses through the shared network broker.
use crate::domain::service_capability::{CapabilityError, CapabilityErrorCode};
use crate::domain::service_integration::{EDGE_TTS_BASE_URL_MAX_LEN, EDGE_TTS_DEFAULT_BASE_URL, EdgeTtsConfigV1};
use crate::error::StorageError;
use serde_json::Value;
use std::time::Duration;

/// Manifest endpoint alias for the instance-scoped OpenAI-compatible TTS base URL.
pub const EDGE_TTS_ENDPOINT_ALIAS: &str = "tts-api";
/// Relative path appended to the configured base URL for synthesis.
pub const EDGE_TTS_SYNTHESIZE_PATH: &str = "v1/audio/speech";
/// Fixed synthesis timeout (provider may take longer than the default 20s).
pub const EDGE_TTS_SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(60);

pub struct NormalizedEdgeTtsBaseUrl {
  /// Canonical URL string (origin + optional path, no trailing slash, no query/fragment).
  pub canonical_url: String,
  /// Hostname shown in egress warnings.
  pub hostname: String,
}

/// Validate and normalize a user-configured Edge TTS base URL.
pub fn normalize_edge_tts_base_url(raw: &str) -> Result<NormalizedEdgeTtsBaseUrl, String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err("base URL is required".into());
  }
  if trimmed.len() > EDGE_TTS_BASE_URL_MAX_LEN {
    return Err(format!("base URL exceeds {EDGE_TTS_BASE_URL_MAX_LEN} characters"));
  }
  let parsed = url::Url::parse(trimmed).map_err(|e| format!("invalid base URL: {e}"))?;
  if parsed.scheme() != "https" {
    return Err("base URL must use https".into());
  }
  if !parsed.username().is_empty() || parsed.password().is_some() {
    return Err("base URL must not include userinfo".into());
  }
  if parsed.query().is_some() {
    return Err("base URL must not include a query".into());
  }
  if parsed.fragment().is_some() {
    return Err("base URL must not include a fragment".into());
  }
  let host = match parsed.host() {
    Some(url::Host::Domain(domain)) => {
      let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
      if domain.is_empty() {
        return Err("base URL host is required".into());
      }
      if domain == "localhost" || domain.ends_with(".localhost") {
        return Err("base URL host must be a DNS name".into());
      }
      domain
    }
    Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => {
      return Err("base URL host must be a DNS name".into());
    }
    None => return Err("base URL host is required".into()),
  };
  let path = parsed.path().trim_end_matches('/').to_string();
  let canonical_url = if path.is_empty() {
    parsed.origin().ascii_serialization()
  } else {
    format!("{}{path}", parsed.origin().ascii_serialization())
  };
  Ok(NormalizedEdgeTtsBaseUrl {
    canonical_url,
    hostname: host,
  })
}

/// Default Edge TTS config (bundled service base URL).
pub fn default_edge_tts_config() -> EdgeTtsConfigV1 {
  EdgeTtsConfigV1 {
    base_url: EDGE_TTS_DEFAULT_BASE_URL.into(),
  }
}

/// Serialize a validated Edge TTS config for persistence.
pub fn serialize_edge_tts_config(config: &EdgeTtsConfigV1) -> Result<String, StorageError> {
  serde_json::to_string(config).map_err(StorageError::from)
}

/// Validate/normalize Edge TTS config JSON; returns canonical config_json string.
pub fn validate_edge_tts_config(config_json: &str) -> Result<String, StorageError> {
  let value: Value =
    serde_json::from_str(config_json).map_err(|_| StorageError::Validation("config_json must be valid JSON".into()))?;
  let obj = value
    .as_object()
    .ok_or_else(|| StorageError::Validation("config_json must be an object".into()))?;

  for forbidden in [
    "projectId",
    "project_id",
    "location",
    "serviceAccount",
    "service_account",
    "endpoint",
    "customEndpoint",
    "apiKey",
    "api_key",
    "token",
    "accessToken",
    "credential",
  ] {
    if obj.contains_key(forbidden) {
      return Err(StorageError::Validation(format!(
        "Edge TTS config rejects field `{forbidden}`"
      )));
    }
  }

  let mut config: EdgeTtsConfigV1 =
    serde_json::from_value(value).map_err(|e| StorageError::Validation(format!("invalid Edge TTS config: {e}")))?;

  let raw = config.base_url.trim();
  let effective = if raw.is_empty() { EDGE_TTS_DEFAULT_BASE_URL } else { raw };
  let normalized = normalize_edge_tts_base_url(effective).map_err(StorageError::Validation)?;
  config.base_url = normalized.canonical_url;

  serialize_edge_tts_config(&config)
}

/// True when Edge TTS config is complete enough to execute (a valid base URL).
pub fn edge_tts_config_complete(config_json: &str) -> bool {
  match serde_json::from_str::<EdgeTtsConfigV1>(config_json) {
    Ok(config) => normalize_edge_tts_base_url(&config.base_url).is_ok(),
    Err(_) => false,
  }
}

fn map_edge_tts_http_error(status: u16, body: &str) -> CapabilityError {
  let provider_code = extract_provider_code(body);
  match status {
    400 => CapabilityError::new(CapabilityErrorCode::InvalidRequest, "Edge TTS rejected the request")
      .with_retryable(false)
      .with_provider_code(provider_code),
    401 | 403 => CapabilityError::new(CapabilityErrorCode::PermissionDenied, "Edge TTS denied the request")
      .with_retryable(false)
      .with_provider_code(provider_code),
    429 => CapabilityError::new(CapabilityErrorCode::RateLimited, "Edge TTS rate limit reached")
      .with_retryable(true)
      .with_provider_code(provider_code),
    500..=599 => CapabilityError::new(CapabilityErrorCode::ProviderUnavailable, "Edge TTS service unavailable")
      .with_retryable(true)
      .with_provider_code(provider_code),
    _ => CapabilityError::new(CapabilityErrorCode::ProviderUnavailable, "Edge TTS request failed")
      .with_retryable(false)
      .with_provider_code(provider_code),
  }
}

/// Best-effort extraction of a provider error code from an OpenAI-shaped error body.
/// Empty string means no code; `with_provider_code` ignores empty values.
fn extract_provider_code(body: &str) -> String {
  let Ok(value) = serde_json::from_str::<Value>(body) else {
    return String::new();
  };
  let code = value
    .get("error")
    .and_then(|e| e.get("code"))
    .and_then(|c| c.as_str())
    .unwrap_or("")
    .trim();
  if code.is_empty() {
    return String::new();
  }
  code
    .chars()
    .take(crate::domain::service_capability::CAPABILITY_PROVIDER_CODE_MAX_LEN)
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  use crate::domain::service_capability::EDGE_TTS_VOICE_DEFAULT;

  #[test]
  fn normalize_base_url_accepts_default_and_strips_trailing_slash() {
    let n = normalize_edge_tts_base_url(EDGE_TTS_DEFAULT_BASE_URL).unwrap();
    assert_eq!(n.canonical_url, "https://tts.wangwangit.com");
    assert_eq!(n.hostname, "tts.wangwangit.com");

    let n = normalize_edge_tts_base_url("https://my.host/api/").unwrap();
    assert_eq!(n.canonical_url, "https://my.host/api");

    let n = normalize_edge_tts_base_url("https://tts.wangwangit.com/api").unwrap();
    assert_ne!(n.canonical_url, EDGE_TTS_DEFAULT_BASE_URL);
  }

  #[test]
  fn normalize_base_url_rejects_http_and_userinfo() {
    assert!(normalize_edge_tts_base_url("http://my.host").is_err());
    assert!(normalize_edge_tts_base_url("https://user:pass@my.host").is_err());
    assert!(normalize_edge_tts_base_url("https://my.host#frag").is_err());
    assert!(normalize_edge_tts_base_url("https://tts.wangwangit.com?route=/custom").is_err());
    assert!(normalize_edge_tts_base_url("").is_err());
  }

  #[test]
  fn validate_config_normalizes_and_rejects_forbidden() {
    let canonical = validate_edge_tts_config("{\"base-url\":\"https://my.host/api/\"}").unwrap();
    assert!(canonical.contains("\"base-url\":\"https://my.host/api\""));
    assert!(validate_edge_tts_config("{\"apiKey\":\"x\"}").is_err());
    // Empty base URL falls back to the bundled default.
    let fallback = validate_edge_tts_config("{}").unwrap();
    assert!(fallback.contains(EDGE_TTS_DEFAULT_BASE_URL));
  }

  #[test]
  fn config_complete_is_true_for_valid_base_url() {
    assert!(edge_tts_config_complete("{\"base-url\":\"https://my.host\"}"));
    assert!(!edge_tts_config_complete("{\"base-url\":\"http://my.host\"}"));
    assert!(!edge_tts_config_complete("not json"));
  }

  #[test]
  fn map_http_error_classes_status_codes() {
    assert_eq!(
      map_edge_tts_http_error(400, "").code,
      CapabilityErrorCode::InvalidRequest
    );
    assert_eq!(map_edge_tts_http_error(429, "").code, CapabilityErrorCode::RateLimited);
    assert_eq!(
      map_edge_tts_http_error(500, "").code,
      CapabilityErrorCode::ProviderUnavailable
    );
    assert_eq!(
      map_edge_tts_http_error(403, "").code,
      CapabilityErrorCode::PermissionDenied
    );
  }

  // Silence unused import warning for EDGE_TTS_VOICE_DEFAULT in test builds if not referenced.
  #[test]
  fn voice_default_is_xiaoxiao() {
    assert_eq!(EDGE_TTS_VOICE_DEFAULT, "zh-CN-XiaoxiaoNeural");
  }
}
