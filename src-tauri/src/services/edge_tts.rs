// ABOUTME: Edge TTS capability handler (speech.synthesize@1) over a configurable OpenAI-compatible API.
// ABOUTME: Credential-free; routes bounded binary MP3 responses through the shared network broker.
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::service_capability::{
  CapabilityError, CapabilityErrorCode, EdgeTtsPreferences, ExecutionContext, SPEECH_AUDIO_MAX_BYTES,
  SPEECH_SYNTHESIZE_CAPABILITY_ID, SpeechSynthesizeRequest, SpeechSynthesizeResponse, validate_capability_language_id,
  validate_capability_request_id, validate_edge_tts_preferences, validate_speech_synthesize_text,
};
use crate::domain::service_integration::{EDGE_TTS_BASE_URL_MAX_LEN, EDGE_TTS_DEFAULT_BASE_URL, EdgeTtsConfigV1};
use crate::error::StorageError;
use crate::services::network_broker::{BrokerRequest, NetworkBroker};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// Manifest endpoint alias for the instance-scoped OpenAI-compatible TTS base URL.
pub const EDGE_TTS_ENDPOINT_ALIAS: &str = "tts-api";
/// Relative path appended to the configured base URL for synthesis.
pub const EDGE_TTS_SYNTHESIZE_PATH: &str = "v1/audio/speech";
/// Fixed synthesis timeout (provider may take longer than the default 20s).
pub const EDGE_TTS_SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(60);

/// Edge TTS capability surface routed through the host-owned network broker.
#[derive(Clone)]
pub struct EdgeTtsCapabilities {
  network: Arc<NetworkBroker>,
}

impl EdgeTtsCapabilities {
  pub fn new(network: Arc<NetworkBroker>) -> Self {
    Self { network }
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

    // Edge TTS pitch is a string scalar ("-50".."50"); Rust f64 Display strips trailing zeros.
    let body = json!({
      "input": request.text,
      "voice": preferences.voice,
      "speed": preferences.speed,
      "pitch": preferences.pitch.to_string(),
      "style": preferences.style,
    });

    if context.cancel.is_cancelled() {
      return Err(
        CapabilityError::new(CapabilityErrorCode::Cancelled, "speech synthesis cancelled")
          .with_capability_id(cap)
          .with_request_id(rid),
      );
    }

    let response = self
      .network
      .execute_bytes(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: cap.into(),
        execution_principal: context.principal(),
        endpoint_alias: EDGE_TTS_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Post,
        relative_path: EDGE_TTS_SYNTHESIZE_PATH.into(),
        query: vec![],
        headers: HashMap::from([("Accept".into(), "audio/mpeg".into())]),
        body: Some(body.to_string()),
        content_type: Some("application/json".into()),
        auth: None,
        request_id: rid.into(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: Some(SPEECH_AUDIO_MAX_BYTES),
        max_request_body_bytes: None,
        timeout: Some(EDGE_TTS_SYNTHESIS_TIMEOUT),
      })
      .await
      .map_err(|e| e.with_capability_id(cap).with_request_id(rid))?;

    if !(200..300).contains(&response.status) {
      let error_body = String::from_utf8_lossy(&response.body);
      return Err(
        map_edge_tts_http_error(response.status, error_body.as_ref())
          .with_capability_id(cap)
          .with_request_id(rid),
      );
    }

    let mp3_bytes = response.body;
    if mp3_bytes.is_empty() {
      return Err(
        CapabilityError::new(CapabilityErrorCode::InvalidResponse, "Edge TTS returned empty audio")
          .with_capability_id(cap)
          .with_request_id(rid),
      );
    }
    // The broker applies this exact cap before returning bytes; retain a local defense-in-depth check.
    if mp3_bytes.len() > SPEECH_AUDIO_MAX_BYTES {
      return Err(
        CapabilityError::new(
          CapabilityErrorCode::InvalidResponse,
          "Edge TTS audio exceeds size limit",
        )
        .with_capability_id(cap)
        .with_request_id(rid),
      );
    }

    Ok(SpeechSynthesizeResponse { mp3_bytes })
  }
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
  use crate::domain::cancel::CancelToken;
  use crate::domain::provider_http::ProviderHttpStreamEvent;
  use crate::domain::service_capability::EDGE_TTS_VOICE_DEFAULT;
  use crate::domain::service_integration::{EDGE_TTS_PLUGIN_ID, IntegrationHealthStatus, IntegrationInstance};
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::repositories::integration_instances;
  use crate::services::bounded_http::{BoundedHttpResponse, PreparedHttpRequest, RawHttpTransport};
  use crate::services::network_broker::NetworkBroker;
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use crate::storage::Database;
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Mutex;

  struct CaptureTransport {
    last: Mutex<Option<PreparedHttpRequest>>,
    response: Mutex<Result<BoundedHttpResponse, StorageError>>,
  }

  impl RawHttpTransport for CaptureTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, StorageError>> + Send + '_>> {
      Box::pin(async move {
        *self.last.lock().unwrap() = Some(prepared);
        match &*self.response.lock().unwrap() {
          Ok(response) => Ok(response.clone()),
          Err(error) => Err(StorageError::Validation(error.to_string())),
        }
      })
    }

    fn stream(
      &self,
      _prepared: PreparedHttpRequest,
      _cancel: CancelToken,
      _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
    ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
      Box::pin(async { Err(StorageError::Validation("stream not supported".into())) })
    }
  }

  fn seed_edge_instance(db: &Database, base_url: &str) -> Uuid {
    let id = new_id();
    let now = now_rfc3339();
    let config_json = serialize_edge_tts_config(&EdgeTtsConfigV1 {
      base_url: base_url.into(),
    })
    .unwrap();
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: EDGE_TTS_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: "Edge TTS".into(),
          enabled: true,
          config_json,
          config_schema_version: 1,
          health_status: IntegrationHealthStatus::Ready,
          last_validated_at: None,
          last_error_code: None,
          runtime_kind: "bundled-rust".into(),
          package_digest: None,
          execution_grant_set_revision: None,
          runtime_state: "active".into(),
          runtime_error_code: None,
          runtime_error_message: None,
          runtime_requirement_json: None,
          created_at: now.clone(),
          updated_at: now,
        },
      )?;
      Ok(())
    })
    .unwrap();
    id
  }

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

  #[test]
  fn extract_provider_code_reads_openai_error_code() {
    let code = extract_provider_code(r#"{"error":{"code":"voice_not_found","message":"x"}}"#);
    assert_eq!(code, "voice_not_found");
    assert!(extract_provider_code("not json").is_empty());
  }

  #[tokio::test]
  async fn synthesize_routes_binary_audio_through_broker() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let instance_id = seed_edge_instance(&db, EDGE_TTS_DEFAULT_BASE_URL);
    let mp3_bytes = vec![0xFF, 0xFB, 0x90, 0x64];
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(BoundedHttpResponse {
        status: 200,
        headers: HashMap::from([("content-type".into(), "audio/mpeg".into())]),
        body: mp3_bytes.clone(),
      })),
    });
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let broker = Arc::new(NetworkBroker::with_transport(db, registry, transport.clone()));
    let capabilities = EdgeTtsCapabilities::new(broker);

    let response = capabilities
      .synthesize_speech(
        instance_id,
        SpeechSynthesizeRequest {
          text: "你好".into(),
          language_id: "zh".into(),
          preferences: serde_json::json!({
            "voice": EDGE_TTS_VOICE_DEFAULT,
            "speed": 1.0,
            "pitch": 0.0,
            "style": "general",
          }),
        },
        ExecutionContext {
          request_id: "edge-broker-1".into(),
          cancel: CancelToken::new(),
          deadline: None,
          integration_instance_id: instance_id,
          plugin_id: EDGE_TTS_PLUGIN_ID.into(),
          capability_id: SPEECH_SYNTHESIZE_CAPABILITY_ID.into(),
        },
      )
      .await
      .unwrap();

    assert_eq!(response.mp3_bytes, mp3_bytes);
    let prepared = transport.last.lock().unwrap().take().unwrap();
    assert_eq!(prepared.url.as_str(), "https://tts.wangwangit.com/v1/audio/speech");
    assert_eq!(prepared.headers.get("Accept").map(String::as_str), Some("audio/mpeg"));
    assert_eq!(prepared.content_type.as_deref(), Some("application/json"));
    assert_eq!(prepared.max_response_body_bytes, Some(SPEECH_AUDIO_MAX_BYTES));
    assert_eq!(prepared.timeout, Some(EDGE_TTS_SYNTHESIS_TIMEOUT));
    assert!(!prepared.headers.contains_key("Authorization"));
  }

  // Silence unused import warning for EDGE_TTS_VOICE_DEFAULT in test builds if not referenced.
  #[test]
  fn voice_default_is_xiaoxiao() {
    assert_eq!(EDGE_TTS_VOICE_DEFAULT, "zh-CN-XiaoxiaoNeural");
  }
}
