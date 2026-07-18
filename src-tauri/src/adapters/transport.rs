// ABOUTME: Async HTTP transport for model-list sync and chat completion (stream + non-stream).
// ABOUTME: Applies authentication, proxy, pagination, SSE parsing, and bounded secret-free errors.
use crate::domain::cancel::CancelToken;
use crate::domain::model::RemoteModelSyncItem;
use crate::domain::provider::{CredentialKind, ProxyMode};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

/// Total request timeout for model-list and non-streaming chat completions.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Connect-only timeout for streaming chat (no overall read deadline — chunks arrive over time).
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Max silence between stream body chunks before treating the connection as stalled.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PAGES: usize = 100;
const MAX_MODEL_KEY_LEN: usize = 256;
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Max serialized Gemini remote metadata JSON stored per model.
const MAX_REMOTE_METADATA_BYTES: usize = 2048;
const MAX_GEMINI_METHODS: usize = 32;
const MAX_GEMINI_METHOD_LEN: usize = 128;
/// Hard cap on a single model-list response body (bytes, after decompression).
const MAX_RESPONSE_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Hard cap on models accepted from a single page.
const MAX_MODELS_PER_PAGE: usize = 500;
/// Hard cap on unique models collected across all pages of one sync.
const MAX_TOTAL_MODELS: usize = 2_000;
/// Hard cap on accumulated streamed assistant text (chars).
const MAX_STREAM_CONTENT_CHARS: usize = 200_000;
/// Cap on in-flight SSE line buffer while reading a stream.
const MAX_SSE_BUFFER_BYTES: usize = 512 * 1024;

static INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
/// Streaming clients omit the overall request timeout so long translations keep receiving chunks.
static STREAM_INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static STREAM_DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Owned request data so the async future does not borrow form or vault state.
/// Secrets are never printed via Debug.
#[derive(Clone)]
pub struct ModelListRequest {
  pub adapter_id: String,
  pub base_url: String,
  pub credential_kind: CredentialKind,
  pub secret: Option<String>,
  pub proxy_mode: ProxyMode,
}

impl std::fmt::Debug for ModelListRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ModelListRequest")
      .field("adapter_id", &self.adapter_id)
      .field("base_url", &self.base_url)
      .field("credential_kind", &self.credential_kind)
      .field("secret", &self.secret.as_ref().map(|_| "[redacted]"))
      .field("proxy_mode", &self.proxy_mode)
      .finish()
  }
}

/// Bounded transport failure codes used by test/sync result DTOs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
  Auth,
  RateLimited,
  Network,
  Timeout,
  Server,
  InvalidResponse,
  /// User or UI aborted the in-flight request.
  Cancelled,
}

impl TransportError {
  pub fn code(self) -> &'static str {
    match self {
      Self::Auth => "auth",
      Self::RateLimited => "rate_limited",
      Self::Network => "network",
      Self::Timeout => "timeout",
      Self::Server => "server",
      Self::InvalidResponse => "invalid_response",
      Self::Cancelled => "cancelled",
    }
  }

  fn message(self) -> &'static str {
    match self {
      Self::Auth => "Authentication failed",
      Self::RateLimited => "Provider rate limit exceeded",
      Self::Network => "Network request failed",
      Self::Timeout => "Request timed out",
      Self::Server => "Provider server error",
      Self::InvalidResponse => "Invalid provider response",
      Self::Cancelled => "Request cancelled",
    }
  }
}

impl std::fmt::Display for TransportError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.message())
  }
}

impl std::error::Error for TransportError {}

/// Injectable model-list transport. Production uses real HTTP; tests inject a queue.
pub trait ModelTransport: Send + Sync {
  fn list_models(
    &self,
    request: ModelListRequest,
  ) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>>;
}

/// Production transport backed by shared reqwest clients.
#[derive(Debug, Default, Clone, Copy)]
pub struct HttpModelTransport;

impl ModelTransport for HttpModelTransport {
  fn list_models(
    &self,
    request: ModelListRequest,
  ) -> Pin<Box<dyn Future<Output = Result<Vec<RemoteModelSyncItem>, TransportError>> + Send + '_>> {
    Box::pin(async move { list_models_http(request).await })
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
  Inherit,
  Direct,
}

/// Pure mapping from saved proxy mode to client kind.
pub fn client_kind_for_proxy(mode: ProxyMode) -> ClientKind {
  match mode {
    ProxyMode::Inherit => ClientKind::Inherit,
    ProxyMode::Direct => ClientKind::Direct,
  }
}

fn build_inherit_client() -> Result<reqwest::Client, TransportError> {
  reqwest::Client::builder()
    .timeout(REQUEST_TIMEOUT)
    .build()
    .map_err(|_| TransportError::Network)
}

fn build_direct_client() -> Result<reqwest::Client, TransportError> {
  reqwest::Client::builder()
    .timeout(REQUEST_TIMEOUT)
    .no_proxy()
    .build()
    .map_err(|_| TransportError::Network)
}

fn client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, TransportError> {
  match client_kind_for_proxy(mode) {
    ClientKind::Inherit => {
      if INHERIT_CLIENT.get().is_none() {
        let client = build_inherit_client()?;
        let _ = INHERIT_CLIENT.set(client);
      }
      INHERIT_CLIENT.get().ok_or(TransportError::Network)
    }
    ClientKind::Direct => {
      if DIRECT_CLIENT.get().is_none() {
        let client = build_direct_client()?;
        let _ = DIRECT_CLIENT.set(client);
      }
      DIRECT_CLIENT.get().ok_or(TransportError::Network)
    }
  }
}

fn build_stream_inherit_client() -> Result<reqwest::Client, TransportError> {
  // No overall `.timeout()`: streaming bodies can exceed 20s while chunks keep arriving.
  reqwest::Client::builder()
    .connect_timeout(STREAM_CONNECT_TIMEOUT)
    .build()
    .map_err(|_| TransportError::Network)
}

fn build_stream_direct_client() -> Result<reqwest::Client, TransportError> {
  reqwest::Client::builder()
    .connect_timeout(STREAM_CONNECT_TIMEOUT)
    .no_proxy()
    .build()
    .map_err(|_| TransportError::Network)
}

/// Client for streaming chat completions only (connect timeout, no total read deadline).
fn stream_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, TransportError> {
  match client_kind_for_proxy(mode) {
    ClientKind::Inherit => {
      if STREAM_INHERIT_CLIENT.get().is_none() {
        let client = build_stream_inherit_client()?;
        let _ = STREAM_INHERIT_CLIENT.set(client);
      }
      STREAM_INHERIT_CLIENT.get().ok_or(TransportError::Network)
    }
    ClientKind::Direct => {
      if STREAM_DIRECT_CLIENT.get().is_none() {
        let client = build_stream_direct_client()?;
        let _ = STREAM_DIRECT_CLIENT.set(client);
      }
      STREAM_DIRECT_CLIENT.get().ok_or(TransportError::Network)
    }
  }
}

/// Race an async HTTP operation against cooperative cancellation.
async fn with_cancel<T, F>(cancel: Option<&CancelToken>, work: F) -> Result<T, TransportError>
where
  F: Future<Output = Result<T, TransportError>>,
{
  let Some(token) = cancel else {
    return work.await;
  };
  if token.is_cancelled() {
    return Err(TransportError::Cancelled);
  }
  tokio::select! {
    biased;
    _ = token.cancelled() => Err(TransportError::Cancelled),
    result = work => result,
  }
}

/// Wait for the next stream body read, aborting on cancel or idle silence between chunks.
///
/// Cancel is preferred over idle timeout (`biased` select). Elapsed idle maps to
/// [`TransportError::Timeout`] so fallback chains treat it like other model failures.
async fn await_with_idle_timeout<T, F>(
  work: F,
  idle_timeout: Duration,
  cancel: Option<&CancelToken>,
) -> Result<T, TransportError>
where
  F: Future<Output = Result<T, reqwest::Error>>,
{
  if cancel.is_some_and(|t| t.is_cancelled()) {
    return Err(TransportError::Cancelled);
  }

  let timed = tokio::time::timeout(idle_timeout, work);

  let result = if let Some(token) = cancel {
    tokio::select! {
      biased;
      _ = token.cancelled() => return Err(TransportError::Cancelled),
      result = timed => result,
    }
  } else {
    timed.await
  };

  match result {
    Ok(Ok(value)) => Ok(value),
    Ok(Err(err)) => Err(map_reqwest_error(err)),
    Err(_elapsed) => Err(TransportError::Timeout),
  }
}

/// Sanitize base URL and join a relative path without dropping existing path segments.
pub fn build_endpoint(base_url: &str, relative: &str) -> Result<url::Url, TransportError> {
  let trimmed = base_url.trim();
  if trimmed.is_empty() {
    return Err(TransportError::InvalidResponse);
  }
  let mut base = url::Url::parse(trimmed).map_err(|_| TransportError::InvalidResponse)?;
  if base.cannot_be_a_base() {
    return Err(TransportError::InvalidResponse);
  }
  let path = base.path();
  if !path.ends_with('/') {
    let mut with_slash = path.to_string();
    with_slash.push('/');
    base.set_path(&with_slash);
  }
  base.join(relative).map_err(|_| TransportError::InvalidResponse)
}

fn models_path_for_adapter(adapter_id: &str) -> Result<&'static str, TransportError> {
  match adapter_id {
    "openai-compatible" | "openai-responses" => Ok("models"),
    "anthropic" => Ok("v1/models"),
    "gemini" => Ok("v1beta/models"),
    _ => Err(TransportError::InvalidResponse),
  }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPage {
  pub items: Vec<RemoteModelSyncItem>,
  pub continuation: Option<String>,
}

/// Pure OpenAI models page parser: `{ data: [{ id }] }`.
pub fn parse_openai_page(value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
  let data = value
    .get("data")
    .and_then(|v| v.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  if data.len() > MAX_MODELS_PER_PAGE {
    return Err(TransportError::InvalidResponse);
  }
  let mut items = Vec::with_capacity(data.len());
  for entry in data {
    let id = entry
      .get("id")
      .and_then(|v| v.as_str())
      .ok_or(TransportError::InvalidResponse)?;
    let model_key = normalize_model_key(id)?;
    items.push(RemoteModelSyncItem {
      model_key,
      remote_display_name: None,
      remote_metadata_json: None,
    });
  }
  Ok(ParsedPage {
    items,
    continuation: None,
  })
}

/// Pure Anthropic models page parser.
///
/// Official list/pagination shape: `{ data: [...], has_more, first_id, last_id }`.
/// Empty `data` is valid (including the empty-list case).
///
/// Field semantics (missing / null / string / wrong type):
/// - `has_more`: must be a boolean. Missing, null, or wrong type → `invalid_response`
///   (never treated as end-of-pagination).
/// - `first_id`: missing or null allowed; string allowed (unused for continuation);
///   wrong type → `invalid_response`.
/// - `last_id`: missing or null allowed only when `has_more` is false; wrong type always
///   → `invalid_response`. When `has_more` is true, `last_id` must be a non-empty string
///   (null / missing / `""` → `invalid_response`).
pub fn parse_anthropic_page(value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
  let data = value
    .get("data")
    .and_then(|v| v.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  if data.len() > MAX_MODELS_PER_PAGE {
    return Err(TransportError::InvalidResponse);
  }
  let mut items = Vec::with_capacity(data.len());
  for entry in data {
    let id = entry
      .get("id")
      .and_then(|v| v.as_str())
      .ok_or(TransportError::InvalidResponse)?;
    let model_key = normalize_model_key(id)?;
    let remote_display_name = entry
      .get("display_name")
      .and_then(|v| v.as_str())
      .map(|s| s.to_string());
    items.push(RemoteModelSyncItem {
      model_key,
      remote_display_name,
      remote_metadata_json: None,
    });
  }
  let has_more = match value.get("has_more") {
    Some(v) => v.as_bool().ok_or(TransportError::InvalidResponse)?,
    None => return Err(TransportError::InvalidResponse),
  };
  // Type-check cursor fields even when unused for continuation.
  let _first_id = parse_anthropic_id_field(value.get("first_id"))?;
  let last_id = parse_anthropic_id_field(value.get("last_id"))?;
  let continuation = if has_more {
    let last_id = last_id
      .filter(|s| !s.is_empty())
      .ok_or(TransportError::InvalidResponse)?;
    Some(last_id)
  } else {
    None
  };
  Ok(ParsedPage { items, continuation })
}

/// Parse Anthropic `first_id` / `last_id`: missing or null → None; string → Some; else invalid.
fn parse_anthropic_id_field(value: Option<&serde_json::Value>) -> Result<Option<String>, TransportError> {
  match value {
    None | Some(serde_json::Value::Null) => Ok(None),
    Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
    // Present but wrong type (number, object, array, bool) must not be coerced.
    Some(_) => Err(TransportError::InvalidResponse),
  }
}

/// Pure Gemini models page parser.
///
/// When `nextPageToken` is present it must be a non-object string (or null to end).
/// A present but wrong-type token is `invalid_response`, not end-of-pagination.
pub fn parse_gemini_page(value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
  let models = value
    .get("models")
    .and_then(|v| v.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  if models.len() > MAX_MODELS_PER_PAGE {
    return Err(TransportError::InvalidResponse);
  }
  let mut items = Vec::with_capacity(models.len());
  for entry in models {
    let name = entry
      .get("name")
      .and_then(|v| v.as_str())
      .ok_or(TransportError::InvalidResponse)?;
    let stripped = name.strip_prefix("models/").unwrap_or(name);
    let model_key = normalize_model_key(stripped)?;
    let remote_display_name = entry.get("displayName").and_then(|v| v.as_str()).map(|s| s.to_string());
    let remote_metadata_json = bound_gemini_metadata(entry)?;
    items.push(RemoteModelSyncItem {
      model_key,
      remote_display_name,
      remote_metadata_json,
    });
  }
  let continuation = parse_gemini_next_page_token(value.get("nextPageToken"))?;
  Ok(ParsedPage { items, continuation })
}

fn parse_gemini_next_page_token(token: Option<&serde_json::Value>) -> Result<Option<String>, TransportError> {
  match token {
    None | Some(serde_json::Value::Null) => Ok(None),
    Some(serde_json::Value::String(s)) => {
      if s.is_empty() {
        Ok(None)
      } else {
        Ok(Some(s.clone()))
      }
    }
    // Present but wrong type — never treat as end of pagination.
    Some(_) => Err(TransportError::InvalidResponse),
  }
}

/// Bound Gemini metadata to a small list of string method names.
fn bound_gemini_metadata(entry: &serde_json::Value) -> Result<Option<serde_json::Value>, TransportError> {
  let Some(methods_val) = entry.get("supportedGenerationMethods") else {
    return Ok(None);
  };
  if methods_val.is_null() {
    return Ok(None);
  }
  let methods = methods_val.as_array().ok_or(TransportError::InvalidResponse)?;
  if methods.len() > MAX_GEMINI_METHODS {
    return Err(TransportError::InvalidResponse);
  }
  let mut out: Vec<String> = Vec::with_capacity(methods.len());
  for method in methods {
    let s = method.as_str().ok_or(TransportError::InvalidResponse)?;
    if s.is_empty() || s.len() > MAX_GEMINI_METHOD_LEN {
      return Err(TransportError::InvalidResponse);
    }
    out.push(s.to_string());
  }
  let meta = serde_json::json!({ "supportedGenerationMethods": out });
  let serialized = serde_json::to_vec(&meta).map_err(|_| TransportError::InvalidResponse)?;
  if serialized.len() > MAX_REMOTE_METADATA_BYTES {
    return Err(TransportError::InvalidResponse);
  }
  Ok(Some(meta))
}

fn normalize_model_key(raw: &str) -> Result<String, TransportError> {
  let key = raw.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(TransportError::InvalidResponse);
  }
  Ok(key.to_string())
}

fn parse_page(adapter_id: &str, value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
  match adapter_id {
    "openai-compatible" | "openai-responses" => parse_openai_page(value),
    "anthropic" => parse_anthropic_page(value),
    "gemini" => parse_gemini_page(value),
    _ => Err(TransportError::InvalidResponse),
  }
}

/// Deduplicate remote items by model_key, keeping the first occurrence.
/// Production paging dedupes incrementally; this helper remains for unit tests.
#[cfg(test)]
fn dedupe_by_model_key(items: Vec<RemoteModelSyncItem>) -> Vec<RemoteModelSyncItem> {
  let mut seen = HashSet::new();
  let mut out = Vec::with_capacity(items.len());
  for item in items {
    if seen.insert(item.model_key.clone()) {
      out.push(item);
    }
  }
  out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthApplication {
  None,
  BearerHeader,
  AnthropicHeaders,
  GeminiQueryKey,
}

/// Pure auth strategy for adapter + credential kind (does not inspect secret values).
pub fn auth_application(adapter_id: &str, credential_kind: CredentialKind) -> Result<AuthApplication, TransportError> {
  match adapter_id {
    "openai-compatible" | "openai-responses" => match credential_kind {
      CredentialKind::None => Ok(AuthApplication::None),
      CredentialKind::ApiKey | CredentialKind::Bearer => Ok(AuthApplication::BearerHeader),
    },
    "anthropic" => Ok(AuthApplication::AnthropicHeaders),
    "gemini" => Ok(AuthApplication::GeminiQueryKey),
    _ => Err(TransportError::InvalidResponse),
  }
}

/// Build the final request URL (Gemini may append `key`; never log the result).
fn prepare_request_url(
  endpoint: &url::Url,
  adapter_id: &str,
  credential_kind: CredentialKind,
  secret: Option<&str>,
  continuation: Option<&str>,
) -> Result<url::Url, TransportError> {
  let mut url = endpoint.clone();
  if let Some(cursor) = continuation {
    match adapter_id {
      "anthropic" => {
        url.query_pairs_mut().append_pair("after_id", cursor);
      }
      "gemini" => {
        url.query_pairs_mut().append_pair("pageToken", cursor);
      }
      _ => return Err(TransportError::InvalidResponse),
    }
  }
  if matches!(
    auth_application(adapter_id, credential_kind)?,
    AuthApplication::GeminiQueryKey
  ) {
    let secret = secret.ok_or(TransportError::Auth)?;
    url.query_pairs_mut().append_pair("key", secret);
  }
  Ok(url)
}

fn apply_headers(
  builder: reqwest::RequestBuilder,
  adapter_id: &str,
  credential_kind: CredentialKind,
  secret: Option<&str>,
) -> Result<reqwest::RequestBuilder, TransportError> {
  match auth_application(adapter_id, credential_kind)? {
    AuthApplication::None | AuthApplication::GeminiQueryKey => Ok(builder),
    AuthApplication::BearerHeader => {
      let secret = secret.ok_or(TransportError::Auth)?;
      Ok(builder.header(reqwest::header::AUTHORIZATION, format!("Bearer {secret}")))
    }
    AuthApplication::AnthropicHeaders => {
      let secret = secret.ok_or(TransportError::Auth)?;
      Ok(
        builder
          .header("x-api-key", secret)
          .header("anthropic-version", ANTHROPIC_VERSION),
      )
    }
  }
}

fn map_status(status: reqwest::StatusCode) -> Result<(), TransportError> {
  if status.is_success() {
    return Ok(());
  }
  match status.as_u16() {
    401 | 403 => Err(TransportError::Auth),
    429 => Err(TransportError::RateLimited),
    500..=599 => Err(TransportError::Server),
    _ => Err(TransportError::InvalidResponse),
  }
}

fn map_reqwest_error(err: reqwest::Error) -> TransportError {
  if err.is_timeout() {
    return TransportError::Timeout;
  }
  if err.is_connect() || err.is_request() {
    return TransportError::Network;
  }
  if err.is_decode() || err.is_body() {
    return TransportError::InvalidResponse;
  }
  // Status errors are handled via response.status(); remaining failures are network-class.
  TransportError::Network
}

fn log_transport_error(adapter_id: &str, err: TransportError) {
  // Only adapter id and bounded code — never secrets, URLs with query, or bodies.
  // External request failures are expected operational conditions, not internal faults.
  log::warn!("model_transport_error adapter_id={adapter_id} code={}", err.code());
}

/// Debug-only: log the outbound chat JSON body (no URL / credentials).
fn log_chat_request_body(adapter_id: &str, stream: bool, body: &serde_json::Value) {
  log::debug!("chat_request adapter_id={adapter_id} stream={stream} body={body}");
}

/// Debug-only: log the inbound chat response payload (no URL / credentials).
fn log_chat_response_body(adapter_id: &str, stream: bool, body: &str) {
  log::debug!("chat_response adapter_id={adapter_id} stream={stream} body={body}");
}

/// Read a response body with a hard size cap, streaming chunks (no full `bytes()` first).
///
/// Rejects immediately when `Content-Length` declares more than `MAX_RESPONSE_BODY_BYTES`.
/// For chunked / missing-length responses, aborts as soon as cumulative bytes exceed the cap
/// so oversized bodies never fully buffer.
async fn read_response_body_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, TransportError> {
  if let Some(declared) = response.content_length() {
    if declared > MAX_RESPONSE_BODY_BYTES as u64 {
      return Err(TransportError::InvalidResponse);
    }
  }

  let mut body = Vec::new();
  if let Some(declared) = response.content_length() {
    // declared is already known to fit the cap.
    body.reserve(declared as usize);
  }

  loop {
    match response.chunk().await {
      Ok(Some(chunk)) => {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
          // Drop the response without reading further; connection closes on drop.
          return Err(TransportError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
      }
      Ok(None) => break,
      Err(e) => return Err(map_reqwest_error(e)),
    }
  }
  Ok(body)
}

async fn list_models_http(request: ModelListRequest) -> Result<Vec<RemoteModelSyncItem>, TransportError> {
  let relative = models_path_for_adapter(&request.adapter_id)?;
  let endpoint = build_endpoint(&request.base_url, relative)?;
  let client = client_for(request.proxy_mode)?;

  let mut all = Vec::new();
  let mut seen_keys: HashSet<String> = HashSet::new();
  let mut continuation: Option<String> = None;
  let mut seen_cursors: HashSet<String> = HashSet::new();
  let mut pages = 0usize;

  loop {
    pages += 1;
    if pages > MAX_PAGES {
      let err = TransportError::InvalidResponse;
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }

    if let Some(cursor) = &continuation {
      if !seen_cursors.insert(cursor.clone()) {
        let err = TransportError::InvalidResponse;
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    }

    let request_url = match prepare_request_url(
      &endpoint,
      &request.adapter_id,
      request.credential_kind,
      request.secret.as_deref(),
      continuation.as_deref(),
    ) {
      Ok(u) => u,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    // Never log request_url: Gemini embeds the API key in the query string.
    let builder = client.get(request_url);
    let builder = match apply_headers(
      builder,
      &request.adapter_id,
      request.credential_kind,
      request.secret.as_deref(),
    ) {
      Ok(b) => b,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    let response = match builder.send().await {
      Ok(resp) => resp,
      Err(e) => {
        let err = map_reqwest_error(e);
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    if let Err(err) = map_status(response.status()) {
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }

    // Stream body with a hard 2 MiB cap (chunked or Content-Length); never full-buffer first.
    let body = match read_response_body_bounded(response).await {
      Ok(b) => b,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };
    let value: serde_json::Value = match serde_json::from_slice(&body) {
      Ok(v) => v,
      Err(_) => {
        let err = TransportError::InvalidResponse;
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    let page = match parse_page(&request.adapter_id, &value) {
      Ok(p) => p,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    // Incremental dedupe and total-model cap while paging.
    for item in page.items {
      if !seen_keys.insert(item.model_key.clone()) {
        continue;
      }
      if all.len() >= MAX_TOTAL_MODELS {
        let err = TransportError::InvalidResponse;
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
      all.push(item);
    }

    match page.continuation {
      None => break,
      Some(next) => {
        continuation = Some(next);
      }
    }
  }

  Ok(all)
}

// ---------------------------------------------------------------------------
// Chat completion (non-streaming) — reuses auth, proxy clients, and error mapping
// ---------------------------------------------------------------------------

/// Owned chat-completion request. Secrets are never printed via Debug.
#[derive(Clone)]
pub struct ChatCompletionRequest {
  pub adapter_id: String,
  pub base_url: String,
  pub credential_kind: CredentialKind,
  pub secret: Option<String>,
  pub proxy_mode: ProxyMode,
  pub model_key: String,
  pub system_prompt: String,
  pub user_prompt: String,
  pub temperature: Option<f64>,
  pub max_tokens: Option<u32>,
  /// OpenAI-compatible thinking toggle (`thinking.type` = enabled/disabled).
  ///
  /// Used by DeepSeek V4-style providers. `None` leaves the provider default
  /// (DeepSeek defaults thinking to enabled). Never sent for other adapters.
  pub thinking: Option<bool>,
}

impl std::fmt::Debug for ChatCompletionRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ChatCompletionRequest")
      .field("adapter_id", &self.adapter_id)
      .field("base_url", &self.base_url)
      .field("credential_kind", &self.credential_kind)
      .field("secret", &self.secret.as_ref().map(|_| "[redacted]"))
      .field("proxy_mode", &self.proxy_mode)
      .field("model_key", &self.model_key)
      .field("temperature", &self.temperature)
      .field("max_tokens", &self.max_tokens)
      .field("thinking", &self.thinking)
      .finish_non_exhaustive()
  }
}

/// Apply DeepSeek-style `thinking` control to an OpenAI-compatible chat payload.
fn apply_openai_thinking(payload: &mut serde_json::Value, thinking: Option<bool>) {
  if let Some(enabled) = thinking {
    payload["thinking"] = serde_json::json!({
      "type": if enabled { "enabled" } else { "disabled" }
    });
  }
}

/// Non-streaming chat completion result (content only; no full provider payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCompletionResult {
  pub content: String,
}

/// Call a provider chat/completions-style endpoint using the same auth and proxy path as model list.
pub async fn chat_completion_http(request: ChatCompletionRequest) -> Result<ChatCompletionResult, TransportError> {
  chat_completion_http_cancellable(request, None).await
}

/// Non-streaming chat completion with optional cooperative cancellation.
pub async fn chat_completion_http_cancellable(
  request: ChatCompletionRequest,
  cancel: Option<&CancelToken>,
) -> Result<ChatCompletionResult, TransportError> {
  with_cancel(cancel, chat_completion_http_inner(request)).await
}

async fn chat_completion_http_inner(request: ChatCompletionRequest) -> Result<ChatCompletionResult, TransportError> {
  let client = client_for(request.proxy_mode)?;
  let (url, body) = match request.adapter_id.as_str() {
    "openai-compatible" => {
      let url = build_endpoint(&request.base_url, "chat/completions")?;
      let mut payload = serde_json::json!({
        "model": request.model_key,
        "messages": [
          { "role": "system", "content": request.system_prompt },
          { "role": "user", "content": request.user_prompt }
        ],
        "stream": false
      });
      if let Some(temp) = request.temperature {
        payload["temperature"] = serde_json::json!(temp);
      }
      if let Some(max) = request.max_tokens {
        payload["max_tokens"] = serde_json::json!(max);
      }
      apply_openai_thinking(&mut payload, request.thinking);
      (url, payload)
    }
    "openai-responses" => {
      let url = build_endpoint(&request.base_url, "responses")?;
      let mut payload = serde_json::json!({
        "model": request.model_key,
        "instructions": request.system_prompt,
        "input": request.user_prompt,
        "stream": false
      });
      if let Some(temp) = request.temperature {
        payload["temperature"] = serde_json::json!(temp);
      }
      if let Some(max) = request.max_tokens {
        payload["max_output_tokens"] = serde_json::json!(max);
      }
      (url, payload)
    }
    "anthropic" => {
      let url = build_endpoint(&request.base_url, "v1/messages")?;
      let mut payload = serde_json::json!({
        "model": request.model_key,
        "system": request.system_prompt,
        "messages": [
          { "role": "user", "content": request.user_prompt }
        ],
        "max_tokens": request.max_tokens.unwrap_or(32768)
      });
      if let Some(temp) = request.temperature {
        payload["temperature"] = serde_json::json!(temp);
      }
      (url, payload)
    }
    "gemini" => {
      let model_path = gemini_generate_path(&request.model_key)?;
      let url = build_endpoint(&request.base_url, &model_path)?;
      let mut generation_config = serde_json::Map::new();
      if let Some(temp) = request.temperature {
        generation_config.insert("temperature".into(), serde_json::json!(temp));
      }
      if let Some(max) = request.max_tokens {
        generation_config.insert("maxOutputTokens".into(), serde_json::json!(max));
      }
      let mut payload = serde_json::json!({
        "systemInstruction": {
          "parts": [{ "text": request.system_prompt }]
        },
        "contents": [{
          "role": "user",
          "parts": [{ "text": request.user_prompt }]
        }]
      });
      if !generation_config.is_empty() {
        payload["generationConfig"] = serde_json::Value::Object(generation_config);
      }
      (url, payload)
    }
    _ => return Err(TransportError::InvalidResponse),
  };

  let request_url = match prepare_request_url(
    &url,
    &request.adapter_id,
    request.credential_kind,
    request.secret.as_deref(),
    None,
  ) {
    Ok(u) => u,
    Err(err) => {
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }
  };

  // Never log request_url: Gemini embeds the API key in the query string.
  log_chat_request_body(&request.adapter_id, false, &body);
  let builder = client.post(request_url).json(&body);
  let builder = match apply_headers(
    builder,
    &request.adapter_id,
    request.credential_kind,
    request.secret.as_deref(),
  ) {
    Ok(b) => b,
    Err(err) => {
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }
  };

  let response = match builder.send().await {
    Ok(resp) => resp,
    Err(e) => {
      let err = map_reqwest_error(e);
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }
  };

  let status = response.status();
  let body_bytes = match read_response_body_bounded(response).await {
    Ok(b) => b,
    Err(err) => {
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }
  };
  let body_text = String::from_utf8_lossy(&body_bytes);
  log_chat_response_body(&request.adapter_id, false, &body_text);

  if let Err(err) = map_status(status) {
    log_transport_error(&request.adapter_id, err);
    return Err(err);
  }

  let value: serde_json::Value = match serde_json::from_slice(&body_bytes) {
    Ok(v) => v,
    Err(_) => {
      let err = TransportError::InvalidResponse;
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }
  };

  let content = match parse_chat_content(&request.adapter_id, &value) {
    Ok(c) => c,
    Err(err) => {
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }
  };

  Ok(ChatCompletionResult { content })
}

/// Build Gemini generateContent relative path from a stored model key.
///
/// Remote list returns keys like `models/gemini-2.0-flash` or bare `gemini-2.0-flash`.
fn gemini_generate_path(model_key: &str) -> Result<String, TransportError> {
  let key = model_key.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(TransportError::InvalidResponse);
  }
  if key.contains("://") || key.contains('?') || key.contains('#') {
    return Err(TransportError::InvalidResponse);
  }
  let resource = if key.starts_with("models/") {
    key.to_string()
  } else {
    format!("models/{key}")
  };
  Ok(format!("v1beta/{resource}:generateContent"))
}

/// Extract assistant text from a provider chat response (no full body retained).
pub fn parse_chat_content(adapter_id: &str, value: &serde_json::Value) -> Result<String, TransportError> {
  match adapter_id {
    "openai-compatible" => parse_openai_chat_content(value),
    "openai-responses" => parse_openai_responses_content(value),
    "anthropic" => parse_anthropic_message_content(value),
    "gemini" => parse_gemini_generate_content(value),
    _ => Err(TransportError::InvalidResponse),
  }
}

fn parse_openai_chat_content(value: &serde_json::Value) -> Result<String, TransportError> {
  // Final answer is always `message.content`. Thinking providers (DeepSeek) may also
  // populate sibling `reasoning_content` with chain-of-thought; that is never the answer.
  let message = value
    .get("choices")
    .and_then(|c| c.as_array())
    .and_then(|arr| arr.first())
    .and_then(|choice| choice.get("message"))
    .ok_or(TransportError::InvalidResponse)?;
  let content = match message.get("content") {
    None => return Err(TransportError::InvalidResponse),
    // Null content is treated like empty — common while only reasoning was produced.
    Some(serde_json::Value::Null) => "",
    Some(v) => v.as_str().ok_or(TransportError::InvalidResponse)?,
  };
  let trimmed = content.trim();
  if trimmed.is_empty() {
    // Complete non-stream response with no final answer (e.g. max_tokens spent on
    // reasoning_content). Not a mid-stream wait state — nothing more will arrive.
    return Err(TransportError::InvalidResponse);
  }
  Ok(trimmed.to_string())
}

fn parse_openai_responses_content(value: &serde_json::Value) -> Result<String, TransportError> {
  // Prefer convenience field when present.
  if let Some(text) = value.get("output_text").and_then(|v| v.as_str()) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_string());
    }
  }
  let output = value
    .get("output")
    .and_then(|v| v.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  let mut parts = Vec::new();
  for item in output {
    let content = item.get("content").and_then(|c| c.as_array());
    let Some(content) = content else {
      continue;
    };
    for block in content {
      let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
      if block_type == "output_text" || block_type == "text" {
        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
          if !text.is_empty() {
            parts.push(text);
          }
        }
      }
    }
  }
  let joined = parts.join("");
  let trimmed = joined.trim();
  if trimmed.is_empty() {
    return Err(TransportError::InvalidResponse);
  }
  Ok(trimmed.to_string())
}

fn parse_anthropic_message_content(value: &serde_json::Value) -> Result<String, TransportError> {
  let content = value
    .get("content")
    .and_then(|c| c.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  let mut parts = Vec::new();
  for block in content {
    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("text");
    if block_type == "text" {
      if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
        if !text.is_empty() {
          parts.push(text);
        }
      }
    }
  }
  let joined = parts.join("");
  let trimmed = joined.trim();
  if trimmed.is_empty() {
    return Err(TransportError::InvalidResponse);
  }
  Ok(trimmed.to_string())
}

fn parse_gemini_generate_content(value: &serde_json::Value) -> Result<String, TransportError> {
  let parts = value
    .get("candidates")
    .and_then(|c| c.as_array())
    .and_then(|arr| arr.first())
    .and_then(|cand| cand.get("content"))
    .and_then(|c| c.get("parts"))
    .and_then(|p| p.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  let mut texts = Vec::new();
  for part in parts {
    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
      if !text.is_empty() {
        texts.push(text);
      }
    }
  }
  let joined = texts.join("");
  let trimmed = joined.trim();
  if trimmed.is_empty() {
    return Err(TransportError::InvalidResponse);
  }
  Ok(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// Chat completion (streaming) — SSE / streamGenerateContent
// ---------------------------------------------------------------------------

/// Build Gemini streamGenerateContent relative path from a stored model key.
fn gemini_stream_generate_path(model_key: &str) -> Result<String, TransportError> {
  let key = model_key.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(TransportError::InvalidResponse);
  }
  if key.contains("://") || key.contains('?') || key.contains('#') {
    return Err(TransportError::InvalidResponse);
  }
  let resource = if key.starts_with("models/") {
    key.to_string()
  } else {
    format!("models/{key}")
  };
  Ok(format!("v1beta/{resource}:streamGenerateContent"))
}

/// Build request URL + JSON body for a streaming chat completion (all adapters).
fn build_stream_request_parts(
  request: &ChatCompletionRequest,
) -> Result<(url::Url, serde_json::Value), TransportError> {
  match request.adapter_id.as_str() {
    "openai-compatible" => {
      let url = build_endpoint(&request.base_url, "chat/completions")?;
      let mut payload = serde_json::json!({
        "model": request.model_key,
        "messages": [
          { "role": "system", "content": request.system_prompt },
          { "role": "user", "content": request.user_prompt }
        ],
        "stream": true
      });
      if let Some(temp) = request.temperature {
        payload["temperature"] = serde_json::json!(temp);
      }
      if let Some(max) = request.max_tokens {
        payload["max_tokens"] = serde_json::json!(max);
      }
      apply_openai_thinking(&mut payload, request.thinking);
      Ok((url, payload))
    }
    "openai-responses" => {
      let url = build_endpoint(&request.base_url, "responses")?;
      let mut payload = serde_json::json!({
        "model": request.model_key,
        "instructions": request.system_prompt,
        "input": request.user_prompt,
        "stream": true
      });
      if let Some(temp) = request.temperature {
        payload["temperature"] = serde_json::json!(temp);
      }
      if let Some(max) = request.max_tokens {
        payload["max_output_tokens"] = serde_json::json!(max);
      }
      Ok((url, payload))
    }
    "anthropic" => {
      let url = build_endpoint(&request.base_url, "v1/messages")?;
      let mut payload = serde_json::json!({
        "model": request.model_key,
        "system": request.system_prompt,
        "messages": [
          { "role": "user", "content": request.user_prompt }
        ],
        "max_tokens": request.max_tokens.unwrap_or(32768),
        "stream": true
      });
      if let Some(temp) = request.temperature {
        payload["temperature"] = serde_json::json!(temp);
      }
      Ok((url, payload))
    }
    "gemini" => {
      let model_path = gemini_stream_generate_path(&request.model_key)?;
      let url = build_endpoint(&request.base_url, &model_path)?;
      let mut generation_config = serde_json::Map::new();
      if let Some(temp) = request.temperature {
        generation_config.insert("temperature".into(), serde_json::json!(temp));
      }
      if let Some(max) = request.max_tokens {
        generation_config.insert("maxOutputTokens".into(), serde_json::json!(max));
      }
      let mut payload = serde_json::json!({
        "systemInstruction": {
          "parts": [{ "text": request.system_prompt }]
        },
        "contents": [{
          "role": "user",
          "parts": [{ "text": request.user_prompt }]
        }]
      });
      if !generation_config.is_empty() {
        payload["generationConfig"] = serde_json::Value::Object(generation_config);
      }
      Ok((url, payload))
    }
    _ => Err(TransportError::InvalidResponse),
  }
}

/// Extract a text delta from one SSE `data:` payload for the given adapter.
///
/// Returns `Ok(Some(delta))` for content, `Ok(None)` for keep-alive / non-text events,
/// and `Err` only for malformed JSON that claims to be a content payload we cannot skip.
pub fn parse_sse_data_delta(
  adapter_id: &str,
  event_name: Option<&str>,
  data: &str,
) -> Result<Option<String>, TransportError> {
  let trimmed = data.trim();
  if trimmed.is_empty() || trimmed == "[DONE]" {
    return Ok(None);
  }
  let value: serde_json::Value = match serde_json::from_str(trimmed) {
    Ok(v) => v,
    // Non-JSON data frames are ignored (comments / keep-alives).
    Err(_) => return Ok(None),
  };
  match adapter_id {
    "openai-compatible" => Ok(parse_openai_stream_delta(&value)),
    "openai-responses" => Ok(parse_openai_responses_stream_delta(event_name, &value)),
    "anthropic" => Ok(parse_anthropic_stream_delta(event_name, &value)),
    "gemini" => Ok(parse_gemini_stream_delta(&value)),
    _ => Err(TransportError::InvalidResponse),
  }
}

/// OpenAI chat.completions stream chunk: `choices[0].delta.content`.
///
/// Thinking-mode providers (DeepSeek and compatible relays) stream CoT first via
/// `delta.reasoning_content` while `content` is null, absent, or empty. Those chunks
/// are skipped so the consumer keeps waiting for later final-answer deltas.
/// `reasoning_content` is never surfaced as user-visible text.
pub fn parse_openai_stream_delta(value: &serde_json::Value) -> Option<String> {
  let delta = value
    .get("choices")
    .and_then(|c| c.as_array())
    .and_then(|arr| arr.first())
    .and_then(|choice| choice.get("delta"))?;
  let content = match delta.get("content") {
    Some(serde_json::Value::String(s)) => s.as_str(),
    // null / missing / non-string → wait for subsequent chunks
    _ => return None,
  };
  if content.is_empty() {
    None
  } else {
    Some(content.to_string())
  }
}

/// OpenAI Responses API stream: prefer `response.output_text.delta` payloads.
fn parse_openai_responses_stream_delta(event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
  let ty = value.get("type").and_then(|t| t.as_str()).or(event_name).unwrap_or("");
  if ty == "response.output_text.delta" || ty.ends_with("output_text.delta") {
    if let Some(delta) = value.get("delta").and_then(|d| d.as_str()) {
      if !delta.is_empty() {
        return Some(delta.to_string());
      }
    }
  }
  // Some gateways nest text under delta.as object.
  if let Some(text) = value.get("delta").and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
    if !text.is_empty() {
      return Some(text.to_string());
    }
  }
  None
}

/// Anthropic Messages stream: `content_block_delta` with `delta.text`.
fn parse_anthropic_stream_delta(event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
  let ty = value.get("type").and_then(|t| t.as_str()).or(event_name).unwrap_or("");
  if ty != "content_block_delta" {
    return None;
  }
  let delta = value.get("delta")?;
  let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("text_delta");
  if delta_type != "text_delta" && delta_type != "text" {
    return None;
  }
  let text = delta.get("text").and_then(|t| t.as_str())?;
  if text.is_empty() {
    None
  } else {
    Some(text.to_string())
  }
}

/// Gemini streamGenerateContent (SSE) chunk — same shape as non-stream generateContent.
fn parse_gemini_stream_delta(value: &serde_json::Value) -> Option<String> {
  let parts = value
    .get("candidates")
    .and_then(|c| c.as_array())
    .and_then(|arr| arr.first())
    .and_then(|cand| cand.get("content"))
    .and_then(|c| c.get("parts"))
    .and_then(|p| p.as_array())?;
  let mut texts = Vec::new();
  for part in parts {
    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
      if !text.is_empty() {
        texts.push(text);
      }
    }
  }
  if texts.is_empty() {
    None
  } else {
    Some(texts.join(""))
  }
}

/// Feed one complete SSE event (joined data lines) through the adapter delta parser.
fn dispatch_sse_event(
  adapter_id: &str,
  event_name: Option<&str>,
  data: &str,
  full: &mut String,
  on_delta: &mut dyn FnMut(&str),
) -> Result<(), TransportError> {
  if let Some(delta) = parse_sse_data_delta(adapter_id, event_name, data)? {
    if full.chars().count().saturating_add(delta.chars().count()) > MAX_STREAM_CONTENT_CHARS {
      return Err(TransportError::InvalidResponse);
    }
    full.push_str(&delta);
    on_delta(&delta);
  }
  Ok(())
}

/// Parse an SSE byte stream, invoking `on_delta` for each text fragment.
///
/// Each body read is bounded by [`STREAM_IDLE_TIMEOUT`]; prolonged silence is a timeout
/// (fallback-eligible). Cooperative cancel still wins over idle timeout.
async fn consume_sse_stream(
  mut response: reqwest::Response,
  adapter_id: &str,
  mut on_delta: impl FnMut(&str),
  cancel: Option<&CancelToken>,
) -> Result<String, TransportError> {
  let mut raw_buf: Vec<u8> = Vec::new();
  let mut carry = String::new();
  let mut event_name: Option<String> = None;
  let mut data_lines: Vec<String> = Vec::new();
  let mut full = String::new();

  loop {
    // Idle timeout between chunks; cancel preferred inside await_with_idle_timeout.
    let chunk = match await_with_idle_timeout(response.chunk(), STREAM_IDLE_TIMEOUT, cancel).await {
      Ok(Some(c)) => c,
      Ok(None) => break,
      Err(e) => return Err(e),
    };
    if raw_buf.len().saturating_add(chunk.len()) > MAX_SSE_BUFFER_BYTES.saturating_mul(4) {
      // Absolute safety: drop if the entire unread stream is absurdly large.
      return Err(TransportError::InvalidResponse);
    }
    raw_buf.extend_from_slice(&chunk);
    // Decode incrementally; invalid UTF-8 mid-chunk waits for more bytes.
    let Ok(text) = std::str::from_utf8(&raw_buf) else {
      if raw_buf.len() > MAX_SSE_BUFFER_BYTES {
        return Err(TransportError::InvalidResponse);
      }
      continue;
    };
    carry.push_str(text);
    raw_buf.clear();

    while let Some(nl) = carry.find('\n') {
      let mut line = carry[..nl].to_string();
      carry = carry[nl + 1..].to_string();
      if line.ends_with('\r') {
        line.pop();
      }
      if line.is_empty() {
        if !data_lines.is_empty() {
          let data = data_lines.join("\n");
          data_lines.clear();
          let name = event_name.take();
          dispatch_sse_event(adapter_id, name.as_deref(), &data, &mut full, &mut on_delta)?;
        } else {
          event_name = None;
        }
        continue;
      }
      if line.starts_with(':') {
        // SSE comment / keep-alive
        continue;
      }
      if let Some(rest) = line.strip_prefix("event:") {
        event_name = Some(rest.trim().to_string());
        continue;
      }
      if let Some(rest) = line.strip_prefix("data:") {
        // Spec allows optional single leading space after the colon.
        let payload = if let Some(stripped) = rest.strip_prefix(' ') {
          stripped
        } else {
          rest
        };
        data_lines.push(payload.to_string());
        continue;
      }
      // Ignore id:/retry: and unknown fields.
    }

    if carry.len() > MAX_SSE_BUFFER_BYTES {
      return Err(TransportError::InvalidResponse);
    }
  }

  // Flush trailing event without final blank line.
  if !data_lines.is_empty() {
    let data = data_lines.join("\n");
    let name = event_name.take();
    dispatch_sse_event(adapter_id, name.as_deref(), &data, &mut full, &mut on_delta)?;
  } else if !carry.trim().is_empty() {
    // Lone data line without trailing newline.
    if let Some(rest) = carry.strip_prefix("data:") {
      let payload = rest.strip_prefix(' ').unwrap_or(rest);
      dispatch_sse_event(adapter_id, event_name.as_deref(), payload, &mut full, &mut on_delta)?;
    }
  }

  let trimmed = full.trim();
  if trimmed.is_empty() {
    return Err(TransportError::InvalidResponse);
  }
  Ok(trimmed.to_string())
}

/// Streaming chat completion: calls `on_delta` for each text fragment and returns full content.
pub async fn chat_completion_stream_http(
  request: ChatCompletionRequest,
  on_delta: impl FnMut(&str) + Send,
) -> Result<ChatCompletionResult, TransportError> {
  chat_completion_stream_http_cancellable(request, on_delta, None).await
}

/// Streaming chat completion with optional cooperative cancellation.
pub async fn chat_completion_stream_http_cancellable(
  request: ChatCompletionRequest,
  mut on_delta: impl FnMut(&str) + Send,
  cancel: Option<&CancelToken>,
) -> Result<ChatCompletionResult, TransportError> {
  if cancel.is_some_and(|t| t.is_cancelled()) {
    return Err(TransportError::Cancelled);
  }
  // Outer select drops the in-flight request when the UI cancels.
  with_cancel(cancel, async {
    let client = stream_client_for(request.proxy_mode)?;
    let (url, body) = match build_stream_request_parts(&request) {
      Ok(parts) => parts,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    let mut request_url = match prepare_request_url(
      &url,
      &request.adapter_id,
      request.credential_kind,
      request.secret.as_deref(),
      None,
    ) {
      Ok(u) => u,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    // Gemini official streaming uses alt=sse for Server-Sent Events framing.
    if request.adapter_id == "gemini" {
      request_url.query_pairs_mut().append_pair("alt", "sse");
    }

    // Never log request_url: Gemini embeds the API key in the query string.
    log_chat_request_body(&request.adapter_id, true, &body);
    let builder = client
      .post(request_url)
      .header(reqwest::header::ACCEPT, "text/event-stream")
      .json(&body);
    let builder = match apply_headers(
      builder,
      &request.adapter_id,
      request.credential_kind,
      request.secret.as_deref(),
    ) {
      Ok(b) => b,
      Err(err) => {
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    let response = match builder.send().await {
      Ok(resp) => resp,
      Err(e) => {
        let err = map_reqwest_error(e);
        log_transport_error(&request.adapter_id, err);
        return Err(err);
      }
    };

    let status = response.status();
    if let Err(err) = map_status(status) {
      // Error responses are typically JSON, not SSE — read as a bounded body for debug.
      match read_response_body_bounded(response).await {
        Ok(bytes) => {
          log_chat_response_body(&request.adapter_id, true, &String::from_utf8_lossy(&bytes));
        }
        Err(_) => {
          log::debug!(
            "chat_response adapter_id={} stream=true body=<unreadable status={}>",
            request.adapter_id,
            status.as_u16()
          );
        }
      }
      log_transport_error(&request.adapter_id, err);
      return Err(err);
    }

    match consume_sse_stream(response, &request.adapter_id, &mut on_delta, cancel).await {
      Ok(content) => {
        log_chat_response_body(&request.adapter_id, true, &content);
        Ok(ChatCompletionResult { content })
      }
      Err(err) => {
        if err != TransportError::Cancelled {
          log_transport_error(&request.adapter_id, err);
        }
        Err(err)
      }
    }
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::HashMap;
  use std::io::{Read, Write};
  use std::net::TcpListener;
  use std::sync::{Arc, Mutex};
  use std::thread;
  use std::time::Duration as StdDuration;

  #[derive(Clone)]
  struct CapturedRequest {
    path_and_query: String,
    headers: HashMap<String, String>,
  }

  /// How LocalServer frames the HTTP response body.
  #[derive(Clone, Copy)]
  enum BodyEncoding {
    /// `Content-Length` + full body in one write (default).
    ContentLength,
    /// `Transfer-Encoding: chunked` with no `Content-Length` (production oversize path).
    Chunked,
  }

  /// One-shot local HTTP responder for production-transport integration tests.
  struct LocalServer {
    base_url: String,
    captured: Arc<Mutex<Vec<CapturedRequest>>>,
    /// Payload bytes successfully written for chunked responses (excludes chunk size lines).
    body_bytes_written: Arc<Mutex<usize>>,
    /// True when a chunked write failed mid-stream (client closed early).
    client_write_failed: Arc<Mutex<bool>>,
    _join: Option<thread::JoinHandle<()>>,
  }

  impl LocalServer {
    fn spawn(responses: Vec<(u16, String)>) -> Self {
      Self::spawn_with_encoding(responses, BodyEncoding::ContentLength)
    }

    fn spawn_chunked(responses: Vec<(u16, String)>) -> Self {
      Self::spawn_with_encoding(responses, BodyEncoding::Chunked)
    }

    fn spawn_with_encoding(responses: Vec<(u16, String)>, encoding: BodyEncoding) -> Self {
      let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
      listener.set_nonblocking(false).expect("blocking accept");
      let addr = listener.local_addr().expect("addr");
      let captured = Arc::new(Mutex::new(Vec::new()));
      let captured_thread = captured.clone();
      let body_bytes_written = Arc::new(Mutex::new(0usize));
      let body_bytes_written_thread = body_bytes_written.clone();
      let client_write_failed = Arc::new(Mutex::new(false));
      let client_write_failed_thread = client_write_failed.clone();
      let join = thread::spawn(move || {
        for (status, body) in responses {
          let (mut stream, _) = match listener.accept() {
            Ok(pair) => pair,
            Err(_) => return,
          };
          let _ = stream.set_read_timeout(Some(StdDuration::from_secs(5)));
          let _ = stream.set_write_timeout(Some(StdDuration::from_secs(5)));
          let mut buf = vec![0u8; 16384];
          let mut total = 0usize;
          // Read until end of headers (or buffer full).
          loop {
            match stream.read(&mut buf[total..]) {
              Ok(0) => break,
              Ok(n) => {
                total += n;
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") || total >= buf.len() {
                  break;
                }
              }
              Err(_) => break,
            }
          }
          let request_text = String::from_utf8_lossy(&buf[..total]);
          let mut headers = HashMap::new();
          let mut path_and_query = String::new();
          for (i, line) in request_text.lines().enumerate() {
            if i == 0 {
              // "GET /path?q HTTP/1.1"
              let parts: Vec<&str> = line.split_whitespace().collect();
              if parts.len() >= 2 {
                path_and_query = parts[1].to_string();
              }
              continue;
            }
            if line.is_empty() {
              break;
            }
            if let Some((k, v)) = line.split_once(':') {
              headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
          }
          captured_thread.lock().expect("captured").push(CapturedRequest {
            path_and_query,
            headers,
          });
          match encoding {
            BodyEncoding::ContentLength => {
              let response = format!(
								"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
								body.len()
							);
              let _ = stream.write_all(response.as_bytes());
              let _ = stream.flush();
            }
            BodyEncoding::Chunked => {
              // No Content-Length: force the client streaming/chunk path.
              let header = format!(
								"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
							);
              if stream.write_all(header.as_bytes()).is_err() {
                *client_write_failed_thread.lock().expect("write failed") = true;
                continue;
              }
              // Write body as multiple small HTTP chunks so oversize aborts mid-stream.
              // Pace chunks so a client that stops reading after the 2 MiB cap closes
              // the socket before the full payload is accepted by write().
              const CHUNK: usize = 64 * 1024;
              let bytes = body.as_bytes();
              let mut offset = 0usize;
              while offset < bytes.len() {
                let end = (offset + CHUNK).min(bytes.len());
                let slice = &bytes[offset..end];
                let size_line = format!("{:x}\r\n", slice.len());
                if stream.write_all(size_line.as_bytes()).is_err() {
                  *client_write_failed_thread.lock().expect("write failed") = true;
                  break;
                }
                if stream.write_all(slice).is_err() {
                  *client_write_failed_thread.lock().expect("write failed") = true;
                  break;
                }
                if stream.write_all(b"\r\n").is_err() {
                  *client_write_failed_thread.lock().expect("write failed") = true;
                  break;
                }
                // Count only payload bytes successfully handed to the socket.
                *body_bytes_written_thread.lock().expect("bytes written") += slice.len();
                offset = end;
                // Give the client time to hit the cap and drop the connection.
                if body.len() > MAX_RESPONSE_BODY_BYTES {
                  let _ = stream.flush();
                  thread::sleep(StdDuration::from_millis(5));
                }
              }
              // Terminating chunk (best-effort; client may already have hung up).
              if offset >= bytes.len() {
                let _ = stream.write_all(b"0\r\n\r\n");
              }
              let _ = stream.flush();
            }
          }
        }
      });
      Self {
        base_url: format!("http://{addr}"),
        captured,
        body_bytes_written,
        client_write_failed,
        _join: Some(join),
      }
    }

    fn captured(&self) -> Vec<CapturedRequest> {
      self.captured.lock().expect("captured").clone()
    }

    fn body_bytes_written(&self) -> usize {
      *self.body_bytes_written.lock().expect("bytes written")
    }

    fn client_write_failed(&self) -> bool {
      *self.client_write_failed.lock().expect("write failed")
    }
  }

  fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
  }

  #[test]
  fn proxy_client_kind_mapping() {
    assert_eq!(client_kind_for_proxy(ProxyMode::Inherit), ClientKind::Inherit);
    assert_eq!(client_kind_for_proxy(ProxyMode::Direct), ClientKind::Direct);
  }

  #[test]
  fn direct_client_builder_uses_no_proxy() {
    // Construction succeeds; policy is enforced via .no_proxy() in build_direct_client.
    let client = build_direct_client().expect("direct client");
    let inherit = build_inherit_client().expect("inherit client");
    // Clients are distinct instances with shared timeout policy.
    let _ = (client, inherit);
  }

  #[test]
  fn stream_clients_build_without_total_timeout() {
    // Streaming clients use connect_timeout only so long responses are not cut at 20s.
    let inherit = build_stream_inherit_client().expect("stream inherit");
    let direct = build_stream_direct_client().expect("stream direct");
    let _ = (inherit, direct);
  }

  #[test]
  fn cancelled_error_code_is_stable() {
    assert_eq!(TransportError::Cancelled.code(), "cancelled");
    assert_eq!(TransportError::Cancelled.to_string(), "Request cancelled");
  }

  #[test]
  fn timeout_error_code_is_stable() {
    assert_eq!(TransportError::Timeout.code(), "timeout");
    assert_eq!(TransportError::Timeout.to_string(), "Request timed out");
  }

  #[test]
  fn with_cancel_none_runs_work() {
    let result = block_on(with_cancel(None, async { Ok::<_, TransportError>(42) }));
    assert_eq!(result.unwrap(), 42);
  }

  #[test]
  fn with_cancel_pre_cancelled_token() {
    let token = CancelToken::new();
    token.cancel();
    let result = block_on(with_cancel(Some(&token), async { Ok::<_, TransportError>(1) }));
    assert_eq!(result.unwrap_err(), TransportError::Cancelled);
  }

  #[test]
  fn await_with_idle_timeout_completes_before_deadline() {
    let result = block_on(await_with_idle_timeout(
      async { Ok::<_, reqwest::Error>(7_u32) },
      Duration::from_secs(5),
      None,
    ));
    assert_eq!(result, Ok(7));
  }

  #[test]
  fn await_with_idle_timeout_errors_on_silence() {
    // Pending future never yields; short idle window must surface Timeout.
    let result = block_on(await_with_idle_timeout(
      std::future::pending::<Result<(), reqwest::Error>>(),
      Duration::from_millis(40),
      None,
    ));
    assert_eq!(result, Err(TransportError::Timeout));
  }

  #[test]
  fn await_with_idle_timeout_pre_cancelled() {
    let token = CancelToken::new();
    token.cancel();
    let result = block_on(await_with_idle_timeout(
      std::future::pending::<Result<(), reqwest::Error>>(),
      Duration::from_secs(30),
      Some(&token),
    ));
    assert_eq!(result, Err(TransportError::Cancelled));
  }

  #[test]
  fn await_with_idle_timeout_cancel_beats_long_idle() {
    // Cancel mid-wait must win over a long idle deadline (not wait for 30s).
    let token = CancelToken::new();
    let token_for_task = token.clone();
    let result = block_on(async {
      let join = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(15)).await;
        token_for_task.cancel();
      });
      let outcome = await_with_idle_timeout(
        std::future::pending::<Result<(), reqwest::Error>>(),
        Duration::from_secs(30),
        Some(&token),
      )
      .await;
      let _ = join.await;
      outcome
    });
    assert_eq!(result, Err(TransportError::Cancelled));
  }

  #[test]
  fn parse_openai_chat_content_ok() {
    let value = serde_json::json!({
      "choices": [{ "message": { "role": "assistant", "content": "  Hello  " } }]
    });
    assert_eq!(parse_chat_content("openai-compatible", &value).unwrap(), "Hello");
  }

  #[test]
  fn parse_openai_chat_content_ignores_reasoning_and_rejects_empty_final() {
    // DeepSeek thinking complete response: CoT present, final answer empty.
    let only_reasoning = serde_json::json!({
      "choices": [{
        "finish_reason": "length",
        "message": {
          "role": "assistant",
          "content": "",
          "reasoning_content": "Thinking about the language of DeT..."
        }
      }]
    });
    assert_eq!(
      parse_chat_content("openai-compatible", &only_reasoning).unwrap_err(),
      TransportError::InvalidResponse
    );

    let null_content = serde_json::json!({
      "choices": [{
        "message": {
          "role": "assistant",
          "content": null,
          "reasoning_content": "still thinking"
        }
      }]
    });
    assert_eq!(
      parse_chat_content("openai-compatible", &null_content).unwrap_err(),
      TransportError::InvalidResponse
    );

    // Final answer still wins when both fields are present.
    let both = serde_json::json!({
      "choices": [{
        "message": {
          "role": "assistant",
          "content": "zh",
          "reasoning_content": "Looks like Chinese."
        }
      }]
    });
    assert_eq!(parse_chat_content("openai-compatible", &both).unwrap(), "zh");
  }

  #[test]
  fn parse_anthropic_and_gemini_chat_content() {
    let anthropic = serde_json::json!({
      "content": [{ "type": "text", "text": "Bonjour" }]
    });
    assert_eq!(parse_chat_content("anthropic", &anthropic).unwrap(), "Bonjour");

    let gemini = serde_json::json!({
      "candidates": [{ "content": { "parts": [{ "text": "Hola" }] } }]
    });
    assert_eq!(parse_chat_content("gemini", &gemini).unwrap(), "Hola");
  }

  #[test]
  fn parse_openai_sse_stream_delta() {
    let data = r#"{"choices":[{"delta":{"content":"Hel"},"index":0}]}"#;
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, data)
        .unwrap()
        .as_deref(),
      Some("Hel")
    );
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, "[DONE]")
        .unwrap()
        .as_deref(),
      None
    );
    // Empty delta content (role-only first chunk) is skipped.
    let role_only = r#"{"choices":[{"delta":{"role":"assistant"},"index":0}]}"#;
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, role_only)
        .unwrap()
        .as_deref(),
      None
    );
  }

  #[test]
  fn parse_openai_sse_skips_reasoning_and_empty_content_until_answer() {
    // DeepSeek thinking stream: reasoning-only chunks must not emit text or error.
    let reasoning_only = r#"{"choices":[{"delta":{"reasoning_content":"Let me think..."},"index":0}]}"#;
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, reasoning_only)
        .unwrap()
        .as_deref(),
      None
    );

    // content:null alongside reasoning — still wait.
    let null_content = r#"{"choices":[{"delta":{"content":null,"reasoning_content":"..."},"index":0}]}"#;
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, null_content)
        .unwrap()
        .as_deref(),
      None
    );

    // Empty string content — still wait.
    let empty_content = r#"{"choices":[{"delta":{"content":""},"index":0}]}"#;
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, empty_content)
        .unwrap()
        .as_deref(),
      None
    );

    // Final answer deltas still surface.
    let answer = r#"{"choices":[{"delta":{"content":"zh"},"index":0}]}"#;
    assert_eq!(
      parse_sse_data_delta("openai-compatible", None, answer)
        .unwrap()
        .as_deref(),
      Some("zh")
    );
  }

  #[test]
  fn parse_anthropic_sse_content_block_delta() {
    let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Bon"}}"#;
    assert_eq!(
      parse_sse_data_delta("anthropic", Some("content_block_delta"), data)
        .unwrap()
        .as_deref(),
      Some("Bon")
    );
    let message_start = r#"{"type":"message_start","message":{"id":"msg_1"}}"#;
    assert_eq!(
      parse_sse_data_delta("anthropic", Some("message_start"), message_start)
        .unwrap()
        .as_deref(),
      None
    );
  }

  #[test]
  fn parse_openai_responses_and_gemini_stream_deltas() {
    let responses = r#"{"type":"response.output_text.delta","delta":"Hi"}"#;
    assert_eq!(
      parse_sse_data_delta("openai-responses", Some("response.output_text.delta"), responses)
        .unwrap()
        .as_deref(),
      Some("Hi")
    );
    let gemini = serde_json::json!({
      "candidates": [{ "content": { "parts": [{ "text": "Hola" }] } }]
    });
    assert_eq!(
      parse_sse_data_delta("gemini", None, &gemini.to_string())
        .unwrap()
        .as_deref(),
      Some("Hola")
    );
  }

  #[test]
  fn openai_parse_items() {
    let value = serde_json::json!({
      "data": [
        {"id": "gpt-4o"},
        {"id": "gpt-4o-mini"}
      ]
    });
    let page = parse_openai_page(&value).unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].model_key, "gpt-4o");
    assert!(page.continuation.is_none());
  }

  #[test]
  fn openai_rejects_blank_id() {
    let value = serde_json::json!({"data": [{"id": "  "}]});
    assert_eq!(parse_openai_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn openai_rejects_missing_id() {
    let value = serde_json::json!({"data": [{"name": "x"}]});
    assert_eq!(parse_openai_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn anthropic_parse_display_name_and_continuation() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3", "display_name": "Claude 3"}],
      "has_more": true,
      "first_id": "claude-3",
      "last_id": "claude-3"
    });
    let page = parse_anthropic_page(&value).unwrap();
    assert_eq!(page.items[0].model_key, "claude-3");
    assert_eq!(page.items[0].remote_display_name.as_deref(), Some("Claude 3"));
    assert_eq!(page.continuation.as_deref(), Some("claude-3"));
  }

  #[test]
  fn anthropic_missing_cursor_when_has_more() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": true,
      "last_id": null
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_absent_last_id_when_has_more_is_invalid() {
    // Field missing entirely (not null) is still invalid when has_more is true.
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": true,
      "first_id": "claude-3"
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_empty_data_list_ok_when_done() {
    // Official empty-list: data=[], has_more=false, cursors null/absent.
    let value = serde_json::json!({
      "data": [],
      "has_more": false,
      "first_id": null,
      "last_id": null
    });
    let page = parse_anthropic_page(&value).unwrap();
    assert!(page.items.is_empty());
    assert!(page.continuation.is_none());
  }

  #[test]
  fn anthropic_null_has_more_is_invalid() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": null,
      "last_id": "claude-3"
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_missing_has_more_is_invalid() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "last_id": "claude-3"
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_wrong_type_has_more_is_invalid() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": "yes",
      "last_id": "claude-3"
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_no_continuation_when_done() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": false,
      "last_id": "claude-3"
    });
    let page = parse_anthropic_page(&value).unwrap();
    assert!(page.continuation.is_none());
  }

  #[test]
  fn anthropic_wrong_type_last_id_is_invalid() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": true,
      "first_id": "claude-3",
      "last_id": 42
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_wrong_type_first_id_is_invalid() {
    // first_id is not used for continuation, but wrong type must still fail.
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": false,
      "first_id": {"id": "claude-3"},
      "last_id": "claude-3"
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_null_first_and_last_id_ok_when_done() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": false,
      "first_id": null,
      "last_id": null
    });
    let page = parse_anthropic_page(&value).unwrap();
    assert!(page.continuation.is_none());
  }

  #[test]
  fn anthropic_missing_first_and_last_id_ok_when_done() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": false
    });
    let page = parse_anthropic_page(&value).unwrap();
    assert!(page.continuation.is_none());
  }

  #[test]
  fn anthropic_empty_last_id_when_has_more_is_invalid() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": true,
      "first_id": "claude-3",
      "last_id": ""
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn anthropic_bool_last_id_is_invalid() {
    let value = serde_json::json!({
      "data": [{"id": "claude-3"}],
      "has_more": false,
      "last_id": true
    });
    assert_eq!(
      parse_anthropic_page(&value).unwrap_err(),
      TransportError::InvalidResponse
    );
  }

  #[test]
  fn gemini_strips_models_prefix() {
    let value = serde_json::json!({
      "models": [{
        "name": "models/gemini-1.5-pro",
        "displayName": "Gemini 1.5 Pro",
        "supportedGenerationMethods": ["generateContent"]
      }],
      "nextPageToken": "tok-2"
    });
    let page = parse_gemini_page(&value).unwrap();
    assert_eq!(page.items[0].model_key, "gemini-1.5-pro");
    assert_eq!(page.items[0].remote_display_name.as_deref(), Some("Gemini 1.5 Pro"));
    assert_eq!(page.continuation.as_deref(), Some("tok-2"));
    assert!(page.items[0].remote_metadata_json.is_some());
  }

  #[test]
  fn gemini_wrong_type_next_page_token_is_invalid() {
    let value = serde_json::json!({
      "models": [{"name": "models/gemini-1.5-pro"}],
      "nextPageToken": 12345
    });
    assert_eq!(parse_gemini_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn gemini_null_next_page_token_ends_pagination() {
    let value = serde_json::json!({
      "models": [{"name": "models/gemini-1.5-pro"}],
      "nextPageToken": null
    });
    let page = parse_gemini_page(&value).unwrap();
    assert!(page.continuation.is_none());
  }

  #[test]
  fn gemini_metadata_rejects_non_string_methods() {
    let value = serde_json::json!({
      "models": [{
        "name": "models/gemini-1.5-pro",
        "supportedGenerationMethods": [{"method": "generateContent"}]
      }]
    });
    assert_eq!(parse_gemini_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn gemini_metadata_rejects_oversized_method_list() {
    let methods: Vec<String> = (0..MAX_GEMINI_METHODS + 1).map(|i| format!("m{i}")).collect();
    let value = serde_json::json!({
      "models": [{
        "name": "models/gemini-1.5-pro",
        "supportedGenerationMethods": methods
      }]
    });
    assert_eq!(parse_gemini_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn gemini_metadata_rejects_long_method_name() {
    let long = "x".repeat(MAX_GEMINI_METHOD_LEN + 1);
    let value = serde_json::json!({
      "models": [{
        "name": "models/gemini-1.5-pro",
        "supportedGenerationMethods": [long]
      }]
    });
    assert_eq!(parse_gemini_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn gemini_metadata_bounds_to_allowed_shape() {
    let value = serde_json::json!({
      "models": [{
        "name": "models/gemini-1.5-pro",
        "supportedGenerationMethods": ["generateContent", "countTokens"]
      }]
    });
    let page = parse_gemini_page(&value).unwrap();
    let meta = page.items[0].remote_metadata_json.as_ref().unwrap();
    assert_eq!(
      meta,
      &serde_json::json!({
        "supportedGenerationMethods": ["generateContent", "countTokens"]
      })
    );
    let bytes = serde_json::to_vec(meta).unwrap();
    assert!(bytes.len() <= MAX_REMOTE_METADATA_BYTES);
  }

  #[test]
  fn dedupe_across_pages() {
    let items = vec![
      RemoteModelSyncItem {
        model_key: "a".into(),
        remote_display_name: Some("A1".into()),
        remote_metadata_json: None,
      },
      RemoteModelSyncItem {
        model_key: "b".into(),
        remote_display_name: None,
        remote_metadata_json: None,
      },
      RemoteModelSyncItem {
        model_key: "a".into(),
        remote_display_name: Some("A2".into()),
        remote_metadata_json: None,
      },
    ];
    let out = dedupe_by_model_key(items);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].remote_display_name.as_deref(), Some("A1"));
  }

  #[test]
  fn endpoint_with_and_without_trailing_slash() {
    let a = build_endpoint("https://api.openai.com/v1", "models").unwrap();
    let b = build_endpoint("https://api.openai.com/v1/", "models").unwrap();
    assert_eq!(a.as_str(), "https://api.openai.com/v1/models");
    assert_eq!(b.as_str(), "https://api.openai.com/v1/models");
  }

  #[test]
  fn endpoint_preserves_custom_v1_path() {
    let url = build_endpoint("http://localhost:11434/v1", "models").unwrap();
    assert_eq!(url.as_str(), "http://localhost:11434/v1/models");
  }

  #[test]
  fn anthropic_and_gemini_endpoints() {
    let anthropic = build_endpoint("https://api.anthropic.com", "v1/models").unwrap();
    assert_eq!(anthropic.as_str(), "https://api.anthropic.com/v1/models");
    let gemini = build_endpoint("https://generativelanguage.googleapis.com", "v1beta/models").unwrap();
    assert_eq!(
      gemini.as_str(),
      "https://generativelanguage.googleapis.com/v1beta/models"
    );
  }

  #[test]
  fn auth_application_matrix() {
    assert_eq!(
      auth_application("openai-compatible", CredentialKind::None).unwrap(),
      AuthApplication::None
    );
    assert_eq!(
      auth_application("openai-responses", CredentialKind::ApiKey).unwrap(),
      AuthApplication::BearerHeader
    );
    assert_eq!(
      auth_application("anthropic", CredentialKind::ApiKey).unwrap(),
      AuthApplication::AnthropicHeaders
    );
    assert_eq!(
      auth_application("gemini", CredentialKind::ApiKey).unwrap(),
      AuthApplication::GeminiQueryKey
    );
  }

  #[test]
  fn transport_error_display_is_secret_free() {
    let secret = "sk-super-secret";
    for err in [
      TransportError::Auth,
      TransportError::RateLimited,
      TransportError::Network,
      TransportError::Timeout,
      TransportError::Server,
      TransportError::InvalidResponse,
    ] {
      let text = err.to_string();
      assert!(!text.contains(secret));
      assert!(!text.contains('?'));
      assert!(!err.code().contains("secret"));
    }
  }

  #[test]
  fn model_list_request_debug_redacts_secret() {
    let req = ModelListRequest {
      adapter_id: "openai-compatible".into(),
      base_url: "https://api.example.com/v1".into(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("sk-super-secret-value".into()),
      proxy_mode: ProxyMode::Inherit,
    };
    let debug = format!("{req:?}");
    assert!(!debug.contains("sk-super-secret-value"));
    assert!(debug.contains("[redacted]"));
  }

  #[test]
  fn status_mapping() {
    assert!(map_status(reqwest::StatusCode::OK).is_ok());
    assert_eq!(
      map_status(reqwest::StatusCode::UNAUTHORIZED).unwrap_err(),
      TransportError::Auth
    );
    assert_eq!(
      map_status(reqwest::StatusCode::FORBIDDEN).unwrap_err(),
      TransportError::Auth
    );
    assert_eq!(
      map_status(reqwest::StatusCode::TOO_MANY_REQUESTS).unwrap_err(),
      TransportError::RateLimited
    );
    assert_eq!(
      map_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR).unwrap_err(),
      TransportError::Server
    );
  }

  #[test]
  fn page_limit_constant() {
    assert_eq!(MAX_PAGES, 100);
  }

  #[test]
  fn response_and_model_limit_constants() {
    assert_eq!(MAX_RESPONSE_BODY_BYTES, 2 * 1024 * 1024);
    assert_eq!(MAX_MODELS_PER_PAGE, 500);
    assert_eq!(MAX_TOTAL_MODELS, 2_000);
  }

  #[test]
  fn openai_page_rejects_over_models_per_page() {
    let data: Vec<serde_json::Value> = (0..=MAX_MODELS_PER_PAGE)
      .map(|i| serde_json::json!({"id": format!("m-{i}")}))
      .collect();
    let value = serde_json::json!({ "data": data });
    assert_eq!(parse_openai_page(&value).unwrap_err(), TransportError::InvalidResponse);
  }

  #[test]
  fn model_key_length_limit() {
    let long = "x".repeat(MAX_MODEL_KEY_LEN + 1);
    assert!(normalize_model_key(&long).is_err());
    let ok = "x".repeat(MAX_MODEL_KEY_LEN);
    assert!(normalize_model_key(&ok).is_ok());
  }

  #[test]
  fn http_openai_no_authorization_header() {
    let body = serde_json::json!({"data": [{"id": "local-model"}]}).to_string();
    let server = LocalServer::spawn(vec![(200, body)]);
    let req = ModelListRequest {
      adapter_id: "openai-compatible".into(),
      base_url: format!("{}/v1", server.base_url),
      credential_kind: CredentialKind::None,
      secret: None,
      proxy_mode: ProxyMode::Direct,
    };
    let models = block_on(list_models_http(req)).expect("ok");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].model_key, "local-model");
    let captured = server.captured();
    assert_eq!(captured.len(), 1);
    assert!(!captured[0].headers.contains_key("authorization"));
    assert!(captured[0].path_and_query.contains("/v1/models"));
  }

  #[test]
  fn http_openai_sends_bearer_authorization() {
    let body = serde_json::json!({"data": [{"id": "gpt-x"}]}).to_string();
    let server = LocalServer::spawn(vec![(200, body)]);
    let req = ModelListRequest {
      adapter_id: "openai-compatible".into(),
      base_url: format!("{}/v1", server.base_url),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("sk-test-token".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let models = block_on(list_models_http(req)).expect("ok");
    assert_eq!(models[0].model_key, "gpt-x");
    let captured = server.captured();
    assert_eq!(
      captured[0].headers.get("authorization").map(String::as_str),
      Some("Bearer sk-test-token")
    );
  }

  #[test]
  fn http_anthropic_multi_page_and_headers() {
    let page1 = serde_json::json!({
      "data": [{"id": "claude-a", "display_name": "A"}],
      "has_more": true,
      "last_id": "claude-a"
    })
    .to_string();
    let page2 = serde_json::json!({
      "data": [{"id": "claude-b", "display_name": "B"}],
      "has_more": false,
      "last_id": "claude-b"
    })
    .to_string();
    let server = LocalServer::spawn(vec![(200, page1), (200, page2)]);
    let req = ModelListRequest {
      adapter_id: "anthropic".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("anth-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let models = block_on(list_models_http(req)).expect("ok");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model_key, "claude-a");
    assert_eq!(models[1].model_key, "claude-b");
    let captured = server.captured();
    assert_eq!(captured.len(), 2);
    assert_eq!(
      captured[0].headers.get("x-api-key").map(String::as_str),
      Some("anth-secret")
    );
    assert_eq!(
      captured[0].headers.get("anthropic-version").map(String::as_str),
      Some(ANTHROPIC_VERSION)
    );
    assert!(captured[1].path_and_query.contains("after_id=claude-a"));
  }

  #[test]
  fn http_gemini_multi_page_and_query_key() {
    let page1 = serde_json::json!({
      "models": [{"name": "models/g1", "supportedGenerationMethods": ["generateContent"]}],
      "nextPageToken": "page-2"
    })
    .to_string();
    let page2 = serde_json::json!({
      "models": [{"name": "models/g2"}],
      "nextPageToken": null
    })
    .to_string();
    let server = LocalServer::spawn(vec![(200, page1), (200, page2)]);
    let req = ModelListRequest {
      adapter_id: "gemini".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("gem-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let models = block_on(list_models_http(req)).expect("ok");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model_key, "g1");
    assert_eq!(models[1].model_key, "g2");
    let captured = server.captured();
    assert_eq!(captured.len(), 2);
    assert!(captured[0].path_and_query.contains("key=gem-secret"));
    assert!(captured[1].path_and_query.contains("pageToken=page-2"));
    assert!(captured[1].path_and_query.contains("key=gem-secret"));
    assert!(!captured[0].headers.contains_key("authorization"));
  }

  #[test]
  fn http_second_page_failure_returns_error() {
    let page1 = serde_json::json!({
      "data": [{"id": "claude-a"}],
      "has_more": true,
      "last_id": "claude-a"
    })
    .to_string();
    let server = LocalServer::spawn(vec![(200, page1), (500, "boom".into())]);
    let req = ModelListRequest {
      adapter_id: "anthropic".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("anth-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let err = block_on(list_models_http(req)).unwrap_err();
    assert_eq!(err, TransportError::Server);
    assert_eq!(server.captured().len(), 2);
  }

  #[test]
  fn http_repeated_cursor_rejected() {
    // Both pages return the same last_id with has_more true → second continuation repeats.
    let page = serde_json::json!({
      "data": [{"id": "claude-a"}],
      "has_more": true,
      "last_id": "same-cursor"
    })
    .to_string();
    let server = LocalServer::spawn(vec![(200, page.clone()), (200, page)]);
    let req = ModelListRequest {
      adapter_id: "anthropic".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("anth-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let err = block_on(list_models_http(req)).unwrap_err();
    assert_eq!(err, TransportError::InvalidResponse);
    // First page + second page with repeated cursor detected after second fetch attempt.
    assert!(server.captured().len() >= 2);
  }

  #[test]
  fn http_page_limit_rejects_after_max_pages() {
    // Always advance with a unique cursor so the page cap, not cursor repeat, fires.
    // Serve exactly MAX_PAGES responses; the client must reject before page MAX_PAGES+1.
    let mut responses = Vec::with_capacity(MAX_PAGES);
    for page_idx in 1..=MAX_PAGES {
      let body = serde_json::json!({
        "data": [{"id": format!("m-{page_idx}")}],
        "has_more": true,
        "first_id": format!("m-{page_idx}"),
        "last_id": format!("cursor-{page_idx}")
      })
      .to_string();
      responses.push((200u16, body));
    }
    let server = LocalServer::spawn(responses);
    let req = ModelListRequest {
      adapter_id: "anthropic".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("anth-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let err = block_on(list_models_http(req)).unwrap_err();
    assert_eq!(err, TransportError::InvalidResponse);
    // All MAX_PAGES responses were consumed; the next page was refused without another request.
    assert_eq!(server.captured().len(), MAX_PAGES);
  }

  #[test]
  fn http_oversized_response_body_is_invalid() {
    // Build a body larger than MAX_RESPONSE_BODY_BYTES via a long model id list.
    // Content-Length is set by LocalServer from body.len() — early-reject path.
    let mut data = Vec::new();
    // Each entry is small; pad with a huge string field to exceed the cap.
    let padding = "x".repeat(MAX_RESPONSE_BODY_BYTES + 1024);
    data.push(serde_json::json!({"id": "m1", "padding": padding}));
    let body = serde_json::json!({ "data": data }).to_string();
    assert!(body.len() > MAX_RESPONSE_BODY_BYTES);
    let server = LocalServer::spawn(vec![(200, body)]);
    let req = ModelListRequest {
      adapter_id: "openai-compatible".into(),
      base_url: format!("{}/v1", server.base_url),
      credential_kind: CredentialKind::None,
      secret: None,
      proxy_mode: ProxyMode::Direct,
    };
    let err = block_on(list_models_http(req)).unwrap_err();
    assert_eq!(err, TransportError::InvalidResponse);
  }

  #[test]
  fn http_oversized_chunked_body_without_content_length_is_invalid() {
    // Production path: Transfer-Encoding chunked, no Content-Length.
    // Streamed reader must abort once cumulative size exceeds 2 MiB (not after full buffer).
    // Prove mid-stream stop: server records payload bytes accepted / early write failure
    // rather than delivering the entire oversized body before the client checks the cap.
    let padding = "x".repeat(MAX_RESPONSE_BODY_BYTES + 512 * 1024);
    let body = serde_json::json!({ "data": [{"id": "m1", "padding": padding}] }).to_string();
    assert!(body.len() > MAX_RESPONSE_BODY_BYTES + 256 * 1024);
    let full_len = body.len();
    let server = LocalServer::spawn_chunked(vec![(200, body)]);
    let req = ModelListRequest {
      adapter_id: "openai-compatible".into(),
      base_url: format!("{}/v1", server.base_url),
      credential_kind: CredentialKind::None,
      secret: None,
      proxy_mode: ProxyMode::Direct,
    };
    let err = block_on(list_models_http(req)).unwrap_err();
    assert_eq!(err, TransportError::InvalidResponse);

    // Wait briefly for the server thread to observe the closed socket / finish writes.
    for _ in 0..100 {
      if server.client_write_failed() || server.body_bytes_written() < full_len {
        break;
      }
      thread::sleep(StdDuration::from_millis(10));
    }
    let written = server.body_bytes_written();
    // Client must stop reading after the cap: either the server failed mid-write or it
    // accepted far less than the full body (socket buffer may absorb a little past 2 MiB).
    assert!(
			server.client_write_failed() || written < full_len,
			"client must disconnect or stop draining before the full {full_len}-byte body is sent; written={written}, write_failed={}",
			server.client_write_failed()
		);
    // If we recorded successful payload writes, they must not equal a full-buffer-then-check.
    assert!(
			written < full_len,
			"server delivered the entire {full_len}-byte body (written={written}); client appears to have buffered fully before rejecting"
		);
    // Sanity: client did read past the cap threshold (plus at most a couple of chunks).
    assert!(
      written > MAX_RESPONSE_BODY_BYTES.saturating_sub(64 * 1024),
      "expected server to send around the 2 MiB cap before client abort; written={written}"
    );
  }

  #[test]
  fn http_chunked_small_body_without_content_length_succeeds() {
    let body = serde_json::json!({"data": [{"id": "local-chunked"}]}).to_string();
    let server = LocalServer::spawn_chunked(vec![(200, body)]);
    let req = ModelListRequest {
      adapter_id: "openai-compatible".into(),
      base_url: format!("{}/v1", server.base_url),
      credential_kind: CredentialKind::None,
      secret: None,
      proxy_mode: ProxyMode::Direct,
    };
    let models = block_on(list_models_http(req)).expect("ok");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].model_key, "local-chunked");
  }

  #[test]
  fn http_total_models_cap_is_enforced_with_incremental_dedupe() {
    // Two pages: first page fills to the cap with unique keys; second page would exceed.
    // Use a reduced synthetic approach: page with MAX_TOTAL_MODELS + 1 unique models is
    // rejected at parse (per-page) if > MAX_MODELS_PER_PAGE, so use multiple pages.
    // Each page has 100 unique models; after MAX_TOTAL_MODELS unique, reject.
    const PER_PAGE: usize = 100;
    assert_eq!(MAX_TOTAL_MODELS % PER_PAGE, 0);
    let full_pages = MAX_TOTAL_MODELS / PER_PAGE;
    let mut responses = Vec::with_capacity(full_pages + 1);
    for page_idx in 0..full_pages {
      let data: Vec<serde_json::Value> = (0..PER_PAGE)
        .map(|i| {
          let n = page_idx * PER_PAGE + i;
          serde_json::json!({"id": format!("m-{n}"), "display_name": format!("M{n}")})
        })
        .collect();
      let last = format!("m-{}", page_idx * PER_PAGE + PER_PAGE - 1);
      let body = serde_json::json!({
        "data": data,
        "has_more": true,
        "first_id": format!("m-{}", page_idx * PER_PAGE),
        "last_id": last
      })
      .to_string();
      responses.push((200u16, body));
    }
    // One more page that would push over the total cap.
    let extra: Vec<serde_json::Value> = (0..PER_PAGE)
      .map(|i| {
        let n = full_pages * PER_PAGE + i;
        serde_json::json!({"id": format!("m-{n}")})
      })
      .collect();
    let overflow_body = serde_json::json!({
      "data": extra,
      "has_more": false,
      "first_id": format!("m-{}", full_pages * PER_PAGE),
      "last_id": format!("m-{}", full_pages * PER_PAGE + PER_PAGE - 1)
    })
    .to_string();
    responses.push((200, overflow_body));

    let server = LocalServer::spawn(responses);
    let req = ModelListRequest {
      adapter_id: "anthropic".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("anth-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let err = block_on(list_models_http(req)).unwrap_err();
    assert_eq!(err, TransportError::InvalidResponse);
    // All full pages plus the overflowing page were fetched; cap tripped during merge.
    assert_eq!(server.captured().len(), full_pages + 1);
  }

  #[test]
  fn http_incremental_dedupe_keeps_first_occurrence() {
    let page1 = serde_json::json!({
      "data": [{"id": "dup", "display_name": "First"}, {"id": "unique-a"}],
      "has_more": true,
      "first_id": "dup",
      "last_id": "unique-a"
    })
    .to_string();
    let page2 = serde_json::json!({
      "data": [{"id": "dup", "display_name": "Second"}, {"id": "unique-b"}],
      "has_more": false,
      "first_id": "dup",
      "last_id": "unique-b"
    })
    .to_string();
    let server = LocalServer::spawn(vec![(200, page1), (200, page2)]);
    let req = ModelListRequest {
      adapter_id: "anthropic".into(),
      base_url: server.base_url.clone(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("anth-secret".into()),
      proxy_mode: ProxyMode::Direct,
    };
    let models = block_on(list_models_http(req)).expect("ok");
    assert_eq!(models.len(), 3);
    assert_eq!(models[0].model_key, "dup");
    assert_eq!(models[0].remote_display_name.as_deref(), Some("First"));
    assert_eq!(models[1].model_key, "unique-a");
    assert_eq!(models[2].model_key, "unique-b");
  }
}
