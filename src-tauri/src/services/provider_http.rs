// ABOUTME: Generic native provider HTTP transport with vault auth injection.
// ABOUTME: Accepts only relative paths; never parses provider JSON or returns secrets.
use crate::credentials::CredentialVault;
use crate::domain::cancel::CancelToken;
use crate::domain::provider::{AuthSchemeV1, ProviderInstance, ProxyMode};
use crate::domain::provider_http::{
  ProviderHttpMethod, ProviderHttpRequest, ProviderHttpResponse, ProviderHttpStreamEvent, ProviderWireRequest,
};
use crate::error::StorageError;
use crate::repositories::provider_instances;
use crate::storage::Database;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Total request timeout for non-streaming provider HTTP.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Connect-only timeout for streaming requests.
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Max silence between stream body chunks.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Hard cap on a single non-stream response body (bytes, after decompression).
const MAX_RESPONSE_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Hard cap on total streamed bytes for one request.
const MAX_STREAM_TOTAL_BYTES: usize = 8 * 1024 * 1024;
/// Max request_id length accepted from the frontend.
const MAX_REQUEST_ID_LEN: usize = 128;

const BLOCKED_HEADER_NAMES: &[&str] = &[
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
];

static INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static STREAM_INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static STREAM_DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Injectable raw HTTP executor so unit tests avoid external network access.
pub trait RawHttpTransport: Send + Sync + 'static {
  fn request(
    &self,
    prepared: PreparedProviderRequest,
  ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, StorageError>> + Send + '_>>;

  fn stream(
    &self,
    prepared: PreparedProviderRequest,
    cancel: CancelToken,
    on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>>;
}

/// Secret-bearing request ready for native execution (never returned over IPC).
pub struct PreparedProviderRequest {
  pub method: ProviderHttpMethod,
  pub url: url::Url,
  pub headers: HashMap<String, String>,
  pub body: Option<String>,
  pub proxy_mode: ProxyMode,
}

impl std::fmt::Debug for PreparedProviderRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("PreparedProviderRequest")
      .field("method", &self.method)
      .field("url_origin", &self.url.origin().ascii_serialization())
      .field("header_names", &self.headers.keys().collect::<Vec<_>>())
      .field("has_body", &self.body.is_some())
      .field("proxy_mode", &self.proxy_mode)
      .finish()
  }
}

#[derive(Clone)]
pub struct ProviderHttpService {
  db: Database,
  vault: Arc<dyn CredentialVault>,
  transport: Arc<dyn RawHttpTransport>,
}

impl ProviderHttpService {
  pub fn new(db: Database, vault: Arc<dyn CredentialVault>) -> Self {
    Self {
      db,
      vault,
      transport: Arc::new(ReqwestRawHttpTransport),
    }
  }

  pub fn with_transport(db: Database, vault: Arc<dyn CredentialVault>, transport: Arc<dyn RawHttpTransport>) -> Self {
    Self { db, vault, transport }
  }

  pub async fn request(
    &self,
    input: ProviderHttpRequest,
    cancel: Option<&CancelToken>,
  ) -> Result<ProviderHttpResponse, StorageError> {
    validate_request_id(&input.request_id)?;
    let prepared = self.prepare(input)?;
    let work = self.transport.request(prepared);
    with_cancel(cancel, work).await
  }

  pub async fn stream(
    &self,
    input: ProviderHttpRequest,
    cancel: CancelToken,
    on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Result<(), StorageError> {
    validate_request_id(&input.request_id)?;
    let prepared = self.prepare(input)?;
    self.transport.stream(prepared, cancel, on_event).await
  }

  fn prepare(&self, input: ProviderHttpRequest) -> Result<PreparedProviderRequest, StorageError> {
    let provider = self
      .db
      .read(|conn| provider_instances::get(conn, input.provider_instance_id))?;
    if !provider.enabled {
      return Err(StorageError::Validation("provider is disabled".into()));
    }
    validate_wire(&input.wire, &provider.auth_scheme)?;
    let base_url = effective_base_url(&provider)?;
    reject_insecure_http_if_needed(&base_url, provider.insecure_http_confirmed_at.as_deref())?;
    let mut url = build_endpoint(&base_url, &input.wire.relative_path)?;
    append_query_pairs(&mut url, &input.wire.query)?;
    let secret = load_secret_for_scheme(self.vault.as_ref(), &provider)?;
    let mut headers = input.wire.headers.clone();
    inject_auth(&mut url, &mut headers, &provider.auth_scheme, secret.as_deref())?;

    Ok(PreparedProviderRequest {
      method: input.wire.method,
      url,
      headers,
      body: input.wire.body,
      proxy_mode: provider.proxy_mode,
    })
  }
}

fn validate_request_id(request_id: &str) -> Result<(), StorageError> {
  let trimmed = request_id.trim();
  if trimmed.is_empty() || trimmed.len() > MAX_REQUEST_ID_LEN {
    return Err(StorageError::Validation(format!(
      "request_id must be non-empty and at most {MAX_REQUEST_ID_LEN} characters"
    )));
  }
  if trimmed != request_id {
    return Err(StorageError::Validation(
      "request_id must not have leading or trailing whitespace".into(),
    ));
  }
  Ok(())
}

fn effective_base_url(provider: &ProviderInstance) -> Result<String, StorageError> {
  let url = provider.base_url.trim();
  if url.is_empty() {
    return Err(StorageError::Validation("base URL is required".into()));
  }
  // Transport always uses the persisted effective Base URL (custom or plugin_default).
  Ok(url.to_string())
}

fn validate_wire(wire: &ProviderWireRequest, auth_scheme: &AuthSchemeV1) -> Result<(), StorageError> {
  validate_relative_path(&wire.relative_path)?;
  for (name, value) in &wire.query {
    validate_caller_name(name, "query")?;
    if value_looks_like_secret_key(name) {
      return Err(StorageError::Validation(format!(
        "caller query name '{name}' is restricted"
      )));
    }
    reject_if_auth_name(name, auth_scheme, "query")?;
    let _ = value; // values may contain user text; secrets must not be sent by plugins
  }
  for (name, value) in &wire.headers {
    validate_caller_name(name, "header")?;
    if is_blocked_header(name) {
      return Err(StorageError::Validation(format!(
        "caller header '{name}' is restricted"
      )));
    }
    reject_if_auth_name(name, auth_scheme, "header")?;
    let _ = value;
  }
  Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), StorageError> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err(StorageError::Validation("relativePath must not be empty".into()));
  }
  if trimmed != path {
    return Err(StorageError::Validation(
      "relativePath must not have leading or trailing whitespace".into(),
    ));
  }
  if trimmed.starts_with('/') || trimmed.starts_with('\\') {
    return Err(StorageError::Validation("relativePath must not be absolute".into()));
  }
  if trimmed.starts_with("//") {
    return Err(StorageError::Validation(
      "relativePath must not contain an authority".into(),
    ));
  }
  if trimmed.contains("://") {
    return Err(StorageError::Validation(
      "relativePath must not contain a scheme".into(),
    ));
  }
  if trimmed.contains('#') {
    return Err(StorageError::Validation(
      "relativePath must not contain a fragment".into(),
    ));
  }
  if trimmed.split('/').any(|seg| seg == "..") {
    return Err(StorageError::Validation(
      "relativePath must not contain parent traversal".into(),
    ));
  }
  Ok(())
}

fn validate_caller_name(name: &str, kind: &str) -> Result<(), StorageError> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err(StorageError::Validation(format!("{kind} name must not be empty")));
  }
  if trimmed != name {
    return Err(StorageError::Validation(format!(
      "{kind} name must not have leading or trailing whitespace"
    )));
  }
  if !trimmed
    .bytes()
    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
  {
    return Err(StorageError::Validation(format!("{kind} name must be an ASCII token")));
  }
  Ok(())
}

fn is_blocked_header(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  BLOCKED_HEADER_NAMES.contains(&lower.as_str())
}

fn value_looks_like_secret_key(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  matches!(
    lower.as_str(),
    "authorization" | "proxy-authorization" | "x-api-key" | "cookie" | "api_key" | "apikey" | "access_token"
  )
}

fn reject_if_auth_name(name: &str, auth_scheme: &AuthSchemeV1, kind: &str) -> Result<(), StorageError> {
  let lower = name.to_ascii_lowercase();
  match auth_scheme {
    AuthSchemeV1::Header { name: auth_name, .. } if kind == "header" => {
      if lower == auth_name.to_ascii_lowercase() {
        return Err(StorageError::Validation(format!(
          "caller header '{name}' conflicts with configured auth scheme"
        )));
      }
    }
    AuthSchemeV1::Query { name: auth_name, .. } if kind == "query" => {
      if lower == auth_name.to_ascii_lowercase() {
        return Err(StorageError::Validation(format!(
          "caller query '{name}' conflicts with configured auth scheme"
        )));
      }
    }
    _ => {}
  }
  Ok(())
}

fn reject_insecure_http_if_needed(base_url: &str, confirmed_at: Option<&str>) -> Result<(), StorageError> {
  let url = url::Url::parse(base_url).map_err(|e| StorageError::Validation(format!("invalid base URL: {e}")))?;
  if url.scheme() == "https" {
    return Ok(());
  }
  if url.scheme() != "http" {
    return Err(StorageError::Validation(format!(
      "unsupported base URL scheme: {}",
      url.scheme()
    )));
  }
  let host = url.host_str().unwrap_or("");
  if is_loopback_host(host) {
    return Ok(());
  }
  if confirmed_at.is_none() {
    return Err(StorageError::Validation(
      "non-loopback HTTP requires insecure_http_confirmed_at".into(),
    ));
  }
  Ok(())
}

fn is_loopback_host(host: &str) -> bool {
  host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

/// Build endpoint under the provider Base URL; preserve path prefixes.
pub fn build_endpoint(base_url: &str, relative: &str) -> Result<url::Url, StorageError> {
  let trimmed = base_url.trim();
  if trimmed.is_empty() {
    return Err(StorageError::Validation("base URL is required".into()));
  }
  let mut base = url::Url::parse(trimmed).map_err(|e| StorageError::Validation(format!("invalid base URL: {e}")))?;
  if base.cannot_be_a_base() {
    return Err(StorageError::Validation("base URL cannot be a base".into()));
  }
  let path = base.path();
  if !path.ends_with('/') {
    let mut with_slash = path.to_string();
    with_slash.push('/');
    base.set_path(&with_slash);
  }
  base
    .join(relative)
    .map_err(|e| StorageError::Validation(format!("invalid relative path: {e}")))
}

fn append_query_pairs(url: &mut url::Url, pairs: &[(String, String)]) -> Result<(), StorageError> {
  if pairs.is_empty() {
    return Ok(());
  }
  {
    let mut query = url.query_pairs_mut();
    for (name, value) in pairs {
      query.append_pair(name, value);
    }
  }
  Ok(())
}

fn load_secret_for_scheme(
  vault: &dyn CredentialVault,
  provider: &ProviderInstance,
) -> Result<Option<String>, StorageError> {
  match &provider.auth_scheme {
    AuthSchemeV1::None { .. } => Ok(None),
    AuthSchemeV1::Bearer { .. } | AuthSchemeV1::Header { .. } | AuthSchemeV1::Query { .. } => {
      let Some(credential_ref) = provider.credential_ref.as_ref() else {
        return Err(StorageError::Validation(
          "credential is required for this auth scheme".into(),
        ));
      };
      match vault.get_for_backend_use(credential_ref) {
        Ok(secret) => {
          if secret.is_empty() {
            return Err(StorageError::Validation("stored credential is empty".into()));
          }
          Ok(Some(secret))
        }
        Err(StorageError::CredentialUnavailable) | Err(StorageError::CredentialAccess) => {
          Err(StorageError::CredentialUnavailable)
        }
        Err(other) => Err(other),
      }
    }
  }
}

fn inject_auth(
  url: &mut url::Url,
  headers: &mut HashMap<String, String>,
  auth_scheme: &AuthSchemeV1,
  secret: Option<&str>,
) -> Result<(), StorageError> {
  inject_auth_headers_only(headers, auth_scheme, secret)?;
  apply_query_auth(url, auth_scheme, secret)?;
  Ok(())
}

fn inject_auth_headers_only(
  headers: &mut HashMap<String, String>,
  auth_scheme: &AuthSchemeV1,
  secret: Option<&str>,
) -> Result<(), StorageError> {
  match auth_scheme {
    AuthSchemeV1::None { .. } => Ok(()),
    AuthSchemeV1::Bearer { .. } => {
      let secret = secret.ok_or_else(|| StorageError::Validation("credential is required".into()))?;
      headers.insert("Authorization".into(), format!("Bearer {secret}"));
      Ok(())
    }
    AuthSchemeV1::Header { name, .. } => {
      let secret = secret.ok_or_else(|| StorageError::Validation("credential is required".into()))?;
      headers.insert(name.clone(), secret.to_string());
      Ok(())
    }
    AuthSchemeV1::Query { .. } => Ok(()),
  }
}

fn apply_query_auth(url: &mut url::Url, auth_scheme: &AuthSchemeV1, secret: Option<&str>) -> Result<(), StorageError> {
  match auth_scheme {
    AuthSchemeV1::Query { name, .. } => {
      let secret = secret.ok_or_else(|| StorageError::Validation("credential is required".into()))?;
      url.query_pairs_mut().append_pair(name, secret);
      Ok(())
    }
    _ => Ok(()),
  }
}

async fn with_cancel<T, F>(cancel: Option<&CancelToken>, work: F) -> Result<T, StorageError>
where
  F: Future<Output = Result<T, StorageError>>,
{
  let Some(token) = cancel else {
    return work.await;
  };
  if token.is_cancelled() {
    return Err(StorageError::Validation("request cancelled".into()));
  }
  tokio::select! {
    biased;
    _ = token.cancelled() => Err(StorageError::Validation("request cancelled".into())),
    result = work => result,
  }
}

struct ReqwestRawHttpTransport;

impl RawHttpTransport for ReqwestRawHttpTransport {
  fn request(
    &self,
    prepared: PreparedProviderRequest,
  ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, StorageError>> + Send + '_>> {
    Box::pin(async move { execute_request(prepared).await })
  }

  fn stream(
    &self,
    prepared: PreparedProviderRequest,
    cancel: CancelToken,
    on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
    Box::pin(async move { execute_stream(prepared, cancel, on_event).await })
  }
}

async fn execute_request(prepared: PreparedProviderRequest) -> Result<ProviderHttpResponse, StorageError> {
  let client = client_for(prepared.proxy_mode)?;
  let mut builder = match prepared.method {
    ProviderHttpMethod::Get => client.get(prepared.url.clone()),
    ProviderHttpMethod::Post => client.post(prepared.url.clone()),
  };
  for (name, value) in &prepared.headers {
    builder = builder.header(name, value);
  }
  if let Some(body) = &prepared.body {
    builder = builder
      .header(reqwest::header::CONTENT_TYPE, "application/json")
      .body(body.clone());
  }

  let response = builder.send().await.map_err(map_reqwest_error)?;
  let status = response.status().as_u16();
  let headers = extract_response_headers(response.headers());
  let body_bytes = read_response_body_bounded(response).await?;
  let body = String::from_utf8(body_bytes)
    .map_err(|_| StorageError::Validation("provider response body is not valid UTF-8".into()))?;
  // Never log secret-bearing URL.
  log::debug!("provider_http_request status={status} body_len={}", body.len());
  Ok(ProviderHttpResponse { status, headers, body })
}

async fn execute_stream(
  prepared: PreparedProviderRequest,
  cancel: CancelToken,
  on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
) -> Result<(), StorageError> {
  if cancel.is_cancelled() {
    return Err(StorageError::Validation("request cancelled".into()));
  }
  let client = stream_client_for(prepared.proxy_mode)?;
  let mut builder = match prepared.method {
    ProviderHttpMethod::Get => client.get(prepared.url.clone()),
    ProviderHttpMethod::Post => client.post(prepared.url.clone()),
  };
  for (name, value) in &prepared.headers {
    builder = builder.header(name, value);
  }
  if let Some(body) = &prepared.body {
    builder = builder
      .header(reqwest::header::CONTENT_TYPE, "application/json")
      .body(body.clone());
  }

  let response = tokio::select! {
    biased;
    _ = cancel.cancelled() => return Err(StorageError::Validation("request cancelled".into())),
    result = builder.send() => result.map_err(map_reqwest_error)?,
  };

  let status = response.status().as_u16();
  let headers = extract_response_headers(response.headers());
  on_event(ProviderHttpStreamEvent::Started { status, headers })?;

  let mut response = response;
  let mut total_bytes = 0usize;
  loop {
    if cancel.is_cancelled() {
      return Err(StorageError::Validation("request cancelled".into()));
    }
    let next = tokio::select! {
      biased;
      _ = cancel.cancelled() => return Err(StorageError::Validation("request cancelled".into())),
      chunk = tokio::time::timeout(STREAM_IDLE_TIMEOUT, response.chunk()) => chunk,
    };
    match next {
      Ok(Ok(Some(chunk))) => {
        total_bytes = total_bytes.saturating_add(chunk.len());
        if total_bytes > MAX_STREAM_TOTAL_BYTES {
          return Err(StorageError::Validation("stream exceeded byte cap".into()));
        }
        on_event(ProviderHttpStreamEvent::Chunk { bytes: chunk.to_vec() })?;
      }
      Ok(Ok(None)) => break,
      Ok(Err(err)) => return Err(map_reqwest_error(err)),
      Err(_) => return Err(StorageError::Validation("stream idle timeout".into())),
    }
  }
  on_event(ProviderHttpStreamEvent::Finished)?;
  Ok(())
}

fn extract_response_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
  let mut out = HashMap::new();
  for name in ["content-type", "retry-after"] {
    if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
      out.insert(name.to_string(), value.to_string());
    }
  }
  out
}

async fn read_response_body_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, StorageError> {
  if let Some(declared) = response.content_length() {
    if declared > MAX_RESPONSE_BODY_BYTES as u64 {
      return Err(StorageError::Validation("response body exceeds size limit".into()));
    }
  }
  let mut body = Vec::new();
  loop {
    match response.chunk().await {
      Ok(Some(chunk)) => {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
          return Err(StorageError::Validation("response body exceeds size limit".into()));
        }
        body.extend_from_slice(&chunk);
      }
      Ok(None) => break,
      Err(e) => return Err(map_reqwest_error(e)),
    }
  }
  Ok(body)
}

fn client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  match mode {
    ProxyMode::Inherit => {
      if INHERIT_CLIENT.get().is_none() {
        let client = reqwest::Client::builder()
          .timeout(REQUEST_TIMEOUT)
          .connect_timeout(REQUEST_TIMEOUT)
          .redirect(reqwest::redirect::Policy::none())
          .build()
          .map_err(|_| StorageError::Internal("failed to build HTTP client".into()))?;
        let _ = INHERIT_CLIENT.set(client);
      }
      INHERIT_CLIENT
        .get()
        .ok_or_else(|| StorageError::Internal("HTTP client unavailable".into()))
    }
    ProxyMode::Direct => {
      if DIRECT_CLIENT.get().is_none() {
        let client = reqwest::Client::builder()
          .timeout(REQUEST_TIMEOUT)
          .connect_timeout(REQUEST_TIMEOUT)
          .no_proxy()
          .redirect(reqwest::redirect::Policy::none())
          .build()
          .map_err(|_| StorageError::Internal("failed to build HTTP client".into()))?;
        let _ = DIRECT_CLIENT.set(client);
      }
      DIRECT_CLIENT
        .get()
        .ok_or_else(|| StorageError::Internal("HTTP client unavailable".into()))
    }
  }
}

fn stream_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  match mode {
    ProxyMode::Inherit => {
      if STREAM_INHERIT_CLIENT.get().is_none() {
        let client = reqwest::Client::builder()
          .connect_timeout(STREAM_CONNECT_TIMEOUT)
          .redirect(reqwest::redirect::Policy::none())
          .build()
          .map_err(|_| StorageError::Internal("failed to build stream HTTP client".into()))?;
        let _ = STREAM_INHERIT_CLIENT.set(client);
      }
      STREAM_INHERIT_CLIENT
        .get()
        .ok_or_else(|| StorageError::Internal("stream HTTP client unavailable".into()))
    }
    ProxyMode::Direct => {
      if STREAM_DIRECT_CLIENT.get().is_none() {
        let client = reqwest::Client::builder()
          .connect_timeout(STREAM_CONNECT_TIMEOUT)
          .no_proxy()
          .redirect(reqwest::redirect::Policy::none())
          .build()
          .map_err(|_| StorageError::Internal("failed to build stream HTTP client".into()))?;
        let _ = STREAM_DIRECT_CLIENT.set(client);
      }
      STREAM_DIRECT_CLIENT
        .get()
        .ok_or_else(|| StorageError::Internal("stream HTTP client unavailable".into()))
    }
  }
}

fn map_reqwest_error(err: reqwest::Error) -> StorageError {
  if err.is_timeout() {
    return StorageError::Validation("request timed out".into());
  }
  if err.is_connect() || err.is_request() {
    return StorageError::Validation("network request failed".into());
  }
  StorageError::Validation("network request failed".into())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::AuthSchemeV1;

  #[test]
  fn provider_http_request_rejects_absolute_and_traversal_paths() {
    assert!(validate_relative_path("models").is_ok());
    assert!(validate_relative_path("/models").is_err());
    assert!(validate_relative_path("../secret").is_err());
    assert!(validate_relative_path("https://evil.example/models").is_err());
    assert!(validate_relative_path("models#frag").is_err());
  }

  #[test]
  fn provider_http_request_build_endpoint_preserves_prefix() {
    let url = build_endpoint("https://api.example.com/v1", "models").unwrap();
    assert_eq!(url.as_str(), "https://api.example.com/v1/models");
  }

  #[test]
  fn provider_http_request_blocks_sensitive_headers() {
    let auth = AuthSchemeV1::bearer();
    let mut wire = ProviderWireRequest {
      method: ProviderHttpMethod::Get,
      relative_path: "models".into(),
      query: vec![],
      headers: HashMap::from([("Authorization".into(), "Bearer x".into())]),
      body: None,
    };
    assert!(validate_wire(&wire, &auth).is_err());
    wire.headers.clear();
    wire.headers.insert("X-Custom".into(), "1".into());
    assert!(validate_wire(&wire, &auth).is_ok());
  }
}
