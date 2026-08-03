// ABOUTME: Shared no_std Anthropic Messages API protocol: body construction, paginated models,
// ABOUTME: stream-delta and preference-envelope parsing; ports the TypeScript plugin (host owns credentials).
#![no_std]

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

/// Maximum model entries accepted in one provider models page (mirrors the TypeScript
/// plugin's `MAX_MODELS_PER_PAGE`).
pub const MAX_MODELS_PER_PAGE: usize = 500;
/// Named maximum pages the guest traverses for one aggregate Models List. The frozen WIT
/// models-list ABI has no continuation field; bounded page traversal stays inside the guest.
pub const MAX_MODELS_PAGES: usize = 5;
/// Named maximum total models across all pages of one aggregate Models List.
pub const MAX_MODELS_TOTAL: usize = 1000;
/// Provider messages relative path under the bound Base URL.
pub const MESSAGES_PATH: &str = "v1/messages";
/// Provider models relative path under the bound Base URL.
pub const MODELS_PATH: &str = "v1/models";
/// Non-secret API version header value (TypeScript `ANTHROPIC_VERSION`).
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Non-secret API version header name requested by the guest.
pub const ANTHROPIC_VERSION_HEADER: &str = "anthropic-version";
/// Default max_tokens applied when the host preference envelope carries none (TypeScript
/// `DEFAULT_MAX_TOKENS`).
pub const DEFAULT_MAX_TOKENS: u64 = 32768;
/// Maximum images accepted in one chat request (the current TypeScript plugin supports one).
pub const MAX_CHAT_IMAGES: usize = 1;

/// Stable protocol failure with a bounded message (mapped to `invalid-response` by guests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

impl ProtocolError {
  pub fn new(message: impl Into<String>) -> Self {
    Self(message.into())
  }
}

/// Bounded provider status classification (mirrors the frontend executor's status mapping;
/// the guest never inspects provider error bodies).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderStatusError {
  Auth,
  RateLimited,
  Server,
  Client,
}

/// Map a provider HTTP status to a bounded error, or none for 2xx.
pub fn provider_status_error(status: u16) -> Option<ProviderStatusError> {
  match status {
    200..=299 => None,
    401 | 403 => Some(ProviderStatusError::Auth),
    429 => Some(ProviderStatusError::RateLimited),
    500..=599 => Some(ProviderStatusError::Server),
    _ => Some(ProviderStatusError::Client),
  }
}

/// Check one provider status for models/chat responses: 2xx passes, else a bounded error.
pub fn require_success(status: u16) -> Result<(), ProviderStatusError> {
  match provider_status_error(status) {
    None => Ok(()),
    Some(error) => Err(error),
  }
}

/// Normalize a provider model key: trim, non-empty, bounded length (TypeScript
/// `normalizeModelKey`).
pub fn normalize_model_key(raw: &str) -> Result<String, ProtocolError> {
  let key = raw.trim();
  if key.is_empty() || key.len() > 256 {
    return Err(ProtocolError::new("invalid model key"));
  }
  Ok(key.to_string())
}

/// One parsed Anthropic models page: normalized ids with optional display names plus the
/// continuation cursor when `has_more` is true (TypeScript `parseModelListPage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsPage {
  pub items: Vec<(String, Option<String>)>,
  pub continuation: Option<String>,
}

/// Parse one Anthropic models page: `{"data":[{"id":...,"display_name":...}],...}` with a
/// required boolean `has_more` and a non-empty `last_id` cursor when `has_more` is true.
pub fn parse_models_page(body: &[u8]) -> Result<ModelsPage, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("anthropic model list is not JSON"))?;
  if !value.is_object() {
    return Err(ProtocolError::new("invalid anthropic model list"));
  }
  let data = value
    .get("data")
    .and_then(|data| data.as_array())
    .ok_or_else(|| ProtocolError::new("anthropic model list missing data"))?;
  if data.len() > MAX_MODELS_PER_PAGE {
    return Err(ProtocolError::new("anthropic model list page too large"));
  }
  let mut items = Vec::with_capacity(data.len());
  for entry in data {
    if !entry.is_object() {
      return Err(ProtocolError::new("invalid anthropic model entry"));
    }
    let id = entry
      .get("id")
      .and_then(|id| id.as_str())
      .ok_or_else(|| ProtocolError::new("anthropic model missing id"))?;
    let display_name = entry
      .get("display_name")
      .and_then(|name| name.as_str())
      .map(ToString::to_string);
    items.push((normalize_model_key(id)?, display_name));
  }
  let has_more = value
    .get("has_more")
    .and_then(|has_more| has_more.as_bool())
    .ok_or_else(|| ProtocolError::new("anthropic model list missing has_more"))?;
  let mut continuation = None;
  if has_more {
    let last_id = value
      .get("last_id")
      .and_then(|last_id| last_id.as_str())
      .filter(|last_id| !last_id.is_empty())
      .ok_or_else(|| ProtocolError::new("anthropic continuation missing last_id"))?;
    continuation = Some(last_id.to_string());
  }
  Ok(ModelsPage { items, continuation })
}

/// Host-owned `LlmChatPreferencesV1` envelope copied into the guest. The host selects the
/// mode; the guest never infers or overrides `stream` from provider protocol details.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmPreferences {
  pub stream: bool,
  pub temperature: Option<f64>,
  pub max_tokens: Option<u64>,
}

/// Parse the host's serialized `LlmChatPreferencesV1` JSON envelope
/// (`{"stream":...,"temperature":...,"maxTokens":...,"thinking":...}`).
pub fn parse_preferences(bytes: &[u8]) -> Result<LlmPreferences, ProtocolError> {
  let value: Value = serde_json::from_slice(bytes).map_err(|_| ProtocolError::new("preferences are not JSON"))?;
  let stream = value
    .get("stream")
    .and_then(|v| v.as_bool())
    .ok_or_else(|| ProtocolError::new("preferences have no stream flag"))?;
  let temperature = value.get("temperature").and_then(|v| v.as_f64());
  let max_tokens = value.get("maxTokens").and_then(|v| v.as_u64());
  Ok(LlmPreferences {
    stream,
    temperature,
    max_tokens,
  })
}

/// Append one JSON string with JS `JSON.stringify` escaping (deterministic wire bytes).
fn push_json_string(out: &mut String, value: &str) {
  out.push('"');
  for byte in value.bytes() {
    match byte {
      b'"' => out.push_str("\\\""),
      b'\\' => out.push_str("\\\\"),
      0x08 => out.push_str("\\b"),
      0x0c => out.push_str("\\f"),
      b'\n' => out.push_str("\\n"),
      b'\r' => out.push_str("\\r"),
      b'\t' => out.push_str("\\t"),
      0x00..=0x1f => {
        out.push_str("\\u00");
        const HEX: &[u8; 16] = b"0123456789abcdef";
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
      }
      _ => out.push(byte as char),
    }
  }
  out.push('"');
}

/// Base64-encode bytes (standard alphabet with padding). Used only for the provider wire
/// image block; image bytes never cross WIT semantic fields.
pub fn base64_encode(bytes: &[u8]) -> String {
  const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
  let mut chunks = bytes.chunks_exact(3);
  for chunk in &mut chunks {
    let b0 = chunk[0] as u32;
    let b1 = chunk[1] as u32;
    let b2 = chunk[2] as u32;
    let n = (b0 << 16) | (b1 << 8) | b2;
    out.push(ALPHABET[(n >> 18) as usize & 0x3f] as char);
    out.push(ALPHABET[(n >> 12) as usize & 0x3f] as char);
    out.push(ALPHABET[(n >> 6) as usize & 0x3f] as char);
    out.push(ALPHABET[n as usize & 0x3f] as char);
  }
  let rest = chunks.remainder();
  if rest.len() == 1 {
    let b0 = rest[0] as u32;
    let n = b0 << 16;
    out.push(ALPHABET[(n >> 18) as usize & 0x3f] as char);
    out.push(ALPHABET[(n >> 12) as usize & 0x3f] as char);
    out.push('=');
    out.push('=');
  } else if rest.len() == 2 {
    let b0 = rest[0] as u32;
    let b1 = rest[1] as u32;
    let n = (b0 << 16) | (b1 << 8);
    out.push(ALPHABET[(n >> 18) as usize & 0x3f] as char);
    out.push(ALPHABET[(n >> 12) as usize & 0x3f] as char);
    out.push(ALPHABET[(n >> 6) as usize & 0x3f] as char);
    out.push('=');
  }
  out
}

/// User message content for an image request (TypeScript `anthropicUserContent`): an image
/// block plus a text block; without an image the plain prompt string is used.
fn push_user_content(out: &mut String, user_prompt: &str, image_png_base64: Option<&str>) {
  match image_png_base64 {
    Some(image) => {
      out.push_str("[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":");
      push_json_string(out, image);
      out.push_str("}},{\"type\":\"text\",\"text\":");
      push_json_string(out, user_prompt);
      out.push_str("}]");
    }
    None => push_json_string(out, user_prompt),
  }
}

/// Build the /v1/messages request body with the exact key order of the TypeScript plugin:
/// `model`, `system`, `messages`, `max_tokens`, then optional `stream` and `temperature`.
/// The host preference envelope supplies the max-token value; when absent the guest applies
/// the provider default (32768).
pub fn build_messages_body(
  model: &str,
  system: &str,
  user_prompt: &str,
  temperature: Option<f64>,
  max_tokens: Option<u64>,
  image_png_base64: Option<&str>,
  stream: bool,
) -> String {
  let mut body = String::from("{\"model\":");
  push_json_string(&mut body, model);
  body.push_str(",\"system\":");
  push_json_string(&mut body, system);
  body.push_str(",\"messages\":[{\"role\":\"user\",\"content\":");
  push_user_content(&mut body, user_prompt, image_png_base64);
  body.push_str("}],\"max_tokens\":");
  body.push_str(&max_tokens.unwrap_or(DEFAULT_MAX_TOKENS).to_string());
  if stream {
    body.push_str(",\"stream\":true");
  }
  if let Some(temperature) = temperature {
    body.push_str(",\"temperature\":");
    body.push_str(&format_number(temperature));
  }
  body.push('}');
  body
}

/// Format a temperature value the same way JS `JSON.stringify` does for fixture values:
/// Rust's shortest round-trip rendering matches JSON for these bounded numbers (e.g. 0.1).
/// The committed fixtures only use such values.
fn format_number(value: f64) -> String {
  format!("{value}")
}

/// Parse one unary /v1/messages response: text blocks joined from the `content` array
/// (blocks without a type default to `text`); the result is trimmed and must be non-empty
/// (TypeScript `parseChatResponse`).
pub fn parse_chat_content(body: &[u8]) -> Result<String, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("anthropic response is not JSON"))?;
  if !value.is_object() {
    return Err(ProtocolError::new("invalid anthropic response"));
  }
  let content = value
    .get("content")
    .and_then(|content| content.as_array())
    .ok_or_else(|| ProtocolError::new("anthropic response missing content"))?;
  let mut parts = String::new();
  for block in content {
    if !block.is_object() {
      continue;
    }
    let block_type = block.get("type").and_then(|ty| ty.as_str()).unwrap_or("text");
    if block_type != "text" {
      continue;
    }
    if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
      if !text.is_empty() {
        parts.push_str(text);
      }
    }
  }
  let joined = parts.trim().to_string();
  if joined.is_empty() {
    return Err(ProtocolError::new("anthropic content is empty"));
  }
  Ok(joined)
}

/// One decoded SSE event: optional event name plus the joined `data:` payload (TypeScript
/// `SseEvent` shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
  pub event: Option<String>,
  pub data: Vec<u8>,
}

/// Incremental SSE line decoder over raw stream frames. Follows the frontend `sse.ts`
/// rules: CRLF is normalized, `:` comment lines are ignored, `event:`/`data:` fields are
/// collected, and a blank line dispatches one event. A trailing partial event (name and/or
/// data lines already seen) stays buffered across frames.
#[derive(Debug, Default)]
pub struct SseEventDecoder {
  pending: Vec<u8>,
  current: Option<SseEvent>,
}

impl SseEventDecoder {
  pub fn new() -> Self {
    Self {
      pending: Vec::new(),
      current: None,
    }
  }

  /// Feed one frame of bytes; returns the completed events in order.
  pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
    let mut events = Vec::new();
    self.pending.extend_from_slice(bytes);
    let mut start = 0;
    for (index, byte) in self.pending.iter().enumerate() {
      if *byte != b'\n' {
        continue;
      }
      let line = &self.pending[start..index];
      start = index + 1;
      let line = line.strip_suffix(b"\r").unwrap_or(line);
      if let Some((field, value)) = parse_field_line(line) {
        match field {
          b"event" => {
            let event = self.current.get_or_insert_with(|| SseEvent {
              event: None,
              data: Vec::new(),
            });
            event.event = Some(String::from_utf8_lossy(value).into_owned());
          }
          b"data" => {
            let event = self.current.get_or_insert_with(|| SseEvent {
              event: None,
              data: Vec::new(),
            });
            if !event.data.is_empty() {
              event.data.push(b'\n');
            }
            event.data.extend_from_slice(value);
          }
          _ => {}
        }
      } else if line.is_empty() {
        if let Some(event) = self.current.take() {
          events.push(event);
        }
      }
    }
    self.pending.drain(..start);
    events
  }
}

/// Parse one SSE field line: `field:value` with one leading space trimmed; returns the
/// field name and value. Non-field lines (including `:` comments) return none.
fn parse_field_line(line: &[u8]) -> Option<(&[u8], &[u8])> {
  if line.is_empty() || line[0] == b':' {
    return None;
  }
  let colon = line.iter().position(|byte| *byte == b':')?;
  let field = &line[..colon];
  let mut value = &line[colon + 1..];
  if let Some(stripped) = value.strip_prefix(b" ") {
    value = stripped;
  }
  Some((field, value))
}

/// One stream-event parse outcome (TypeScript `StreamParseResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEventOutcome {
  Ignore,
  Delta(String),
}

/// Parse one Anthropic SSE event: only `content_block_delta` events with a
/// `text_delta`/`text` delta contribute text; everything else is ignored. A non-JSON
/// payload is a stable error (TypeScript `parseStreamEvent`).
pub fn parse_stream_event(data: &[u8], event_name: Option<&str>) -> Result<StreamEventOutcome, ProtocolError> {
  if data.is_empty() {
    return Ok(StreamEventOutcome::Ignore);
  }
  let value: Value = serde_json::from_slice(data).map_err(|_| ProtocolError::new("stream event is not JSON"))?;
  if !value.is_object() {
    return Ok(StreamEventOutcome::Ignore);
  }
  // Prefer payload `type` (SDK-style), fall back to SSE event name.
  let ty = value
    .get("type")
    .and_then(|ty| ty.as_str())
    .or(event_name)
    .unwrap_or("");
  if ty != "content_block_delta" {
    return Ok(StreamEventOutcome::Ignore);
  }
  let delta = value.get("delta").filter(|delta| delta.is_object());
  let Some(delta) = delta else {
    return Ok(StreamEventOutcome::Ignore);
  };
  let delta_type = delta.get("type").and_then(|ty| ty.as_str()).unwrap_or("text_delta");
  if delta_type != "text_delta" && delta_type != "text" {
    return Ok(StreamEventOutcome::Ignore);
  }
  if let Some(text) = delta.get("text").and_then(|text| text.as_str()) {
    if !text.is_empty() {
      return Ok(StreamEventOutcome::Delta(text.to_string()));
    }
  }
  Ok(StreamEventOutcome::Ignore)
}

/// Total bytes of a PNG image read through host Blob handles: bounded length plus PNG magic.
pub const CHAT_IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// PNG file magic required for chat image Blobs.
pub const PNG_MAGIC: [u8; 4] = [0x89, 0x50, 0x4e, 0x47];

/// Validate an image Blob's byte length (bounded) and PNG magic; returns the length.
pub fn validate_png_image(length: u64, head: &[u8]) -> Result<u64, ProtocolError> {
  if length == 0 || length > CHAT_IMAGE_MAX_BYTES {
    return Err(ProtocolError::new("chat image blob length is out of bounds"));
  }
  if head.len() < PNG_MAGIC.len() || head[..PNG_MAGIC.len()] != PNG_MAGIC {
    return Err(ProtocolError::new("chat image blob is not a png"));
  }
  Ok(length)
}
