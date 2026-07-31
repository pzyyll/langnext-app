// ABOUTME: Shared bounded HTTP transport used by provider HTTP and service-integration brokers.
// ABOUTME: Enforces timeouts, redirect disablement, proxy mode, size caps, and cancellation.
use crate::domain::cancel::CancelToken;
use crate::domain::provider::ProxyMode;
use crate::domain::provider_http::{ProviderHttpMethod, ProviderHttpResponse, ProviderHttpStreamEvent};
use crate::error::StorageError;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
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
// TrustedFixed clients use OS DNS but never a system proxy; ProxyMode is intentionally ignored.
static TRUSTED_FIXED_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static TRUSTED_FIXED_STREAM_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
// Public-destination clients always disable system proxies (see build_public_client); a single
// cached client per transport kind is sufficient because ProxyMode is intentionally ignored.
static PUBLIC_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PUBLIC_STREAM_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// DNS lookup function used by [`PublicDestinationResolver`]. Returns resolved socket
/// addresses; port 0 is acceptable because reqwest replaces it with the URL's explicit port
/// or the scheme default before opening a socket.
type DnsLookupFn =
  Arc<dyn Fn(&str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send>> + Send + Sync>;

/// Resolver that rejects all DNS results outside public unicast address space before reqwest
/// opens a socket. Returning the vetted addresses pins this connection attempt to the checked
/// result and closes literal-IP and DNS rebinding paths for dynamic-origin (e.g. proxy) egress.
/// Production builds resolve through the system resolver; tests inject a synthetic lookup so the
/// private/link-local/loopback filter is exercised without real network access.
#[derive(Clone)]
struct PublicDestinationResolver {
  lookup: DnsLookupFn,
}

impl std::fmt::Debug for PublicDestinationResolver {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("PublicDestinationResolver").finish_non_exhaustive()
  }
}

impl Default for PublicDestinationResolver {
  fn default() -> Self {
    Self {
      lookup: Arc::new(system_dns_lookup),
    }
  }
}

impl PublicDestinationResolver {
  /// Test-only resolver backed by an injected lookup function.
  #[cfg(test)]
  fn with_lookup(lookup: DnsLookupFn) -> Self {
    Self { lookup }
  }
}

/// System DNS lookup used by the default resolver: resolves `host:0` and collects socket addrs.
/// Port 0 is intentional - reqwest replaces it with the URL's explicit port or scheme default.
fn system_dns_lookup(hostname: &str) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send>> {
  let host = hostname.to_owned();
  Box::pin(async move {
    let addrs: Vec<_> = tokio::net::lookup_host((host.as_str(), 0u16)).await?.collect();
    Ok(addrs)
  })
}

/// Filter resolved addresses down to publicly routable destinations. Public so transport-level
/// tests can exercise the SSRF filter independently of live DNS.
fn filter_public_resolved(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
  addrs
    .into_iter()
    .filter(|addr| is_public_destination_ip(addr.ip()))
    .collect()
}

impl Resolve for PublicDestinationResolver {
  fn resolve(&self, name: Name) -> Resolving {
    let lookup = self.lookup.clone();
    let hostname = name.as_str().to_owned();
    Box::pin(async move {
      let addresses = (lookup)(&hostname).await?;
      let public = filter_public_resolved(addresses);
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

/// Request body representation that preserves both UTF-8 text (JSON/string callers) and
/// arbitrary binary octets without lossy conversion. Existing string callers use
/// [`RequestBody::text`]; binary callers use [`RequestBody::bytes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestBody {
  /// No body.
  None,
  /// UTF-8 text body (JSON, form-encoded, etc.).
  Text(String),
  /// Arbitrary binary octets (Blob request bodies, protobuf, etc.).
  Bytes(Vec<u8>),
}

impl RequestBody {
  /// Build a text body from a string.
  pub fn text(body: impl Into<String>) -> Self {
    Self::Text(body.into())
  }

  /// Build a binary body from raw bytes.
  pub fn bytes(body: impl Into<Vec<u8>>) -> Self {
    Self::Bytes(body.into())
  }

  /// True when no body is present.
  pub fn is_none(&self) -> bool {
    matches!(self, Self::None)
  }

  /// Byte length of the body payload (0 for empty/none).
  pub fn len(&self) -> usize {
    match self {
      Self::None => 0,
      Self::Text(s) => s.len(),
      Self::Bytes(b) => b.len(),
    }
  }

  /// Borrow the body as a UTF-8 string slice when it is a text body; `None` for bytes/none.
  pub fn as_text(&self) -> Option<&str> {
    match self {
      Self::Text(s) => Some(s.as_str()),
      _ => None,
    }
  }

  /// Borrow the body as raw bytes (text bodies return their UTF-8 bytes).
  pub fn as_bytes(&self) -> Option<&[u8]> {
    match self {
      Self::None => None,
      Self::Text(s) => Some(s.as_bytes()),
      Self::Bytes(b) => Some(b.as_slice()),
    }
  }
}

impl Default for RequestBody {
  fn default() -> Self {
    Self::None
  }
}

/// Destination restriction selected by the host before native transport begins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinationPolicy {
  /// Preserve the configured provider destination, including explicit loopback development providers.
  Configured,
  /// Reach a host-owned, exact HTTPS origin through the OS/TUN resolver with no system proxy.
  /// TLS hostname verification remains reqwest's default; ProxyMode is intentionally ignored.
  TrustedFixed,
  /// Resolve and connect only to publicly routable external addresses.
  PublicInternet,
  /// Use OS DNS and the selected instance ProxyMode without filtering DNS address classes.
  /// This is available only after an exact host approval for one DNS origin.
  UserApprovedCustom,
}

/// Secret-bearing request ready for native execution (never returned over IPC).
pub struct PreparedHttpRequest {
  pub method: ProviderHttpMethod,
  pub url: url::Url,
  pub headers: HashMap<String, String>,
  pub body: RequestBody,
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
      .field("has_body", &!self.body.is_none())
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

/// Test-only transport that runs the real reqwest request with an injected DNS resolver.
/// `UserApprovedCustom` deliberately uses the unfiltered configured client; `PublicInternet`
/// deliberately uses the strict resolver so a policy regression fails at the public broker seam.
#[cfg(test)]
pub(crate) type TestDnsLookupFn = DnsLookupFn;

#[cfg(test)]
const TEST_DNS_TRANSPORT_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(test)]
#[derive(Clone)]
struct UnfilteredDnsResolver {
  lookup: DnsLookupFn,
}

#[cfg(test)]
impl Resolve for UnfilteredDnsResolver {
  fn resolve(&self, name: Name) -> Resolving {
    let lookup = self.lookup.clone();
    let hostname = name.as_str().to_owned();
    Box::pin(async move {
      let addresses = (lookup)(&hostname).await?;
      if addresses.is_empty() {
        return Err(std::io::Error::other("test DNS returned no destinations").into());
      }
      Ok(Box::new(addresses.into_iter()) as Addrs)
    })
  }
}

#[cfg(test)]
pub(crate) struct ResolverBackedTestTransport {
  lookup: TestDnsLookupFn,
}

#[cfg(test)]
impl ResolverBackedTestTransport {
  pub(crate) fn new(lookup: TestDnsLookupFn) -> Self {
    Self { lookup }
  }
}

#[cfg(test)]
impl RawHttpTransport for ResolverBackedTestTransport {
  fn request(
    &self,
    prepared: PreparedHttpRequest,
  ) -> Pin<Box<dyn Future<Output = Result<BoundedHttpResponse, StorageError>> + Send + '_>> {
    let lookup = self.lookup.clone();
    Box::pin(async move {
      let client_kind = destination_client_kind(prepared.destination_policy);
      let resolver: Arc<dyn Resolve> = match client_kind {
        DestinationClientKind::PublicInternet => Arc::new(PublicDestinationResolver::with_lookup(lookup.clone())),
        _ => Arc::new(UnfilteredDnsResolver { lookup: lookup.clone() }),
      };
      // Tests use Direct to prevent inherited CI proxy settings from making a live request; the
      // prepared request still carries the production-selected ProxyMode for seam assertions.
      let client = match client_kind {
        DestinationClientKind::PublicInternet => build_public_client_with_resolver(resolver)?,
        DestinationClientKind::TrustedFixed => build_trusted_fixed_client_with_resolver(Some(resolver))?,
        DestinationClientKind::Configured => build_configured_client_with_resolver(ProxyMode::Direct, Some(resolver))?,
      };
      match tokio::time::timeout(
        TEST_DNS_TRANSPORT_TIMEOUT,
        execute_request_with_client(&client, prepared),
      )
      .await
      {
        Ok(result) => result,
        Err(_) => Err(StorageError::Validation("test DNS transport timed out".into())),
      }
    })
  }

  fn stream(
    &self,
    _prepared: PreparedHttpRequest,
    _cancel: CancelToken,
    _on_event: Box<dyn Fn(ProviderHttpStreamEvent) -> Result<(), StorageError> + Send>,
  ) -> Pin<Box<dyn Future<Output = Result<(), StorageError>> + Send + '_>> {
    Box::pin(async { Err(StorageError::Validation("test transport stream not supported".into())) })
  }
}

async fn execute_request(prepared: PreparedHttpRequest) -> Result<BoundedHttpResponse, StorageError> {
  let client = client_for(prepared.proxy_mode, prepared.destination_policy)?;
  execute_request_with_client(client, prepared).await
}

async fn execute_request_with_client(
  client: &reqwest::Client,
  prepared: PreparedHttpRequest,
) -> Result<BoundedHttpResponse, StorageError> {
  let max_body = prepared.max_response_body_bytes.unwrap_or(MAX_RESPONSE_BODY_BYTES);
  let mut builder = match prepared.method {
    ProviderHttpMethod::Get => client.get(prepared.url.clone()),
    ProviderHttpMethod::Post => client.post(prepared.url.clone()),
  };
  for (name, value) in &prepared.headers {
    builder = builder.header(name, value);
  }
  let body_bytes: Option<Vec<u8>> = match &prepared.body {
    RequestBody::None => None,
    RequestBody::Text(s) => Some(s.as_bytes().to_vec()),
    RequestBody::Bytes(b) => Some(b.clone()),
  };
  if let Some(body) = &body_bytes {
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
  // Thread grant/request limits through instead of relying on fixed defaults: the stream byte
  // cap comes from the prepared request (grant max_stream_bytes / max_response_body_bytes),
  // falling back to the host default only when the caller sets no cap.
  let max_total_bytes = prepared.max_response_body_bytes.unwrap_or(MAX_STREAM_TOTAL_BYTES);
  let total_timeout = prepared.timeout;
  let client = stream_client_for(prepared.proxy_mode, prepared.destination_policy)?;
  let mut builder = match prepared.method {
    ProviderHttpMethod::Get => client.get(prepared.url.clone()),
    ProviderHttpMethod::Post => client.post(prepared.url.clone()),
  };
  for (name, value) in &prepared.headers {
    builder = builder.header(name, value);
  }
  let body_bytes: Option<Vec<u8>> = match &prepared.body {
    RequestBody::None => None,
    RequestBody::Text(s) => Some(s.as_bytes().to_vec()),
    RequestBody::Bytes(b) => Some(b.clone()),
  };
  if let Some(body) = &body_bytes {
    let content_type = prepared.content_type.as_deref().unwrap_or("application/json");
    builder = builder
      .header(reqwest::header::CONTENT_TYPE, content_type)
      .body(body.clone());
  }

  let send = async move {
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
          if total_bytes > max_total_bytes {
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
  };
  // Enforce the grant/request total timeout around the whole stream so continuously active
  // traffic cannot exceed the bound even when each chunk arrives within the idle timeout.
  match total_timeout {
    Some(timeout) => match tokio::time::timeout(timeout, send).await {
      Ok(result) => result,
      Err(_) => Err(StorageError::Validation("stream total timeout".into())),
    },
    None => send.await,
  }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestinationClientKind {
  Configured,
  TrustedFixed,
  PublicInternet,
}

fn destination_client_kind(destination_policy: DestinationPolicy) -> DestinationClientKind {
  match destination_policy {
    DestinationPolicy::Configured | DestinationPolicy::UserApprovedCustom => DestinationClientKind::Configured,
    DestinationPolicy::TrustedFixed => DestinationClientKind::TrustedFixed,
    DestinationPolicy::PublicInternet => DestinationClientKind::PublicInternet,
  }
}

fn client_for(
  mode: ProxyMode,
  destination_policy: DestinationPolicy,
) -> Result<&'static reqwest::Client, StorageError> {
  match destination_client_kind(destination_policy) {
    DestinationClientKind::Configured => configured_client_for(mode),
    DestinationClientKind::TrustedFixed => trusted_fixed_client_for(),
    DestinationClientKind::PublicInternet => public_client_for(mode),
  }
}

fn configured_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  let cell = match mode {
    ProxyMode::Inherit => &INHERIT_CLIENT,
    ProxyMode::Direct => &DIRECT_CLIENT,
  };
  if cell.get().is_none() {
    let _ = cell.set(build_configured_client(mode)?);
  }
  cell
    .get()
    .ok_or_else(|| StorageError::Internal("HTTP client unavailable".into()))
}

/// Build a fresh Configured-destination client honoring ProxyMode. Inherit keeps reqwest's default
/// system-proxy detection (env/OS); Direct disables it. Exposed so behavior tests can build a
/// non-cached client under a controlled proxy environment.
fn build_configured_client(mode: ProxyMode) -> Result<reqwest::Client, StorageError> {
  build_configured_client_with_resolver(mode, None)
}

/// Build an OS/TUN-resolved client. Production passes no resolver, deliberately leaving DNS to
/// the platform network stack; test probes may inject an unfiltered resolver to observe connect.
fn build_configured_client_with_resolver(
  mode: ProxyMode,
  resolver: Option<Arc<dyn Resolve>>,
) -> Result<reqwest::Client, StorageError> {
  let mut builder = reqwest::Client::builder()
    .timeout(REQUEST_TIMEOUT)
    .connect_timeout(REQUEST_TIMEOUT)
    .redirect(reqwest::redirect::Policy::none());
  if let Some(resolver) = resolver {
    builder = builder.dns_resolver(resolver);
  }
  let builder = match mode {
    ProxyMode::Inherit => builder,
    ProxyMode::Direct => builder.no_proxy(),
  };
  builder
    .build()
    .map_err(|_| StorageError::Internal("failed to build HTTP client".into()))
}

/// Return the dedicated fixed-origin client: platform DNS with no environment or OS proxy.
fn trusted_fixed_client_for() -> Result<&'static reqwest::Client, StorageError> {
  if TRUSTED_FIXED_CLIENT.get().is_none() {
    let _ = TRUSTED_FIXED_CLIENT.set(build_trusted_fixed_client()?);
  }
  TRUSTED_FIXED_CLIENT
    .get()
    .ok_or_else(|| StorageError::Internal("trusted fixed HTTP client unavailable".into()))
}

/// Build an OS/TUN-resolved fixed-origin client that always bypasses system proxies. Tests can
/// inject an unfiltered resolver to prove fixed origins are not subject to the public-DNS filter.
fn build_trusted_fixed_client() -> Result<reqwest::Client, StorageError> {
  build_trusted_fixed_client_with_resolver(None)
}

fn build_trusted_fixed_client_with_resolver(
  resolver: Option<Arc<dyn Resolve>>,
) -> Result<reqwest::Client, StorageError> {
  let mut builder = reqwest::Client::builder()
    .timeout(REQUEST_TIMEOUT)
    .connect_timeout(REQUEST_TIMEOUT)
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none());
  if let Some(resolver) = resolver {
    builder = builder.dns_resolver(resolver);
  }
  builder
    .build()
    .map_err(|_| StorageError::Internal("failed to build trusted fixed HTTP client".into()))
}

fn public_client_for(_mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  // PublicInternet always disables system proxies. With an HTTPS proxy reqwest resolves only the
  // proxy host and leaves the target hostname for the proxy to resolve, which defeats the
  // PublicDestinationResolver pin and reopens rebinding/private-network egress through the proxy.
  // ProxyMode is accepted for API symmetry but never honored for public destinations.
  if PUBLIC_CLIENT.get().is_none() {
    let _ = PUBLIC_CLIENT.set(build_public_client()?);
  }
  PUBLIC_CLIENT
    .get()
    .ok_or_else(|| StorageError::Internal("HTTP client unavailable".into()))
}

/// Build a fresh public-destination client: public DNS pinning + no system proxy. Single source of
/// truth for `public_client_for`; behavior tests build a non-cached client through this helper.
fn build_public_client() -> Result<reqwest::Client, StorageError> {
  build_public_client_with_resolver(Arc::new(PublicDestinationResolver::default()))
}

/// Build a strict public-destination client with an explicit resolver. The production caller
/// supplies [`PublicDestinationResolver`]; tests inject DNS answers without external lookups.
fn build_public_client_with_resolver(resolver: Arc<dyn Resolve>) -> Result<reqwest::Client, StorageError> {
  // reqwest replaces port 0 in the resolver's SocketAddrs with the URL's explicit port or the
  // scheme default before connect, so the resolver may return port-0 addresses safely.
  reqwest::Client::builder()
    .dns_resolver(resolver)
    .timeout(REQUEST_TIMEOUT)
    .connect_timeout(REQUEST_TIMEOUT)
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .map_err(|_| StorageError::Internal("failed to build HTTP client".into()))
}

fn stream_client_for(
  mode: ProxyMode,
  destination_policy: DestinationPolicy,
) -> Result<&'static reqwest::Client, StorageError> {
  match destination_client_kind(destination_policy) {
    DestinationClientKind::Configured => configured_stream_client_for(mode),
    DestinationClientKind::TrustedFixed => trusted_fixed_stream_client_for(),
    DestinationClientKind::PublicInternet => public_stream_client_for(mode),
  }
}

fn configured_stream_client_for(mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  let cell = match mode {
    ProxyMode::Inherit => &STREAM_INHERIT_CLIENT,
    ProxyMode::Direct => &STREAM_DIRECT_CLIENT,
  };
  if cell.get().is_none() {
    let _ = cell.set(build_configured_stream_client(mode)?);
  }
  cell
    .get()
    .ok_or_else(|| StorageError::Internal("stream HTTP client unavailable".into()))
}

/// Build a fresh Configured-destination stream client honoring ProxyMode (no body timeout; the
/// caller drives chunk/idle timeouts). Exposed for behavior-test parity with non-stream clients.
fn build_configured_stream_client(mode: ProxyMode) -> Result<reqwest::Client, StorageError> {
  let builder = reqwest::Client::builder()
    .connect_timeout(STREAM_CONNECT_TIMEOUT)
    .redirect(reqwest::redirect::Policy::none());
  let builder = match mode {
    ProxyMode::Inherit => builder,
    ProxyMode::Direct => builder.no_proxy(),
  };
  builder
    .build()
    .map_err(|_| StorageError::Internal("failed to build stream HTTP client".into()))
}

/// Return the dedicated fixed-origin stream client: platform DNS with no environment or OS proxy.
fn trusted_fixed_stream_client_for() -> Result<&'static reqwest::Client, StorageError> {
  if TRUSTED_FIXED_STREAM_CLIENT.get().is_none() {
    let _ = TRUSTED_FIXED_STREAM_CLIENT.set(build_trusted_fixed_stream_client()?);
  }
  TRUSTED_FIXED_STREAM_CLIENT
    .get()
    .ok_or_else(|| StorageError::Internal("trusted fixed stream HTTP client unavailable".into()))
}

/// Build an OS/TUN-resolved fixed-origin stream client that always bypasses system proxies.
fn build_trusted_fixed_stream_client() -> Result<reqwest::Client, StorageError> {
  build_trusted_fixed_stream_client_with_resolver(None)
}

fn build_trusted_fixed_stream_client_with_resolver(
  resolver: Option<Arc<dyn Resolve>>,
) -> Result<reqwest::Client, StorageError> {
  let mut builder = reqwest::Client::builder()
    .connect_timeout(STREAM_CONNECT_TIMEOUT)
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none());
  if let Some(resolver) = resolver {
    builder = builder.dns_resolver(resolver);
  }
  builder
    .build()
    .map_err(|_| StorageError::Internal("failed to build trusted fixed stream HTTP client".into()))
}

fn public_stream_client_for(_mode: ProxyMode) -> Result<&'static reqwest::Client, StorageError> {
  // Stream clients share the public-destination DNS pinning and no-proxy policy of non-stream
  // public clients (see public_client_for).
  if PUBLIC_STREAM_CLIENT.get().is_none() {
    let _ = PUBLIC_STREAM_CLIENT.set(build_public_stream_client()?);
  }
  PUBLIC_STREAM_CLIENT
    .get()
    .ok_or_else(|| StorageError::Internal("stream HTTP client unavailable".into()))
}

/// Build a fresh public-destination stream client (public DNS pinning + no system proxy).
fn build_public_stream_client() -> Result<reqwest::Client, StorageError> {
  reqwest::Client::builder()
    .dns_resolver(PublicDestinationResolver::default())
    .connect_timeout(STREAM_CONNECT_TIMEOUT)
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .map_err(|_| StorageError::Internal("failed to build stream HTTP client".into()))
}

pub fn map_reqwest_error(err: reqwest::Error) -> StorageError {
  if err.is_timeout() {
    return StorageError::Validation("request timed out".into());
  }
  // Preserve a coarse category without formatting reqwest or its source: either may include a
  // request URL (including query values). Request bodies and credentials must never reach errors.
  let category = if err.is_connect() {
    "connect"
  } else if err.is_request() {
    "request"
  } else {
    "transport"
  };
  StorageError::Validation(format!("network request failed ({category})"))
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

  #[test]
  fn bounded_http_filter_public_resolved_drops_non_routable() {
    let addrs = vec![
      SocketAddr::from(([127, 0, 0, 1], 0)),
      SocketAddr::from(([10, 0, 0, 1], 0)),
      SocketAddr::from(([169, 254, 1, 1], 0)),
      SocketAddr::from(([8, 8, 8, 8], 0)),
      SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 0)),
    ];
    let public = filter_public_resolved(addrs);
    assert_eq!(public.len(), 1);
    assert_eq!(public[0].ip(), "8.8.8.8".parse::<IpAddr>().unwrap());
    // All-private input yields an empty (not panicking) result.
    let empty = filter_public_resolved(vec![SocketAddr::from(([127, 0, 0, 1], 0))]);
    assert!(empty.is_empty());
  }

  #[tokio::test]
  async fn bounded_http_resolver_keeps_only_public_dns_results() {
    use reqwest::dns::{Name, Resolve};
    let resolver = PublicDestinationResolver::with_lookup(Arc::new(|_host| {
      Box::pin(async move {
        Ok(vec![
          SocketAddr::from(([127, 0, 0, 1], 0)),
          SocketAddr::from(([10, 0, 0, 1], 0)),
          SocketAddr::from(([169, 254, 1, 1], 0)),
          SocketAddr::from(([8, 8, 8, 8], 0)),
        ])
      })
    }));
    let name: Name = "proxy.example".parse().unwrap();
    let addrs_iter = resolver.resolve(name).await.expect("resolution must succeed");
    let addrs: Vec<_> = addrs_iter.collect();
    assert_eq!(addrs.len(), 1);
    assert_eq!(addrs[0].ip(), "8.8.8.8".parse::<IpAddr>().unwrap());
  }

  #[tokio::test]
  async fn bounded_http_resolver_fails_closed_when_only_private_dns_results() {
    use reqwest::dns::{Name, Resolve};
    let resolver = PublicDestinationResolver::with_lookup(Arc::new(|_host| {
      Box::pin(async move {
        Ok(vec![
          SocketAddr::from(([127, 0, 0, 1], 0)),
          SocketAddr::from(([169, 254, 1, 1], 0)),
        ])
      })
    }));
    let name: Name = "rebind.example".parse().unwrap();
    match resolver.resolve(name).await {
      Ok(addrs) => panic!("expected error, got addrs: {:?}", addrs.collect::<Vec<_>>()),
      Err(err) => assert!(
        err.to_string().contains("no public destinations"),
        "expected no-public-destinations error, got {err}"
      ),
    }
  }

  /// Test resolver that deliberately preserves every answer, emulating OS/TUN DNS for a fixed
  /// host-owned origin. It proves TrustedFixed does not apply the public-destination filter.
  #[derive(Clone)]
  struct UnfilteredTestResolver {
    lookup: DnsLookupFn,
  }

  impl Resolve for UnfilteredTestResolver {
    fn resolve(&self, name: Name) -> Resolving {
      let lookup = self.lookup.clone();
      let hostname = name.as_str().to_owned();
      Box::pin(async move {
        let addresses = (lookup)(&hostname).await?;
        if addresses.is_empty() {
          return Err(std::io::Error::other("test DNS returned no destinations").into());
        }
        Ok(Box::new(addresses.into_iter()) as Addrs)
      })
    }
  }

  /// Bounded wait for dynamic-client DNS rejection without opening a socket.
  const BENCHMARK_CONNECT_PROBE_TIMEOUT: Duration = Duration::from_millis(100);
  const BENCHMARK_DNS_PROBE_IP: [u8; 4] = [198, 18, 0, 1];
  const BENCHMARK_DNS_PROBE_PORT: u16 = 443;

  async fn assert_trusted_fixed_resolver_keeps_benchmark_dns_result(
    build_client: impl FnOnce(Arc<dyn Resolve>) -> Result<reqwest::Client, StorageError>,
  ) {
    const BENCHMARK_DNS_PROBE_HOST: &str = "benchmark-origin.test";
    const LOOPBACK_DNS_PROBE_HOST: &str = "loopback-origin.test";
    const LOOPBACK_DNS_PROBE_IP: [u8; 4] = [127, 0, 0, 1];

    let listener = tokio::net::TcpListener::bind(SocketAddr::from((LOOPBACK_DNS_PROBE_IP, 0)))
      .await
      .expect("bind loopback probe listener");
    let loopback_port = listener.local_addr().expect("loopback probe listener address").port();
    let lookup_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = lookup_count.clone();
    let resolver: Arc<dyn Resolve> = Arc::new(UnfilteredTestResolver {
      lookup: Arc::new(move |hostname| {
        let calls = calls.clone();
        let hostname = hostname.to_owned();
        Box::pin(async move {
          calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
          match hostname.as_str() {
            BENCHMARK_DNS_PROBE_HOST => Ok(vec![SocketAddr::from((
              BENCHMARK_DNS_PROBE_IP,
              BENCHMARK_DNS_PROBE_PORT,
            ))]),
            LOOPBACK_DNS_PROBE_HOST => Ok(vec![SocketAddr::from((LOOPBACK_DNS_PROBE_IP, 0))]),
            _ => Err(std::io::Error::other("unexpected trusted-fixed DNS probe hostname")),
          }
        })
      }),
    });
    let benchmark_name: Name = BENCHMARK_DNS_PROBE_HOST.parse().unwrap();
    let addresses: Vec<_> = resolver.resolve(benchmark_name).await.unwrap().collect();
    assert_eq!(
      addresses,
      vec![SocketAddr::from((BENCHMARK_DNS_PROBE_IP, BENCHMARK_DNS_PROBE_PORT))]
    );
    let client = build_client(resolver).expect("trusted fixed client accepts the unfiltered resolver");
    let request_url = format!("https://{LOOPBACK_DNS_PROBE_HOST}:{loopback_port}/");
    let send = client.get(request_url).send();
    tokio::pin!(send);
    tokio::select! {
      biased;
      accepted = listener.accept() => {
        accepted.expect("trusted fixed client must reach the loopback resolver answer");
      }
      result = &mut send => panic!("trusted fixed client did not reach the loopback resolver answer: {result:?}"),
      _ = tokio::time::sleep(PROBE_ACCEPT_RACE_TIMEOUT) => {
        panic!("trusted fixed client did not reach the loopback resolver answer before timeout");
      }
    }
    assert_eq!(lookup_count.load(std::sync::atomic::Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn bounded_http_trusted_fixed_client_keeps_benchmark_dns_result_without_prefiltering() {
    assert_trusted_fixed_resolver_keeps_benchmark_dns_result(|resolver| {
      build_trusted_fixed_client_with_resolver(Some(resolver))
    })
    .await;
  }

  #[tokio::test]
  async fn bounded_http_trusted_fixed_stream_client_keeps_benchmark_dns_result_without_prefiltering() {
    assert_trusted_fixed_resolver_keeps_benchmark_dns_result(|resolver| {
      build_trusted_fixed_stream_client_with_resolver(Some(resolver))
    })
    .await;
  }

  #[tokio::test]
  async fn bounded_http_dynamic_client_rejects_benchmark_dns_before_connect() {
    let lookup_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = lookup_count.clone();
    let resolver = Arc::new(PublicDestinationResolver::with_lookup(Arc::new(move |_host| {
      let calls = calls.clone();
      Box::pin(async move {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![SocketAddr::from((
          BENCHMARK_DNS_PROBE_IP,
          BENCHMARK_DNS_PROBE_PORT,
        ))])
      })
    })));
    let client = build_public_client_with_resolver(resolver).unwrap();
    let result = tokio::time::timeout(
      BENCHMARK_CONNECT_PROBE_TIMEOUT,
      client.get("https://dynamic-origin.test/").send(),
    )
    .await
    .expect("dynamic DNS filtering must fail before a connect timeout")
    .expect_err("benchmark DNS result must be rejected");
    assert_eq!(lookup_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    // reqwest intentionally normalizes resolver details, but completion within the connect probe
    // proves its client stopped at the strict resolver rather than opening this fake-IP socket.
    assert!(
      !result.is_timeout(),
      "dynamic DNS rejection must not reach connect timeout"
    );
  }

  #[tokio::test]
  async fn bounded_http_user_approved_custom_client_keeps_fake_ip_and_private_dns_answers() {
    use reqwest::dns::{Name, Resolve};
    const BENCHMARK_HOST: &str = "approved-benchmark.test";
    const PRIVATE_HOST: &str = "approved-private.test";
    const LOOPBACK_HOST: &str = "approved-loopback.test";
    const BENCHMARK_IP: [u8; 4] = [198, 18, 0, 1];
    const PRIVATE_IP: [u8; 4] = [10, 0, 0, 7];
    const LOOPBACK_IP: [u8; 4] = [127, 0, 0, 1];

    let lookup_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = lookup_count.clone();
    let resolver: Arc<dyn Resolve> = Arc::new(UnfilteredTestResolver {
      lookup: Arc::new(move |hostname| {
        let calls = calls.clone();
        let hostname = hostname.to_owned();
        Box::pin(async move {
          calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
          match hostname.as_str() {
            BENCHMARK_HOST => Ok(vec![SocketAddr::from((BENCHMARK_IP, 0))]),
            PRIVATE_HOST => Ok(vec![SocketAddr::from((PRIVATE_IP, 0))]),
            LOOPBACK_HOST => Ok(vec![SocketAddr::from((LOOPBACK_IP, 0))]),
            _ => Err(std::io::Error::other("unexpected approved-custom DNS hostname")),
          }
        })
      }),
    });
    for (host, expected) in [(BENCHMARK_HOST, BENCHMARK_IP), (PRIVATE_HOST, PRIVATE_IP)] {
      let name: Name = host.parse().unwrap();
      let addresses: Vec<_> = resolver.resolve(name).await.unwrap().collect();
      assert_eq!(addresses, vec![SocketAddr::from((expected, 0))]);
    }

    let listener = tokio::net::TcpListener::bind(SocketAddr::from((LOOPBACK_IP, 0)))
      .await
      .expect("bind approved-custom DNS probe listener");
    let port = listener.local_addr().unwrap().port();
    let client = build_configured_client_with_resolver(ProxyMode::Direct, Some(resolver)).unwrap();
    let send = client.get(format!("https://{LOOPBACK_HOST}:{port}/")).send();
    tokio::pin!(send);
    tokio::select! {
      biased;
      accepted = listener.accept() => {
        accepted.expect("approved custom client must use the unfiltered configured resolver");
      }
      result = &mut send => panic!("approved custom client did not reach synthetic DNS answer: {result:?}"),
      _ = tokio::time::sleep(PROBE_ACCEPT_RACE_TIMEOUT) => {
        panic!("approved custom client did not reach synthetic DNS answer before timeout");
      }
    }
    assert!(lookup_count.load(std::sync::atomic::Ordering::SeqCst) >= 3);
  }

  #[tokio::test]
  async fn bounded_http_resolver_fails_closed_when_dns_lookup_errors() {
    use reqwest::dns::{Name, Resolve};
    let resolver = PublicDestinationResolver::with_lookup(Arc::new(|_host| {
      Box::pin(async move { Err(std::io::Error::other("nameserver unreachable")) })
    }));
    let name: Name = "down.example".parse().unwrap();
    match resolver.resolve(name).await {
      Ok(addrs) => panic!("expected error, got addrs: {:?}", addrs.collect::<Vec<_>>()),
      Err(err) => assert!(
        err.to_string().contains("nameserver unreachable"),
        "expected nameserver-unreachable error, got {err}"
      ),
    }
  }

  // --- Public/Configured destination proxy behavior tests (isolated subprocess) ---
  //
  // Each probe runs in an isolated child process (the test binary re-invoked with --exact) so the
  // parent test process never mutates proxy env vars. The child clears ALL_PROXY/all_proxy/
  // HTTP_PROXY/http_proxy/HTTPS_PROXY/https_proxy/NO_PROXY/no_proxy (avoiding CI override and
  // parallel races), sets ALL_PROXY at a freshly bound loopback proxy listener, builds the client
  // under test, issues one GET to a loopback target, and deterministically races the two listener
  // accepts (no fixed sleep). The winner is written to a temp file the parent reads back.
  //
  // Production semantics verified: PublicInternet clients always disable system proxies (no_proxy);
  // Configured Inherit keeps reqwest's default system-proxy detection.
  //
  // Every reqwest-consulted proxy env var. Cleared in the child before ALL_PROXY is set so a CI
  // environment cannot override the probe; restore is implicit because the child exits.
  const PROXY_ENV_VARS: &[&str] = &[
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const PROBE_MODE_ENV: &str = "LANGNEXT_BOUNDED_HTTP_PROBE_MODE";
  const PROBE_OUT_ENV: &str = "LANGNEXT_BOUNDED_HTTP_PROBE_OUT";
  /// Upper bound on the accept race so a regression fails fast instead of hanging the suite.
  const PROBE_ACCEPT_RACE_TIMEOUT: Duration = Duration::from_secs(5);

  /// Subprocess entry point. Runs only when [`PROBE_MODE_ENV`] is set; otherwise a no-op so a
  /// normal `cargo test` run of this function is harmless.
  #[tokio::test]
  async fn bounded_http_proxy_probe_entry() {
    let mode = match std::env::var(PROBE_MODE_ENV) {
      Ok(mode) => mode,
      Err(_) => return,
    };
    let out_path = std::env::var(PROBE_OUT_ENV).expect("probe out path");

    // Bind fresh loopback listeners; their addresses are unknown to the parent, so the child sets
    // ALL_PROXY itself (only in this isolated process).
    let proxy_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind proxy");
    let proxy_addr = proxy_listener.local_addr().expect("proxy addr");
    let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind target");
    let target_addr = target_listener.local_addr().expect("target addr");

    // Clear every reqwest-consulted proxy env var (CI may set HTTP_PROXY/HTTPS_PROXY) then point
    // ALL_PROXY at the probe proxy. SAFETY: this is an isolated child process running a single
    // test; it exits immediately after the probe and never shares env with the parent or parallel
    // tests.
    for var in PROXY_ENV_VARS {
      unsafe { std::env::remove_var(var) };
    }
    unsafe { std::env::set_var("ALL_PROXY", format!("http://{proxy_addr}")) };

    let client = match mode.as_str() {
      "public-ignores-proxy" => build_public_client().expect("public client"),
      "public-stream-ignores-proxy" => build_public_stream_client().expect("public stream client"),
      "trusted-fixed-inherit-ignores-proxy" => client_for(ProxyMode::Inherit, DestinationPolicy::TrustedFixed)
        .expect("trusted fixed client")
        .clone(),
      "trusted-fixed-stream-inherit-ignores-proxy" => {
        stream_client_for(ProxyMode::Inherit, DestinationPolicy::TrustedFixed)
          .expect("trusted fixed stream client")
          .clone()
      }
      "inherit-respects-proxy" => build_configured_client(ProxyMode::Inherit).expect("configured inherit client"),
      "inherit-stream-respects-proxy" => {
        build_configured_stream_client(ProxyMode::Inherit).expect("configured inherit stream client")
      }
      _ => panic!("unknown probe mode: {mode}"),
    };

    // Issue one GET to the target. The client connects to either the proxy (Inherit) or the target
    // directly (Public); the accept race records which listener received the connection. The send
    // result is irrelevant (the probe listeners never speak HTTP), so it is raced alongside the
    // accepts to avoid a fixed sleep.
    let send = client.get(format!("http://127.0.0.1:{}/", target_addr.port())).send();
    tokio::pin!(send);
    let winner = tokio::select! {
      Ok(_) = proxy_listener.accept() => "proxy",
      Ok(_) = target_listener.accept() => "target",
      _ = &mut send => "send-without-accept",
      _ = tokio::time::sleep(PROBE_ACCEPT_RACE_TIMEOUT) => "timeout",
    };
    std::fs::write(&out_path, winner).expect("write probe result");
  }

  /// Spawn the probe subprocess for `mode` and return which listener won the accept race.
  fn run_proxy_probe(mode: &str) -> String {
    let exe = std::env::current_exe().expect("test exe path");
    let out_dir = tempfile::TempDir::new().expect("probe temp dir");
    let out_path = out_dir.path().join("probe-result.txt");
    // libtest test names omit the crate name; strip it from module_path!() so --exact matches.
    let module = module_path!();
    let path = module.split_once("::").map(|(_, rest)| rest).unwrap_or(module);
    let filter = format!("{path}::bounded_http_proxy_probe_entry");
    let output = std::process::Command::new(exe)
      .args(["--exact", &filter])
      .env(PROBE_MODE_ENV, mode)
      .env(PROBE_OUT_ENV, &out_path)
      .output()
      .unwrap_or_else(|err| panic!("failed to spawn probe subprocess for {mode}: {err}"));
    let winner = std::fs::read_to_string(&out_path).unwrap_or_else(|_| {
      panic!(
        "probe subprocess for {mode} did not write a result (filter={filter} status={:?})\nstdout: {}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
      )
    });
    assert!(
      output.status.success(),
      "probe subprocess for {mode} failed: {:?}\nstderr: {}",
      output.status,
      String::from_utf8_lossy(&output.stderr)
    );
    drop(out_dir);
    winner
  }

  #[test]
  fn bounded_http_public_client_ignores_system_proxy() {
    let winner = run_proxy_probe("public-ignores-proxy");
    assert_eq!(
      winner, "target",
      "public client must connect directly (no system proxy)"
    );
  }

  #[test]
  fn bounded_http_public_stream_client_ignores_system_proxy() {
    let winner = run_proxy_probe("public-stream-ignores-proxy");
    assert_eq!(
      winner, "target",
      "public stream client must connect directly (no system proxy)"
    );
  }

  #[test]
  fn bounded_http_user_approved_custom_uses_configured_dns_and_proxy_clients() {
    assert!(std::ptr::eq(
      client_for(ProxyMode::Inherit, DestinationPolicy::UserApprovedCustom).unwrap(),
      configured_client_for(ProxyMode::Inherit).unwrap(),
    ));
    assert!(std::ptr::eq(
      client_for(ProxyMode::Direct, DestinationPolicy::UserApprovedCustom).unwrap(),
      configured_client_for(ProxyMode::Direct).unwrap(),
    ));
    assert!(std::ptr::eq(
      stream_client_for(ProxyMode::Inherit, DestinationPolicy::UserApprovedCustom).unwrap(),
      configured_stream_client_for(ProxyMode::Inherit).unwrap(),
    ));
    assert!(std::ptr::eq(
      stream_client_for(ProxyMode::Direct, DestinationPolicy::UserApprovedCustom).unwrap(),
      configured_stream_client_for(ProxyMode::Direct).unwrap(),
    ));
  }

  #[test]
  fn bounded_http_trusted_fixed_clients_ignore_proxy_mode() {
    assert!(std::ptr::eq(
      client_for(ProxyMode::Inherit, DestinationPolicy::TrustedFixed).unwrap(),
      client_for(ProxyMode::Direct, DestinationPolicy::TrustedFixed).unwrap(),
    ));
    assert!(std::ptr::eq(
      stream_client_for(ProxyMode::Inherit, DestinationPolicy::TrustedFixed).unwrap(),
      stream_client_for(ProxyMode::Direct, DestinationPolicy::TrustedFixed).unwrap(),
    ));
  }

  #[test]
  fn bounded_http_trusted_fixed_client_ignores_system_proxy_in_inherit_mode() {
    let winner = run_proxy_probe("trusted-fixed-inherit-ignores-proxy");
    assert_eq!(
      winner, "target",
      "trusted fixed client must connect directly even in Inherit mode"
    );
  }

  #[test]
  fn bounded_http_trusted_fixed_stream_client_ignores_system_proxy_in_inherit_mode() {
    let winner = run_proxy_probe("trusted-fixed-stream-inherit-ignores-proxy");
    assert_eq!(
      winner, "target",
      "trusted fixed stream client must connect directly even in Inherit mode"
    );
  }

  #[test]
  fn bounded_http_configured_inherit_client_respects_system_proxy() {
    let winner = run_proxy_probe("inherit-respects-proxy");
    assert_eq!(winner, "proxy", "configured inherit client must honor the system proxy");
  }

  #[test]
  fn bounded_http_configured_inherit_stream_client_respects_system_proxy() {
    let winner = run_proxy_probe("inherit-stream-respects-proxy");
    assert_eq!(
      winner, "proxy",
      "configured inherit stream client must honor the system proxy"
    );
  }
}
