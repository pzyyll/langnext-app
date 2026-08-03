// ABOUTME: Shared no_std Gemini protocol: generateContent body construction, paginated
// ABOUTME: v1beta/models and content/SSE parsing, preference envelopes; ports the TS plugin.
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
/// Named maximum pages the guest traverses for one aggregate Models List. The frozen WIT
/// models-list ABI has no continuation field; bounded page traversal stays inside the guest.
pub const MAX_MODELS_PAGES: usize = 5;
/// Named maximum total models across all pages of one aggregate Models List.
pub const MAX_MODELS_TOTAL: usize = 1000;
/// Maximum supportedGenerationMethods entries per model entry (TypeScript
/// `MAX_GEMINI_METHODS`).
pub const MAX_GEMINI_METHODS: usize = 32;
/// Maximum length of one method name (TypeScript `MAX_GEMINI_METHOD_LEN`).
pub const MAX_GEMINI_METHOD_LEN: usize = 128;
/// Maximum serialized remote metadata bytes (TypeScript `MAX_REMOTE_METADATA_BYTES`).
pub const MAX_REMOTE_METADATA_BYTES: usize = 2048;
/// Provider models relative path under the bound Base URL.
pub const MODELS_PATH: &str = "v1beta/models";
/// Maximum images accepted in one chat request (the current TypeScript plugin supports one).
pub const MAX_CHAT_IMAGES: usize = 1;
/// SSE `data:` payloads for Gemini are JSON candidate objects; there is no `[DONE]` marker.

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

/// Validate and normalize a Gemini model resource: trim, bounded length, no scheme/fragment,
/// and a `models/` prefix (TypeScript `geminiModelResource`).
pub fn gemini_model_resource(model_key: &str) -> Result<String, ProtocolError> {
  let key = model_key.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(ProtocolError::new("invalid gemini model key"));
  }
  if key.contains("://") || key.contains('?') || key.contains('#') {
    return Err(ProtocolError::new("invalid gemini model key"));
  }
  Ok(if key.starts_with("models/") {
    key.to_string()
  } else {
    format!("models/{key}")
  })
}

/// One parsed Gemini models page: normalized ids with optional display names plus the
/// continuation cursor (`nextPageToken`) when present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiModelsPage {
  pub items: Vec<(String, Option<String>)>,
  pub continuation: Option<String>,
}

/// Parse one Gemini models page: `{"models":[{"name":...,"displayName":...,...}],...}` with an
/// optional `nextPageToken`. `supportedGenerationMethods` is validated (bounded) but not
/// projected (the frozen WIT descriptor carries id/label only).
pub fn parse_models_page(body: &[u8]) -> Result<GeminiModelsPage, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("gemini model list is not JSON"))?;
  if !value.is_object() {
    return Err(ProtocolError::new("invalid gemini model list"));
  }
  let models = value
    .get("models")
    .and_then(|models| models.as_array())
    .ok_or_else(|| ProtocolError::new("gemini model list missing models"))?;
  if models.len() > MAX_MODELS_PER_PAGE {
    return Err(ProtocolError::new("gemini model list page too large"));
  }
  let mut items = Vec::with_capacity(models.len());
  for entry in models {
    if !entry.is_object() {
      return Err(ProtocolError::new("invalid gemini model entry"));
    }
    let name = entry
      .get("name")
      .and_then(|name| name.as_str())
      .ok_or_else(|| ProtocolError::new("gemini model missing name"))?;
    let stripped = name.strip_prefix("models/").unwrap_or(name);
    let id = normalize_model_key(stripped)?;
    let display_name = entry
      .get("displayName")
      .and_then(|name| name.as_str())
      .map(ToString::to_string);
    if let Some(methods) = entry.get("supportedGenerationMethods") {
      if !methods.is_null() {
        let methods = methods
          .as_array()
          .ok_or_else(|| ProtocolError::new("invalid gemini methods metadata"))?;
        if methods.len() > MAX_GEMINI_METHODS {
          return Err(ProtocolError::new("invalid gemini methods metadata"));
        }
        for method in methods {
          let method = method
            .as_str()
            .filter(|method| !method.is_empty() && method.len() <= MAX_GEMINI_METHOD_LEN)
            .ok_or_else(|| ProtocolError::new("invalid gemini method name"))?;
          let _ = method;
        }
        let meta = Value::Object({
          let mut map = serde_json::Map::new();
          map.insert("supportedGenerationMethods".into(), Value::Array(methods.clone()));
          map
        });
        if meta.to_string().len() > MAX_REMOTE_METADATA_BYTES {
          return Err(ProtocolError::new("gemini metadata too large"));
        }
      }
    }
    items.push((id, display_name));
  }
  let mut continuation = None;
  if let Some(token) = value.get("nextPageToken") {
    if !token.is_null() {
      let token = token
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| ProtocolError::new("invalid gemini nextPageToken"))?;
      continuation = Some(token.to_string());
    }
  }
  Ok(GeminiModelsPage { items, continuation })
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
/// image inline_data; image bytes never cross WIT semantic fields.
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

/// User message parts for an image request (TypeScript `geminiUserParts`): a text part plus
/// an `inline_data` part carrying the base64 PNG; without an image only the text part is used.
fn push_user_parts(out: &mut String, user_prompt: &str, image_png_base64: Option<&str>) {
  out.push_str("[{\"text\":");
  push_json_string(out, user_prompt);
  if let Some(image) = image_png_base64 {
    out.push_str("},{\"inline_data\":{\"mime_type\":\"image/png\",\"data\":");
    push_json_string(out, image);
    out.push_str("}}]");
  } else {
    out.push_str("}]");
  }
}

/// Build the generateContent request body with the exact key order of the TypeScript plugin:
/// `systemInstruction`, `contents`, then optional `generationConfig` (temperature then
/// maxOutputTokens). The host preference envelope supplies the values.
pub fn build_generate_content(
  _model_resource: &str,
  system_prompt: &str,
  user_prompt: &str,
  temperature: Option<f64>,
  max_tokens: Option<u64>,
  image_png_base64: Option<&str>,
  stream: bool,
) -> String {
  let _ = stream; // alt=sse is a query parameter; the body is identical for both modes.
  let mut body = String::from("{\"systemInstruction\":{\"parts\":[{\"text\":");
  push_json_string(&mut body, system_prompt);
  body.push_str("}]},\"contents\":[{\"role\":\"user\",\"parts\":");
  push_user_parts(&mut body, user_prompt, image_png_base64);
  body.push_str("}]");
  if temperature.is_some() || max_tokens.is_some() {
    body.push_str(",\"generationConfig\":{");
    let mut first = true;
    if let Some(temperature) = temperature {
      body.push_str("\"temperature\":");
      body.push_str(&format_number(temperature));
      first = false;
    }
    if let Some(max_tokens) = max_tokens {
      if !first {
        body.push(',');
      }
      body.push_str("\"maxOutputTokens\":");
      body.push_str(&max_tokens.to_string());
    }
    body.push('}');
  }
  body.push('}');
  body
}

/// Format a temperature value the same way JS `JSON.stringify` does for fixture values:
/// Rust's shortest round-trip rendering matches JSON for these bounded numbers (e.g. 0.2).
fn format_number(value: f64) -> String {
  format!("{value}")
}

/// Extract the text parts of the first candidate: `candidates[0].content.parts[].text`
/// joined in order (TypeScript `extractGeminiTexts`).
fn extract_gemini_texts(value: &Value) -> Vec<String> {
  let mut texts = Vec::new();
  let Some(candidates) = value.get("candidates").and_then(|c| c.as_array()) else {
    return texts;
  };
  let Some(first) = candidates.first() else {
    return texts;
  };
  let Some(content) = first.get("content") else {
    return texts;
  };
  let Some(parts) = content.get("parts").and_then(|p| p.as_array()) else {
    return texts;
  };
  for part in parts {
    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
      if !text.is_empty() {
        texts.push(text.to_string());
      }
    }
  }
  texts
}

/// Parse one unary generateContent response: joined text parts trimmed to a non-empty string
/// (TypeScript `parseChatResponse`).
pub fn parse_chat_content(body: &[u8]) -> Result<String, ProtocolError> {
  let value: Value = serde_json::from_slice(body).map_err(|_| ProtocolError::new("gemini response is not JSON"))?;
  let joined = extract_gemini_texts(&value).join("");
  let joined = joined.trim().to_string();
  if joined.is_empty() {
    return Err(ProtocolError::new("gemini content is empty"));
  }
  Ok(joined)
}

/// One stream-event parse outcome (TypeScript `StreamParseResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEventOutcome {
  Ignore,
  Delta(String),
}

/// Parse one Gemini SSE `data:` payload: JSON candidate text parts become a delta; a payload
/// with no text parts is ignored; a non-JSON payload is a stable error (TypeScript
/// `parseStreamEvent`).
pub fn parse_stream_event_data(data: &[u8]) -> Result<StreamEventOutcome, ProtocolError> {
  if data.is_empty() {
    return Ok(StreamEventOutcome::Ignore);
  }
  let value: Value = serde_json::from_slice(data).map_err(|_| ProtocolError::new("stream event is not JSON"))?;
  let texts = extract_gemini_texts(&value);
  if texts.is_empty() {
    return Ok(StreamEventOutcome::Ignore);
  }
  Ok(StreamEventOutcome::Delta(texts.join("")))
}

/// Incremental SSE line decoder over raw stream frames: splits byte frames on `\n`, groups
/// consecutive `data:` lines into events separated by blank lines, and returns one payload per
/// completed event. A trailing partial line stays buffered for the next frame.
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
