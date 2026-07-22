// ABOUTME: Anthropic Messages API adapter strategy.
// ABOUTME: Owns x-api-key auth, models pagination, messages payload, and stream deltas.
use crate::adapters::builtin::openai_shared::normalize_model_key;
use crate::adapters::protocol::{AdapterMeta, ProviderAdapter};
use crate::adapters::transport::{AuthApplication, ChatCompletionRequest, ParsedPage, TransportError, build_endpoint};
use crate::domain::model::RemoteModelSyncItem;
use crate::domain::provider::CredentialKind;

const MAX_MODELS_PER_PAGE: usize = 500;
const DEFAULT_MAX_TOKENS: u32 = 32768;

/// Anthropic Messages API.
#[derive(Debug, Default, Clone, Copy)]
pub struct AnthropicAdapter;

impl ProviderAdapter for AnthropicAdapter {
  fn meta(&self) -> AdapterMeta {
    AdapterMeta {
      id: "anthropic",
      label: "Anthropic",
      default_base_url: Some("https://api.anthropic.com"),
    }
  }

  fn secret_required(&self, _credential_kind: CredentialKind) -> bool {
    true
  }

  fn auth_application(&self, _credential_kind: CredentialKind) -> Result<AuthApplication, TransportError> {
    Ok(AuthApplication::AnthropicHeaders)
  }

  fn models_path(&self) -> &'static str {
    "v1/models"
  }

  fn parse_models_page(&self, value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
    parse_anthropic_page(value)
  }

  fn apply_list_continuation(&self, url: &mut url::Url, cursor: &str) -> Result<(), TransportError> {
    url.query_pairs_mut().append_pair("after_id", cursor);
    Ok(())
  }

  fn build_chat(
    &self,
    request: &ChatCompletionRequest,
    stream: bool,
  ) -> Result<(url::Url, serde_json::Value), TransportError> {
    let url = build_endpoint(&request.base_url, "v1/messages")?;
    let image = request.image_png_base64.as_deref();
    let mut payload = serde_json::json!({
      "model": request.model_key,
      "system": request.system_prompt,
      "messages": [
        { "role": "user", "content": anthropic_user_content(&request.user_prompt, image) }
      ],
      "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)
    });
    if stream {
      payload["stream"] = serde_json::json!(true);
    }
    if let Some(temp) = request.temperature {
      payload["temperature"] = serde_json::json!(temp);
    }
    Ok((url, payload))
  }

  fn parse_chat_content(&self, value: &serde_json::Value) -> Result<String, TransportError> {
    parse_anthropic_message_content(value)
  }

  fn parse_stream_delta(&self, event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
    parse_anthropic_stream_delta(event_name, value)
  }
}

/// Pure Anthropic models page parser.
///
/// Official list/pagination shape: `{ data: [...], has_more, first_id, last_id }`.
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
      capability_overrides_json: None,
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

fn anthropic_user_content(user_prompt: &str, image_png_base64: Option<&str>) -> serde_json::Value {
  match image_png_base64 {
    Some(image) => serde_json::json!([
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": image
        }
      },
      { "type": "text", "text": user_prompt }
    ]),
    None => serde_json::json!(user_prompt),
  }
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
  if text.is_empty() { None } else { Some(text.to_string()) }
}
