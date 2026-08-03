// ABOUTME: Shared no_std OpenAI Responses protocol: /responses body construction, models and
// ABOUTME: typed event-stream parsing, status mapping, preference envelopes; ports the TS plugin.
#![no_std]

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

/// Maximum model key length accepted from a provider models page (mirrors the TypeScript
/// plugin's `MAX_MODEL_KEY_LEN`).
pub const MAX_MODEL_KEY_LEN: usize = 256;
/// Maximum model entries accepted in one provider models page (mirrors the TypeScript
/// plugin's `MAX_MODELS_PER_PAGE`).
pub const MAX_MODELS_PER_PAGE: usize = 500;
/// Provider models relative path under the bound Base URL.
pub const MODELS_PATH: &str = "models";
/// Provider Responses API relative path under the bound Base URL.
pub const RESPONSES_PATH: &str = "responses";
/// Maximum images accepted in one chat request (the current TypeScript plugin supports one).
pub const MAX_CHAT_IMAGES: usize = 1;
/// SSE `data:` payload that marks the end of a Responses event stream.
pub const SSE_DONE: &[u8] = b"[DONE]";
/// Fallback error message when an `error` stream event carries no readable message.
pub const STREAM_ERROR_FALLBACK_MESSAGE: &str = "Provider stream error";
/// Fallback error message when a `response.failed` stream event carries no readable message.
pub const STREAM_FAILED_FALLBACK_MESSAGE: &str = "Provider response failed";

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
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(ProtocolError::new("invalid model key"));
  }
  Ok(key.to_string())
}

/// Parse one OpenAI models page: `{"data":[{"id":...},...]}`. Bounded at
/// [`MAX_MODELS_PER_PAGE`]; each id is normalized. The current plugin projects no remote
/// display name, so descriptors carry `label = None` at the guest boundary.
pub fn parse_models_page(body: &[u8]) -> Result<Vec<String>, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("model list is not JSON"))?;
  if !value.is_object() {
    return Err(ProtocolError::new("invalid model list page"));
  }
  let data = value
    .get("data")
    .and_then(|data| data.as_array())
    .ok_or_else(|| ProtocolError::new("model list missing data array"))?;
  if data.len() > MAX_MODELS_PER_PAGE {
    return Err(ProtocolError::new("model list page too large"));
  }
  let mut models = Vec::with_capacity(data.len());
  for entry in data {
    let id = entry
      .get("id")
      .and_then(|id| id.as_str())
      .ok_or_else(|| ProtocolError::new("model list entry missing id"))?;
    models.push(normalize_model_key(id)?);
  }
  Ok(models)
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
/// image data URL; image bytes never cross WIT semantic fields.
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

/// Responses user input for an image request (TypeScript `responsesUserInput`): a plain
/// string without an image, or one user turn with `input_text` plus `input_image` parts
/// carrying the base64 PNG data URL.
fn push_responses_input(out: &mut String, user_prompt: &str, image_png_base64: Option<&str>) {
  match image_png_base64 {
    Some(image) => {
      out.push_str("[{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":");
      push_json_string(out, user_prompt);
      out.push_str("},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,");
      out.push_str(image);
      out.push_str("\"}]}]");
    }
    None => push_json_string(out, user_prompt),
  }
}

/// Build the /responses request body with the exact key order of the TypeScript plugin:
/// `model`, `instructions`, `input`, `stream`, then optional `temperature` and
/// `max_output_tokens`. The optional image base64 is embedded as a data URL.
pub fn build_responses_body(
  model: &str,
  instructions: &str,
  user_prompt: &str,
  temperature: Option<f64>,
  max_tokens: Option<u64>,
  image_png_base64: Option<&str>,
  stream: bool,
) -> String {
  let mut body = String::from("{\"model\":");
  push_json_string(&mut body, model);
  body.push_str(",\"instructions\":");
  push_json_string(&mut body, instructions);
  body.push_str(",\"input\":");
  push_responses_input(&mut body, user_prompt, image_png_base64);
  body.push_str(",\"stream\":");
  body.push_str(if stream { "true" } else { "false" });
  if let Some(temperature) = temperature {
    body.push_str(",\"temperature\":");
    body.push_str(&format_number(temperature));
  }
  if let Some(max_tokens) = max_tokens {
    body.push_str(",\"max_output_tokens\":");
    body.push_str(&max_tokens.to_string());
  }
  body.push('}');
  body
}

/// Format a temperature value the same way JS `JSON.stringify` does for fixture values:
/// Rust's shortest round-trip rendering matches JSON for these bounded numbers (e.g. 0.2,
/// 128). The committed fixtures only use such values.
fn format_number(value: f64) -> String {
  format!("{value}")
}

/// Parse one unary /responses response: the `output_text` convenience field wins; otherwise
/// text blocks of type `output_text`/`text` are joined from the `output` array. The result
/// is trimmed and must be non-empty (TypeScript `parseChatResponse`).
pub fn parse_chat_content(body: &[u8]) -> Result<String, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("responses body is not JSON"))?;
  if !value.is_object() {
    return Err(ProtocolError::new("invalid responses body"));
  }
  if let Some(output_text) = value.get("output_text").and_then(|text| text.as_str()) {
    if !output_text.trim().is_empty() {
      return Ok(output_text.trim().to_string());
    }
  }
  let output = value
    .get("output")
    .and_then(|output| output.as_array())
    .ok_or_else(|| ProtocolError::new("responses missing output"))?;
  let mut parts = String::new();
  for item in output {
    let Some(content) = item.get("content").and_then(|content| content.as_array()) else {
      continue;
    };
    for block in content {
      let block_type = block.get("type").and_then(|ty| ty.as_str()).unwrap_or("");
      if block_type != "output_text" && block_type != "text" {
        continue;
      }
      if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
        if !text.is_empty() {
          parts.push_str(text);
        }
      }
    }
  }
  let joined = parts.trim().to_string();
  if joined.is_empty() {
    return Err(ProtocolError::new("responses content is empty"));
  }
  Ok(joined)
}

/// True when the SSE event name marks a content delta (must be valid JSON) — TypeScript
/// `isDeltaStreamEventName`.
fn is_delta_event_name(event_name: Option<&str>) -> bool {
  event_name.is_some_and(|name| name.contains("delta"))
}

/// True for terminal failure event names that must surface to the UI — TypeScript
/// `isFailureStreamEventName`.
fn is_failure_event_name(event_name: Option<&str>) -> bool {
  matches!(event_name, Some("error" | "response.failed"))
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

/// Non-empty trimmed string helper (TypeScript `nonEmptyString`).
fn non_empty_string(value: &Value) -> Option<String> {
  let text = value.as_str()?.trim();
  if text.is_empty() {
    None
  } else {
    Some(text.to_string())
  }
}

/// Extract the message from a Responses `error` stream event (TypeScript
/// `extractStreamErrorMessage`): top-level message, then nested error.message / error.code,
/// then top-level code, else the fallback message.
pub fn extract_stream_error_message(value: &Value) -> String {
  if let Some(message) = value.get("message").and_then(non_empty_string) {
    return message;
  }
  if let Some(error) = value.get("error").filter(|error| error.is_object()) {
    if let Some(message) = error.get("message").and_then(non_empty_string) {
      return message;
    }
    if let Some(code) = error.get("code").and_then(non_empty_string) {
      return code;
    }
  }
  if let Some(code) = value.get("code").and_then(non_empty_string) {
    return code;
  }
  String::from(STREAM_ERROR_FALLBACK_MESSAGE)
}

/// Extract the message from a Responses `response.failed` stream event (TypeScript
/// `extractFailedResponseMessage`): response.error.message, then response.error.code, else
/// the fallback message.
pub fn extract_failed_response_message(value: &Value) -> String {
  if let Some(response) = value.get("response").filter(|response| response.is_object()) {
    if let Some(error) = response.get("error").filter(|error| error.is_object()) {
      if let Some(message) = error.get("message").and_then(non_empty_string) {
        return message;
      }
      if let Some(code) = error.get("code").and_then(non_empty_string) {
        return code;
      }
    }
  }
  String::from(STREAM_FAILED_FALLBACK_MESSAGE)
}

/// One stream-event parse outcome (TypeScript `StreamParseResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEventOutcome {
  Ignore,
  Delta(String),
  Error(String),
}

/// Parse one Responses SSE event. Lifecycle events (`response.created`/`in_progress`/
/// `completed`) and non-JSON non-delta payloads are ignored; failure events surface a
/// bounded message; delta events must be valid JSON (a malformed delta is a stable error).
/// Truncated lifecycle payloads are tolerated exactly like the current TypeScript plugin.
pub fn parse_stream_event(data: &[u8], event_name: Option<&str>) -> Result<StreamEventOutcome, ProtocolError> {
  if data.is_empty() || data == SSE_DONE {
    return Ok(StreamEventOutcome::Ignore);
  }
  let value: Value = match serde_json::from_slice(data) {
    Ok(value) => value,
    Err(_) => {
      // Failure events must still surface even when the payload is malformed.
      if is_failure_event_name(event_name) {
        return Ok(StreamEventOutcome::Error(String::from(STREAM_ERROR_FALLBACK_MESSAGE)));
      }
      // Content only comes from *.delta events. Lifecycle payloads such as
      // response.completed can be large and occasionally truncated; never fail the
      // stream after deltas were already delivered.
      if is_delta_event_name(event_name) {
        return Err(ProtocolError::new("stream event is not JSON"));
      }
      return Ok(StreamEventOutcome::Ignore);
    }
  };
  if !value.is_object() {
    return Ok(StreamEventOutcome::Ignore);
  }
  // Prefer payload `type` (SDK-style), fall back to SSE event name.
  let ty = value
    .get("type")
    .and_then(|ty| ty.as_str())
    .or(event_name)
    .unwrap_or("");
  match ty {
    // Lifecycle: emitted once; no content contribution.
    "response.created" | "response.in_progress" | "response.completed" => Ok(StreamEventOutcome::Ignore),
    // Terminal failures — surface message to workflow/toast.
    "error" => Ok(StreamEventOutcome::Error(extract_stream_error_message(&value))),
    "response.failed" => Ok(StreamEventOutcome::Error(extract_failed_response_message(&value))),
    _ => {
      // Text streaming deltas (multiple).
      if ty == "response.output_text.delta" || ty.ends_with("output_text.delta") {
        if let Some(delta) = value.get("delta").and_then(|delta| delta.as_str()) {
          if !delta.is_empty() {
            return Ok(StreamEventOutcome::Delta(delta.to_string()));
          }
        }
        return Ok(StreamEventOutcome::Ignore);
      }
      // Compatibility: nested delta.text shapes from some proxies.
      if let Some(nested) = value
        .get("delta")
        .and_then(|delta| delta.get("text"))
        .and_then(|text| text.as_str())
      {
        if !nested.is_empty() {
          return Ok(StreamEventOutcome::Delta(nested.to_string()));
        }
      }
      Ok(StreamEventOutcome::Ignore)
    }
  }
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
