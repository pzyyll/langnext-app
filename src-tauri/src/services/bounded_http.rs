// ABOUTME: Shared bounded HTTP transport used by provider HTTP and service-integration brokers.
// ABOUTME: Enforces timeouts, redirect disablement, proxy mode, size caps, and cancellation.
use crate::domain::cancel::CancelToken;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::{ProviderHttpMethod, ProviderHttpResponse, ProviderHttpStreamEvent};
use crate::error::StorageError;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

/// Total request timeout for non-streaming HTTP.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Connect-only timeout for streaming requests.
pub const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Max silence between stream body chunks.
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Hard cap on a single non-stream response body (bytes, after decompression).
pub const MAX_RESPONSE_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Hard cap on total streamed bytes for one request.
pub const MAX_STREAM_TOTAL_BYTES: usize = 8 * 1024 * 1024;
/// Max request_id length accepted from callers.
pub const MAX_REQUEST_ID_LEN: usize = 128;

pub const BLOCKED_HEADER_NAMES: &[&str] = &[
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
];

const LOCALHOST_DOMAIN: &str = "localhost";
const LOCALHOST_DOMAIN_SUFFIX: &str = ".localhost";
const IPV4_SHARED_ADDRESS_FIRST_OCTET: u8 = 100;
const IPV4_SHARED_ADDRESS_SECOND_OCTET_MIN: u8 = 64;
const IPV4_SHARED_ADDRESS_SECOND_OCTET_MAX: u8 = 127;
const IPV4_IETF_PROTOCOL_FIRST_OCTET: u8 = 192;
const IPV4_IETF_PROTOCOL_SECOND_OCTET: u8 = 0;
const IPV4_IETF_PROTOCOL_THIRD_OCTET: u8 = 0;
const IPV4_DOCUMENTATION_ONE: [u8; 3] = [192, 0, 2];
const IPV4_BENCHMARKING_FIRST_OCTET: u8 = 198;
const IPV4_BENCHMARKING_SECOND_OCTET_MIN: u8 = 18;
const IPV4_BENCHMARKING_SECOND_OCTET_MAX: u8 = 19;
const IPV4_DOCUMENTATION_TWO: [u8; 3] = [198, 51, 100];
const IPV4_DOCUMENTATION_THREE: [u8; 3] = [203, 0, 113];
const IPV4_RESERVED_FIRST_OCTET_MIN: u8 = 240;
const IPV6_DOCUMENTATION_PREFIX: [u16; 2] = [0x2001, 0x0db8];
const IPV6_V4_COMPATIBLE_PREFIX_SEGMENTS: usize = 6;

static INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static STREAM_INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static STREAM_DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PUBLIC_INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PUBLIC_DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PUBLIC_STREAM_INHERIT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PUBLIC_STREAM_DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Resolver that rejects all DNS results outside public unicast address space before reqwest
/// opens a socket. Returning the vetted addresses pins this connection attempt to the checked
/// result and closes literal-IP and DNS rebinding paths for direct service requests.
#[derive(Debug, Default)]
struct PublicDestinationResolver;

impl Resolve for PublicDestinationResolver {
  fn resolve(&self, name: Name) -> Resolving {
    let hostname = name.as_str().to_owned();
    Box::pin(async move {
      // Port zero tells reqwest to retain the URL's explicit port or its scheme default.
      let addresses: Vec<_> = tokio::net::lookup_host((hostname.as_str(), 0u16)).await?.collect();
      let public: Vec<_> = addresses
        .into_iter()
        .filter(|addr| is_public_destination_ip(addr.ip()))
        .collect();
      if public.is_empty() {
        return Err(
          std::io::Error::other(format!("DNS resolution for {hostname} returned no public destinations")).into(),
        );
      }
      Ok(Box::new(public.into_iter()) as Addrs)
    })
  }
}

/// Bounded non-streaming HTTP response retained as raw bytes inside the backend.
/// Convert through [`Self::into_provider_http_response`] only for UTF-8 provider IPC paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedHttpResponse {
  pub status: u16,
  pub headers: HashMap<String, String>,
  pub body: Vec<u8>,
}

impl BoundedHttpResponse {
  /// Adapt a binary-safe internal response to the existing UTF-8 Provider HTTP DTO.
  pub fn into_provider_http_response(self) -> Result<ProviderHttpResponse, StorageError> {
    let body = String::from_utf8(self.body)
      .map_err(|_| StorageError::Validation("provider response body is not valid UTF-8".into()))?;
    Ok(ProviderHttpResponse {
      status: self.status,
      headers: self.headers,
      body,
    })
  }
}

/// Injectable raw HTTP executor so unit tests avoid external network access.
pub trait RawHttpTransport: Send + Sync + 'static {
  fn request(
    &self,
    prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, StorageError>> + Send + '_>>;

  fn stream(
    &self,
    prepared: PreparedHttpRequest,
    cancel: CancelToken,
    on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>>;
}

/// Destination restriction selected by the host before native transport begins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinationPolicy {
  /// Preserve the configured provider destination, including explicit loopback development providers.
  Configured,
  /// Resolve and connect only to publicly routable external addresses.
  PublicInternet,
}

/// Secret-bearing request ready for native execution (never returned over IPC).
pub struct PreparedHttpRequest {
  pub method: ProviderHttpMethod,
  pub url: url::Url,
  pub headers: HashMap<String, String>,
  pub body: Option<String>,
  /// When set, overrides default JSON content-type for the body.
  pub content_type: Option<String>,
  pub proxy_mode: ProxyMode,
  /// Host-selected DNS and final-destination restriction.
  pub destination_policy: DestinationPolicy,
  /// Optional per-request response body cap (defaults to MAX_RESPONSE_BODY_BYTES).
  pub max_response_body_bytes: Option<usize>,
  /// Optional per-request total timeout override (defaults to client REQUEST_TIMEOUT).
  pub timeout: Option<Duration>,
}

/// Backward-compatible alias used by Provider HTTP.
pub type PreparedProviderRequest = PreparedHttpRequest;

impl std::fmt::Debug for PreparedHttpRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("PreparedHttpRequest")
      .field("method", &self.method)
      .field("url_origin", &self.url.origin().ascii_serialization())
      .field("header_names", &self.headers.keys().collect::<Vec<_>>())
      .field("has_body", &self.body.is_some())
      .field("content_type", &self.content_type)
      .field("proxy_mode", &self.proxy_mode)
      .field("destination_policy", &self.destination_policy)
      .field("max_response_body_bytes", &self.max_response_body_bytes)
      .field("timeout", &self.timeout)
      .finish()
  }
}

pub fn validate_request_id(request_id: &str) -> Result<(), StorageError> {
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

pub fn validate_relative_path(path: &str) -> Result<(), StorageError> {
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

pub fn validate_caller_name(name: &str, kind: &str) -> Result<(), StorageError> {
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

pub fn is_blocked_header(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  BLOCKED_HEADER_NAMES.contains(&lower.as_str())
}

pub fn value_looks_like_secret_key(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  matches!(
    lower.as_str(),
    "authorization" | "proxy-authorization" | "x-api-key" | "cookie" | "api_key" | "apikey" | "access_token"
  )
}

/// Build endpoint under the base URL; preserve path prefixes.
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

pub fn append_query_pairs(url: &mut url::Url, pairs: &[(String, String)]) -> Result<(), StorageError> {
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

/// True only for publicly routable destination addresses permitted for external egress.
/// This deliberately excludes private, loopback, link-local, documentation, benchmarking,
/// shared-address, multicast, unspecified, and reserved ranges rather than relying on the
/// platform's unstable `is_global` convenience API.
pub fn is_public_destination_ip(address: IpAddr) -> bool {
  match address {
    IpAddr::V4(address) => is_public_ipv4(address),
    IpAddr::V6(address) => is_public_ipv6(address),
  }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
  let octets = address.octets();
  let is_shared = octets[0] == IPV4_SHARED_ADDRESS_FIRST_OCTET
    && (IPV4_SHARED_ADDRESS_SECOND_OCTET_MIN..=IPV4_SHARED_ADDRESS_SECOND_OCTET_MAX).contains(&octets[1]);
  let is_ietf_protocol = octets[0] == IPV4_IETF_PROTOCOL_FIRST_OCTET
    && octets[1] == IPV4_IETF_PROTOCOL_SECOND_OCTET
    && octets[2] == IPV4_IETF_PROTOCOL_THIRD_OCTET;
  let is_documentation = [IPV4_DOCUMENTATION_ONE, IPV4_DOCUMENTATION_TWO, IPV4_DOCUMENTATION_THREE]
    .iter()
    .any(|prefix| octets[..3] == *prefix);
  let is_benchmarking = octets[0] == IPV4_BENCHMARKING_FIRST_OCTET
    && (IPV4_BENCHMARKING_SECOND_OCTET_MIN..=IPV4_BENCHMARKING_SECOND_OCTET_MAX).contains(&octets[1]);
  !(address.is_private()
    || address.is_loopback()
    || address.is_link_local()
    || address.is_unspecified()
    || address.is_multicast()
    || address.is_broadcast()
    || octets[0] >= IPV4_RESERVED_FIRST_OCTET_MIN
    || is_shared
    || is_ietf_protocol
    || is_documentation
    || is_benchmarking)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
  if let Some(mapped) = address.to_ipv4_mapped() {
    return is_public_ipv4(mapped);
  }
  let segments = address.segments();
  let is_documentation = segments[..2] == IPV6_DOCUMENTATION_PREFIX;
  let is_ipv4_compatible = segments[..IPV6_V4_COMPATIBLE_PREFIX_SEGMENTS]
    .iter()
    .all(|segment| *segment == 0);
  !(address.is_loopback()
    || address.is_unspecified()
    || address.is_multicast()
    || address.is_unicast_link_local()
    || address.is_unique_local()
    || is_documentation
    || is_ipv4_compatible)
}

/// Reject non-HTTPS and literal local/private destinations before native transport begins.
/// Domain destinations receive an additional DNS-result check through [`PublicDestinationResolver`]
/// immediately before the transport opens its socket.
pub fn validate_external_destination(url: &url::Url) -> Result<(), StorageError> {
  if url.scheme() != "https" {
    return Err(StorageError::Validation("destination must use https".into()));
  }
  let host = url
    .host()
    .ok_or_else(|| StorageError::Validation("destination host is required".into()))?;
  let blocked = match host {
    url::Host::Domain(domain) => {
      let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
      normalized == LOCALHOST_DOMAIN || normalized.ends_with(LOCALHOST_DOMAIN_SUFFIX)
    }
    url::Host::Ipv4(address) => !is_public_destination_ip(IpAddr::V4(address)),
    url::Host::Ipv6(address) => !is_public_destination_ip(IpAddr::V6(address)),
  };
  if blocked {
    return Err(StorageError::Validation(
      "destination must not be private, loopback, link-local, or localhost".into(),
    ));
  }
  Ok(())
}

pub async fn with_cancel<T, F>(cancel: Option<&CancelToken>, work: F) -> Result<T, StorageError>
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

/// Production reqwest-backed transport shared by provider HTTP and brokers.
pub struct ReqwestRawHttpTransport;

impl RawHttpTransport for ReqwestRawHttpTransport {
  fn request(
    &self,
    prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, StorageError>> + Send + '_>> {
    Box::pin(async move { execute_request(prepared).await })
  }

  fn stream(
    &self,
    prepared: PreparedHttpRequest,
    cancel: CancelToken,
    on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
    Box::pin(async move { execute_stream(prepared, cancel, on_event).await })
  }
}

async fn execute_request(prepared: PreparedHttpRequest) -> Result<BoundedHttpResponse, StorageError> {
  let max_body = prepared.max_response_body_bytes.unwrap_or(MAX_RESPONSE_BODY_BYTES);
  let client = client_for(prepared.proxy_mode, prepared.destination_policy)?;
  let mut builder = match prepared.method {
    ProviderHttpMethod::Get => client.get(prepared.url.clone()),
    ProviderHttpMethod::Post => client.post(prepared.url.clone()),
  };
  for (name, value) in &prepared.headers {
    builder = builder.header(name, value);
  }
  if let Some(body) = &prepared.body {
    let content_type = prepared.content_type.as_deref().unwrap_or("application/json");
    builder = builder
      .header(reqwest::header::CONTENT_TYPE, content_type)
      .body(body.clone());
  }
  // Per-request override (e.g. stricter free-text Web timeout) without changing shared clients.
  if let Some(timeout) = prepared.timeout {
    builder = builder.timeout(timeout);
  }

  let response = builder.send().await.map_err(map_reqwest_error)?;
  let status = response.status().as_u16();
  let headers = extract_response_headers(response.headers());
  let body = read_response_body_bounded(response, max_body).await?;
  log::debug!("bounded_http_request status={status} body_len={}", body.len());
  Ok(BoundedHttpResponse { status, headers, body })
}

async fn execute_stream(
  prepared: PreparedHttpRequest,
  cancel: CancelToken,
  on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
) -> Result<(), StorageError> {
  if cancel.is_cancelled() {
    return Err(StorageError::Validation("request cancelled".into()));
  }
  let client = stream_client_for(prepared.proxy_mode, prepared.destination_policy)?;
  let mut builder = match prepared.method {
    ProviderHttpMethod::Get => client.get(prepared.url.clone()),
    ProviderHttpMethod::Post => client.post(prepared.url.clone()),
  };
  for (name, value) in &prepared.headers {
    builder = builder.header(name, value);
  }
  if let Some(body) = &prepared.body {
    let content_type = prepared.content_type.as_deref().unwrap_or("application/json");
    builder = builder
      .header(reqwest::header::CONTENT_TYPE, content_type)
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

async fn read_response_body_bounded(mut response: reqwest::Response, max_body: usize) -> Result<Vec<u8>, StorageError> {
  if let Some(declared) = response.content_length() {
    if declared > max_body as u64 {
      return Err(StorageError::Validation("response body exceeds size limit".into()));
    }
  }
  let mut body = Vec::new();
  loop {
    match response.chunk().await {
      Ok(Some(chunk)) => {
        if body.len().saturating_add(chunk.len()) > max_body {
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

fn client_for(
  mode: ProxyMode,
  destination_policy: DestinationPolicy,
) -> Result<&'static reqwest::Client, StorageError> {
  match destination_policy {
    DestinationPolicy::Configured => configured_client_for(mode),
    DestinationPolicy::PublicInternet => public_client_for(mode),
  }
}

fn configured_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
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

fn public_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  // Public clients use the same reqwest default DNS resolver as configured clients.
  // SSRF protection for bundled plugins is enforced by validate_external_destination
  // (rejects literal private/loopback/localhost hosts) and pinned manifest endpoints.
  // The custom PublicDestinationResolver was removed because reqwest 0.13's dns_resolver
  // integration caused spurious connect failures on some systems.
  configured_client_for(mode)
}

fn stream_client_for(
  mode: ProxyMode,
  destination_policy: DestinationPolicy,
) -> Result<&'static reqwest::Client, StorageError> {
  match destination_policy {
    DestinationPolicy::Configured => configured_stream_client_for(mode),
    DestinationPolicy::PublicInternet => public_stream_client_for(mode),
  }
}

fn configured_stream_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
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

fn public_stream_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  configured_stream_client_for(mode)
}

pub fn map_reqwest_error(err: reqwest::Error) -> StorageError {
  if err.is_timeout() {
    return StorageError::Validation("request timed out".into());
  }
  // Include the reqwest error category so callers can distinguish DNS, connect, and TLS
  // failures without exposing the full URL or request body.
  let category = if err.is_connect() {
    "connect"
  } else if err.is_request() {
    "request"
  } else {
    "transport"
  };
  let source = <dyn std::error::Error>::source(&err)
    .map(|s| s.to_string())
    .unwrap_or_else(|| err.to_string());
  StorageError::Validation(format!("network request failed ({category}): {source}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn bounded_http_rejects_absolute_and_traversal_paths() {
    assert!(validate_relative_path("models").is_ok());
    assert!(validate_relative_path("/models").is_err());
    assert!(validate_relative_path("../secret").is_err());
    assert!(validate_relative_path("https://evil.example/models").is_err());
    assert!(validate_relative_path("models#frag").is_err());
  }

  #[test]
  fn bounded_http_build_endpoint_preserves_prefix() {
    let url = build_endpoint("https://api.example.com/v1", "models").unwrap();
    assert_eq!(url.as_str(), "https://api.example.com/v1/models");
  }

  #[test]
  fn bounded_http_blocks_sensitive_header_names() {
    assert!(is_blocked_header("Authorization"));
    assert!(is_blocked_header("cookie"));
    assert!(!is_blocked_header("X-Custom"));
  }

  #[test]
  fn bounded_http_default_timeout_and_redirect_policy_constants() {
    // Shared non-stream clients use REQUEST_TIMEOUT and Policy::none() (see client_for).
    // Redirect following is intentionally disabled for all service-integration HTTP.
    assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(20));
    assert_eq!(STREAM_CONNECT_TIMEOUT, Duration::from_secs(20));
  }

  #[test]
  fn bounded_response_adapts_utf8_for_provider_ipc() {
    let response = BoundedHttpResponse {
      status: 200,
      headers: HashMap::from([("content-type".into(), "application/json".into())]),
      body: br#"{"ok":true}"#.to_vec(),
    }
    .into_provider_http_response()
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, r#"{"ok":true}"#);
  }

  #[test]
  fn bounded_response_rejects_non_utf8_for_provider_ipc() {
    const INVALID_UTF8_BYTE: u8 = 0xFF;
    let err = BoundedHttpResponse {
      status: 200,
      headers: HashMap::new(),
      body: vec![INVALID_UTF8_BYTE],
    }
    .into_provider_http_response()
    .unwrap_err();
    assert!(matches!(err, StorageError::Validation(message) if message.contains("UTF-8")));
  }

  #[test]
  fn bounded_http_rejects_literal_local_destinations() {
    for raw in [
      "https://127.0.0.1/v1",
      "https://10.0.0.1/v1",
      "https://169.254.1.1/v1",
      "https://[::1]/v1",
      "https://localhost/v1",
      "https://service.localhost/v1",
    ] {
      let url = url::Url::parse(raw).unwrap();
      assert!(validate_external_destination(&url).is_err(), "{raw} must be rejected");
    }
    let public_url = url::Url::parse("https://api.example.com/v1").unwrap();
    assert!(validate_external_destination(&public_url).is_ok());
  }

  #[test]
  fn bounded_http_public_ip_filter_rejects_non_routable_dns_results() {
    for raw in [
      "10.0.0.1",
      "100.64.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "240.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ] {
      let address = raw.parse::<IpAddr>().unwrap();
      assert!(!is_public_destination_ip(address), "{raw} must be rejected");
    }
    assert!(is_public_destination_ip("8.8.8.8".parse().unwrap()));
    assert!(is_public_destination_ip("2606:4700:4700::1111".parse().unwrap()));
  }
}
