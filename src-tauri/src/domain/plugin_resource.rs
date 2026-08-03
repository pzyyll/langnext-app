// ABOUTME: Host-owned blob/stream resource identity, ownership, direction, and terminal states.
// ABOUTME: Opaque IDs never reveal paths, pointers, or secrets; scoped to one principal/request.
use crate::domain::cancel::CancelToken;
use crate::domain::runtime_plugin::PluginPrincipal;
use rand::RngCore;
use std::fmt;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Cryptographically unpredictable opaque resource id (16 random bytes, hex-encoded).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ResourceId([u8; RESOURCE_ID_BYTES]);

/// Byte length of a raw resource id.
pub const RESOURCE_ID_BYTES: usize = 16;
/// Hex character length of a resource id string.
pub const RESOURCE_ID_HEX_LEN: usize = RESOURCE_ID_BYTES * 2;
/// Default blob/stream lifetime when no explicit expiry is supplied.
pub const RESOURCE_DEFAULT_TTL: Duration = Duration::from_secs(120);
/// Maximum single blob-write/read chunk accepted by the host (1 MiB).
pub const RESOURCE_MAX_CHUNK_BYTES: u64 = 1024 * 1024;
/// Absolute upper bound on any blob/stream max-bytes declaration (32 MiB).
pub const RESOURCE_ABSOLUTE_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Default stream buffer capacity in frames (backpressure threshold).
pub const STREAM_DEFAULT_BUFFER_FRAMES: usize = 8;
/// Maximum stream buffer capacity in frames.
pub const STREAM_ABSOLUTE_BUFFER_FRAMES: usize = 64;
/// Maximum sanitized terminal failure code length.
pub const RESOURCE_ERROR_CODE_MAX_LEN: usize = 64;
/// Host-private temp-file backing threshold (bytes). Phase 6 keeps all blobs in memory;
/// values at or above this threshold are documented for a later backing switch without path exposure.
pub const BLOB_TEMP_FILE_BACKING_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;

impl ResourceId {
  /// Generate a new cryptographically unpredictable resource id.
  pub fn generate() -> Self {
    let mut bytes = [0u8; RESOURCE_ID_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    Self(bytes)
  }

  /// Lowercase hex representation (never logged with owner data).
  pub fn to_hex(self) -> String {
    hex::encode(self.0)
  }

  /// Borrow the raw id bytes.
  pub fn as_bytes(&self) -> &[u8; RESOURCE_ID_BYTES] {
    &self.0
  }
}

impl fmt::Debug for ResourceId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    // Opaque: only show a short prefix so logs never dump full ids with owner context.
    write!(f, "ResourceId({})", &self.to_hex()[..8])
  }
}

/// Blob/stream direction. `Input` = guest reads; `Output` = guest writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceDirection {
  Input,
  Output,
}

impl ResourceDirection {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Input => "input",
      Self::Output => "output",
    }
  }
}

/// Immutable stream payload kind bound at creation (matches WIT `stream-kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
  NetworkBinary,
  LlmDelta,
}

impl StreamKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::NetworkBinary => "network-binary",
      Self::LlmDelta => "llm-delta",
    }
  }
}

/// Closed LLM completion status (matches WIT `llm-completion-status`). The host never infers
/// this from opaque delta bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmCompletionStatus {
  Stop,
  Length,
  ToolCalls,
}

impl LlmCompletionStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Stop => "stop",
      Self::Length => "length",
      Self::ToolCalls => "tool-calls",
    }
  }
}

/// Structured tool-call delta (matches WIT `llm-tool-call-delta`). Arguments are copied JSON
/// bytes, never an opaque stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmToolCallDelta {
  pub id: String,
  pub name: String,
  pub arguments_json: Vec<u8>,
}

/// Closed structured LLM delta contract for v1 streaming chat (matches WIT `llm-delta`). Every
/// variant is preserved losslessly in the domain [`StreamFrame`] representation; the host never
/// encodes arbitrary JSON then guesses on receive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmDelta {
  Text(String),
  Reasoning(String),
  ToolCall(LlmToolCallDelta),
  Complete(LlmCompletionStatus),
}

/// Owner principal binding for a host-owned resource. Cross-instance/request/package use is denied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceOwner {
  plugin_id: String,
  instance_id: Uuid,
  request_id: String,
  package_digest: Option<String>,
  capability_id: String,
}

impl ResourceOwner {
  /// Bind ownership from an execution principal.
  pub fn from_principal(principal: &PluginPrincipal) -> Self {
    Self {
      plugin_id: principal.plugin_id().as_str().to_string(),
      instance_id: principal.instance_id(),
      request_id: principal.request_id().as_str().to_string(),
      package_digest: principal.package_digest().map(|d| d.as_str().to_string()),
      capability_id: principal.capability_id().as_str().to_string(),
    }
  }

  /// True when `other` is the same principal scope (plugin, instance, request, package, capability).
  pub fn matches(&self, other: &ResourceOwner) -> bool {
    self.plugin_id == other.plugin_id
      && self.instance_id == other.instance_id
      && self.request_id == other.request_id
      && self.package_digest == other.package_digest
      && self.capability_id == other.capability_id
  }

  /// True when this owner matches the live principal.
  pub fn matches_principal(&self, principal: &PluginPrincipal) -> bool {
    self.matches(&Self::from_principal(principal))
  }

  pub fn plugin_id(&self) -> &str {
    &self.plugin_id
  }

  pub fn instance_id(&self) -> Uuid {
    self.instance_id
  }

  pub fn request_id(&self) -> &str {
    &self.request_id
  }

  pub fn package_digest(&self) -> Option<&str> {
    self.package_digest.as_deref()
  }

  pub fn capability_id(&self) -> &str {
    &self.capability_id
  }
}

/// Media metadata carried with blob/stream resources (content-type is metadata only).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MediaMetadata {
  pub content_type: Option<String>,
  pub byte_length: Option<u64>,
}

/// Terminal lifecycle states for blob/stream resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceLifecycle {
  /// Accepts producer/consumer operations within bounds.
  Open,
  /// Producer sealed the resource; readers may still drain closed content.
  Closed,
  /// Hard-released; all subsequent ops fail without revealing owner data.
  Discarded,
  /// Cooperative cancellation; subsequent ops fail as cancelled.
  Cancelled,
  /// Past expiry; subsequent ops fail as closed.
  Expired,
}

impl ResourceLifecycle {
  pub fn is_terminal_release(&self) -> bool {
    matches!(self, Self::Discarded | Self::Expired | Self::Cancelled)
  }

  pub fn allows_read(&self) -> bool {
    matches!(self, Self::Open | Self::Closed)
  }

  pub fn allows_write(&self) -> bool {
    matches!(self, Self::Open)
  }
}

/// Stream terminal reason queryable via `stream-state` (matches WIT `stream-terminal-state`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamTerminalState {
  Finished,
  Failed(String),
  Cancelled,
}

impl StreamTerminalState {
  /// Sanitize a guest/host failure code to a bounded stable string.
  pub fn failed_sanitized(code: &str) -> Self {
    let sanitized: String = code
      .chars()
      .filter(|c| c.is_ascii_graphic() && *c != '\\')
      .take(RESOURCE_ERROR_CODE_MAX_LEN)
      .collect();
    let code = if sanitized.is_empty() {
      "failed".into()
    } else {
      sanitized
    };
    Self::Failed(code)
  }
}

/// Stable resource operation errors (never include owner data or paths).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceError {
  NotOwned,
  WrongDirection,
  Exhausted,
  OutOfBounds,
  Closed,
  Cancelled,
  Internal(String),
}

impl ResourceError {
  pub fn as_code(&self) -> &'static str {
    match self {
      Self::NotOwned => "not-owned",
      Self::WrongDirection => "wrong-direction",
      Self::Exhausted => "exhausted",
      Self::OutOfBounds => "out-of-bounds",
      Self::Closed => "closed",
      Self::Cancelled => "cancelled",
      Self::Internal(_) => "internal",
    }
  }
}

impl fmt::Display for ResourceError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Internal(msg) => write!(f, "internal: {msg}"),
      other => write!(f, "{}", other.as_code()),
    }
  }
}

/// Shared creation parameters for blob and stream resources.
#[derive(Debug, Clone)]
pub struct ResourceCreateParams {
  pub owner: ResourceOwner,
  pub direction: ResourceDirection,
  pub content_type: Option<String>,
  pub max_bytes: u64,
  pub expires_at: Option<Instant>,
  pub cancel: CancelToken,
}

impl ResourceCreateParams {
  /// Validate max-bytes and content-type bounds before allocation.
  pub fn validate(&self) -> Result<(), ResourceError> {
    if self.max_bytes == 0 || self.max_bytes > RESOURCE_ABSOLUTE_MAX_BYTES {
      return Err(ResourceError::OutOfBounds);
    }
    if let Some(ct) = &self.content_type {
      if ct.is_empty() || ct.len() > 128 || ct.chars().any(|c| c.is_control()) {
        return Err(ResourceError::Internal("invalid content-type".into()));
      }
    }
    Ok(())
  }

  /// Default expiry from now when none supplied.
  pub fn effective_expiry(&self) -> Instant {
    self.expires_at.unwrap_or_else(|| Instant::now() + RESOURCE_DEFAULT_TTL)
  }
}

/// Allowed broker response body variants for one network grant entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkResponseBodyModes {
  json: bool,
  bytes: bool,
  stream: bool,
}

impl NetworkResponseBodyModes {
  /// JSON-only (legacy/default; preserves existing grant authority digests).
  pub const JSON_ONLY: Self = Self {
    json: true,
    bytes: false,
    stream: false,
  };

  /// JSON + bounded binary bytes (Edge TTS and similar).
  pub const JSON_AND_BYTES: Self = Self {
    json: true,
    bytes: true,
    stream: false,
  };

  /// Bytes-only (binary endpoints that never return JSON).
  pub const BYTES_ONLY: Self = Self {
    json: false,
    bytes: true,
    stream: false,
  };

  /// All modes (future streaming endpoints; not production-enabled for LLM yet).
  pub const ALL: Self = Self {
    json: true,
    bytes: true,
    stream: true,
  };

  pub fn allows_json(self) -> bool {
    self.json
  }

  pub fn allows_bytes(self) -> bool {
    self.bytes
  }

  pub fn allows_stream(self) -> bool {
    self.stream
  }

  /// Canonical stable string for persistence and authority digest (sorted tokens).
  pub fn as_canonical(self) -> String {
    let mut parts = Vec::with_capacity(3);
    if self.json {
      parts.push("json");
    }
    if self.bytes {
      parts.push("bytes");
    }
    if self.stream {
      parts.push("stream");
    }
    if parts.is_empty() {
      // Fail closed: empty is invalid authority; treat as json-only encoding.
      return "json".into();
    }
    parts.join(",")
  }

  pub fn parse(value: &str) -> Result<Self, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      return Ok(Self::JSON_ONLY);
    }
    let mut json = false;
    let mut bytes = false;
    let mut stream = false;
    for part in trimmed.split(',') {
      match part.trim() {
        "json" => json = true,
        "bytes" => bytes = true,
        "stream" => stream = true,
        other if other.is_empty() => continue,
        other => return Err(format!("invalid network response body mode: {other}")),
      }
    }
    if !json && !bytes && !stream {
      return Err("network response body modes must allow at least one mode".into());
    }
    Ok(Self { json, bytes, stream })
  }

  /// True when this equals the default JSON-only mode (omitted from authority digest).
  pub fn is_default(self) -> bool {
    self == Self::JSON_ONLY
  }
}

impl Default for NetworkResponseBodyModes {
  fn default() -> Self {
    Self::JSON_ONLY
  }
}

/// Selected broker response body mode for one fetch (guest request within grant).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkResponseBodyMode {
  Json,
  Bytes,
  Stream,
}

impl NetworkResponseBodyMode {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Json => "json",
      Self::Bytes => "bytes",
      Self::Stream => "stream",
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resource_id_is_unpredictable_and_unique() {
    let a = ResourceId::generate();
    let b = ResourceId::generate();
    assert_ne!(a, b);
    assert_eq!(a.to_hex().len(), RESOURCE_ID_HEX_LEN);
  }

  #[test]
  fn response_body_modes_round_trip() {
    assert_eq!(NetworkResponseBodyModes::JSON_ONLY.as_canonical(), "json");
    assert_eq!(NetworkResponseBodyModes::JSON_AND_BYTES.as_canonical(), "json,bytes");
    assert_eq!(
      NetworkResponseBodyModes::parse("bytes,json").unwrap().as_canonical(),
      "json,bytes"
    );
    assert!(NetworkResponseBodyModes::parse("xml").is_err());
  }

  #[test]
  fn failed_terminal_sanitizes_code() {
    let t = StreamTerminalState::failed_sanitized("bad\ncode\\x");
    match t {
      StreamTerminalState::Failed(code) => {
        assert!(!code.contains('\n'));
        assert!(!code.contains('\\'));
      }
      _ => panic!("expected failed"),
    }
  }
}
