// ABOUTME: Shared no_std DeepSeek protocol: chat.completions body with first-class thinking
// ABOUTME: policy, models/chat/SSE parsing, preference envelopes; ports the TypeScript plugin.
#![no_std]

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::Value;

/// Maximum model key length accepted from a provider models page (TypeScript
/// `MAX_MODEL_KEY_LEN`).
pub const MAX_MODEL_KEY_LEN: usize = 256;
/// Maximum model entries accepted in one provider models page (TypeScript
/// `MAX_MODELS_PER_PAGE`).
pub const MAX_MODELS_PER_PAGE: usize = 500;
/// Provider models relative path under the bound Base URL.
pub const MODELS_PATH: &str = "models";
/// Provider chat completions relative path under the bound Base URL.
pub const CHAT_COMPLETIONS_PATH: &str = "chat/completions";
/// Maximum images accepted in one chat request (the current TypeScript plugin supports one).
pub const MAX_CHAT_IMAGES: usize = 1;
/// SSE `data:` payload that marks the end of a chat completions stream.
pub const SSE_DONE: &[u8] = b"[DONE]";
/// Host-interpreted detection defaults projected from the signed manifest (TypeScript
/// `DETECT_MAX_TOKENS_THINKING` and the deepseek detect policy).
pub const DETECT_MAX_TOKENS: u32 = 2048;

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

/// Normalize a provider model key: trim, non-empty, bounded length (TypeScript
/// `normalizeModelKey`).
pub fn normalize_model_key(raw: &str) -> Result<String, ProtocolError> {
  let key = raw.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(ProtocolError::new("invalid model key"));
  }
  Ok(key.to_string())
}

/// Parse one OpenAI-shaped models page: `{"data":[{"id":...},...]}`. Bounded at
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
/// mode; the guest never infers or overrides `stream` from provider protocol details. The
/// `thinking` flag is host policy; the guest only renders it into the wire payload.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmPreferences {
  pub stream: bool,
  pub temperature: Option<f64>,
  pub max_tokens: Option<u64>,
  pub thinking: bool,
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
  let thinking = value
    .get("thinking")
    .and_then(|v| v.as_bool())
    .ok_or_else(|| ProtocolError::new("preferences have no thinking flag"))?;
  Ok(LlmPreferences {
    stream,
    temperature,
    max_tokens,
    thinking,
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

/// Chat message content array for an image request (TypeScript `openaiUserContent`): a text
/// part plus one `image_url` part carrying the base64 PNG data URL.
fn push_image_user_content(out: &mut String, user_prompt: &str, image_png_base64: &str) {
  out.push_str("[{\"type\":\"text\",\"text\":");
  push_json_string(out, user_prompt);
  out.push_str("},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,");
  out.push_str(image_png_base64);
  out.push_str("\"}}]");
}

/// Build the chat.completions request body with the exact key order of the TypeScript plugin:
/// `model`, `messages`, `stream`, then optional `temperature` and `max_tokens`, and finally
/// the host-envelope `thinking` payload (`{"type":"enabled"|"disabled"}`). The thinking value
/// is host policy rendered by the guest; the guest never chooses it.
pub fn build_chat_completions(
  model: &str,
  messages: &[(String, String)],
  temperature: Option<f64>,
  max_tokens: Option<u64>,
  image_png_base64: Option<&str>,
  stream: bool,
  thinking: bool,
) -> String {
  let mut body = String::from("{\"model\":");
  push_json_string(&mut body, model);
  body.push_str(",\"messages\":[");
  for (index, (role, content)) in messages.iter().enumerate() {
    if index > 0 {
      body.push(',');
    }
    body.push_str("{\"role\":");
    push_json_string(&mut body, role);
    body.push_str(",\"content\":");
    match image_png_base64 {
      Some(image) if is_user_role(role) => push_image_user_content(&mut body, content, image),
      _ => push_json_string(&mut body, content),
    }
    body.push('}');
  }
  body.push_str("],\"stream\":");
  body.push_str(if stream { "true" } else { "false" });
  if let Some(temperature) = temperature {
    body.push_str(",\"temperature\":");
    body.push_str(&format_number(temperature));
  }
  if let Some(max_tokens) = max_tokens {
    body.push_str(",\"max_tokens\":");
    body.push_str(&max_tokens.to_string());
  }
  body.push_str(",\"thinking\":{\"type\":\"");
  body.push_str(if thinking { "enabled" } else { "disabled" });
  body.push_str("\"}");
  body.push('}');
  body
}

/// The image content array applies to the user message only (matches the TypeScript plugin,
/// which always pairs the user prompt with the image).
fn is_user_role(role: &str) -> bool {
  role.eq_ignore_ascii_case("user")
}

/// Format a temperature value the same way JS `JSON.stringify` does for fixture values:
/// Rust's shortest round-trip rendering matches JSON for these bounded numbers (e.g. 0).
fn format_number(value: f64) -> String {
  format!("{value}")
}

/// Parse one unary chat.completions response: `choices[0].message.content` trimmed to a
/// non-empty string (TypeScript `parseOpenAiChatContent`).
pub fn parse_chat_content(body: &[u8]) -> Result<String, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("chat response is not JSON"))?;
  if !value.is_object() {
    return Err(ProtocolError::new("invalid chat response"));
  }
  let choices = value
    .get("choices")
    .and_then(|choices| choices.as_array())
    .filter(|choices| !choices.is_empty())
    .ok_or_else(|| ProtocolError::new("chat response missing choices"))?;
  let message = choices[0]
    .get("message")
    .filter(|message| message.is_object())
    .ok_or_else(|| ProtocolError::new("chat response missing message"))?;
  let content = message
    .get("content")
    .and_then(|content| content.as_str())
    .ok_or_else(|| ProtocolError::new("chat response missing content"))?;
  if content.as_bytes().iter().all(|byte| byte.is_ascii_whitespace()) {
    return Err(ProtocolError::new("chat content is empty"));
  }
  Ok(content.trim().to_string())
}

/// Extract the text delta from one stream chunk value: `choices[0].delta.content` when it is
/// a non-empty string; otherwise no delta (TypeScript `parseOpenAiStreamDelta`).
pub fn parse_stream_delta(value: &Value) -> Option<String> {
  let choices = value.get("choices")?.as_array()?;
  let delta = choices.first()?.get("delta")?;
  let content = delta.get("content")?.as_str()?;
  if content.is_empty() {
    return None;
  }
  Some(content.to_string())
}

/// Parse one SSE `data:` payload: `[DONE]` ends the stream (`Ok(None)`), a JSON chunk yields
/// an optional text delta, and a non-JSON payload is a stable error ("stream event is not
/// JSON" — TypeScript behavior).
pub fn parse_stream_event_data(data: &[u8]) -> Result<Option<String>, ProtocolError> {
  if data.is_empty() {
    return Ok(None);
  }
  if data == SSE_DONE {
    return Ok(None);
  }
  let value: Value = serde_json::from_slice(data).map_err(|_| ProtocolError::new("stream event is not JSON"))?;
  Ok(parse_stream_delta(&value))
}

/// Incremental SSE line decoder: splits byte frames on `\n`, groups consecutive `data:`
/// lines into events separated by blank lines, and returns one payload per completed event.
/// A trailing partial line stays buffered for the next frame.
#[derive(Debug, Default)]
pub struct SseDecoder {
  pending: Vec<u8>,
}

impl SseDecoder {
  pub fn new() -> Self {
    Self { pending: Vec::new() }
  }

  /// Feed one frame of bytes; returns the completed event `data:` payloads (with the `data:`
  /// prefix stripped and one leading space trimmed), in order.
  pub fn feed(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut events = Vec::new();
    let mut current_event: Option<Vec<u8>> = None;
    self.pending.extend_from_slice(bytes);
    let mut start = 0;
    for (index, byte) in self.pending.iter().enumerate() {
      if *byte != b'\n' {
        continue;
      }
      let line = &self.pending[start..index];
      start = index + 1;
      if let Some(payload) = parse_data_line(line) {
        match current_event.as_mut() {
          Some(event) => {
            event.push(b'\n');
            event.extend_from_slice(payload);
          }
          None => current_event = Some(payload.to_vec()),
        }
      } else if line.is_empty() || line == b"\r" {
        if let Some(event) = current_event.take() {
          events.push(event);
        }
      }
    }
    self.pending.drain(..start);
    events
  }
}

/// Parse one `data:` line: returns the payload with the prefix stripped and one leading
/// space removed, or none for non-data lines.
fn parse_data_line(line: &[u8]) -> Option<&[u8]> {
  let line = line.strip_suffix(b"\r").unwrap_or(line);
  let rest = line.strip_prefix(b"data:")?;
  Some(rest.strip_prefix(b" ").unwrap_or(rest))
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
