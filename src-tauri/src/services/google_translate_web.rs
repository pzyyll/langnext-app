// ABOUTME: Google Web Translation GTX and HTTPS-proxy capability handlers.
// ABOUTME: Credential-free Translate/Detect over pinned GTX or validated third-party HTTPS proxy.
use crate::domain::provider_http::ProviderHttpMethod;
use crate::domain::service_capability::{
  CAPABILITY_TEXT_MAX_BYTES, CapabilityError, CapabilityErrorCode, DetectLanguageRequest, DetectLanguageResponse,
  ExecutionContext, TranslateTextRequest, TranslateTextResponse, validate_capability_language_id,
  validate_capability_request_id, validate_capability_text,
};
use crate::domain::service_integration::{
  GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL, GOOGLE_TRANSLATE_WEB_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PROXY_URL_MAX_LEN,
  GoogleTranslateWebChannel, GoogleTranslateWebConfigV1,
};
use crate::error::StorageError;
use crate::repositories::integration_instances;
use crate::services::google_cloud::{app_language_to_google, google_language_to_app};
use crate::services::network_broker::{BrokerRequest, NetworkBroker};
use crate::storage::Database;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// Capability id for text translation (shared major with Cloud).
pub const GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID: &str = "translate.text@1";
/// Capability id for language detection (shared major with Cloud).
pub const GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID: &str = "translate.detect@1";
/// Manifest endpoint alias for pinned GTX origin.
pub const GOOGLE_WEB_GTX_ENDPOINT_ALIAS: &str = "gtx";
/// Manifest endpoint alias for instance-configured HTTPS proxy origin.
pub const GOOGLE_WEB_PROXY_ENDPOINT_ALIAS: &str = "https_proxy";
/// GTX relative path under translate.google.com.
pub const GOOGLE_WEB_GTX_RELATIVE_PATH: &str = "translate_a/single";
/// GTX client query value (unofficial free endpoint).
pub const GOOGLE_WEB_GTX_CLIENT: &str = "gtx";
/// GTX text encoding query values.
pub const GOOGLE_WEB_GTX_ENCODING: &str = "UTF-8";
/// GTX `dt` value requesting translation segments.
pub const GOOGLE_WEB_GTX_DT: &str = "t";
/// Stricter response body cap for free-text translation (bytes).
pub const GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES: usize = 256 * 1024;
/// Stricter total request timeout for free-text GTX/proxy calls (shorter than shared 20s client default).
pub const GOOGLE_WEB_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Max translated segment count accepted from a GTX payload.
const GTX_MAX_SEGMENTS: usize = 512;
/// Minimum outer-array length required to read the detected-language slot.
const GTX_DETECT_MIN_OUTER_LEN: usize = 3;
/// Documented outer-array index of the detected language code.
const GTX_DETECT_LANGUAGE_INDEX: usize = 2;
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

#[derive(Clone)]
pub struct GoogleTranslateWebCapabilities {
  db: Database,
  network: Arc<NetworkBroker>,
}

impl GoogleTranslateWebCapabilities {
  pub fn new(db: Database, network: Arc<NetworkBroker>) -> Self {
    Self { db, network }
  }

  pub async fn translate_text(
    &self,
    instance_id: Uuid,
    request: TranslateTextRequest,
    context: ExecutionContext,
  ) -> Result<TranslateTextResponse, CapabilityError> {
    validate_capability_request_id(&context.request_id)?;
    validate_capability_text(&request.text)?;
    validate_capability_language_id(&request.target_language_id, "target_language_id")?;
    if !request.source_language_id.is_empty() && request.source_language_id != "auto" {
      validate_capability_language_id(&request.source_language_id, "source_language_id")?;
    }

    let config = load_web_config(&self.db, instance_id)?;
    match config.channel {
      GoogleTranslateWebChannel::Gtx => self.translate_via_gtx(instance_id, &request, &context).await,
      GoogleTranslateWebChannel::HttpsProxy => self.translate_via_proxy(instance_id, &config, &request, &context).await,
    }
  }

  pub async fn detect_language(
    &self,
    instance_id: Uuid,
    request: DetectLanguageRequest,
    context: ExecutionContext,
  ) -> Result<DetectLanguageResponse, CapabilityError> {
    validate_capability_request_id(&context.request_id)?;
    validate_capability_text(&request.text)?;
    // Detect always uses pinned GTX, even when the instance channel is https_proxy.
    let _config = load_web_config(&self.db, instance_id)?;
    self.detect_via_gtx(instance_id, &request, &context).await
  }

  async fn translate_via_gtx(
    &self,
    instance_id: Uuid,
    request: &TranslateTextRequest,
    context: &ExecutionContext,
  ) -> Result<TranslateTextResponse, CapabilityError> {
    let target = app_language_to_google(&request.target_language_id).ok_or_else(|| {
      CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported target language")
        .with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;
    let source = gtx_source_language(&request.source_language_id).map_err(|e| {
      e.with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_WEB_GTX_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Get,
        relative_path: GOOGLE_WEB_GTX_RELATIVE_PATH.into(),
        query: gtx_query_pairs(source, target, &request.text),
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: Some(GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES),
        max_request_body_bytes: None,
        timeout: Some(GOOGLE_WEB_REQUEST_TIMEOUT),
      })
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_gtx_translate_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }

  async fn detect_via_gtx(
    &self,
    instance_id: Uuid,
    request: &DetectLanguageRequest,
    context: &ExecutionContext,
  ) -> Result<DetectLanguageResponse, CapabilityError> {
    // Detect uses source=auto and a fixed target; only the detected language slot is used.
    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_WEB_GTX_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Get,
        relative_path: GOOGLE_WEB_GTX_RELATIVE_PATH.into(),
        query: gtx_query_pairs("auto", "en", &request.text),
        headers: HashMap::new(),
        body: None,
        content_type: None,
        auth: None,
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: Some(GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES),
        max_request_body_bytes: None,
        timeout: Some(GOOGLE_WEB_REQUEST_TIMEOUT),
      })
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_gtx_detect_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }

  async fn translate_via_proxy(
    &self,
    instance_id: Uuid,
    config: &GoogleTranslateWebConfigV1,
    request: &TranslateTextRequest,
    context: &ExecutionContext,
  ) -> Result<TranslateTextResponse, CapabilityError> {
    let proxy_url = config.proxy_url.as_deref().ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "proxy URL is required for https_proxy channel",
      )
      .with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
      .with_request_id(&context.request_id)
    })?;
    let normalized = normalize_proxy_url(proxy_url).map_err(|msg| {
      CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg)
        .with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let target = app_language_to_google(&request.target_language_id).ok_or_else(|| {
      CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported target language")
        .with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;
    let source = proxy_source_language(&request.source_language_id).map_err(|e| {
      e.with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })?;

    let body = json!({
      "text": request.text,
      "source_lang": source,
      "target_lang": target,
    });

    let response = self
      .network
      .execute(BrokerRequest {
        integration_instance_id: instance_id,
        capability_id: GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        endpoint_alias: GOOGLE_WEB_PROXY_ENDPOINT_ALIAS.into(),
        method: ProviderHttpMethod::Post,
        relative_path: normalized.relative_path,
        query: vec![],
        headers: HashMap::new(),
        body: Some(body.to_string()),
        content_type: Some("application/json".into()),
        auth: None,
        request_id: context.request_id.clone(),
        cancel: Some(context.cancel.clone()),
        max_response_body_bytes: Some(GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES),
        max_request_body_bytes: None,
        timeout: Some(GOOGLE_WEB_REQUEST_TIMEOUT),
      })
      .await
      .map_err(|e| {
        e.with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
          .with_request_id(&context.request_id)
      })?;

    parse_proxy_translate_response(response.status, &response.body).map_err(|e| {
      e.with_capability_id(GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID)
        .with_request_id(&context.request_id)
    })
  }
}

/// Normalized HTTPS proxy endpoint parts used by the network broker.
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Default config for a new Google Web instance (GTX channel).
pub fn default_web_config() -> GoogleTranslateWebConfigV1 {
  GoogleTranslateWebConfigV1 {
    channel: GoogleTranslateWebChannel::Gtx,
    proxy_url: None,
  }
}

/// Serialize a validated Web config for persistence.
pub fn serialize_web_config(config: &GoogleTranslateWebConfigV1) -> Result<String, StorageError> {
  serde_json::to_string(config).map_err(StorageError::from)
}

/// Validate/normalize Web config JSON; returns canonical config_json string.
pub fn validate_google_translate_web_config(config_json: &str) -> Result<String, StorageError> {
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
    "baseUrl",
    "base_url",
    "endpoint",
    "customEndpoint",
    "apiKey",
    "api_key",
    "token",
    "accessToken",
  ] {
    if obj.contains_key(forbidden) {
      return Err(StorageError::Validation(format!(
        "Google Web config rejects field `{forbidden}`"
      )));
    }
  }

  let mut config: GoogleTranslateWebConfigV1 =
    serde_json::from_value(value).map_err(|e| StorageError::Validation(format!("invalid Google Web config: {e}")))?;

  match config.channel {
    GoogleTranslateWebChannel::Gtx => {
      config.proxy_url = None;
    }
    GoogleTranslateWebChannel::HttpsProxy => {
      let raw = config
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL);
      let normalized = normalize_proxy_url(raw).map_err(StorageError::Validation)?;
      config.proxy_url = Some(normalized.canonical_url);
    }
  }

  serialize_web_config(&config)
}

/// True when Web config is complete enough to execute (always for valid GTX; proxy needs URL).
pub fn google_translate_web_config_complete(config_json: &str) -> bool {
  match serde_json::from_str::<GoogleTranslateWebConfigV1>(config_json) {
    Ok(config) => match config.channel {
      GoogleTranslateWebChannel::Gtx => true,
      GoogleTranslateWebChannel::HttpsProxy => config
        .proxy_url
        .as_deref()
        .map(|u| normalize_proxy_url(u).is_ok())
        .unwrap_or(false),
    },
    Err(_) => false,
  }
}

fn load_web_config(db: &Database, instance_id: Uuid) -> Result<GoogleTranslateWebConfigV1, CapabilityError> {
  let instance = db
    .read(|conn| integration_instances::get(conn, instance_id))
    .map_err(|e| match e {
      StorageError::NotFound(_) => CapabilityError::new(
        CapabilityErrorCode::InvalidConfiguration,
        "integration instance not found",
      ),
      _ => CapabilityError::new(CapabilityErrorCode::Internal, "failed to load integration instance"),
    })?;

  if instance.plugin_id != GOOGLE_TRANSLATE_WEB_PLUGIN_ID {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "instance is not a Google Web translation integration",
    ));
  }
  if !instance.enabled {
    return Err(CapabilityError::new(
      CapabilityErrorCode::PluginUnavailable,
      "integration instance is disabled",
    ));
  }

  serde_json::from_str(&instance.config_json).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "invalid Google Web configuration",
    )
  })
}

fn gtx_source_language(source_language_id: &str) -> Result<&'static str, CapabilityError> {
  if source_language_id.is_empty() || source_language_id == "auto" {
    return Ok("auto");
  }
  app_language_to_google(source_language_id)
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported source language"))
}

fn proxy_source_language(source_language_id: &str) -> Result<&'static str, CapabilityError> {
  if source_language_id.is_empty() || source_language_id == "auto" {
    return Ok("auto");
  }
  app_language_to_google(source_language_id)
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::UnsupportedLanguage, "unsupported source language"))
}

fn gtx_query_pairs(source: &str, target: &str, text: &str) -> Vec<(String, String)> {
  vec![
    ("client".into(), GOOGLE_WEB_GTX_CLIENT.into()),
    ("sl".into(), source.into()),
    ("tl".into(), target.into()),
    ("hl".into(), target.into()),
    ("dt".into(), GOOGLE_WEB_GTX_DT.into()),
    ("ie".into(), GOOGLE_WEB_GTX_ENCODING.into()),
    ("oe".into(), GOOGLE_WEB_GTX_ENCODING.into()),
    ("q".into(), text.into()),
  ]
}

/// Map free-endpoint HTTP status to capability errors (no Cloud auth codes).
pub fn map_web_http_error(status: u16) -> Result<(), CapabilityError> {
  if (200..300).contains(&status) {
    return Ok(());
  }
  match status {
    429 => Err(
      CapabilityError::new(CapabilityErrorCode::RateLimited, "Google Web rate limited")
        .with_retryable(true)
        .with_provider_code("429"),
    ),
    400 => Err(
      CapabilityError::new(CapabilityErrorCode::InvalidRequest, "Google Web rejected the request")
        .with_retryable(false)
        .with_provider_code("400"),
    ),
    500..=599 => Err(
      CapabilityError::new(
        CapabilityErrorCode::ProviderUnavailable,
        "Google Web service unavailable",
      )
      .with_retryable(true)
      .with_provider_code(status.to_string()),
    ),
    _ => Err(
      CapabilityError::new(CapabilityErrorCode::ProviderUnavailable, "Google Web request failed")
        .with_retryable(false)
        .with_provider_code(status.to_string()),
    ),
  }
}

/// Parse GTX nested-array translate response; join segments in order.
pub fn parse_gtx_translate_response(status: u16, body: &str) -> Result<TranslateTextResponse, CapabilityError> {
  map_web_http_error(status)?;
  if body.len() > GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "response body exceeds size limit",
    ));
  }
  let root: Value = serde_json::from_str(body)
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "translate response was malformed"))?;
  let outer = root
    .as_array()
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "translate response was malformed"))?;
  let segments = outer.first().and_then(Value::as_array).ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "translate response missing segments",
    )
  })?;

  let mut parts: Vec<String> = Vec::new();
  for (idx, segment) in segments.iter().enumerate() {
    if idx >= GTX_MAX_SEGMENTS {
      return Err(CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "translate response has too many segments",
      ));
    }
    // Fail closed: every segment must be an array whose first element is a string.
    // Skipping malformed entries would silently truncate translations.
    let arr = segment
      .as_array()
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "translate segment was malformed"))?;
    let text = arr
      .first()
      .and_then(Value::as_str)
      .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "translate segment missing text"))?;
    if !text.is_empty() {
      parts.push(text.to_string());
    }
  }
  if parts.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "translate response contained no text",
    ));
  }
  let translated_text = parts.join("");
  if translated_text.len() > CAPABILITY_TEXT_MAX_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "translated text exceeds size limit",
    ));
  }

  let detected =
    extract_gtx_detected_language(outer).and_then(|code| google_language_to_app(&code).map(str::to_string));

  Ok(TranslateTextResponse {
    translated_text,
    detected_source_language_id: detected,
  })
}

/// Parse GTX detect response from the documented outer-array language slot.
pub fn parse_gtx_detect_response(status: u16, body: &str) -> Result<DetectLanguageResponse, CapabilityError> {
  map_web_http_error(status)?;
  if body.len() > GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "response body exceeds size limit",
    ));
  }
  let root: Value = serde_json::from_str(body)
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "detect response was malformed"))?;
  let outer = root
    .as_array()
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "detect response was malformed"))?;
  let code = extract_gtx_detected_language(outer)
    .ok_or_else(|| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "detect response missing language"))?;
  let language_id = google_language_to_app(&code).ok_or_else(|| {
    CapabilityError::new(
      CapabilityErrorCode::UnsupportedLanguage,
      "detected language is outside the app contract",
    )
  })?;
  Ok(DetectLanguageResponse {
    language_id: language_id.to_string(),
    confidence: None,
  })
}

fn extract_gtx_detected_language(outer: &[Value]) -> Option<String> {
  if outer.len() < GTX_DETECT_MIN_OUTER_LEN {
    return None;
  }
  outer
    .get(GTX_DETECT_LANGUAGE_INDEX)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(str::to_string)
}

/// Parse bounded proxy `{ "data": string }` response.
pub fn parse_proxy_translate_response(status: u16, body: &str) -> Result<TranslateTextResponse, CapabilityError> {
  map_web_http_error(status)?;
  if body.len() > GOOGLE_WEB_MAX_RESPONSE_BODY_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "response body exceeds size limit",
    ));
  }
  let root: Value = serde_json::from_str(body)
    .map_err(|_| CapabilityError::new(CapabilityErrorCode::InvalidResponse, "proxy response was malformed"))?;
  let data = root
    .get("data")
    .and_then(Value::as_str)
    .map(str::to_string)
    .ok_or_else(|| {
      CapabilityError::new(
        CapabilityErrorCode::InvalidResponse,
        "proxy response missing data string",
      )
    })?;
  if data.is_empty() {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "proxy response data is empty",
    ));
  }
  if data.len() > CAPABILITY_TEXT_MAX_BYTES {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidResponse,
      "translated text exceeds size limit",
    ));
  }
  Ok(TranslateTextResponse {
    translated_text: data,
    detected_source_language_id: None,
  })
}

/// Resolve instance-configured proxy origin for the network broker.
pub fn resolve_instance_proxy_origin(config_json: &str) -> Result<String, CapabilityError> {
  let config: GoogleTranslateWebConfigV1 = serde_json::from_str(config_json).map_err(|_| {
    CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "invalid Google Web configuration",
    )
  })?;
  if config.channel != GoogleTranslateWebChannel::HttpsProxy {
    return Err(CapabilityError::new(
      CapabilityErrorCode::InvalidConfiguration,
      "proxy endpoint requires https_proxy channel",
    ));
  }
  let raw = config
    .proxy_url
    .as_deref()
    .unwrap_or(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL);
  let normalized =
    normalize_proxy_url(raw).map_err(|msg| CapabilityError::new(CapabilityErrorCode::InvalidConfiguration, msg))?;
  Ok(normalized.origin)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::cancel::CancelToken;
  use crate::domain::provider_http::{ProviderHttpResponse, ProviderHttpStreamEvent};
  use crate::domain::service_integration::{
    GOOGLE_TRANSLATE_WEB_GTX_ORIGIN, IntegrationHealthStatus, IntegrationInstance,
  };
  use crate::domain::time::{new_id, now_rfc3339};
  use crate::services::bounded_http::{PreparedHttpRequest, RawHttpTransport};
  use crate::services::service_integration_registry::ServiceIntegrationRegistry;
  use std::future::Future;
  use std::pin::Pin;
  use std::sync::Mutex;

  struct CaptureTransport {
    last: Mutex<Option<PreparedHttpRequest>>,
    response: Mutex<Result<ProviderHttpResponse, StorageError>>,
  }

  impl RawHttpTransport for CaptureTransport {
    fn request(
      &self,
      prepared: PreparedHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, StorageError>> + Send + '_>> {
      Box::pin(async move {
        *self.last.lock().unwrap() = Some(prepared);
        match &*self.response.lock().unwrap() {
          Ok(r) => Ok(r.clone()),
          Err(e) => Err(StorageError::Validation(e.to_string())),
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

  fn seed_web_instance(db: &Database, config: &GoogleTranslateWebConfigV1) -> Uuid {
    let id = new_id();
    let now = now_rfc3339();
    db.transaction(|uow| {
      integration_instances::insert(
        uow.conn(),
        &IntegrationInstance {
          id,
          plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
          plugin_version: "1.0.0".into(),
          display_name: "Web".into(),
          enabled: true,
          config_json: serialize_web_config(config).unwrap(),
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
    id
  }

  fn caps_with(db: Database, transport: Arc<dyn RawHttpTransport>) -> GoogleTranslateWebCapabilities {
    let registry = Arc::new(ServiceIntegrationRegistry::bundled().unwrap());
    let network = Arc::new(NetworkBroker::with_transport(db.clone(), registry, transport));
    GoogleTranslateWebCapabilities::new(db, network)
  }

  #[test]
  fn google_translate_web_gtx_parses_multiline_unicode_segments() {
    let body = r#"[[["Hello ","你好",null,null,10],["world 🌍","世界 🌍",null,null,10]],null,"zh"]"#;
    let resp = parse_gtx_translate_response(200, body).unwrap();
    assert_eq!(resp.translated_text, "Hello world 🌍");
    assert_eq!(resp.detected_source_language_id.as_deref(), Some("zh"));
  }

  #[test]
  fn google_translate_web_gtx_rejects_malformed_and_empty() {
    let err = parse_gtx_translate_response(200, r#"{"not":"array"}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);

    let err = parse_gtx_translate_response(200, r#"[[],null,"en"]"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);

    let err = parse_gtx_translate_response(200, "not-json").unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[test]
  fn google_translate_web_gtx_rejects_malformed_segments_fail_closed() {
    // Non-array segment must not be skipped (would drop later valid segments).
    let err = parse_gtx_translate_response(200, r#"[[["Hello","x",null,null,1],"bad"],null,"en"]"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
    assert!(err.message.contains("malformed"));

    // Segment array without a leading string text slot.
    let err = parse_gtx_translate_response(200, r#"[[["Hello","x",null,null,1],[123]],null,"en"]"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
    assert!(err.message.contains("missing text"));

    // Null first element is not a string.
    let err = parse_gtx_translate_response(200, r#"[[[null,"x"]],null,"en"]"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[test]
  fn google_translate_web_gtx_joins_valid_multi_segments() {
    let body =
      r#"[[["PartA","源A",null,null,10],["PartB","源B",null,null,10],["PartC","源C",null,null,10]],null,"zh"]"#;
    let resp = parse_gtx_translate_response(200, body).unwrap();
    assert_eq!(resp.translated_text, "PartAPartBPartC");
    assert_eq!(resp.detected_source_language_id.as_deref(), Some("zh"));
  }

  #[test]
  fn google_translate_web_request_timeout_is_stricter_than_default() {
    use crate::services::bounded_http::REQUEST_TIMEOUT;
    assert_eq!(GOOGLE_WEB_REQUEST_TIMEOUT, Duration::from_secs(10));
    assert!(GOOGLE_WEB_REQUEST_TIMEOUT < REQUEST_TIMEOUT);
  }

  #[test]
  fn google_translate_web_gtx_detect_variants() {
    let body = r#"[[["x","y",null,null,1]],null,"zh-CN"]"#;
    let resp = parse_gtx_detect_response(200, body).unwrap();
    assert_eq!(resp.language_id, "zh");

    let body = r#"[[["x","y",null,null,1]],null,"nb"]"#;
    let resp = parse_gtx_detect_response(200, body).unwrap();
    assert_eq!(resp.language_id, "no");

    let body = r#"[[["x","y",null,null,1]],null,"fil"]"#;
    let resp = parse_gtx_detect_response(200, body).unwrap();
    assert_eq!(resp.language_id, "tl");

    let err = parse_gtx_detect_response(200, r#"[[["x"]],null]"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);

    let err = parse_gtx_detect_response(200, r#"[[["x"]],null,"xyzzy"]"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::UnsupportedLanguage);
  }

  #[test]
  fn google_translate_web_gtx_maps_rate_limit_and_limits() {
    let err = map_web_http_error(429).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::RateLimited);
    assert!(err.retryable);

    let huge = format!(r#"[[["{}"]],null,"en"]"#, "a".repeat(CAPABILITY_TEXT_MAX_BYTES + 1));
    let err = parse_gtx_translate_response(200, &huge).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[tokio::test]
  async fn google_translate_web_gtx_builds_get_without_auth() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_web_instance(
      &db,
      &GoogleTranslateWebConfigV1 {
        channel: GoogleTranslateWebChannel::Gtx,
        proxy_url: None,
      },
    );
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"[[["Hi","你好",null,null,1]],null,"zh"]"#.into(),
      })),
    });
    let caps = caps_with(db, transport.clone());
    let resp = caps
      .translate_text(
        id,
        TranslateTextRequest {
          text: "你好".into(),
          source_language_id: "auto".into(),
          target_language_id: "en".into(),
        },
        ExecutionContext {
          request_id: "req-gtx-1".into(),
          cancel: CancelToken::new(),
          deadline: None,
          integration_instance_id: id,
          plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
          capability_id: GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        },
      )
      .await
      .unwrap();
    assert_eq!(resp.translated_text, "Hi");
    let prepared = transport.last.lock().unwrap().take().unwrap();
    assert!(prepared.url.as_str().starts_with(GOOGLE_TRANSLATE_WEB_GTX_ORIGIN));
    assert!(prepared.url.as_str().contains("client=gtx"));
    assert!(!prepared.headers.keys().any(|k| k.eq_ignore_ascii_case("Authorization")));
    assert!(prepared.body.is_none());
    assert_eq!(prepared.timeout, Some(GOOGLE_WEB_REQUEST_TIMEOUT));
  }

  #[tokio::test]
  async fn google_translate_web_gtx_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_web_instance(
      &db,
      &GoogleTranslateWebConfigV1 {
        channel: GoogleTranslateWebChannel::Gtx,
        proxy_url: None,
      },
    );
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"[[["x"]],null,"en"]"#.into(),
      })),
    });
    let caps = caps_with(db, transport);
    let cancel = CancelToken::new();
    cancel.cancel();
    let err = caps
      .translate_text(
        id,
        TranslateTextRequest {
          text: "hi".into(),
          source_language_id: "en".into(),
          target_language_id: "zh".into(),
        },
        ExecutionContext {
          request_id: "req-gtx-cancel".into(),
          cancel,
          deadline: None,
          integration_instance_id: id,
          plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
          capability_id: GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        },
      )
      .await
      .unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::Cancelled);
  }

  #[test]
  fn google_translate_web_proxy_rejects_unsafe_urls() {
    assert!(normalize_proxy_url("http://example.com/t").is_err());
    assert!(normalize_proxy_url("https://user:pass@example.com/t").is_err());
    assert!(normalize_proxy_url("https://example.com/t#frag").is_err());
    assert!(normalize_proxy_url("https://example.com/t?api_key=secret").is_err());
    assert!(normalize_proxy_url("https://example.com/t?token=abc").is_err());
    assert!(normalize_proxy_url("https://").is_err());
    assert!(normalize_proxy_url("https:///").is_err());
    assert!(normalize_proxy_url("").is_err());

    let ok = normalize_proxy_url("https://googlet.deno.dev/translate?foo=bar").unwrap();
    assert_eq!(ok.canonical_url, "https://googlet.deno.dev/translate");
    assert_eq!(ok.origin, "https://googlet.deno.dev");
    assert_eq!(ok.relative_path, "translate");
    assert_eq!(ok.hostname, "googlet.deno.dev");
  }

  #[test]
  fn google_translate_web_proxy_parses_data_and_rejects_malformed() {
    let resp = parse_proxy_translate_response(200, r#"{"data":"你好"}"#).unwrap();
    assert_eq!(resp.translated_text, "你好");
    assert!(resp.detected_source_language_id.is_none());

    let err = parse_proxy_translate_response(200, r#"{"data":123}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
    let err = parse_proxy_translate_response(200, r#"{"result":"x"}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
    let err = parse_proxy_translate_response(200, r#"{"data":""}"#).unwrap_err();
    assert_eq!(err.code, CapabilityErrorCode::InvalidResponse);
  }

  #[tokio::test]
  async fn google_translate_web_proxy_posts_json_without_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_web_instance(
      &db,
      &GoogleTranslateWebConfigV1 {
        channel: GoogleTranslateWebChannel::HttpsProxy,
        proxy_url: Some(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL.into()),
      },
    );
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"{"data":"Hello"}"#.into(),
      })),
    });
    let caps = caps_with(db, transport.clone());
    let resp = caps
      .translate_text(
        id,
        TranslateTextRequest {
          text: "你好".into(),
          source_language_id: "zh".into(),
          target_language_id: "en".into(),
        },
        ExecutionContext {
          request_id: "req-proxy-1".into(),
          cancel: CancelToken::new(),
          deadline: None,
          integration_instance_id: id,
          plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
          capability_id: GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID.into(),
        },
      )
      .await
      .unwrap();
    assert_eq!(resp.translated_text, "Hello");
    let prepared = transport.last.lock().unwrap().take().unwrap();
    assert_eq!(prepared.url.as_str(), "https://googlet.deno.dev/translate");
    assert!(!prepared.headers.keys().any(|k| k.eq_ignore_ascii_case("Authorization")));
    assert!(!prepared.headers.keys().any(|k| k.eq_ignore_ascii_case("Cookie")));
    assert_eq!(prepared.timeout, Some(GOOGLE_WEB_REQUEST_TIMEOUT));
    let body: Value = serde_json::from_str(prepared.body.as_ref().unwrap()).unwrap();
    assert_eq!(body["text"], "你好");
    assert_eq!(body["source_lang"], "zh-CN");
    assert_eq!(body["target_lang"], "en");
  }

  #[tokio::test]
  async fn google_translate_web_proxy_detect_stays_on_gtx() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id = seed_web_instance(
      &db,
      &GoogleTranslateWebConfigV1 {
        channel: GoogleTranslateWebChannel::HttpsProxy,
        proxy_url: Some(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL.into()),
      },
    );
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"[[["x"]],null,"en"]"#.into(),
      })),
    });
    let caps = caps_with(db, transport.clone());
    let resp = caps
      .detect_language(
        id,
        DetectLanguageRequest { text: "hello".into() },
        ExecutionContext {
          request_id: "req-proxy-detect".into(),
          cancel: CancelToken::new(),
          deadline: None,
          integration_instance_id: id,
          plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
          capability_id: GOOGLE_WEB_DETECT_LANGUAGE_CAPABILITY_ID.into(),
        },
      )
      .await
      .unwrap();
    assert_eq!(resp.language_id, "en");
    let prepared = transport.last.lock().unwrap().take().unwrap();
    assert!(prepared.url.as_str().starts_with(GOOGLE_TRANSLATE_WEB_GTX_ORIGIN));
  }

  #[tokio::test]
  async fn google_translate_web_proxy_instance_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::new(dir.path()).unwrap();
    db.initialize().unwrap();
    let id_a = seed_web_instance(
      &db,
      &GoogleTranslateWebConfigV1 {
        channel: GoogleTranslateWebChannel::HttpsProxy,
        proxy_url: Some("https://proxy-a.example/translate".into()),
      },
    );
    let id_b = seed_web_instance(
      &db,
      &GoogleTranslateWebConfigV1 {
        channel: GoogleTranslateWebChannel::HttpsProxy,
        proxy_url: Some("https://proxy-b.example/v1".into()),
      },
    );
    let transport = Arc::new(CaptureTransport {
      last: Mutex::new(None),
      response: Mutex::new(Ok(ProviderHttpResponse {
        status: 200,
        headers: HashMap::new(),
        body: r#"{"data":"ok"}"#.into(),
      })),
    });
    let caps = caps_with(db, transport.clone());
    let ctx = |id: Uuid, rid: &str| ExecutionContext {
      request_id: rid.into(),
      cancel: CancelToken::new(),
      deadline: None,
      integration_instance_id: id,
      plugin_id: GOOGLE_TRANSLATE_WEB_PLUGIN_ID.into(),
      capability_id: GOOGLE_WEB_TRANSLATE_TEXT_CAPABILITY_ID.into(),
    };
    let req = TranslateTextRequest {
      text: "hi".into(),
      source_language_id: "en".into(),
      target_language_id: "zh".into(),
    };
    caps.translate_text(id_a, req.clone(), ctx(id_a, "a")).await.unwrap();
    let url_a = transport.last.lock().unwrap().take().unwrap().url.as_str().to_string();
    caps.translate_text(id_b, req, ctx(id_b, "b")).await.unwrap();
    let url_b = transport.last.lock().unwrap().take().unwrap().url.as_str().to_string();
    assert_eq!(url_a, "https://proxy-a.example/translate");
    assert_eq!(url_b, "https://proxy-b.example/v1");
  }

  #[test]
  fn google_translate_web_config_defaults_and_validation() {
    let json = validate_google_translate_web_config(r#"{"channel":"gtx"}"#).unwrap();
    let config: GoogleTranslateWebConfigV1 = serde_json::from_str(&json).unwrap();
    assert_eq!(config.channel, GoogleTranslateWebChannel::Gtx);
    assert!(config.proxy_url.is_none());
    assert!(google_translate_web_config_complete(&json));

    let json = validate_google_translate_web_config(r#"{"channel":"https_proxy"}"#).unwrap();
    let config: GoogleTranslateWebConfigV1 = serde_json::from_str(&json).unwrap();
    assert_eq!(config.channel, GoogleTranslateWebChannel::HttpsProxy);
    assert_eq!(
      config.proxy_url.as_deref(),
      Some(GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL)
    );

    let err = validate_google_translate_web_config(r#"{"channel":"gtx","projectId":"x"}"#).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("projectId")));

    let err = validate_google_translate_web_config(r#"{"channel":"https_proxy","proxyUrl":"http://x"}"#).unwrap_err();
    assert!(matches!(err, StorageError::Validation(msg) if msg.contains("https")));
  }
}
