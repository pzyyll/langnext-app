// ABOUTME: OpenAI Responses API adapter strategy.
// ABOUTME: Owns responses endpoint payload shape and stream delta parsing.
use crate::adapters::builtin::openai_shared::parse_openai_page;
use crate::adapters::protocol::{AdapterMeta, ProviderAdapter};
use crate::adapters::transport::{AuthApplication, ChatCompletionRequest, ParsedPage, TransportError, build_endpoint};
use crate::domain::provider::CredentialKind;

/// OpenAI Responses API (`/responses`).
#[derive(Debug, Default, Clone, Copy)]
pub struct OpenAiResponsesAdapter;

impl ProviderAdapter for OpenAiResponsesAdapter {
  fn meta(&self) -> AdapterMeta {
    AdapterMeta {
      id: "openai-responses",
      label: "OpenAI Responses",
      default_base_url: Some("https://api.openai.com/v1"),
    }
  }

  fn secret_required(&self, credential_kind: CredentialKind) -> bool {
    matches!(credential_kind, CredentialKind::ApiKey | CredentialKind::Bearer)
  }

  fn auth_application(&self, credential_kind: CredentialKind) -> Result<AuthApplication, TransportError> {
    match credential_kind {
      CredentialKind::None => Ok(AuthApplication::None),
      CredentialKind::ApiKey | CredentialKind::Bearer => Ok(AuthApplication::BearerHeader),
    }
  }

  fn models_path(&self) -> &'static str {
    "models"
  }

  fn parse_models_page(&self, value: &serde_json::Value) -> Result<ParsedPage, TransportError> {
    parse_openai_page(value)
  }

  fn build_chat(
    &self,
    request: &ChatCompletionRequest,
    stream: bool,
  ) -> Result<(url::Url, serde_json::Value), TransportError> {
    let url = build_endpoint(&request.base_url, "responses")?;
    let mut payload = serde_json::json!({
      "model": request.model_key,
      "instructions": request.system_prompt,
      "input": responses_user_input(&request.user_prompt, request.image_png_base64.as_deref()),
      "stream": stream
    });
    if let Some(temp) = request.temperature {
      payload["temperature"] = serde_json::json!(temp);
    }
    if let Some(max) = request.max_tokens {
      payload["max_output_tokens"] = serde_json::json!(max);
    }
    Ok((url, payload))
  }

  fn parse_chat_content(&self, value: &serde_json::Value) -> Result<String, TransportError> {
    parse_openai_responses_content(value)
  }

  fn parse_stream_delta(&self, event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
    parse_openai_responses_stream_delta(event_name, value)
  }
}

/// Build Responses API `input` for text-only or vision (OCR) calls.
///
/// Text-only keeps the simple string form. Multimodal uses a user message with
/// `input_text` + `input_image` (data URL), per OpenAI Responses vision docs.
fn responses_user_input(user_prompt: &str, image_png_base64: Option<&str>) -> serde_json::Value {
  match image_png_base64 {
    Some(image) => serde_json::json!([
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": user_prompt },
          {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{image}")
          }
        ]
      }
    ]),
    None => serde_json::json!(user_prompt),
  }
}

fn parse_openai_responses_content(value: &serde_json::Value) -> Result<String, TransportError> {
  // Prefer convenience field when present.
  if let Some(text) = value.get("output_text").and_then(|v| v.as_str()) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_string());
    }
  }
  let output = value
    .get("output")
    .and_then(|v| v.as_array())
    .ok_or(TransportError::InvalidResponse)?;
  let mut parts = Vec::new();
  for item in output {
    let content = item.get("content").and_then(|c| c.as_array());
    let Some(content) = content else {
      continue;
    };
    for block in content {
      let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
      if block_type == "output_text" || block_type == "text" {
        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
          if !text.is_empty() {
            parts.push(text);
          }
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

/// OpenAI Responses API stream: prefer `response.output_text.delta` payloads.
fn parse_openai_responses_stream_delta(event_name: Option<&str>, value: &serde_json::Value) -> Option<String> {
  let ty = value.get("type").and_then(|t| t.as_str()).or(event_name).unwrap_or("");
  if ty == "response.output_text.delta" || ty.ends_with("output_text.delta") {
    if let Some(delta) = value.get("delta").and_then(|d| d.as_str()) {
      if !delta.is_empty() {
        return Some(delta.to_string());
      }
    }
  }
  // Some gateways nest text under delta as object.
  if let Some(text) = value.get("delta").and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
    if !text.is_empty() {
      return Some(text.to_string());
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::domain::provider::ProxyMode;

  fn sample_request(image_png_base64: Option<String>) -> ChatCompletionRequest {
    ChatCompletionRequest {
      adapter_id: "openai-responses".into(),
      base_url: "https://api.openai.com/v1".into(),
      credential_kind: CredentialKind::ApiKey,
      secret: Some("sk-test".into()),
      proxy_mode: ProxyMode::Inherit,
      model_key: "gpt-5.4-mini".into(),
      system_prompt: "You are an OCR engine.".into(),
      user_prompt: "Extract all text from the image.".into(),
      temperature: Some(0.2),
      max_tokens: Some(128000),
      thinking: None,
      image_png_base64,
    }
  }

  #[test]
  fn text_only_input_stays_string() {
    let adapter = OpenAiResponsesAdapter;
    let (_url, body) = adapter.build_chat(&sample_request(None), false).unwrap();
    assert_eq!(body["input"], "Extract all text from the image.");
    assert_eq!(body["instructions"], "You are an OCR engine.");
    assert_eq!(body["max_output_tokens"], 128000);
  }

  #[test]
  fn image_input_uses_input_image_data_url() {
    let adapter = OpenAiResponsesAdapter;
    let (_url, body) = adapter
      .build_chat(&sample_request(Some("abc123".into())), false)
      .unwrap();
    let input = body["input"].as_array().expect("multimodal input array");
    assert_eq!(input.len(), 1);
    assert_eq!(input[0]["role"], "user");
    let content = input[0]["content"].as_array().expect("content array");
    assert_eq!(content.len(), 2);
    assert_eq!(content[0]["type"], "input_text");
    assert_eq!(content[0]["text"], "Extract all text from the image.");
    assert_eq!(content[1]["type"], "input_image");
    assert_eq!(content[1]["image_url"], "data:image/png;base64,abc123");
  }
}
