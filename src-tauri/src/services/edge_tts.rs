// ABOUTME: Edge TTS capability handler (speech.synthesize@1) over a configurable OpenAI-compatible API.
// ABOUTME: Credential-free; calls reqwest directly to read raw MP3 bytes that the broker cannot carry.
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, EdgeTtsPreferences, ExecutionContext, SPEECH_AUDIO_MAX_BYTES,
  SPEECH_SYNTHESIZE_CAPABILITY_ID, SpeechSynthesizeRequest, SpeechSynthesizeResponse, validate_capability_language_id,
  validate_capability_request_id, validate_edge_tts_preferences, validate_speech_synthesize_text,
};
use crate::domain::service_integration::{EDGE_TTS_BASE_URL_MAX_LEN, EDGE_TTS_DEFAULT_BASE_URL, EdgeTtsConfigV1};
use crate::error::StorageError;
use crate::repositories::integration_instances;
use crate::storage::Database;
use serde_json::{Value, json};
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

/// Relative path appended to the configured base URL for synthesis.
pub const EDGE_TTS_SYNTHESIZE_PATH: &str = "v1/audio/speech";
/// Fixed synthesis timeout (provider may take longer than the default 20s).
pub const EDGE_TTS_SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(60);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_client() -> Result<&'static reqwest::Client, CapabilityError> {
  if CLIENT.get().is_none() {
    let client = reqwest::Client::builder()
      .timeout(EDGE_TTS_SYNTHESIS_TIMEOUT)
      .connect_timeout(EDGE_TTS_SYNTHESIS_TIMEOUT)
      .redirect(reqwest::redirect::Policy::none())
      .build()
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Internal, "failed to build HTTP client"))?;
    let _ = CLIENT.set(client);
  }
  CLIENT
    .get()
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::Internal, "HTTP client unavailable"))
}

/// Edge TTS capability surface bound to storage for instance config lookup.
#[derive(Clone)]
pub struct EdgeTtsCapabilities {
  db: Database,
}

impl EdgeTtsCapabilities {
  pub fn new(db: Database) -> Self {
    Self { db }
  }

  pub async fn synthesize_speech(
    &self,
    instance_id: Uuid,
    request: SpeechSynthesizeRequest,
    context: ExecutionContext,
  ) -> Result<SpeechSynthesizeResponse, CapabilityError> {
    let cap = SPEECH_SYNTHESIZE_CAPABILITY_ID;
    let rid = context.request_id.as_str();
    validate_capability_request_id(rid).map_err(|e| e.with_capability_id(cap).with_request_id(rid))?;
    validate_speech_synthesize_text(&request.text).map_err(|e| e.with_capability_id(cap).with_request_id(rid))?;
    validate_capability_language_id(&request.language_id, "language_id")
      .map_err(|e| e.with_capability_id(cap).with_request_id(rid))?;

    let preferences: EdgeTtsPreferences = serde_json::from_value(request.preferences.clone()).map_err(|_| {
      CapabilityError::new(CapabilityErrorCode::InvalidRequest, "invalid Edge TTS preferences")
        .with_capability_id(cap)
        .with_request_id(rid)
    })?;
    validate_edge_tts_preferences(&preferences).map_err(|e| e.with_capability_id(cap).with_request_id(rid))?;

    let base_url = load_edge_tts_base_url(&self.db, instance_id)
      .map_err(|e| e.with_capability_id(cap).with_request_id(rid))?
      .to_string();
    let url = format!("{base_url}/{EDGE_TTS_SYNTHESIZE_PATH}");

    // Edge TTS pitch is a string scalar ("-50".."50"); Rust f64 Display strips trailing zeros.
    let body = json!({
      "input": request.text,
      "voice": preferences.voice,
      "speed": preferences.speed,
      "pitch": preferences.pitch.to_string(),
      "style": preferences.style,
    });

    if context.cancel.is_cancelled() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::Cancelled,
        "speech synthesis cancelled",
      ));
    }

    let response = shared_client()?
      .post(url)
      .header(reqwest::header::CONTENT_TYPE, "application/json")
      .header(reqwest::header::ACCEPT, "audio/mpeg")
      .body(body.to_string())
      .send()
      .await
      .map_err(map_reqwest_error)?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
      // Drain a bounded text body for error diagnostics; binary-safe because we cap the bytes.
      let text = response.text().await.unwrap_or_default();
      return Err(map_edge_tts_http_error(status, &text));
    }

    // Reject oversized payloads before slurping the full body when Content-Length is known.
    if let Some(declared) = response.content_length() {
      if declared > SPEECH_AUDIO_MAX_BYTES as u64 {
        return Err(CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          "Edge TTS audio exceeds size limit",
        ));
      }
    }

    let mp3_bytes = response
      .bytes()
      .await
      .map_err(|_| CapabilityError::new(CapabilityErrorCode::Network, "failed to read Edge TTS audio"))?
      .to_vec();
    if mp3_bytes.is_empty() {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "Edge TTS returned empty audio",
      ));
    }
    if mp3_bytes.len() > SPEECH_AUDIO_MAX_BYTES {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "Edge TTS audio exceeds size limit",
      ));
    }

    Ok(SpeechSynthesizeResponse { mp3_bytes })
  }
}

fn load_edge_tts_base_url(db: &Database, instance_id: Uuid) -> Result<String, CapabilityError> {
  let instance = db
    .read(|conn| integration_instances::get(conn, instance_id))
    .map_err(|e| match e {
      StorageError::NotFound(_) => CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "integration instance not found",
      ),
      _ => CapabilityError::new(CapabilityErrorCode::Internal, "failed to load integration instance"),
    })?;
  let config: EdgeTtsConfigV1 = serde_json::from_str(&instance.config_json).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "invalid Edge TTS configuration",
    )
  })?;
  let normalized = normalize_edge_tts_base_url(&config.base_url)
    .map_err(|msg| CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg))?;
  Ok(normalized.canonical_url)
}

/// Normalized Edge TTS base URL parts.
#[derive(Debug, Clone, PartialEq, Eq)]
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
  if parsed.fragment().is_some() {
    return Err("base URL must not include a fragment".into());
  }
  let host = match parsed.host() {
    Some(url::Host::Domain(domain)) => {
      let domain = domain.trim();
      if domain.is_empty() {
        return Err("base URL host is required".into());
      }
      domain.to_string()
    }
    Some(url::Host::Ipv4(addr)) => addr.to_string(),
    Some(url::Host::Ipv6(addr)) => addr.to_string(),
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

fn map_reqwest_error(err: reqwest::Error) -> CapabilityError {
  if err.is_timeout() {
    return CapabilityError::new(CapabilityErrorCode::Timeout, "Edge TTS request timed out").with_retryable(true);
  }
  if err.is_connect() || err.is_request() {
    return CapabilityError::new(CapabilityErrorCode::Network, "Edge TTS network request failed").with_retryable(true);
  }
  CapabilityError::new(CapabilityErrorCode::Network, "Edge TTS network request failed").with_retryable(true)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::service_capability::EDGE_TTS_VOICE_DEFAULT;
  use crate::domain::service_integration::{EDGE_TTS_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstance};
  use crate::domain::time::{new_id, now_rfc3339};

  #[test]
  fn normalize_base_url_accepts_default_and_strips_trailing_slash() {
    let n = normalize_edge_tts_base_url(EDGE_TTS_DEFAULT_BASE_URL).unwrap();
    assert_eq!(n.canonical_url, "https://tts.wangwangit.com");
    assert_eq!(n.hostname, "tts.wangwangit.com");

    let n = normalize_edge_tts_base_url("https://my.host/api/").unwrap();
    assert_eq!(n.canonical_url, "https://my.host/api");
  }

  #[test]
  fn normalize_base_url_rejects_http_and_userinfo() {
    assert!(normalize_edge_tts_base_url("http://my.host").is_err());
    assert!(normalize_edge_tts_base_url("https://user:pass@my.host").is_err());
    assert!(normalize_edge_tts_base_url("https://my.host#frag").is_err());
    assert!(normalize_edge_tts_base_url("").is_err());
  }

  #[test]
  fn validate_config_normalizes_and_rejects_forbidden() {
    let canonical = validate_edge_tts_config("{\"baseUrl\":\"https://my.host/api/\"}").unwrap();
    assert!(canonical.contains("\"baseUrl\":\"https://my.host/api\""));
    assert!(validate_edge_tts_config("{\"apiKey\":\"x\"}").is_err());
    // Empty base URL falls back to the bundled default.
    let fallback = validate_edge_tts_config("{}").unwrap();
    assert!(fallback.contains(EDGE_TTS_DEFAULT_BASE_URL));
  }

  #[test]
  fn config_complete_is_true_for_valid_base_url() {
    assert!(edge_tts_config_complete("{\"baseUrl\":\"https://my.host\"}"));
    assert!(!edge_tts_config_complete("{\"baseUrl\":\"http://my.host\"}"));
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

  #[test]
  fn extract_provider_code_reads_openai_error_code() {
    let code = extract_provider_code(r#"{"error":{"code":"voice_not_found","message":"x"}}"#);
    assert_eq!(code, "voice_not_found");
    assert!(extract_provider_code("not json").is_empty());
  }

  #[test]
  fn load_base_url_reads_instance_config() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = new_id();
    let now = now_rfc3339();
    let config = serialize_edge_tts_config(&default_edge_tts_config()).unwrap();
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: EDGE_TTS_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: "Edge TTS".into(),
          enabled: true,
          config_json: config,
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Ready,
          last_validated_at: None,
          last_error_code: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    let url = load_edge_tts_base_url(&db, id).unwrap();
    assert_eq!(url, "https://tts.wangwangit.com");
  }

  // Silence unused import warning for EDGE_TTS_VOICE_DEFAULT in test builds if not referenced.
  #[test]
  fn voice_default_is_xiaoxiao() {
    assert_eq!(EDGE_TTS_VOICE_DEFAULT, "zh-CN-XiaoxiaoNeural");
  }
}
