// ABOUTME: Host resource types, neutral broker/log types, the BrokerHandle abstraction, and the
// ABOUTME: PluginHostState helper methods backing the generated LangNext host import traits.
use crate::domain::cancel::CancelToken;
use crate::domain::plugin_resource::{NetworkResponseBodyMode, NetworkResponseBodyModes, ResourceId};
use crate::domain::runtime_plugin::{
  AuthPolicyId, EndpointId, ExecutionGrantSet, GrantError, HttpsOrigin, NetworkOriginKind, PluginPrincipal,
  ResourceLimits,
};
use crate::services::stream_resources::StreamReaderHandle;
use std::time::{Duration, Instant};

const EDGE_TTS_ENDPOINT_ALIAS: &str = "tts-api";
const EDGE_TTS_SYNTHESIZE_PATH: &str = "v1/audio/speech";

use super::store::{
  BROKER_IMPORT_CLEANUP_TIMEOUT, BROKER_IMPORT_MAX_TIMEOUT, BROKER_IMPORT_NO_DEADLINE_DEFAULT, PluginHostState,
};

/// Host-owned blob handle backing storage. Opaque to guests: only `Resource<BlobResource>`
/// table indices ever cross the ABI, never raw bytes.
#[derive(Debug)]
pub struct BlobResource {
  pub id: ResourceId,
}

/// Host-owned stream writer backing storage (output/producer endpoint).
#[derive(Debug)]
pub struct StreamWriterResource {
  pub id: ResourceId,
}

/// Host-owned stream reader backing storage (input/consumer endpoint).
#[derive(Debug)]
pub struct StreamReaderResource {
  pub id: ResourceId,
}

/// Neutral log level mirroring the WIT `host.log-level` enum, independent of generated types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeutralLogLevel {
  Trace,
  Debug,
  Info,
  Warn,
  Error,
}

/// Authorization result for a broker fetch: the matched grant entry's origin, auth policy, and
/// resource limits. Produced by [`PluginHostState::authorize_broker_fetch`] after the host
/// runtime validates principal, grant, capability, endpoint, and method. The broker handle
/// receives this so it never needs to re-derive authority from the raw grant set.
#[derive(Debug, Clone)]
pub struct BrokerAuthorization {
  pub endpoint_id: EndpointId,
  pub origin: HttpsOrigin,
  /// Complete canonical base URL copied from the verified grant entry, never guest input.
  pub base_url: String,
  /// Immutable origin provenance copied from the verified grant entry, never guest input.
  pub origin_kind: NetworkOriginKind,
  pub auth_policy: AuthPolicyId,
  pub resource_limits: ResourceLimits,
  /// Allowed response body variants from the grant (guest cannot broaden).
  pub response_body_modes: NetworkResponseBodyModes,
  /// Selected response mode for this fetch (Accept-driven, grant-checked).
  pub selected_response_mode: NetworkResponseBodyMode,
}

impl PluginHostState {
  /// Authorize a broker fetch against the principal and grant set before delegating to the
  /// broker handle. The host runtime — not the broker — enforces:
  ///
  /// - principal↔grant binding (identity, plugin, instance, revision, authority digest)
  /// - capability is granted
  /// - endpoint is granted for the principal's capability
  /// - request method matches the grant entry's method
  ///
  /// Returns the matched grant entry's origin, auth policy, and resource limits so the broker
  /// can execute transport without re-deriving authority. This is the single authorization
  /// chokepoint: a broker handle can never bypass it.
  pub(crate) fn authorize_broker_fetch(
    &self,
    request: &BrokerFetchRequest,
  ) -> Result<BrokerAuthorization, BrokerFetchError> {
    // Re-validate the principal↔grant binding on every import (defense-in-depth: the principal
    // was issued from this grant, but a stale/forged principal must not slip through).
    self
      .grant
      .grants_capability(&self.principal)
      .map_err(map_grant_error_to_broker)?;
    // Find the network entry matching the principal's capability + requested endpoint.
    let entry = self
      .grant
      .network_entries()
      .find(|entry| {
        entry.capability_id() == self.principal.capability_id() && entry.endpoint_id().as_str() == request.endpoint_id
      })
      .ok_or(BrokerFetchError::NotApproved)?;
    // Validate the request method against the grant entry's allowed method.
    let request_method = http_method_from_str(&request.method).ok_or(BrokerFetchError::MethodNotAllowed)?;
    if entry.method() != request_method {
      return Err(BrokerFetchError::MethodNotAllowed);
    }
    // Validate request body size against the grant entry's max_request_bytes.
    let body_bytes = match &request.body {
      BrokerRequestBody::Empty => 0,
      BrokerRequestBody::Json(bytes) => bytes.len(),
      BrokerRequestBody::Blob { byte_len, .. } => *byte_len,
    };
    if body_bytes as u64 > entry.resource_limits().max_request_bytes() {
      return Err(BrokerFetchError::LimitExceeded);
    }
    // Validate request JSON body is UTF-8 and valid JSON (not just opaque bytes).
    if let BrokerRequestBody::Json(bytes) = &request.body {
      validate_json_bytes(bytes).map_err(|_| BrokerFetchError::HeaderBlocked)?;
    }
    // Path/header chokepoint: confined relative path + blocked sensitive headers.
    validate_broker_relative_path(&request.relative_path)?;
    validate_fixed_endpoint_scope(
      entry.endpoint_id().as_str(),
      entry.capability_id().as_str(),
      &request.relative_path,
    )?;
    validate_broker_headers(&request.headers)?;
    let response_body_modes = entry.response_body_modes();
    let selected_response_mode = select_response_mode(&request.headers, response_body_modes)?;
    Ok(BrokerAuthorization {
      endpoint_id: entry.endpoint_id().clone(),
      origin: entry.origin().clone(),
      base_url: entry.base_url().to_string(),
      origin_kind: entry.origin_kind(),
      auth_policy: entry.auth_policy().clone(),
      resource_limits: *entry.resource_limits(),
      response_body_modes,
      selected_response_mode,
    })
  }

  /// Neutral broker-fetch logic: authorize via the grant set, enforce per-import timeout and
  /// cancellation, then delegate to the broker handle for transport. The host runtime enforces
  /// authorization and time bounds; the broker handle only executes the authorized transport.
  /// Fuel/epoch cannot preempt a blocking broker import, so this select is the import's own
  /// timeout/cancellation boundary — it does not rely on the executor's outer select.
  pub(crate) async fn do_broker_fetch(&mut self, request: BrokerFetchRequest) -> BrokerFetchOutcome {
    let authorization = match self.authorize_broker_fetch(&request) {
      Ok(auth) => auth,
      Err(error) => return Err(error),
    };
    let import_timeout = compute_import_timeout(self.deadline, &authorization);
    let import_deadline = Instant::now() + import_timeout;
    // Pass the effective import deadline into the broker so a stream transport and its
    // transport-specific token observe the same bound as this host import select.
    let broker_deadline = Some(
      self
        .deadline
        .map_or(import_deadline, |deadline| deadline.min(import_deadline)),
    );
    let principal = &self.principal;
    let grant = &self.grant;
    let cancel = &self.cancel;
    let broker = &self.broker;
    let broker_future = broker.fetch(
      principal,
      grant,
      request,
      authorization.clone(),
      cancel,
      broker_deadline,
    );
    tokio::pin!(broker_future);
    tokio::select! {
      biased;
      _ = cancel.cancelled() => {
        // Do not immediately drop the broker future: the network stream's pre-header path sees
        // this same token, cancels its transport token, and joins/aborts the raw task first.
        if tokio::time::timeout(BROKER_IMPORT_CLEANUP_TIMEOUT, &mut broker_future).await.is_err() {
          log::warn!("broker future exceeded cancellation cleanup timeout");
        }
        Err(BrokerFetchError::Cancelled)
      }
      _ = tokio::time::sleep(import_timeout) => {
        // The broker received `broker_deadline`, so it can stop a pre-header transport before
        // this import returns. Keep the grace bounded for non-cooperating implementations.
        if tokio::time::timeout(BROKER_IMPORT_CLEANUP_TIMEOUT, &mut broker_future).await.is_err() {
          log::warn!("broker future exceeded deadline cleanup timeout");
        }
        Err(BrokerFetchError::Timeout)
      }
      outcome = &mut broker_future => match outcome {
        Ok(response) => validate_broker_response(&response, &authorization).map(|()| response),
        Err(error) => Err(error),
      },
    }
  }

  /// Neutral log: enforce the field allowlist and bounded UTF-8 byte lengths, then emit a
  /// sanitized host log line. Disallowed fields and oversized values are dropped (never passed
  /// through). The log line records only safe metadata: the principal ids, the level enum, the
  /// message byte count, and each allowlisted field NAME with its VALUE BYTE LENGTH. Guest raw
  /// message/field values are NEVER written to logs (a malicious guest cannot exfiltrate user
  /// content via the `stage` or any other allowlisted field). Never traps: log is best-effort.
  pub(crate) fn do_log(&self, level: NeutralLogLevel, message: &str, fields: &[(String, String)]) {
    let budget = &self.log_budget;
    let message_bytes = truncate_utf8_bytes(message, budget.max_message_bytes).len();
    // Collect only allowlisted field names with their truncated value byte length. The value
    // itself is never logged.
    let mut field_summary: Vec<(&str, usize)> = Vec::with_capacity(fields.len().min(budget.max_fields));
    for (name, value) in fields.iter().take(budget.max_fields) {
      if name.len() > budget.max_field_name_bytes || !budget.allowed_field_names.iter().any(|allowed| allowed == name) {
        continue;
      }
      let value_len = truncate_utf8_bytes(value, budget.max_field_value_bytes).len();
      field_summary.push((name.as_str(), value_len));
    }
    let principal = &self.principal;
    log::log!(
      map_log_level(level),
      "plugin log plugin={} instance={} capability={} request={} level={:?} msg_bytes={} fields={:?}",
      principal.plugin_id().as_str(),
      principal.instance_id(),
      principal.capability_id().as_str(),
      principal.request_id().as_str(),
      level,
      message_bytes,
      field_summary
    );
  }

  /// Remaining milliseconds until the request deadline, or `None` if no deadline is set.
  /// The host enforces the deadline regardless of this hint.
  pub(crate) fn do_deadline_remaining(&self) -> Option<u64> {
    self.deadline.map(|deadline| {
      let now = Instant::now();
      if deadline <= now {
        0
      } else {
        deadline.duration_since(now).as_millis().min(u64::MAX as u128) as u64
      }
    })
  }

  /// Whether the request has been cooperatively cancelled.
  pub(crate) fn do_is_cancelled(&self) -> bool {
    self.cancel.is_cancelled()
  }
}

/// Parse an HTTP method string (e.g. `"GET"`) into the domain enum. Returns `None` for
/// unrecognized methods so the caller maps it to `MethodNotAllowed`.
fn http_method_from_str(value: &str) -> Option<crate::domain::runtime_plugin::HttpMethod> {
  use crate::domain::runtime_plugin::HttpMethod;
  match value {
    "GET" => Some(HttpMethod::Get),
    "POST" => Some(HttpMethod::Post),
    "PUT" => Some(HttpMethod::Put),
    "PATCH" => Some(HttpMethod::Patch),
    "DELETE" => Some(HttpMethod::Delete),
    "HEAD" => Some(HttpMethod::Head),
    "OPTIONS" => Some(HttpMethod::Options),
    _ => None,
  }
}

/// Map a grant-set denial to a stable broker error for the guest-visible result.
fn map_grant_error_to_broker(error: GrantError) -> BrokerFetchError {
  match error {
    GrantError::NotGranted(_) => BrokerFetchError::NotApproved,
    GrantError::InvalidEntry(_) | GrantError::DuplicateEntry(_) | GrantError::LimitExceeded(_) => {
      BrokerFetchError::Internal("grant validation failed".into())
    }
  }
}

/// Compute the per-import timeout as the minimum of: the remaining wall deadline (if set),
/// the grant entry's `timeout_ms` resource limit, and the hard maximum import timeout. When no
/// deadline is set, [`BROKER_IMPORT_NO_DEADLINE_DEFAULT`] bounds the import so a missing
/// deadline can never hang the host.
fn compute_import_timeout(deadline: Option<Instant>, authorization: &BrokerAuthorization) -> Duration {
  let mut timeout = BROKER_IMPORT_MAX_TIMEOUT;
  if let Some(deadline) = deadline {
    let now = Instant::now();
    if deadline <= now {
      timeout = Duration::ZERO;
    } else {
      timeout = timeout.min(deadline.duration_since(now));
    }
  } else {
    timeout = timeout.min(BROKER_IMPORT_NO_DEADLINE_DEFAULT);
  }
  let grant_timeout = Duration::from_millis(authorization.resource_limits.timeout_ms());
  timeout.min(grant_timeout)
}

/// Validate a broker response against the grant's response limits and host bounds. Enforced
/// AFTER the broker handle returns and BEFORE the response reaches the guest: response body
/// bytes <= `max_response_bytes`, header count/name/value within bounds, and JSON bodies are
/// valid UTF-8 + valid JSON. A violation is a `LimitExceeded`/`HeaderBlocked` denial so a
/// broker (or upstream) can never push oversized or malformed content into the guest.
fn validate_broker_response(
  response: &BrokerFetchResponse,
  authorization: &BrokerAuthorization,
) -> Result<(), BrokerFetchError> {
  let body_len = match &response.body {
    BrokerResponseBody::Json(bytes) => bytes.len() as u64,
    BrokerResponseBody::Bytes { bytes, .. } => bytes.len() as u64,
    BrokerResponseBody::Stream { .. } => 0,
  };
  if body_len > authorization.resource_limits.max_response_bytes() {
    return Err(BrokerFetchError::LimitExceeded);
  }
  // Guest/grant mode selection must match the transport body variant.
  match (&response.body, authorization.selected_response_mode) {
    (BrokerResponseBody::Json(_), NetworkResponseBodyMode::Json) => {}
    (BrokerResponseBody::Bytes { .. }, NetworkResponseBodyMode::Bytes) => {}
    (BrokerResponseBody::Stream { .. }, NetworkResponseBodyMode::Stream) => {}
    _ => return Err(BrokerFetchError::NotApproved),
  }
  if response.headers.len() > BROKER_MAX_HEADERS {
    return Err(BrokerFetchError::HeaderBlocked);
  }
  for (name, value) in &response.headers {
    if name.is_empty()
      || name.len() > BROKER_MAX_HEADER_NAME_BYTES
      || value.len() > BROKER_MAX_HEADER_VALUE_BYTES
      || name.chars().any(|c| c.is_control())
      || value.chars().any(|c| c.is_control())
    {
      return Err(BrokerFetchError::HeaderBlocked);
    }
  }
  if let BrokerResponseBody::Json(bytes) = &response.body {
    validate_json_bytes(bytes).map_err(|_| BrokerFetchError::HeaderBlocked)?;
  }
  Ok(())
}

/// Select the broker response body mode from guest Accept headers within grant-allowed modes.
pub(crate) fn select_response_mode(
  headers: &[(String, String)],
  allowed: NetworkResponseBodyModes,
) -> Result<NetworkResponseBodyMode, BrokerFetchError> {
  let accept = headers
    .iter()
    .find(|(name, _)| name.eq_ignore_ascii_case("accept"))
    .map(|(_, value)| value.as_str())
    .unwrap_or("");
  let accept_l = accept.to_ascii_lowercase();
  let requested = if accept_l.is_empty() || accept_l.contains("application/json") || accept_l == "*/*" {
    // Prefer JSON when Accept is missing, wildcard, or explicitly JSON.
    // Binary Accept values take precedence below when more specific.
    if accept_l.contains("audio/")
      || accept_l.contains("image/")
      || accept_l.contains("application/octet-stream")
      || accept_l.contains("application/pdf")
    {
      NetworkResponseBodyMode::Bytes
    } else if accept_l.contains("text/event-stream") {
      NetworkResponseBodyMode::Stream
    } else {
      NetworkResponseBodyMode::Json
    }
  } else if accept_l.contains("text/event-stream") {
    NetworkResponseBodyMode::Stream
  } else if accept_l.contains("audio/")
    || accept_l.contains("image/")
    || accept_l.contains("application/octet-stream")
    || accept_l.contains("application/pdf")
    || accept_l.contains("video/")
  {
    NetworkResponseBodyMode::Bytes
  } else {
    NetworkResponseBodyMode::Json
  };
  let permitted = match requested {
    NetworkResponseBodyMode::Json => allowed.allows_json(),
    NetworkResponseBodyMode::Bytes => allowed.allows_bytes(),
    NetworkResponseBodyMode::Stream => allowed.allows_stream(),
  };
  if !permitted {
    return Err(BrokerFetchError::NotApproved);
  }
  Ok(requested)
}

/// Validate that `bytes` are valid UTF-8 and parse as a JSON value. Used for both request and
/// response JSON bodies so a guest/broker can never smuggle non-UTF-8 or malformed JSON across
/// the broker boundary.
fn validate_json_bytes(bytes: &[u8]) -> Result<(), BrokerFetchError> {
  let s = std::str::from_utf8(bytes).map_err(|_| BrokerFetchError::HeaderBlocked)?;
  serde_json::from_str::<serde_json::Value>(s).map_err(|_| BrokerFetchError::HeaderBlocked)?;
  Ok(())
}

/// Truncate a string to at most `max_bytes` UTF-8 bytes, never splitting a multi-byte
/// character. Returns a `String` whose `.len()` (byte length) is ≤ `max_bytes`.
fn truncate_utf8_bytes(input: &str, max_bytes: usize) -> String {
  if input.len() <= max_bytes {
    return input.to_string();
  }
  // Find the largest char boundary at or before `max_bytes`.
  let mut end = max_bytes;
  while end > 0 && !input.is_char_boundary(end) {
    end -= 1;
  }
  input[..end].to_string()
}

fn map_log_level(level: NeutralLogLevel) -> log::Level {
  match level {
    NeutralLogLevel::Trace => log::Level::Trace,
    NeutralLogLevel::Debug => log::Level::Debug,
    NeutralLogLevel::Info => log::Level::Info,
    NeutralLogLevel::Warn => log::Level::Warn,
    NeutralLogLevel::Error => log::Level::Error,
  }
}

/// Bounded structured-log policy: an allowlist of field names and per-value/per-call caps.
/// Guest log calls exceeding these caps are filtered/truncated; messages never contain secrets.
#[derive(Debug, Clone)]
pub struct LogBudget {
  pub max_message_bytes: usize,
  pub max_fields: usize,
  pub max_field_name_bytes: usize,
  pub max_field_value_bytes: usize,
  pub allowed_field_names: &'static [&'static str],
}

impl Default for LogBudget {
  fn default() -> Self {
    Self {
      max_message_bytes: LOG_MAX_MESSAGE_BYTES,
      max_fields: LOG_MAX_FIELDS,
      max_field_name_bytes: LOG_MAX_FIELD_NAME_BYTES,
      max_field_value_bytes: LOG_MAX_FIELD_VALUE_BYTES,
      allowed_field_names: LOG_ALLOWED_FIELD_NAMES,
    }
  }
}

/// Maximum UTF-8 bytes accepted in a single guest log message (truncated beyond this).
pub const LOG_MAX_MESSAGE_BYTES: usize = 2048;
/// Maximum structured fields per guest log call (excess dropped).
pub const LOG_MAX_FIELDS: usize = 16;
/// Maximum UTF-8 bytes in a single log field name (excess dropped).
pub const LOG_MAX_FIELD_NAME_BYTES: usize = 64;
/// Maximum UTF-8 bytes in a single log field value (excess dropped).
pub const LOG_MAX_FIELD_VALUE_BYTES: usize = 512;
/// Allowlist of structured log field names guests may emit. Unknown names are dropped.
pub const LOG_ALLOWED_FIELD_NAMES: &[&str] = &["capability", "request_id", "attempt", "stage"];

/// Maximum header count per broker request (defense-in-depth against header flooding).
pub const BROKER_MAX_HEADERS: usize = 32;
/// Maximum query pairs accepted in a broker relative-path `?query` suffix.
pub const BROKER_QUERY_MAX_PAIRS: usize = 32;
/// Maximum UTF-8 bytes per query key in a broker relative-path `?query` suffix.
pub const BROKER_QUERY_KEY_MAX_BYTES: usize = 128;
/// Maximum UTF-8 bytes per broker request header name.
pub const BROKER_MAX_HEADER_NAME_BYTES: usize = 128;
/// Maximum UTF-8 bytes per broker request header value.
pub const BROKER_MAX_HEADER_VALUE_BYTES: usize = 8192;
/// Case-insensitive blocked request header names. Guests must never set these; the host injects
/// auth/cookie/host material itself when policy requires it.
pub const BROKER_BLOCKED_REQUEST_HEADER_NAMES: &[&str] =
  &["authorization", "proxy-authorization", "cookie", "set-cookie", "host"];
/// Legacy constant retained for test references; blob/stream bodies are implemented in Phase 6.
pub const BROKER_UNSUPPORTED_BLOB_STREAM_MESSAGE: &str = "unsupported";

/// Validate a broker `relative_path` as a confined relative path with an optional query
/// suffix (`path?k=v&k=v`). Rejects empty values, absolute URLs/schemes, authority prefixes
/// (`//`), backslashes, `.`/`..` segments, fragments, control characters, and credential-like
/// query keys. The query suffix is the only way for a guest to convey GTX query pairs (the
/// v1 `broker-request` record has no query field); values must already be percent-encoded.
pub(crate) fn validate_broker_relative_path(path: &str) -> Result<(), BrokerFetchError> {
  if path.is_empty() {
    return Err(BrokerFetchError::PathConfined);
  }
  if path != path.trim() {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.chars().any(|c| c.is_control()) {
    return Err(BrokerFetchError::PathConfined);
  }
  // Split an optional `?query` suffix once; the path part stays confined, the query is validated
  // separately. Fragments (`#`) remain rejected in both parts.
  let (path_part, query_part) = match path.split_once('?') {
    Some((p, q)) => (p, Some(q)),
    None => (path, None),
  };
  validate_path_part(path_part)?;
  if let Some(query) = query_part {
    validate_query_part(query)?;
  }
  Ok(())
}

fn validate_fixed_endpoint_scope(
  endpoint_id: &str,
  capability_id: &str,
  relative_path: &str,
) -> Result<(), BrokerFetchError> {
  if endpoint_id == EDGE_TTS_ENDPOINT_ALIAS
    && capability_id == crate::domain::service_capability::SPEECH_SYNTHESIZE_CAPABILITY_ID
    && relative_path != EDGE_TTS_SYNTHESIZE_PATH
  {
    return Err(BrokerFetchError::PathConfined);
  }
  Ok(())
}

/// Validate the path portion (before any `?`): relative, no scheme/authority/traversal/fragment.
fn validate_path_part(path: &str) -> Result<(), BrokerFetchError> {
  if path.is_empty() {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.starts_with('/') || path.starts_with('\\') {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.starts_with("//") {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.contains('\\') {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.contains("://") {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.contains('#') {
    return Err(BrokerFetchError::PathConfined);
  }
  if path.contains(':') {
    return Err(BrokerFetchError::PathConfined);
  }
  for segment in path.split('/') {
    if segment.is_empty() || segment == "." || segment == ".." {
      return Err(BrokerFetchError::PathConfined);
    }
  }
  Ok(())
}

/// Validate a query suffix (`k=v&k=v`): bounded pairs, no fragments/controls, no
/// credential-like keys. Values are already percent-encoded by the guest and are not re-encoded.
fn validate_query_part(query: &str) -> Result<(), BrokerFetchError> {
  if query.is_empty() {
    return Ok(());
  }
  if query.contains('#') || query.chars().any(|c| c.is_control()) {
    return Err(BrokerFetchError::PathConfined);
  }
  if query.matches('&').count() >= BROKER_QUERY_MAX_PAIRS {
    return Err(BrokerFetchError::LimitExceeded);
  }
  for pair in query.split('&') {
    if pair.is_empty() {
      return Err(BrokerFetchError::PathConfined);
    }
    let key = match pair.split_once('=') {
      Some((k, _)) => k,
      None => pair,
    };
    if key.is_empty() || key.len() > BROKER_QUERY_KEY_MAX_BYTES {
      return Err(BrokerFetchError::PathConfined);
    }
    if credential_like_query_key(key) {
      return Err(BrokerFetchError::HeaderBlocked);
    }
  }
  Ok(())
}

/// True when a query key looks like it carries credentials (mirrors the broker's secret-key heuristic).
fn credential_like_query_key(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  matches!(
    lower.as_str(),
    "api_key"
      | "apikey"
      | "access_token"
      | "token"
      | "authorization"
      | "auth"
      | "key"
      | "secret"
      | "password"
      | "passwd"
      | "credential"
      | "credentials"
  ) || lower.contains("token")
    || lower.contains("secret")
    || lower.contains("password")
    || lower.contains("auth")
}

/// Validate broker request headers: count/size bounds, no control characters in name/value, and
/// case-insensitive block of sensitive header names from [`BROKER_BLOCKED_REQUEST_HEADER_NAMES`].
pub(crate) fn validate_broker_headers(headers: &[(String, String)]) -> Result<(), BrokerFetchError> {
  if headers.len() > BROKER_MAX_HEADERS {
    return Err(BrokerFetchError::HeaderBlocked);
  }
  for (name, value) in headers {
    if name.is_empty() {
      return Err(BrokerFetchError::HeaderBlocked);
    }
    if name.len() > BROKER_MAX_HEADER_NAME_BYTES || value.len() > BROKER_MAX_HEADER_VALUE_BYTES {
      return Err(BrokerFetchError::HeaderBlocked);
    }
    if name.chars().any(|c| c.is_control()) || value.chars().any(|c| c.is_control()) {
      return Err(BrokerFetchError::HeaderBlocked);
    }
    let lower = name.to_ascii_lowercase();
    if BROKER_BLOCKED_REQUEST_HEADER_NAMES.contains(&lower.as_str()) {
      return Err(BrokerFetchError::HeaderBlocked);
    }
  }
  Ok(())
}

/// Broker handle abstraction for the host `broker-fetch` import. Phase 2 implementors return
/// grant-authorized synthetic responses for the conformance suite; real HTTP transport is added
/// in Phase 5. The host runtime authorizes before calling `fetch`; the broker receives the
/// [`BrokerAuthorization`] (matched origin, auth policy, resource limits) for transport.
/// Implementations must still be cancellation-aware as a defense-in-depth measure.
pub trait BrokerHandle: Send + Sync {
  /// Execute a brokered fetch. Authorization is already enforced by the host runtime; the
  /// broker receives `principal`/`grant` for context/audit and `authorization` for transport.
  /// Returns a typed broker result; `Err(broker-error)` is a normal guest-visible denial, while
  /// a trap surfaces as a host error.
  #[allow(clippy::too_many_arguments)]
  fn fetch(
    &self,
    principal: &PluginPrincipal,
    grant: &ExecutionGrantSet,
    request: BrokerFetchRequest,
    authorization: BrokerAuthorization,
    cancel: &CancelToken,
    deadline: Option<Instant>,
  ) -> std::pin::Pin<Box<dyn std::future::Future<Output = BrokerFetchOutcome> + Send + '_>>;
}

/// Host-side broker fetch input derived from the WIT `broker-request`.
#[derive(Debug, Clone)]
pub struct BrokerFetchRequest {
  pub endpoint_id: String,
  pub relative_path: String,
  pub method: String,
  pub headers: Vec<(String, String)>,
  pub body: BrokerRequestBody,
}

/// Broker request body union mirroring the WIT `broker-body-request`.
#[derive(Debug, Clone)]
pub enum BrokerRequestBody {
  Empty,
  Json(Vec<u8>),
  /// Blob body already materialized by the host (byte_len used for grant limit checks).
  Blob {
    bytes: Vec<u8>,
    byte_len: usize,
  },
}

/// Broker fetch outcome: the WIT `result<broker-response, broker-error>` lifted to host types.
pub type BrokerFetchOutcome = Result<BrokerFetchResponse, BrokerFetchError>;

/// Broker fetch response derived from the WIT `broker-response`.
#[derive(Debug, Clone)]
pub struct BrokerFetchResponse {
  pub status: u16,
  pub headers: Vec<(String, String)>,
  pub body: BrokerResponseBody,
}

/// Broker response body union. Json/Bytes carry payload bytes; Stream carries a host reader
/// handle already bound to a network-binary stream pair created by the broker transport path.
/// The host adopts it into the request's stream table before handing a reader resource to the guest.
#[derive(Debug, Clone)]
pub enum BrokerResponseBody {
  Json(Vec<u8>),
  Bytes {
    content_type: Option<String>,
    bytes: Vec<u8>,
  },
  Stream {
    reader: StreamReaderHandle,
  },
}

/// Stable broker error mirroring the WIT `broker-error` variant.
#[derive(Debug, Clone)]
pub enum BrokerFetchError {
  NotApproved,
  MethodNotAllowed,
  PathConfined,
  HeaderBlocked,
  Network(String),
  Timeout,
  Cancelled,
  LimitExceeded,
  Internal(String),
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn relative_path_accepts_confined_segments() {
    assert!(validate_broker_relative_path("v1/test").is_ok());
    assert!(validate_broker_relative_path("models").is_ok());
    assert!(validate_broker_relative_path("a/b/c.json").is_ok());
    // Query suffix is accepted for endpoints like GTX that require query pairs.
    assert!(validate_broker_relative_path("translate_a/single?client=gtx&sl=auto&tl=en&q=Hi").is_ok());
    assert!(validate_broker_relative_path("translate_a/single?").is_ok());
  }

  #[test]
  fn edge_tts_scope_stays_fixed_even_with_a_base_path() {
    assert!(validate_fixed_endpoint_scope("tts-api", "speech.synthesize@1", "v1/audio/speech").is_ok());
    assert!(validate_fixed_endpoint_scope("tts-api", "speech.synthesize@1", "api/v1/audio/speech").is_err());
    assert!(validate_fixed_endpoint_scope("tts-api", "speech.synthesize@1", "v1/audio/speech?route=other").is_err());
  }

  #[test]
  fn relative_path_rejects_absolute_url_traversal_and_controls() {
    let path_confined = [
      "",
      "/abs",
      "//evil",
      "https://evil.example/x",
      "https:evil",
      "C:\\windows",
      "a\\b",
      ".",
      "..",
      "a/../b",
      "a/./b",
      "a//b",
      "a#frag",
      " a",
      "a\0b",
      "a?b#c",
    ];
    for path in path_confined {
      assert!(
        matches!(validate_broker_relative_path(path), Err(BrokerFetchError::PathConfined)),
        "path {path:?} must be PathConfined"
      );
    }
    // Credential-like query keys are rejected as HeaderBlocked (not PathConfined).
    for path in ["a?api_key=secret", "a?token=x", "a?secret=y"] {
      assert!(
        matches!(
          validate_broker_relative_path(path),
          Err(BrokerFetchError::HeaderBlocked)
        ),
        "path {path:?} must be HeaderBlocked"
      );
    }
  }

  #[test]
  fn headers_block_sensitive_names_case_insensitive() {
    for name in ["Authorization", "PROXY-AUTHORIZATION", "Cookie", "Set-Cookie", "Host"] {
      let headers = vec![(name.into(), "x".into())];
      assert!(
        matches!(validate_broker_headers(&headers), Err(BrokerFetchError::HeaderBlocked)),
        "header {name} must be blocked"
      );
    }
    assert!(validate_broker_headers(&[("x-custom".into(), "ok".into())]).is_ok());
  }

  #[test]
  fn headers_reject_control_characters() {
    assert!(matches!(
      validate_broker_headers(&[("x\0name".into(), "v".into())]),
      Err(BrokerFetchError::HeaderBlocked)
    ));
    assert!(matches!(
      validate_broker_headers(&[("x-name".into(), "v\n".into())]),
      Err(BrokerFetchError::HeaderBlocked)
    ));
  }

  #[test]
  fn truncate_utf8_bytes_never_splits_multibyte() {
    // "héllo" = h(1) é(2) l(1) l(1) o(1) = 6 bytes
    let input = "héllo";
    assert_eq!(input.len(), 6);
    // Truncate to 2 bytes: byte 2 is mid-é, must back off to byte 1 ('h').
    let truncated = truncate_utf8_bytes(input, 2);
    assert_eq!(truncated, "h");
    assert_eq!(truncated.len(), 1);
    // Truncate to 3 bytes: byte 3 is a char boundary (start of 'l'), returns "hé".
    let truncated = truncate_utf8_bytes(input, 3);
    assert_eq!(truncated, "hé");
    assert_eq!(truncated.len(), 3);
    // Truncate to 4 bytes: byte 4 is a char boundary (start of 2nd 'l'), returns "hél".
    let truncated = truncate_utf8_bytes(input, 4);
    assert_eq!(truncated, "hél");
    // No truncation needed.
    let truncated = truncate_utf8_bytes(input, 100);
    assert_eq!(truncated, "héllo");
  }

  #[test]
  fn truncate_utf8_bytes_handles_multibyte_only_input() {
    // Three 3-byte CJK characters = 9 bytes.
    let input = "你好吗";
    assert_eq!(input.len(), 9);
    // Truncate to 4 bytes: must back off to 3 bytes (one char).
    let truncated = truncate_utf8_bytes(input, 4);
    assert_eq!(truncated, "你");
    // Truncate to 7 bytes: must back off to 6 bytes (two chars).
    let truncated = truncate_utf8_bytes(input, 7);
    assert_eq!(truncated, "你好");
  }

  #[test]
  fn truncate_utf8_bytes_empty_and_exact() {
    assert_eq!(truncate_utf8_bytes("", 10), "");
    assert_eq!(truncate_utf8_bytes("abc", 3), "abc");
    // Exact boundary on multibyte.
    assert_eq!(truncate_utf8_bytes("你好", 6), "你好");
  }
}
