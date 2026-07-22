// ABOUTME: Shared OpenAI chat.completions / models wire helpers.
// ABOUTME: Used by openai-compatible, deepseek, and related OpenAI-shaped adapters.
use crate::adapters::transport::{ParsedPage, TransportError, build_endpoint};
use crate::domain::model::RemoteModelSyncItem;

const MAX_MODEL_KEY_LEN: usize = 256;
const MAX_MODELS_PER_PAGE: usize = 500;

pub fn normalize_model_key(raw: &str) -> Result<String, TransportError> {
  let key = raw.trim();
  if key.is_empty() || key.len() > MAX_MODEL_KEY_LEN {
    return Err(TransportError::InvalidResponse);
  }
  Ok(key.to_string())
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
      capability_overrides_json: None,
    });
  }
  Ok(ParsedPage {
    items,
    continuation: None,
  })
}

/// Build multimodal user content for OpenAI chat.completions when an image is present.
pub(crate) fn openai_user_content(user_prompt: &str, image_png_base64: Option<&str>) -> serde_json::Value {
  match image_png_base64 {
    Some(image) => serde_json::json!([
      { "type": "text", "text": user_prompt },
      {
        "type": "image_url",
        "image_url": {
          "url": format!("data:image/png;base64,{image}")
        }
      }
    ]),
    None => serde_json::json!(user_prompt),
  }
}

/// Apply OpenAI-compatible `thinking` control (`thinking.type` = enabled/disabled).
pub fn apply_openai_thinking(payload: &mut serde_json::Value, thinking: Option<bool>) {
  if let Some(enabled) = thinking {
    payload["thinking"] = serde_json::json!({
      "type": if enabled { "enabled" } else { "disabled" }
    });
  }
}

/// Build OpenAI chat.completions URL + body (stream or non-stream).
pub(crate) fn build_openai_chat_completions(
  base_url: &str,
  model_key: &str,
  system_prompt: &str,
  user_prompt: &str,
  temperature: Option<f64>,
  max_tokens: Option<u32>,
  thinking: Option<bool>,
  image_png_base64: Option<&str>,
  stream: bool,
) -> Result<(url::Url, serde_json::Value), TransportError> {
  let url = build_endpoint(base_url, "chat/completions")?;
  let mut payload = serde_json::json!({
    "model": model_key,
    "messages": [
      { "role": "system", "content": system_prompt },
      { "role": "user", "content": openai_user_content(user_prompt, image_png_base64) }
    ],
    "stream": stream
  });
  if let Some(temp) = temperature {
    payload["temperature"] = serde_json::json!(temp);
  }
  if let Some(max) = max_tokens {
    payload["max_tokens"] = serde_json::json!(max);
  }
  apply_openai_thinking(&mut payload, thinking);
  Ok((url, payload))
}

/// Final answer is always `message.content`. Thinking providers may also populate
/// sibling `reasoning_content` with chain-of-thought; that is never the answer.
pub fn parse_openai_chat_content(value: &serde_json::Value) -> Result<String, TransportError> {
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

/// OpenAI chat.completions stream chunk: `choices[0].delta.content`.
///
/// Thinking-mode providers stream CoT first via `delta.reasoning_content` while
/// `content` is null, absent, or empty. Those chunks are skipped so the consumer
/// keeps waiting for later final-answer deltas.
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
